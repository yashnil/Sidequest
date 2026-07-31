import type {
  AccessDataset,
  DiscoveryCandidate,
  DiscoverySelection,
  Interest,
  Itinerary,
  Place,
  Region,
  SelectionStatus,
  TravelerProfile,
  TripBasics,
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
  lunchEarliestMinute: number;
  lunchLatestMinute: number;
  lunchMinutes: number;
  dinnerEarliestMinute: number;
  dinnerMinutes: number;
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
  lunchEarliestMinute: 11 * 60 + 30,
  lunchLatestMinute: 14 * 60 + 30,
  lunchMinutes: 45,
  dinnerEarliestMinute: 18 * 60,
  dinnerMinutes: 60,
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
  /** Matrix id for the trip base. Days start and end here. */
  baseId: string;
  config?: Partial<PlannerConfig>;
  /** Injected so output is reproducible in tests. */
  generatedAt?: string;
}

export type PlanFailureCode =
  | 'no_candidates'
  | 'no_usable_days'
  | 'matrix_unusable'
  | 'internal_error';

export type PlanResult =
  | { ok: true; itinerary: Itinerary }
  | { ok: false; code: PlanFailureCode; message: string };

export function resolveConfig(overrides?: Partial<PlannerConfig>): PlannerConfig {
  return { ...DEFAULT_PLANNER_CONFIG, ...overrides };
}
