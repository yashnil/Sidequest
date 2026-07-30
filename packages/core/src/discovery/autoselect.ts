import { INTEREST_LABELS, type Interest, type PlaceCategory } from '../schemas/common';
import type { TravelerProfile } from '../schemas/profile';
import type { DiscoveryCandidate } from './board';

export interface AutoSelection {
  /** Place ids to pre-check, in board order. */
  selectedIds: string[];
  targetCount: number;
  /** Plain-language account of what the selection traded off. */
  notes: string[];
  stats: {
    hiddenGemShare: number;
    totalDriveMinutesOneWay: number;
    byCategory: Partial<Record<PlaceCategory, number>>;
  };
}

export interface AutoSelectInput {
  candidates: DiscoveryCandidate[];
  profile: TravelerProfile;
  tripDays: number;
}

/**
 * Picks a balanced starting set so the traveller confirms a plan rather than
 * builds one. Fully deterministic: the same board and profile always produce the
 * same selection, which is what makes it testable and what keeps the "auto-pick"
 * button honest.
 *
 * Constraints applied, in order of precedence:
 *   - never select something unworkable or a weak fit
 *   - respect the per-interest frequency ceiling the traveller set
 *   - keep total driving inside a sane share of the trip's travel budget
 *   - allow at most one stop beyond the stated detour tolerance
 *   - hold roughly the famous/hidden balance they asked for
 *   - keep category variety so the trip is not six versions of one thing
 */
export function autoSelect(input: AutoSelectInput): AutoSelection {
  const { candidates, profile, tripDays } = input;
  const derived = profile.derived;

  // Arrival and departure days realistically hold about half a day each.
  const effectiveDays = Math.max(1, tripDays - 1);
  const targetCount = Math.max(1, Math.round(derived.activitySlotsPerDay * effectiveDays));

  const eligible = candidates.filter(
    (candidate) => candidate.fit.band !== 'not_workable' && candidate.fit.band !== 'weak',
  );

  // Coarse driving budget, measured in one-way minutes summed across picks.
  // Stops that share a day share their driving, so this deliberately under-counts
  // rather than modelling round trips per stop — the routing phase will replace
  // it with a real travel-time matrix. Half the trip's total travel allowance
  // keeps the board from pre-selecting a week of driving without starving the
  // cheap stops fifteen minutes from town.
  const driveBudget = Math.round(tripDays * profile.transport.maxDailyTravelMinutes * 0.5);
  const maxPerCategory = Math.max(2, Math.ceil(targetCount / 3));
  const maxStretch = 1;
  const maxHidden = Math.ceil(targetCount * derived.hiddenGemTarget) + 1;
  const maxClassic = Math.ceil(targetCount * (1 - derived.hiddenGemTarget)) + 1;
  // A ceiling on classics is not the same as a floor on gems: without a reserved
  // quota, a hidden-gem-leaning traveller ends up with the same board as everyone
  // else, because interest and distance dominate the ordering. Hold back a share
  // of the slots for genuine gems and fill them from the top down.
  const minHidden = Math.floor(targetCount * derived.hiddenGemTarget * 0.7);

  const interestCounts = new Map<Interest, number>();
  const categoryCounts = new Map<PlaceCategory, number>();
  const selected: DiscoveryCandidate[] = [];
  const notes: string[] = [];
  let driveUsed = 0;
  let stretchUsed = 0;
  let hiddenUsed = 0;
  let classicUsed = 0;
  const skippedForFrequency = new Set<Interest>();

  const ordered = [...eligible].sort(
    (a, b) => b.fit.score - a.fit.score || a.place.id.localeCompare(b.place.id),
  );

  // Pass 1 — every constraint active.
  for (const candidate of ordered) {
    if (selected.length >= targetCount) break;
    // Once the remaining slots are exactly what the gem quota still needs, stop
    // spending them on anything else.
    const slotsLeft = targetCount - selected.length;
    const gemsStillNeeded = minHidden - hiddenUsed;
    if (gemsStillNeeded >= slotsLeft && !isHiddenGem(candidate)) continue;

    const check = canTake(candidate, {
      interestCounts,
      categoryCounts,
      driveUsed,
      driveBudget,
      maxPerCategory,
      stretchUsed,
      maxStretch,
      hiddenUsed,
      maxHidden,
      classicUsed,
      maxClassic,
      profile,
    });
    if (!check.ok) {
      if (check.reason === 'frequency' && candidate.fit.primaryInterest) {
        skippedForFrequency.add(candidate.fit.primaryInterest);
      }
      continue;
    }
    take(candidate);
  }

  // Pass 2 — fill any remaining slots, relaxing the balance targets but never
  // the traveller's own frequency ceilings or travel budget.
  if (selected.length < targetCount) {
    for (const candidate of ordered) {
      if (selected.length >= targetCount) break;
      if (selected.includes(candidate)) continue;
      const check = canTake(candidate, {
        interestCounts,
        categoryCounts,
        driveUsed,
        driveBudget,
        maxPerCategory: maxPerCategory + 1,
        stretchUsed,
        maxStretch,
        hiddenUsed,
        maxHidden: targetCount,
        classicUsed,
        maxClassic: targetCount,
        profile,
      });
      if (!check.ok) continue;
      take(candidate);
    }
  }

  function take(candidate: DiscoveryCandidate) {
    selected.push(candidate);
    for (const [interest, cost] of frequencyCost(candidate)) {
      interestCounts.set(interest, (interestCounts.get(interest) ?? 0) + cost);
    }
    categoryCounts.set(
      candidate.place.category,
      (categoryCounts.get(candidate.place.category) ?? 0) + 1,
    );
    driveUsed += candidate.driveMinutes;
    if (candidate.detourClass === 'stretch') stretchUsed += 1;
    if (isHiddenGem(candidate)) hiddenUsed += 1;
    if (candidate.place.popularityScore >= 0.7) classicUsed += 1;
  }

  if (targetCount - selected.length >= 2) {
    notes.push(
      `We pre-selected ${selected.length} rather than padding out to ${targetCount}. Add more from the board if you want fuller days.`,
    );
  }
  const heldBack = [...skippedForFrequency].sort();
  if (heldBack.length > 0) {
    const named = heldBack.slice(0, 3).map((interest) => INTEREST_LABELS[interest].toLowerCase());
    const list =
      named.length === 1
        ? named[0]
        : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
    notes.push(
      `There is more ${list} on the board — we stopped at the frequency you asked for rather than filling the trip with it.`,
    );
  }
  if (stretchUsed > 0) {
    notes.push('One pick sits past your usual detour limit because it earned the extra drive.');
  }

  return {
    selectedIds: selected.map((candidate) => candidate.place.id),
    targetCount,
    notes,
    stats: {
      hiddenGemShare: selected.length > 0 ? hiddenUsed / selected.length : 0,
      totalDriveMinutesOneWay: driveUsed,
      byCategory: Object.fromEntries(categoryCounts) as Partial<Record<PlaceCategory, number>>,
    },
  };
}

/** Same threshold the board uses to file something under hidden gems. */
function isHiddenGem(candidate: DiscoveryCandidate): boolean {
  return candidate.place.hiddenGemScore >= 0.6;
}

interface TakeContext {
  interestCounts: Map<Interest, number>;
  categoryCounts: Map<PlaceCategory, number>;
  driveUsed: number;
  driveBudget: number;
  maxPerCategory: number;
  stretchUsed: number;
  maxStretch: number;
  hiddenUsed: number;
  maxHidden: number;
  classicUsed: number;
  maxClassic: number;
  profile: TravelerProfile;
}

type TakeCheck =
  | { ok: true }
  | { ok: false; reason: 'frequency' | 'category' | 'drive' | 'stretch' | 'mix' };

/**
 * What one stop costs against the traveller's frequency ceilings. A place spends
 * a full unit of the thing it primarily is, and half a unit of everything else it
 * happens to deliver — so a lakeside hike draws down the hiking allowance in full
 * and the lake allowance partially, instead of either double-charging or ignoring
 * one of them.
 */
function frequencyCost(candidate: DiscoveryCandidate): [Interest, number][] {
  const primary = candidate.fit.primaryInterest;
  return candidate.fit.matchedInterests.map((interest) => [
    interest,
    interest === primary ? 1 : 0.5,
  ]);
}

function canTake(candidate: DiscoveryCandidate, ctx: TakeContext): TakeCheck {
  for (const [interest, cost] of frequencyCost(candidate)) {
    const cap = ctx.profile.derived.frequencyCaps[interest] ?? 0;
    if ((ctx.interestCounts.get(interest) ?? 0) + cost > cap) {
      return { ok: false, reason: 'frequency' };
    }
  }
  if ((ctx.categoryCounts.get(candidate.place.category) ?? 0) >= ctx.maxPerCategory) {
    return { ok: false, reason: 'category' };
  }
  if (ctx.driveUsed + candidate.driveMinutes > ctx.driveBudget) {
    return { ok: false, reason: 'drive' };
  }
  if (candidate.detourClass === 'stretch' && ctx.stretchUsed >= ctx.maxStretch) {
    return { ok: false, reason: 'stretch' };
  }
  if (candidate.place.hiddenGemScore >= 0.6 && ctx.hiddenUsed >= ctx.maxHidden) {
    return { ok: false, reason: 'mix' };
  }
  if (candidate.place.popularityScore >= 0.7 && ctx.classicUsed >= ctx.maxClassic) {
    return { ok: false, reason: 'mix' };
  }
  return { ok: true };
}
