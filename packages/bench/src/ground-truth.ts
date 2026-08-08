import type { BenchmarkTripRequest } from './schemas/request';

/**
 * WHAT THE VALIDATORS ARE ALLOWED TO KNOW.
 *
 * A port, not an implementation. The neutral validators take this object and
 * nothing else, and that is the mechanism by which they stay neutral rather
 * than the promise that they will.
 *
 * Three things are deliberately absent, and each is absent because including it
 * would decide the benchmark:
 *
 * **No planner configuration.** The production validator takes a `PlannerConfig`
 * and reads legality out of it — the meal-overrun allowance, the lunch
 * threshold, the free-time floor by pace. Those are conventions one system
 * agreed to. A plan built to different conventions is not wrong, and measuring
 * it against them would be measuring agreement rather than quality. Where a
 * threshold is genuinely needed it lives in `NEUTRAL_THRESHOLDS`, is published,
 * and is nobody's default.
 *
 * **No derived traveller profile.** `preferredPhysicalIntensity` and
 * `frequencyCaps` are computed policy, not stated fact. The request is the only
 * statement of what the traveller wants.
 *
 * **No native artifact.** Neither the compiled region nor the model's raw
 * response reaches a check. Everything is resolved through the shared inventory,
 * by id, so that two plans naming the same place are talking about the same
 * place and a plan naming something the inventory does not hold produces an
 * honest `unknown` rather than a fuzzy string match.
 *
 * Every accessor returns `null` for "not established". None returns a default,
 * because a default is how a check silently starts grading a guess.
 */

export interface InventoryEntry {
  entityId: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Minutes a visit here typically takes, where a source states one. */
  typicalDurationMinutes: number | null;
  /** Officially signed for daylight use only. Null means nobody said. */
  daylightOnly: boolean | null;
  /** Categories from the shared taxonomy, used for avoidance matching. */
  tags: readonly string[];
  /** Access facts, where the inventory holds them. */
  requiresCar: boolean | null;
  unpavedApproach: boolean | null;
  remoteNoServices: boolean | null;
  strenuous: boolean | null;
}

export interface DayOpening {
  /** `unknown` is a real answer and the most common one for many places. */
  status: 'open' | 'closed' | 'always_open' | 'unknown';
  windows: readonly { openMinute: number; closeMinute: number }[];
  lastAdmissionMinute: number | null;
}

export interface SolarDay {
  sunriseMinute: number;
  sunsetMinute: number;
  kind: 'normal' | 'polar_day' | 'polar_night';
}

export interface FoodVenueFacts {
  entityId: string;
  name: string;
  latitude: number;
  longitude: number;
  servesSlots: readonly ('breakfast' | 'lunch' | 'dinner' | 'snack')[];
  /** What the venue itself states it cannot accommodate. */
  cannotAccommodate: readonly string[];
}

/**
 * The ground-truth port.
 *
 * Implemented once over the shared region data, and once again over a fixture in
 * the offline case library. Both competitors' plans are checked against the same
 * instance in a session — which is what makes the comparison a comparison.
 */
export interface BenchmarkGroundTruth {
  /** The traveller's own statement. The only source of "what was asked for". */
  request: BenchmarkTripRequest;
  /** The instant the run is judged at, injected so a plan does not score
   *  differently on a Tuesday. */
  now: Date;

  place(entityId: string): InventoryEntry | null;
  /** `null` when no dataset covered this place on this date. */
  openingOn(entityId: string, date: string): DayOpening | null;
  /** `null` when no seasonal rule is on record. */
  seasonallyOpenOn(entityId: string, date: string): boolean | null;
  /** `null` when no solar record could be computed. */
  solar(entityId: string, date: string): SolarDay | null;
  /** Measured minutes for a pair, or `null` when nobody measured it. */
  routeMinutes(fromEntityId: string, toEntityId: string): number | null;
  /** Great-circle distance. Always available where both places have coordinates. */
  straightLineKm(fromEntityId: string, toEntityId: string): number | null;
  food(entityId: string): FoodVenueFacts | null;
  /**
   * Whether the source at `sourceIndex` states what the plan says it states.
   *
   * One question only: does this source support this value. It is emphatically
   * *not* a range check on the index — the plan's own `sources` list is the only
   * authority on whether a citation points at something, the claims check does
   * that check itself, and an implementation that answered `false` because its
   * own record of the run held fewer sources would convict a plan of an
   * unsupported claim on the strength of an unrelated count. Where an
   * implementation cannot tell — it holds provider records rather than quoted
   * statements, or it never read the source — the answer is `null`, and `false`
   * is reserved for a source that was read and does not say it.
   */
  supportsClaim(sourceIndex: number, factPath: string | undefined, statedValue: string | undefined): boolean | null;
}

/**
 * PUBLISHED THRESHOLDS.
 *
 * Every `minor` finding that needs a number reads it from here, and the number
 * is stated in the benchmark specification rather than inherited from either
 * system's configuration. A test asserts that no value here was taken by
 * reference from the production planner's defaults — coinciding by accident is
 * fine and is commented where it happens; coinciding by import is not.
 *
 * These are deliberately generous. A neutral checker's job is to catch plans
 * that do not work, not to enforce a house style, and a tight threshold would
 * quietly punish whichever system's conventions differ from the author's.
 *
 * Two rules govern the numbers themselves, and both exist because a threshold is
 * the quietest place in a benchmark to hide a thumb on the scale.
 *
 * **One number, one verdict.** Several of these used to be a single figure read
 * by three unrelated checks, which meant a reviewer adjusting the food rule
 * silently moved a free-time gate and a rest-day ceiling with it, and no test
 * would have said so. Every check now reads a constant that is named after the
 * question it answers, even where two of them presently hold the same value.
 *
 * **Nothing adjacent to a competitor's own cap.** A neutral threshold sitting
 * just inside one system's internal limit can never fire against that system
 * while firing freely against the other, which reads as a quality difference and
 * is an artefact of the instrument. Where a competitor's house limit is known,
 * the reasoning for the distance from it is written beside the number.
 */
export const NEUTRAL_THRESHOLDS = {
  /** Above this many scheduled activity blocks in one day, density is flagged. */
  maxActivityBlocksPerDay: 8,
  /**
   * Below this many unscheduled minutes on a full day, free time is flagged.
   *
   * The deterministic planner holds itself to 45, 90 or 150 minutes depending on
   * pace, so the previous figure of 30 sat under every one of them: it could not
   * fire against that arm at all, while a plan built to no floor tripped it
   * freely. Sixty sits above the tightest of the three — a fast-paced day built
   * exactly to that arm's own floor is still checkable — and well below the other
   * two, so this is not that arm's balanced-pace convention wearing a neutral
   * name. It is low enough to mean "no slack in the day at all" rather than
   * "less slack than the author would have left".
   */
  minFreeMinutesPerFullDay: 60,
  /** A day with more scheduled minutes than this is flagged as overfull. */
  maxScheduledMinutesPerDay: 840,
  /** A day longer than this with no meal block at all is flagged. */
  longDayMinutesRequiringFood: 480,
  /**
   * Minutes of day length per meal the day is expected to name.
   *
   * Separate from the figure above despite sharing its value: one asks whether a
   * long day feeds the traveller at all, the other asks how many times, and they
   * are free to move apart without either dragging the other with it.
   */
  minutesPerImpliedMeal: 480,
  /**
   * A day at least this long is held to the free-time floor.
   *
   * Half a day that is entirely booked is a morning rather than an ordeal, and
   * this is the line between the two. It answers a scheduling question and no
   * longer borrows the food rule's number to do it.
   */
  fullDayMinutesForFreeTimeFloor: 480,
  /**
   * Commitments above this on a day the plan itself calls a rest day.
   *
   * A full working day of obligations, which is the point at which the label and
   * the load are telling the traveller two different things. Neither competitor
   * publishes a rest-day ceiling, so there is no house limit to stay clear of.
   */
  restDayMaxCommittedMinutes: 480,
  /** Ground speed used only to prove a jump impossible, never to estimate one. */
  impossibleJumpKmh: 130,
  /** Slack allowed before a stated travel time is called understated. */
  travelUnderstatementToleranceMinutes: 10,
  /** How far a stated route time may sit from the measured one. */
  routeTimeDisagreementToleranceMinutes: 15,
  /** Minutes before sunset after which a daylight-only visit is merely flagged. */
  daylightBufferMinutes: 30,
  /**
   * Detour to a meal above this is flagged when the request states no tolerance.
   *
   * The deterministic planner allows 20 minutes for an ordinary meal and 35 for
   * one it considers worth the trip. Thirty sat between the two, which made the
   * check fire against that arm only for meals it had deliberately chosen to
   * detour for, and against the other arm for anything at all. Forty-five clears
   * both caps, so a plan trips this only by going further off route than either
   * system's own idea of a defensible detour.
   */
  mealDetourMinutes: 45,
  /** A visit shorter than this fraction of the typical duration is implausible. */
  minDurationFractionOfTypical: 0.4,
  /** A visit longer than this multiple of the typical duration is implausible. */
  maxDurationMultipleOfTypical: 4,
} as const;
