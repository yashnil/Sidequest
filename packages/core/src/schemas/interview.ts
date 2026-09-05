import { z } from 'zod';

/**
 * THE VOCABULARY OF THE ADAPTIVE INTERVIEW.
 *
 * Everything the questionnaire v2 can record that the v1 answer set could not:
 * where a value came from and how strongly it binds, the trade-off answers,
 * the comfort dimensions a dense city never needs and a remote delta cannot do
 * without, and the explicit hard constraints. Every enum here is closed on
 * purpose — the composition summary, the review screen and the reconciler all
 * key off these values.
 *
 * Nothing here is a claim about the world. These are statements about one
 * traveller, and every one of them is optional at the schema level so a trip
 * saved before the interview existed still parses (`answers_json` is stored raw
 * and reparsed on every read).
 */

// ---------------------------------------------------------------------------
// Provenance: where a preference came from, and how hard it binds
// ---------------------------------------------------------------------------

export const PREFERENCE_SOURCES = [
  /** The traveller chose it on a screen that asked. */
  'explicit',
  /** Derived from something else they said (a theme, free text, another answer). */
  'inferred',
  /** Sidequest's own default for this question, chosen because nobody answered. */
  'smart_default',
  /** A default chosen because of where they are going, not who they are. */
  'destination_prior',
  /** Carried from an earlier screen or profile (the composer, a saved trip). */
  'existing_profile',
] as const;
export const preferenceSourceSchema = z.enum(PREFERENCE_SOURCES);
export type PreferenceSource = z.infer<typeof preferenceSourceSchema>;

export const PREFERENCE_BINDINGS = ['hard', 'strong', 'normal', 'weak'] as const;
export const preferenceBindingSchema = z.enum(PREFERENCE_BINDINGS);
export type PreferenceBinding = z.infer<typeof preferenceBindingSchema>;

export const preferenceProvenanceSchema = z.object({
  source: preferenceSourceSchema,
  strength: preferenceBindingSchema,
  /** 0–1. Explicit answers are 1; a destination prior is honest about being a guess. */
  confidence: z.number().min(0).max(1),
  /** One sentence a traveller can read: why this value is what it is. */
  reason: z.string().max(300).optional(),
  /** ISO timestamp of the answer or decision. */
  at: z.string().optional(),
});
export type PreferenceProvenance = z.infer<typeof preferenceProvenanceSchema>;

// ---------------------------------------------------------------------------
// Trade-off and comfort dimensions
// ---------------------------------------------------------------------------

export const BASE_MOVE_TOLERANCES = ['stay_put', 'move_once', 'move_if_it_saves_time', 'move_freely'] as const;
export const baseMoveToleranceSchema = z.enum(BASE_MOVE_TOLERANCES);
export type BaseMoveTolerance = z.infer<typeof baseMoveToleranceSchema>;

export const ICONIC_CROWD_STRATEGIES = ['see_it_anyway', 'go_at_odd_hours', 'quieter_alternative'] as const;
export const iconicCrowdStrategySchema = z.enum(ICONIC_CROWD_STRATEGIES);
export type IconicCrowdStrategy = z.infer<typeof iconicCrowdStrategySchema>;

export const CONVENIENCE_SPENDS = ['save_money', 'balance', 'pay_to_reduce_hassle'] as const;
export const convenienceSpendSchema = z.enum(CONVENIENCE_SPENDS);
export type ConvenienceSpend = z.infer<typeof convenienceSpendSchema>;

export const LODGING_STYLES = [
  'hostel',
  'basic_hotel',
  'boutique_hotel',
  'apartment',
  'resort',
  'luxury_hotel',
  'nature_lodge',
  'no_preference',
] as const;
export const lodgingStyleSchema = z.enum(LODGING_STYLES);
export type LodgingStyle = z.infer<typeof lodgingStyleSchema>;

export const LODGING_STYLE_LABELS: Record<LodgingStyle, string> = {
  hostel: 'Hostel or guesthouse',
  basic_hotel: 'Simple, clean hotel',
  boutique_hotel: 'Small hotel with character',
  apartment: 'Apartment or rental',
  resort: 'Resort',
  luxury_hotel: 'Luxury hotel',
  nature_lodge: 'Lodge or cabin in nature',
  no_preference: 'No preference',
};

/** A three-way tolerance the reconciler can read as soft or hard. */
export const TOLERANCES = ['fine', 'prefer_not', 'cannot'] as const;
export const toleranceSchema = z.enum(TOLERANCES);
export type Tolerance = z.infer<typeof toleranceSchema>;

export const GUIDE_WILLINGNESSES = ['prefer', 'sometimes', 'avoid'] as const;
export const guideWillingnessSchema = z.enum(GUIDE_WILLINGNESSES);
export type GuideWillingness = z.infer<typeof guideWillingnessSchema>;

export const TRANSFER_WILLINGNESSES = ['fine', 'if_needed', 'avoid'] as const;
export const transferWillingnessSchema = z.enum(TRANSFER_WILLINGNESSES);
export type TransferWillingness = z.infer<typeof transferWillingnessSchema>;

export const ALTITUDE_COMFORTS = ['fine', 'take_it_slow', 'avoid_high'] as const;
export const altitudeComfortSchema = z.enum(ALTITUDE_COMFORTS);
export type AltitudeComfort = z.infer<typeof altitudeComfortSchema>;

export const HIKE_APPETITES = ['none', 'short', 'half_day', 'full_day'] as const;
export const hikeAppetiteSchema = z.enum(HIKE_APPETITES);
export type HikeAppetite = z.infer<typeof hikeAppetiteSchema>;

export const HIKE_APPETITE_LABELS: Record<HikeAppetite, string> = {
  none: 'No real hikes',
  short: 'Under two hours, gentle',
  half_day: 'A half-day hike is fine',
  full_day: 'A full-day hike is the point',
};

export const LATE_NIGHT_APPETITES = ['fine', 'sometimes', 'no'] as const;
export const lateNightAppetiteSchema = z.enum(LATE_NIGHT_APPETITES);
export type LateNightAppetite = z.infer<typeof lateNightAppetiteSchema>;

export const COVERAGE_STRATEGIES = ['depth', 'breadth', 'best_subset'] as const;
export const coverageStrategySchema = z.enum(COVERAGE_STRATEGIES);
export type CoverageStrategy = z.infer<typeof coverageStrategySchema>;

export const DAY_TRIP_APPETITES = ['stay_in_city', 'one_day_trip', 'several'] as const;
export const dayTripAppetiteSchema = z.enum(DAY_TRIP_APPETITES);
export type DayTripAppetite = z.infer<typeof dayTripAppetiteSchema>;

export const WALKING_TOLERANCES = ['lots', 'moderate', 'little'] as const;
export const walkingToleranceSchema = z.enum(WALKING_TOLERANCES);
export type WalkingTolerance = z.infer<typeof walkingToleranceSchema>;

/** Minutes on foot across a day each answer stands for. Read by the urban planner as a ceiling. */
export const WALKING_TOLERANCE_MINUTES: Record<WalkingTolerance, number> = {
  lots: 360,
  moderate: 180,
  little: 75,
};

export const BUDGET_ENVELOPE_BASES = ['per_person_per_day', 'per_person_trip', 'group_trip'] as const;
export const budgetEnvelopeBasisSchema = z.enum(BUDGET_ENVELOPE_BASES);
export type BudgetEnvelopeBasis = z.infer<typeof budgetEnvelopeBasisSchema>;

export const budgetEnvelopeSchema = z.object({
  amount: z.number().positive().max(1_000_000),
  currency: z.string().length(3).default('USD'),
  basis: budgetEnvelopeBasisSchema,
});
export type BudgetEnvelope = z.infer<typeof budgetEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Hard constraints
// ---------------------------------------------------------------------------

/**
 * The closed list of things a traveller can make *hard*.
 *
 * Hard means the reconciler and the composition prompt treat it as a filter,
 * not a preference: a `max_daily_drive_minutes` of 180 removes a day that
 * measures 200, and `must_be_back_by` closes every day's window at that hour.
 * Free text is never promoted to one of these by inference — `hardNotes` is
 * the only place prose can be hard, and it is hard because the traveller
 * ticked the box that says so.
 */
export const HARD_CONSTRAINT_CODES = [
  'cannot_drive',
  'max_daily_drive_minutes',
  'max_walking_minutes',
  'no_boats',
  'no_small_aircraft',
  'no_strenuous_hiking',
  'wheelchair_accessible',
  'no_stairs',
  'dietary_absolute',
  'must_be_back_by',
  'no_early_starts',
  'no_late_nights',
  'no_remote_areas',
  'no_high_altitude',
  'no_hotel_changes',
  'must_include',
  'must_avoid',
] as const;
export const hardConstraintCodeSchema = z.enum(HARD_CONSTRAINT_CODES);
export type HardConstraintCode = z.infer<typeof hardConstraintCodeSchema>;

export const HARD_CONSTRAINT_LABELS: Record<HardConstraintCode, string> = {
  cannot_drive: 'Nobody will be driving',
  max_daily_drive_minutes: 'A hard ceiling on daily driving',
  max_walking_minutes: 'A hard ceiling on walking per day',
  no_boats: 'No boats or ferries',
  no_small_aircraft: 'No small aircraft',
  no_strenuous_hiking: 'No strenuous hiking',
  wheelchair_accessible: 'Everything must be wheelchair accessible',
  no_stairs: 'No stairs',
  dietary_absolute: 'Dietary needs are absolute',
  must_be_back_by: 'Back at base by a set time each night',
  no_early_starts: 'No early starts',
  no_late_nights: 'No late nights',
  no_remote_areas: 'Nowhere without phone signal or services',
  no_high_altitude: 'No high altitude',
  no_hotel_changes: 'One base for the whole trip',
  must_include: 'Must include a specific place',
  must_avoid: 'Must avoid a specific place',
};

export const hardConstraintSchema = z.object({
  code: hardConstraintCodeSchema,
  /** Minutes for the ceilings and the back-by time (minutes from midnight); absent elsewhere. */
  value: z.number().int().min(0).max(1440).optional(),
  /** The named place for must include / must avoid, or a note. */
  text: z.string().max(160).optional(),
});
export type HardConstraint = z.infer<typeof hardConstraintSchema>;

// ---------------------------------------------------------------------------
// The interview log: what was asked, decided, skipped, and why
// ---------------------------------------------------------------------------

export const INTERVIEW_MODES = ['fast', 'normal', 'deep'] as const;
export const interviewModeSchema = z.enum(INTERVIEW_MODES);
export type InterviewMode = z.infer<typeof interviewModeSchema>;

export const interviewLogSchema = z.object({
  mode: interviewModeSchema.default('normal'),
  /** Question ids shown, in the order they were shown. */
  asked: z.array(z.string()).default([]),
  /** Question ids the traveller explicitly answered. */
  answered: z.array(z.string()).default([]),
  /** Question ids handed to Sidequest with "decide for me". */
  decided: z.array(z.string()).default([]),
  /** Question ids skipped with "no preference". */
  skipped: z.array(z.string()).default([]),
  /** Why a module or question appeared, keyed by id: the trait or answer that triggered it. */
  branchReasons: z.record(z.string(), z.string()).default({}),
  /** The screening that shaped this interview, for the review screen and the debug analytics. */
  screening: z
    .object({
      traits: z.array(z.string()).default([]),
      basis: z.record(z.string(), z.string()).default({}),
      evidence: z.enum(['screened', 'partial', 'none']).default('none'),
    })
    .optional(),
  /** The id of the question the traveller was on, for resume. */
  position: z.string().optional(),
});
export type InterviewLog = z.infer<typeof interviewLogSchema>;
