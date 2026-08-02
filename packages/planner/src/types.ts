import type {
  AccessDataset,
  DiscoveryCandidate,
  DiscoverySelection,
  FoodDataset,
  FoodSelection,
  Interest,
  MealSlot,
  Itinerary,
  OperatingHoursDataset,
  Place,
  PlannerReadiness,
  Region,
  SelectionStatus,
  TravelerProfile,
  TripBasics,
  WeatherDataset,
} from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';

export const PLANNER_VERSION = 1;

/**
 * Trip-specific feasibility — the third of the four kinds of state this domain
 * keeps apart. It joins a canonical `Place` (never mutated), the traveller's
 * computed fit, and what they said on the board, without writing any of that
 * back onto the place record.
 */
export interface PlanningCandidate {
  place: Place;
  /** Higher wins. Manual choices outrank auto-picks, which outrank maybes. */
  priority: number;
  /** The traveller chose this by hand rather than accepting an auto-pick. */
  manual: boolean;
  selectionStatus: SelectionStatus;
  fitScore: number;
  primaryInterest?: Interest;
  matchedInterests: readonly Interest[];
  /** How long to allow on site. */
  durationMinutes: number;
  driveMinutesFromBase: number;
}

export interface PlannerConfig {
  /** Transition slack after an ordinary stop. */
  bufferMinutes: number;
  /** Longer decompression after something strenuous. */
  restAfterStrenuousMinutes: number;
  /**
   * When each meal stops being that meal.
   *
   * One record rather than five loose constants, because they were five loose
   * constants and two of them had already gone bad: `lunchLatestMinute` was
   * declared and never read, so lunch had no upper bound at all, and a second
   * copy of the dinner hour written in the food layer quietly moved dinner from
   * six to five across every plan in the product.
   *
   * These are product rules about naming, not claims about when a person should
   * eat. Breakfast at eleven is lunch; dinner at half four is not dinner. The
   * planner leaves a slot empty rather than stretch one.
   */
  mealWindows: Record<MealSlot, { earliest: number; latest: number }>;
  /** How long a meal block runs when no venue is behind it. */
  unplannedMealMinutes: Record<MealSlot, number>;
  /**
   * How far past the day's window the last meal of the day may run.
   *
   * The window bounds what the planner *schedules*; a meal at the end of it is
   * the one thing a traveller carries on past that line. Without an allowance a
   * balanced-pace day ending at seven could hold an hour of dinner and not a
   * minute more, and every real restaurant in this region takes longer than an
   * hour — so the plan held time for a meal instead of naming one, on days that
   * had a perfectly good table free. One-sided, and only the last meal may use
   * it: the layout and the validator read the same number.
   */
  mealOverrunAllowanceMinutes: number;
  /** A day shorter than this does not get a sit-down meal block. */
  minDayMinutesForLunch: number;
  /** Day end by pace, as minutes from midnight. */
  dayEndByPace: Record<TravelerProfile['pace'], number>;
  /** Day start by the traveller's stated preference. */
  dayStartByPreference: Record<TravelerProfile['dayStart'], number>;
  /** Settling-in time after arriving before anything is scheduled. */
  arrivalSettleMinutes: number;
  /** Slack before the stated departure time on the last day. */
  departureLeadMinutes: number;
  /** Share of a normal day's capacity an arrival or departure day may hold. */
  edgeDayCapacityShare: number;
  maxRevisionPasses: number;
  /** Below this, a leftover gap is slack rather than a free-time block. */
  minFreeTimeBlockMinutes: number;
  /**
   * Unbooked minutes a full day must keep, by pace. Free time is a legitimate
   * output, not leftover space — a plan that fills every hour is the thing
   * travellers complain about, and it has no room to absorb a late start or a
   * longer hike than expected. Edge days are exempt; they are already short.
   */
  minFreeMinutesByPace: Record<TravelerProfile['pace'], number>;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  bufferMinutes: 15,
  restAfterStrenuousMinutes: 30,
  mealWindows: {
    breakfast: { earliest: 6 * 60, latest: 10 * 60 + 30 },
    lunch: { earliest: 11 * 60 + 30, latest: 14 * 60 + 30 },
    dinner: { earliest: 18 * 60, latest: 21 * 60 },
    snack: { earliest: 9 * 60, latest: 17 * 60 },
  },
  unplannedMealMinutes: { breakfast: 30, lunch: 45, dinner: 60, snack: 20 },
  mealOverrunAllowanceMinutes: 45,
  minDayMinutesForLunch: 5 * 60,
  dayEndByPace: { slow: 18 * 60, balanced: 19 * 60, fast: 20 * 60 },
  dayStartByPreference: { early: 7 * 60 + 30, normal: 9 * 60, relaxed: 10 * 60 + 30 },
  arrivalSettleMinutes: 60,
  departureLeadMinutes: 90,
  edgeDayCapacityShare: 0.6,
  maxRevisionPasses: 3,
  minFreeTimeBlockMinutes: 30,
  minFreeMinutesByPace: { slow: 150, balanced: 90, fast: 45 },
};

export interface PlannerInput {
  tripId: string;
  basics: TripBasics;
  profile: TravelerProfile;
  region: Region;
  /**
   * Straight from `buildDiscoveryBoard`. Reusing these means the planner inherits
   * the fit scores, seasonal assessment and blockers already computed rather than
   * running a second, subtly different copy of that logic.
   */
  candidates: readonly DiscoveryCandidate[];
  selections: readonly DiscoverySelection[];
  matrix: TravelTimeMatrix;
  /**
   * Resolved and validated at the server boundary, exactly like the matrix. The
   * planner never asks a provider anything; it is handed the facts and stays a
   * pure function of them.
   */
  access: AccessDataset;
  /**
   * When each place is actually accepting visitors, resolved and validated at
   * the same boundary. Kept separate from `access` on purpose: reachable and
   * open are two different questions, and a plan has to pass both.
   */
  hours: OperatingHoursDataset;
  /**
   * What the sky is expected to do, resolved and validated at the same boundary.
   * The weakest of the three and the only one that may not decide legality: it
   * chooses between days that access and hours have already allowed, and it
   * carries the daylight windows — which are a fact rather than a prediction and
   * are the one part of this that does constrain.
   *
   * Always present, never optional. A trip whose forecast could not be fetched
   * gets a dataset full of `unavailable` days, because the difference between
   * "we looked and could not find out" and "nobody looked" is exactly what a
   * traveller needs told.
   */
  weather: WeatherDataset;
  /**
   * Where the traveller could eat, resolved and validated at the same boundary
   * as the three above.
   *
   * Optional, and the only one of the five that is — because "we have no food
   * data for this region" is a state the product has to work in, and works in
   * honestly: every meal block is still there, and every one of them says it is
   * time held rather than somewhere named. Undefined and an empty dataset are
   * different things and the plan says which it had.
   */
  food?: FoodDataset;
  /** Venues the traveller asked for, or asked not to be sent to, on the board. */
  foodSelections?: readonly FoodSelection[];
  /** Matrix id for the trip base. Days start and end here. */
  baseId: string;
  config?: Partial<PlannerConfig>;
  /** Injected so output is reproducible in tests. */
  generatedAt?: string;
  /**
   * "Now", for the one question that needs it: whether the forecast behind this
   * plan has aged past its own freshness window. Injected rather than read, so a
   * staleness test does not have to wait six hours.
   */
  now?: Date;
}

export type PlanFailureCode =
  | 'no_candidates'
  | 'no_usable_days'
  | 'matrix_unusable'
  /**
   * Everything was measurable and nothing could be placed.
   *
   * Distinct from the three above, which are all "we could not start". This one
   * means the planner ran in full and produced nothing, which is the only
   * failure that owes the traveller a breakdown rather than a sentence.
   */
  | 'planner_coverage_insufficient'
  | 'internal_error';

export type PlanResult =
  | {
      ok: true;
      itinerary: Itinerary;
      /**
       * How much of what the traveller picked actually made it.
       *
       * Present on success as well as failure, because "this plan holds four of
       * the nine things you chose" is worth saying, and because a record that
       * only exists on failure cannot be compared across two builds.
       */
      readiness: PlannerReadiness;
    }
  | {
      ok: false;
      code: PlanFailureCode;
      message: string;
      /** Present on `planner_coverage_insufficient`, and only there. */
      readiness?: PlannerReadiness;
    };

export function resolveConfig(overrides?: Partial<PlannerConfig>): PlannerConfig {
  return { ...DEFAULT_PLANNER_CONFIG, ...overrides };
}
