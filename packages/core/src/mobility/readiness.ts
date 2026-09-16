import type { OperatingType } from '../operating/model';
import type { Journey, JourneyTruth } from './journey';
import { TRAVEL_MODE_LABELS } from './vocabulary';

/**
 * V12.1 §18 — READINESS, ASKED OF THE JOURNEYS RATHER THAN OF A PERCENTAGE.
 *
 * ── WHAT V11 AND V12 EACH GOT RIGHT, AND WHAT IS STILL MISSING ──────────────
 *
 * V11 §4 replaced a leg-percentage gate with a route-critical one, which was
 * right. V12 §21 replaced the archetype label with
 * `transportCertaintyRequirement`, a single float, which was also right and is
 * not enough: **0.90 is unsatisfiable**. `island_hopping` and `rail_journey`
 * both sit there, and the rule `>= 0.8` means "every base transfer must be
 * timed" — which for a ferry or a Shinkansen means measured by a road router
 * that cannot see either. Both families were therefore permanently unready, for
 * a reason that has nothing to do with the trip.
 *
 * The missing idea is that **different families accept different kinds of
 * truth**, not different amounts of it:
 *
 *   a self-drive route      needs its base transfers MEASURED
 *   a rail journey          accepts TIMETABLED, and accepts a stated
 *                           schedule-to-confirm on a corridor that really has trains
 *   an operator-led trek    accepts OPERATOR_SET, and must never be asked for
 *                           road-measured trail legs
 *   a resort week           accepts OPERATOR_SET for the arrival transfer
 *   island hopping          needs its route-critical crossings to be
 *                           operationally plausible — a real corridor, a real mode
 *   a city week             accepts an unverified transit leg where walking or a
 *                           taxi would also do
 *
 * ── THE RULE THAT STOPS THIS BECOMING A LOOPHOLE ────────────────────────────
 *
 * Accepting `OPERATOR_SET` is not accepting `UNKNOWN`. A journey is
 * operator-set because an operator owns it and the plan says so; a journey is
 * unknown because nobody could say. The first is a fact about the trip, the
 * second about us — and §22's rule follows directly: only the first may become
 * a traveller's booking task, and the second is never a task at all.
 *
 * Pure.
 */

/** What kinds of knowledge satisfy this family for a route-critical journey. */
export interface JourneyRequirementProfile {
  /** Truth states that count as settled for a route-critical journey. */
  accepts: readonly JourneyTruth[];
  /**
   * Whether an `unknown` route-critical journey may still be Ready when the
   * corridor itself is plausible — a real mode, a real pair of endpoints, and
   * a schedule somebody publishes that we simply have not read.
   *
   * True only for families whose transport is somebody else's timetable. A road
   * trip cannot use this, because there is no timetable to fall back on: an
   * untimed drive is genuinely a hole.
   */
  acceptsScheduleToConfirm: boolean;
  /** One sentence naming what this family needs, for the shortfall's detail. */
  need: string;
}

const MEASURED_ONLY: JourneyRequirementProfile = {
  accepts: ['measured', 'timetabled'],
  acceptsScheduleToConfirm: false,
  need: 'the drives between the places you sleep have journey times',
};

const SCHEDULED: JourneyRequirementProfile = {
  accepts: ['measured', 'timetabled', 'operator_set'],
  acceptsScheduleToConfirm: true,
  need: 'the scheduled journeys between your stops are real services on real routes',
};

const OPERATOR_LED: JourneyRequirementProfile = {
  accepts: ['measured', 'timetabled', 'operator_set'],
  acceptsScheduleToConfirm: false,
  need: 'whoever runs this trip owns the transfers, and the plan says who',
};

const URBAN: JourneyRequirementProfile = {
  accepts: ['measured', 'timetabled', 'operator_set', 'estimated'],
  acceptsScheduleToConfirm: true,
  need: 'you can get between the places on this trip on foot, by taxi or on the network',
};

export const FAMILY_JOURNEY_REQUIREMENTS: Record<OperatingType, JourneyRequirementProfile> = {
  urban_culture: URBAN,
  urban_food_nightlife: URBAN,
  urban_family: URBAN,
  overland_backpacking: SCHEDULED,
  mountain_road_trip: MEASURED_ONLY,
  multi_day_trek: OPERATOR_LED,
  guided_wildlife: OPERATOR_LED,
  resort_stay: OPERATOR_LED,
  island_hopping: SCHEDULED,
  rail_journey: SCHEDULED,
  self_drive_road_trip: MEASURED_ONLY,
  remote_overland: OPERATOR_LED,
  mixed_regional: SCHEDULED,
};

/**
 * Whether a route-critical journey is settled enough for this family.
 *
 * `contradicted` is never settled for anybody — it is the one state that says
 * the journey cannot be made, and a plan resting on it is not ready whatever
 * kind of trip it is.
 */
export function journeyIsSettled(journey: Journey, profile: JourneyRequirementProfile): boolean {
  if (journey.truth === 'contradicted') return false;
  if (profile.accepts.includes(journey.truth)) return true;
  if (journey.truth !== 'unknown') return false;
  if (!profile.acceptsScheduleToConfirm) return false;
  /*
   * SCHEDULE TO CONFIRM IS A STATE, NOT AN EXCUSE.
   *
   * It applies only where somebody else owns the departure — a timetable, a
   * network or an operator — because that is the only case in which "we have not
   * read it yet" describes a real, findable schedule rather than our own gap. An
   * unknown road leg on a scheduled-transport trip (the taxi to the port) is not
   * covered by this and still counts against Ready.
   */
  return journey.control === 'timetable_controlled' || journey.control === 'network_controlled' || journey.control === 'operator_controlled' || journey.control === 'air';
}

export interface JourneyReadiness {
  /** Route-critical journeys this family considers settled, out of all of them. */
  settled: number;
  total: number;
  /** Journeys an affirmative source says cannot be made. Always a shortfall. */
  contradicted: Journey[];
  /** Route-critical journeys that are neither settled nor contradicted. */
  outstanding: Journey[];
  /** Journeys whose only problem is that no provider in this deployment measures their mode. Sidequest's gap, never a task. */
  ownedBySidequest: Journey[];
}

/**
 * How ready this family's route-critical mobility is.
 *
 * `ownedBySidequest` is the field §18 and §22 both turn on. A journey nobody
 * could time because no provider does ferries is **our** unfinished work: it
 * lowers confidence, it is stated plainly, and it never becomes "Decide
 * transportation" on the traveller's list. V11 §`owner` settled that for
 * feasibility items; this carries it into mobility, which is where the
 * temptation to invent a task is strongest.
 */
export function assessJourneyReadiness(journeys: readonly Journey[], family: OperatingType): JourneyReadiness {
  const profile = FAMILY_JOURNEY_REQUIREMENTS[family];
  const critical = journeys.filter((journey) => journey.routeCritical);
  const contradicted = critical.filter((journey) => journey.truth === 'contradicted');
  const settled = critical.filter((journey) => journeyIsSettled(journey, profile));
  const outstanding = critical.filter((journey) => journey.truth !== 'contradicted' && !journeyIsSettled(journey, profile));
  const ownedBySidequest = outstanding.filter((journey) => journey.unknownReason === 'no_provider_for_mode' || journey.unknownReason === 'outside_provider_coverage' || journey.unknownReason === 'provider_did_not_answer' || journey.unknownReason === 'measurement_implausible');
  return { settled: settled.length, total: critical.length, contradicted, outstanding, ownedBySidequest };
}

export interface JourneyShortfall {
  requirement: string;
  detail: string;
  /** Who can move this forward. Sidequest's own gaps never reach a traveller's list (§22). */
  owner: 'traveler' | 'sidequest';
}

/**
 * What is not finished about this trip's mobility, for this family.
 *
 * Empty means every route-critical journey is settled in a way this kind of trip
 * accepts — which is not the same as "everything is measured", and deliberately
 * so.
 */
export function journeyShortfalls(readiness: JourneyReadiness, family: OperatingType): JourneyShortfall[] {
  const profile = FAMILY_JOURNEY_REQUIREMENTS[family];
  const out: JourneyShortfall[] = [];

  for (const journey of readiness.contradicted) {
    out.push({
      requirement: 'journey_contradicted',
      detail: journey.contradiction ?? `The ${TRAVEL_MODE_LABELS[journey.mode].toLowerCase()} between ${journey.origin.name} and ${journey.destination.name} is not running as planned.`,
      owner: 'traveler',
    });
  }

  const travellerOwned = readiness.outstanding.filter((journey) => !readiness.ownedBySidequest.includes(journey));
  if (travellerOwned.length > 0) {
    out.push({
      requirement: 'route_critical_journeys',
      detail: `${travellerOwned.length} of the ${readiness.total} journeys this trip rests on ${travellerOwned.length === 1 ? 'is' : 'are'} not settled yet — ${profile.need}.`,
      owner: 'traveler',
    });
  }

  if (readiness.ownedBySidequest.length > 0) {
    out.push({
      requirement: 'journeys_we_cannot_time',
      detail: `${readiness.ownedBySidequest.length} journey${readiness.ownedBySidequest.length === 1 ? '' : 's'} on this trip ${readiness.ownedBySidequest.length === 1 ? 'is' : 'are'} one${readiness.ownedBySidequest.length === 1 ? '' : 's'} we have not been able to time. That is our unfinished work, not yours.`,
      owner: 'sidequest',
    });
  }

  return out;
}
