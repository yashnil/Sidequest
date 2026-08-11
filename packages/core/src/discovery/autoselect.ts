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
    /**
     * One-way minutes summed across picks, in whatever mode each is made in.
     *
     * Was `totalDriveMinutesOneWay`, and on a car-free board it was structurally
     * **zero** — the only thing that added to it was a candidate whose access
     * rules named `drive`, and there were none — so the figure said "no travel
     * at all" about a trip made entirely of train journeys.
     */
    totalTravelMinutesOneWay: number;
    /** The part of that actually spent at a wheel. Zero for a non-driver. */
    totalDriveMinutesOneWay: number;
    byCategory: Partial<Record<PlaceCategory, number>>;
  };
  /**
   * Why each candidate that was not pre-selected was left out.
   *
   * Section 7: "when a candidate is excluded, store or expose a truthful
   * reason". Every one of these was already computed and thrown away — the band
   * pre-filter did not even produce one — so a traveller looking at a thin
   * pre-selection had no way to tell "we ran out of slots" from "your frequency
   * ceiling stopped us" from "we could not route it".
   */
  excluded: { placeId: string; reason: ExclusionReason }[];
}

/** Why auto-pick left a candidate alone. Never a judgement it did not make. */
export const AUTO_SELECT_EXCLUSIONS = [
  /** Unworkable on these dates or for this traveller. The board says why. */
  'not_workable',
  /** A weak fit on its own merits, which auto-pick never proposes. */
  'weak_fit',
  /** Past the per-interest ceiling the traveller set. */
  'frequency',
  /** The board already holds enough of this kind of thing. */
  'category',
  /** Would take the trip past the travel the traveller said they would accept. */
  'travel_budget',
  /** Already at the one pick allowed past the usual detour. */
  'stretch',
  /** The famous/hidden balance they asked for is already met. */
  'mix',
  /** No legal way in on any day of the trip. */
  'access',
  /** Nothing could establish the journey, so it is not pre-selected for them. */
  'reach_unverified',
  /** Real, eligible, and there were no slots left. */
  'no_slots',
] as const;
export type ExclusionReason = (typeof AUTO_SELECT_EXCLUSIONS)[number];

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

  const excluded: { placeId: string; reason: ExclusionReason }[] = [];
  const eligible = candidates.filter((candidate) => {
    if (candidate.fit.band === 'not_workable') {
      excluded.push({ placeId: candidate.place.id, reason: 'not_workable' });
      return false;
    }
    if (candidate.fit.band === 'weak') {
      excluded.push({ placeId: candidate.place.id, reason: 'weak_fit' });
      return false;
    }
    return true;
  });

  // Coarse travel budget, measured in one-way minutes summed across picks.
  // Stops that share a day share their travel, so this deliberately under-counts
  // rather than modelling round trips per stop — the routing phase will replace
  // it with a real travel-time matrix. Half the trip's total travel allowance
  // keeps the board from pre-selecting a week of long journeys without starving
  // the cheap stops fifteen minutes from town.
  //
  // TWO BUDGETS, because the traveller gave two answers. There was one, it was
  // the driving one, and it was drawn down only by stops whose *access rules*
  // named a car — so a car-free board had no travel accounting whatsoever and
  // auto-pick would happily pre-select six hour-long train journeys against a
  // budget of zero it never consulted.
  const driveBudget = Math.round(tripDays * profile.transport.maxDailyDriveMinutes * 0.5);
  const travelBudget = Math.round(tripDays * profile.transport.maxDailyTransportMinutes * 0.5);
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
  let travelUsed = 0;
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
      travelUsed,
      travelBudget,
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
        travelUsed,
        travelBudget,
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

  /*
   * The final verdict per eligible candidate, taken once, after both passes.
   * Re-running `canTake` against the *finished* counters is what makes the
   * reason honest: a candidate rejected in pass 1 for category saturation and
   * then taken in pass 2 is not excluded at all, and one that was fine on every
   * rule and simply arrived after the last slot is `no_slots` rather than a
   * constraint it never actually hit.
   */
  for (const candidate of ordered) {
    if (selected.includes(candidate)) continue;
    const check = canTake(candidate, {
      interestCounts,
      categoryCounts,
      driveUsed,
      driveBudget,
      travelUsed,
      travelBudget,
      maxPerCategory: maxPerCategory + 1,
      stretchUsed,
      maxStretch,
      hiddenUsed,
      maxHidden: targetCount,
      classicUsed,
      maxClassic: targetCount,
      profile,
    });
    excluded.push({
      placeId: candidate.place.id,
      reason: check.ok ? 'no_slots' : check.reason,
    });
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
    /*
     * Charged to the budget the mode actually spends, and to both where the mode
     * is a drive — an hour at the wheel is an hour of getting about as well as an
     * hour of driving. An unresolved journey draws down nothing: there is no
     * number, and inventing one to spend would be fake precision on the exact
     * axis this pass exists to remove.
     */
    const minutes = candidate.travelMinutesFromBase;
    if (minutes !== null && candidate.detourClass !== 'base') {
      /*
       * Base-area stops spend nothing. They are minutes from the bed by
       * definition, and charging them would let five strolls around town eat
       * the budget that exists to bound genuine journeys out.
       */
      travelUsed += minutes;
      if (drivesThere(candidate)) driveUsed += minutes;
    }
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
    // "the extra drive" on a trip with no car was one of the board's plainer
    // untruths. The sentence is about distance, so it says distance.
    notes.push('One pick sits past your usual detour limit because it earned the extra journey.');
  }

  return {
    selectedIds: selected.map((candidate) => candidate.place.id),
    targetCount,
    notes,
    stats: {
      hiddenGemShare: selected.length > 0 ? hiddenUsed / selected.length : 0,
      totalTravelMinutesOneWay: travelUsed,
      totalDriveMinutesOneWay: driveUsed,
      byCategory: Object.fromEntries(categoryCounts) as Partial<Record<PlaceCategory, number>>,
    },
    excluded: excluded.sort((a, b) => a.placeId.localeCompare(b.placeId)),
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
  travelUsed: number;
  travelBudget: number;
  maxPerCategory: number;
  stretchUsed: number;
  maxStretch: number;
  hiddenUsed: number;
  maxHidden: number;
  classicUsed: number;
  maxClassic: number;
  profile: TravelerProfile;
}

type TakeCheck = { ok: true } | { ok: false; reason: ExclusionReason };

/**
 * True when this candidate spends the traveller's own *driving* budget.
 *
 * Both halves are required and they answer different questions. The resolved
 * mode says the journey is made on a road; the access rules say who is at the
 * wheel. A gateway reached along that same road on a park shuttle is a road
 * journey nobody drives, and charging it to the driving cap would refuse a stop
 * over driving that does not happen.
 */
function drivesThere(candidate: DiscoveryCandidate): boolean {
  return (
    candidate.travelModeFromBase === 'drive' && candidate.access.requiredModes.includes('drive')
  );
}

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
  /*
   * BOTH BUDGETS, AND THE SAME REACH TRUTH THE BOARD AND PLANNER USE.
   *
   * A drive spends the driving budget and the transport budget; anything else
   * spends only the second. `travelMinutesFromBase` is the resolved journey, so
   * a train is charged as a train — which is the whole of §7.
   */
  const minutes = candidate.travelMinutesFromBase;
  if (minutes !== null) {
    if (drivesThere(candidate) && ctx.driveUsed + minutes > ctx.driveBudget) {
      return { ok: false, reason: 'travel_budget' };
    }
    if (ctx.travelBudget > 0 && ctx.travelUsed + minutes > ctx.travelBudget) {
      return { ok: false, reason: 'travel_budget' };
    }
  }
  // Auto-pick must never propose something the traveller cannot legally reach on
  // any day of their trip. The board explains why; the pre-selection just leaves
  // it alone.
  if (candidate.access.status === 'blocked') {
    return { ok: false, reason: 'access' };
  }
  /*
   * A journey nobody could verify is not pre-selected *for* the traveller.
   *
   * Both unresolved states, and for the same reason rather than two. `conflict`
   * — the only measured route is one this traveller may not use — is the
   * road-only candidate a non-driver must never be handed. `unmeasured` is a
   * gap in what anybody could time. Neither is a duration auto-pick can fit into
   * a day, and pre-checking a stop we cannot time puts the planner's refusal
   * *after* the traveller's approval, which is the order that wastes their time.
   *
   * It stays on the board, keeps its score, its badges and its access notes, and
   * can be added by hand. This is a statement about what we will decide on
   * somebody's behalf, not a verdict on the place.
   *
   * A place *at* the base is exempt, because there is no journey to verify —
   * `classifyDetour` returns `base` before it looks at reach for exactly that
   * reason, and requiring a measured leg here would empty the pre-selection of a
   * car-free town trip whose every stop is on the doorstep.
   */
  if (candidate.detourClass !== 'base' && candidate.reach.status !== 'measured') {
    return { ok: false, reason: 'reach_unverified' };
  }
  /*
   * TOO FAR IS NOT PRE-SELECTED, FOR ANY MODE.
   *
   * `too_far` now means "the round trip exceeds the budget for the mode that
   * would make it" — it is no longer a hard fit blocker for a non-driving
   * journey, so the card stays a card, keeps its band and can be added by hand.
   * But auto-pick proposing it would put the planner's refusal after the
   * traveller's approval: the scheduler applies the same caps and would drop
   * the stop with a reason on the finished plan, which is the Phase 9 shape —
   * a board that promises and a planner that takes it back.
   */
  if (candidate.detourClass === 'too_far') {
    return { ok: false, reason: 'travel_budget' };
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
