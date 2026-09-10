import type { Itinerary } from '../schemas/itinerary';
import { modelMayOverride, type TripContract } from '../contract/trip-contract';
import { STRENUOUS_BLOCKERS, FUNCTIONAL_NEED_LABELS, type FunctionalNeed } from '../party/traveler';
import { dayStrain } from '../party/strain';

/**
 * THE FEASIBILITY REPORT — DETERMINISTIC, FROM THE PLAN AS IT STANDS.
 *
 * V6 §12. "Ready" used to be a function of how much verified: a plan with no
 * error-class issue, every leg timed and every place found was ready; anything
 * less was ready with cautions. That let a relocation day whose five-hour
 * transfer nobody measured read as ready with a caution, and a first day that
 * depended on which of two airports the traveller lands at read as ready
 * full stop.
 *
 * This report asks a different question of every day — can it be *done* —
 * and answers in four words:
 *
 *   feasible                      nothing stands in the way
 *   feasible_with_cautions        it works; read these first
 *   unresolved_major_dependency   a decision or a measurement the plan
 *                                 cannot do without is still open
 *   infeasible                    something locked is contradicted
 *
 * "Ready" may only appear on the first two. Every item names its area, its
 * severity, the day it concerns and one sentence a traveller can act on.
 * Unknown ≠ false throughout: an unmeasured transfer is a dependency, never
 * an impossibility; a missing sunset time produces no daylight finding.
 */

export const FEASIBILITY_VERDICTS = ['feasible', 'feasible_with_cautions', 'unresolved_major_dependency', 'infeasible'] as const;
export type FeasibilityVerdict = (typeof FEASIBILITY_VERDICTS)[number];

export const FEASIBILITY_AREAS = ['dates', 'bases', 'transport', 'time', 'daylight', 'physical', 'season', 'booking', 'food', 'party'] as const;
export type FeasibilityArea = (typeof FEASIBILITY_AREAS)[number];

export interface FeasibilityItem {
  area: FeasibilityArea;
  severity: 'blocker' | 'dependency' | 'caution';
  dayNumber?: number;
  detail: string;
}

export interface FeasibilityReport {
  version: 1;
  verdict: FeasibilityVerdict;
  items: FeasibilityItem[];
  summary: string;
}

export const FEASIBILITY_VERDICT_COPY: Record<FeasibilityVerdict, { label: string; blurb: string }> = {
  feasible: { label: 'Ready', blurb: 'Every day fits, and nothing you chose was dropped without a reason.' },
  feasible_with_cautions: { label: 'Ready, with cautions', blurb: 'The plan works. A few things are worth reading before you commit.' },
  unresolved_major_dependency: { label: 'Needs a decision', blurb: 'One thing the plan depends on is still open. Settle it and the days fall into place.' },
  infeasible: { label: 'Needs a rethink', blurb: 'Something you locked is contradicted by the plan as it stands.' },
};

export interface FeasibilityInput {
  itinerary: Itinerary;
  contract?: TripContract;
  /** The audit's own verdict on the checks the report should not recompute. */
  audit?: { checks: readonly { id: string; ok: boolean; severity: 'error' | 'warning'; detail: string }[] };
  /** Functional needs across the party (the contract's union), by label or key. */
  partyNeeds?: readonly string[];
  /** Bookings the plan requires that nobody has arranged, one title each. */
  requiredUnbooked?: readonly string[];
  /** The traveller's own driving ceiling, minutes, when they gave one. */
  maxDailyDriveMinutes?: number | null;
}

const HARD_FAIL_NEED_LABELS = new Set<string>(STRENUOUS_BLOCKERS.map((need) => FUNCTIONAL_NEED_LABELS[need]));
const HARD_FAIL_NEED_KEYS = new Set<string>(STRENUOUS_BLOCKERS);

function needIsStrenuousBlocker(need: string): boolean {
  return HARD_FAIL_NEED_KEYS.has(need as FunctionalNeed) || HARD_FAIL_NEED_LABELS.has(need) || /steep|limited walking|step-free|wheelchair|cannot stand|pregnan/i.test(need);
}

export function buildFeasibilityReport(input: FeasibilityInput): FeasibilityReport {
  const { itinerary } = input;
  const items: FeasibilityItem[] = [];
  const pkg = itinerary.package;

  // --- dates: the audit already compared the itinerary to the contract ------------------
  const lockedDates = input.audit?.checks.find((c) => c.id === 'locked_dates_preserved');
  if (lockedDates && !lockedDates.ok) items.push({ area: 'dates', severity: 'blocker', detail: `The plan is not dated to the window you chose: ${lockedDates.detail}.` });
  const nights = input.audit?.checks.find((c) => c.id === 'nights_sum');
  if (nights && !nights.ok) items.push({ area: 'bases', severity: 'blocker', detail: `The nights do not add up: ${nights.detail}.` });
  const contractRespected = input.audit?.checks.find((c) => c.id === 'contract_respected');
  if (contractRespected && !contractRespected.ok) items.push({ area: 'dates', severity: 'blocker', detail: contractRespected.detail });

  // --- bases -----------------------------------------------------------------------------
  const baseConsistency = input.audit?.checks.find((c) => c.id === 'base_consistency');
  if (baseConsistency && !baseConsistency.ok) items.push({ area: 'bases', severity: 'dependency', detail: `Where you sleep is not continuous: ${baseConsistency.detail}.` });

  // --- transport -------------------------------------------------------------------------
  for (const day of itinerary.days) {
    if (day.totals.unmeasuredMajorTransfer) {
      items.push({ area: 'transport', severity: 'dependency', dayNumber: day.dayNumber, detail: `Day ${day.dayNumber} moves base and the main transfer has not been measured, so the day cannot be timed yet.` });
    }
  }
  /* Legs nobody could time or estimate are cautions: those days are shown in parts of the day, not clocks. */
  const allowanceDays = itinerary.days.filter((d) => d.totals.allowanceMinutes > 0 && !d.totals.unmeasuredMajorTransfer).map((d) => d.dayNumber);
  if (allowanceDays.length > 0) items.push({ area: 'transport', severity: 'caution', detail: `${allowanceDays.length} day${allowanceDays.length === 1 ? '' : 's'} (${allowanceDays.join(', ')}) hold${allowanceDays.length === 1 ? 's' : ''} travel nobody could time; those days show parts of the day rather than clock times.` });
  const unverified = pkg?.verification.unverified ?? 0;
  if (unverified > 0) items.push({ area: 'booking', severity: 'caution', detail: `${unverified} named place${unverified === 1 ? '' : 's'} could not be confirmed yet; check ${unverified === 1 ? 'it' : 'them'} before relying on ${unverified === 1 ? 'it' : 'them'}.` });
  const driveCap = input.audit?.checks.find((c) => c.id === 'drive_cap');
  /* Over the traveller's own ceiling is a contradiction; over Sidequest's default is a caution. */
  const driveCapIsTheirs = input.contract ? !modelMayOverride(input.contract.transport.maxDailyDriveMinutes.lock) : false;
  if (driveCap && !driveCap.ok) items.push({ area: 'transport', severity: driveCapIsTheirs ? 'blocker' : 'caution', detail: `${driveCapIsTheirs ? 'Driving runs over the ceiling you set' : 'A long driving day'}: ${driveCap.detail}.` });
  const modePlausible = input.audit?.checks.find((c) => c.id === 'mode_plausible');
  if (modePlausible && !modePlausible.ok) items.push({ area: 'transport', severity: 'caution', detail: `A walk is written where the distance needs wheels: ${modePlausible.detail}.` });
  /* A stated prohibition against a mode the plan uses is a contradiction of a locked fact. */
  if (input.contract) {
    const usedModes = new Set(itinerary.days.flatMap((d) => d.transport.modes));
    for (const rule of input.contract.transport.prohibitions) {
      if (modelMayOverride(rule.lock)) continue;
      const value = rule.value ?? '';
      if (/^No ferries/i.test(value) && usedModes.has('ferry')) items.push({ area: 'transport', severity: rule.lock === 'user_soft' ? 'caution' : 'blocker', detail: 'The plan uses a ferry and you said no ferries.' });
      if (/^No self-driving/i.test(value) && itinerary.transportStrategy.primaryMode === 'drive') items.push({ area: 'transport', severity: rule.lock === 'user_soft' ? 'caution' : 'blocker', detail: 'The plan is built around driving yourselves and you said you would not drive.' });
      /* Mountain and unpaved road rules need road evidence to judge; without it there is no finding (unknown ≠ false). */
    }
  }

  // --- time ------------------------------------------------------------------------------
  /* The audit's details are lists ("day 1: X; day 1: Y"); a traveller needs the verb. */
  const TIME_LEAD: Record<string, string> = {
    no_overlaps: 'Two stops overlap',
    edges_respected: 'Something sits outside the arrival or departure window',
    no_stop_past_window: 'A stop runs past the end of its day',
    time_intent_respected: 'A stop is not at the hour it needs',
    stops_follow_transfers: 'A stop starts before the leg that reaches it ends',
  };
  for (const id of ['no_overlaps', 'edges_respected', 'no_stop_past_window', 'time_intent_respected', 'stops_follow_transfers'] as const) {
    const check = input.audit?.checks.find((c) => c.id === id);
    if (check && !check.ok) items.push({ area: 'time', severity: 'caution', detail: `${TIME_LEAD[id]}: ${check.detail}.` });
  }
  for (const issue of itinerary.issues) {
    if (issue.code === 'gateway_unresolved') items.push({ area: 'transport', severity: 'dependency', ...(issue.dayNumber ? { dayNumber: issue.dayNumber } : {}), detail: issue.message });
  }

  // --- daylight --------------------------------------------------------------------------
  const daylight = input.audit?.checks.find((c) => c.id === 'daylight_respected');
  if (daylight && !daylight.ok) items.push({ area: 'daylight', severity: 'caution', detail: `An outdoor stop sits after sunset: ${daylight.detail}.` });

  // --- physical / party ------------------------------------------------------------------
  const blockingNeeds = (input.partyNeeds ?? []).filter(needIsStrenuousBlocker);
  if (blockingNeeds.length > 0) {
    const label = ((FUNCTIONAL_NEED_LABELS as Record<string, string>)[blockingNeeds[0]!] ?? blockingNeeds[0]!).toLowerCase();
    for (const day of itinerary.days) {
      const strain = dayStrain(day);
      if (strain.accommodated) continue;
      /*
       * A blocker needs a stop that says why (`dayStrain.demanding`). A day
       * that is merely long is a caution — the person may well manage it, and
       * the plan does not know otherwise; unknown ≠ false.
       */
      if (strain.demanding.length > 0) {
        items.push({ area: 'party', severity: 'blocker', dayNumber: day.dayNumber, detail: `Day ${day.dayNumber} puts ${strain.demanding.slice(0, 2).join(' and ')} in front of someone who needs "${label}", with no easier option for them.` });
      } else if (strain.full) {
        items.push({ area: 'party', severity: 'caution', dayNumber: day.dayNumber, detail: `Day ${day.dayNumber} is a full day and someone in the party needs "${label}"; nothing in it is known to be steep or long on foot, so check the stops with them.` });
      }
    }
  }
  const partyCheck = input.audit?.checks.find((c) => c.id === 'party_hard_fails');
  if (partyCheck && !partyCheck.ok && !items.some((i) => i.area === 'party' && i.severity === 'blocker')) items.push({ area: 'party', severity: 'blocker', detail: partyCheck.detail });
  const restCheck = input.audit?.checks.find((c) => c.id === 'rest_is_deliberate');
  if (restCheck && !restCheck.ok) items.push({ area: 'physical', severity: 'caution', detail: `An empty day with no stated reason: ${restCheck.detail}.` });

  // --- season ----------------------------------------------------------------------------
  for (const day of itinerary.days) {
    for (const warning of day.warnings ?? []) {
      if (/\b(seasonal|closed for the season|closure|snowed|winter road|road closed|pass closed|not open in|out of season)\b/i.test(warning)) items.push({ area: 'season', severity: 'caution', dayNumber: day.dayNumber, detail: warning });
    }
  }

  // --- booking ---------------------------------------------------------------------------
  for (const title of input.requiredUnbooked ?? []) items.push({ area: 'booking', severity: 'caution', detail: `${title} needs arranging before this works as planned.` });
  const bookedRespected = input.audit?.checks.find((c) => c.id === 'booked_respected');
  if (bookedRespected && !bookedRespected.ok) items.push({ area: 'booking', severity: 'blocker', detail: bookedRespected.detail });

  // --- food ------------------------------------------------------------------------------
  const meals = input.audit?.checks.find((c) => c.id === 'meals_in_window');
  if (meals && !meals.ok) items.push({ area: 'food', severity: 'caution', detail: `A meal sits at an odd hour: ${meals.detail}.` });
  if (input.contract && input.contract.party.dietaryHard.length > 0) {
    const daysWithoutNamedVenue = itinerary.days.filter((d) => d.items.some((i) => i.kind === 'meal') && !d.items.some((i) => i.kind === 'meal' && i.food?.stopKind === 'venue')).length;
    if (daysWithoutNamedVenue > 0) items.push({ area: 'food', severity: 'caution', detail: `Your dietary rules are absolute and ${daysWithoutNamedVenue} day(s) have no named venue yet; check kitchens before relying on them.` });
  }

  // --- verdict ---------------------------------------------------------------------------
  const SEVERITY_RANK = { blocker: 0, dependency: 1, caution: 2 } as const;
  const deduped = items
    .filter((item, i, all) => all.findIndex((x) => x.detail === item.detail && x.dayNumber === item.dayNumber) === i)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.dayNumber ?? 0) - (b.dayNumber ?? 0));
  const verdict: FeasibilityVerdict = deduped.some((i) => i.severity === 'blocker')
    ? 'infeasible'
    : deduped.some((i) => i.severity === 'dependency')
      ? 'unresolved_major_dependency'
      : deduped.length > 0
        ? 'feasible_with_cautions'
        : 'feasible';
  const blockers = deduped.filter((i) => i.severity === 'blocker').length;
  const dependencies = deduped.filter((i) => i.severity === 'dependency').length;
  const cautions = deduped.filter((i) => i.severity === 'caution').length;
  const summary =
    verdict === 'feasible'
      ? 'Every day can be done as written.'
      : verdict === 'feasible_with_cautions'
        ? `${cautions} thing${cautions === 1 ? '' : 's'} worth reading before you commit.`
        : verdict === 'unresolved_major_dependency'
          ? `${dependencies} decision${dependencies === 1 ? '' : 's'} or measurement${dependencies === 1 ? '' : 's'} still open${cautions > 0 ? `, and ${cautions} caution${cautions === 1 ? '' : 's'}` : ''}.`
          : `${blockers} thing${blockers === 1 ? '' : 's'} contradict${blockers === 1 ? 's' : ''} what you locked.`;
  return { version: 1, verdict, items: deduped, summary };
}

/** The itinerary status a verdict maps to — the only bridge between the two vocabularies. */
export function itineraryStatusForVerdict(verdict: FeasibilityVerdict): 'ready' | 'ready_with_cautions' | 'needs_decision' {
  return verdict === 'feasible' ? 'ready' : verdict === 'feasible_with_cautions' ? 'ready_with_cautions' : 'needs_decision';
}
