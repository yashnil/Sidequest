import { z } from 'zod';
import { isoDateSchema, isoTimeSchema } from './common';
import { selectedDestinationSchema } from './destination-index';
import { travelerNeedSchema, tripModeSchema } from './trip';

/**
 * WHAT THE TRAVELLER HAS TOLD US, BEFORE ANYTHING EXPENSIVE HAPPENS.
 *
 * The composer exists because of a specific defect: the questionnaire ran
 * *after* the region was compiled, so the compiler spent minutes and model
 * budget without knowing pace, transport, interests or budget — the four things
 * that decide what is worth researching at all. Everything in this file is
 * therefore captured **before** the first paid call.
 *
 * Three properties hold throughout:
 *
 * - **Every field is optional except the ones that name a trip.** A composer
 *   that refused to save until it was complete would lose work on every refresh,
 *   and the flow is explicitly progressive.
 * - **"Not answered" and "answered as no" are different values.** `undefined`
 *   means nobody has said; `false`, `'none'` and `'no'` mean somebody has. The
 *   scope layer already depends on this distinction for `carAvailable`, and
 *   collapsing it is how a plan claims a traveller refused something they were
 *   never asked.
 * - **Nothing here is a claim about the world.** These are preferences. Not one
 *   of them may be rendered as a fact about a destination.
 */

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const DATE_MODES = [
  /** Two dates, decided. */
  'exact',
  /** Two dates, but they can move. */
  'flexible',
  /** A month, no dates. */
  'month',
  /** A season, no month. */
  'season',
  /** Nothing decided yet. */
  'undecided',
] as const;
export const dateModeSchema = z.enum(DATE_MODES);
export type DateMode = z.infer<typeof dateModeSchema>;

export const DATE_MODE_LABELS: Record<DateMode, string> = {
  exact: 'These exact dates',
  flexible: 'Around these dates',
  month: 'Some time in a month',
  season: 'Some time in a season',
  undecided: 'Not decided yet',
};

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export const seasonSchema = z.enum(SEASONS);
export type Season = z.infer<typeof seasonSchema>;

/** How far either date may move, in days. Only meaningful when mode is `flexible`. */
export const FLEX_DAYS = [1, 3, 7] as const;

export const dateIntentSchema = z.object({
  mode: dateModeSchema,
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  flexDays: z.number().int().min(0).max(14).optional(),
  /** 1–12. Set for `month`. */
  month: z.number().int().min(1).max(12).optional(),
  season: seasonSchema.optional(),
  /** The calendar year the month or season refers to. */
  year: z.number().int().min(2000).max(2100).optional(),
  /**
   * Whether the traveller has asked us to propose dates.
   *
   * Its own flag rather than a sixth mode: somebody can want a recommendation
   * *and* already have a month in mind, and modelling that as a mode would force
   * them to throw the month away to ask the question.
   */
  wantsRecommendation: z.boolean().default(false),
});
export type DateIntent = z.infer<typeof dateIntentSchema>;

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

export const DURATION_MODES = ['fixed', 'range', 'unknown'] as const;
export const durationModeSchema = z.enum(DURATION_MODES);
export type DurationMode = z.infer<typeof durationModeSchema>;

export const durationIntentSchema = z.object({
  mode: durationModeSchema,
  nights: z.number().int().min(1).max(30).optional(),
  minNights: z.number().int().min(1).max(30).optional(),
  maxNights: z.number().int().min(1).max(30).optional(),
  wantsRecommendation: z.boolean().default(false),
});
export type DurationIntent = z.infer<typeof durationIntentSchema>;

// ---------------------------------------------------------------------------
// Arrival and departure
// ---------------------------------------------------------------------------

/**
 * When somebody gets in, at the precision they actually know it.
 *
 * The form this replaces demanded `<input type="time">` and pre-filled `15:00`,
 * which is a fabricated fact that then decided how full day one was. A traveller
 * who has not booked a flight has to be able to say so.
 */
export const ARRIVAL_PRECISIONS = ['exact', 'morning', 'afternoon', 'evening', 'unknown', 'not_booked'] as const;
export const arrivalPrecisionSchema = z.enum(ARRIVAL_PRECISIONS);
export type ArrivalPrecision = z.infer<typeof arrivalPrecisionSchema>;

export const ARRIVAL_PRECISION_LABELS: Record<ArrivalPrecision, string> = {
  exact: 'I know the time',
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening or later',
  unknown: 'No idea yet',
  not_booked: 'Not booked yet',
};

/**
 * The planning window each precision implies, as local minutes from midnight.
 *
 * Conservative on both ends: an "afternoon" arrival is planned as if it were the
 * late end of afternoon, because a day built for 12:00 that starts at 17:00 is
 * a day that does not happen, while the reverse is merely a quiet first evening.
 */
export const ARRIVAL_PLANNING_MINUTES: Record<ArrivalPrecision, number | null> = {
  exact: null,
  morning: 11 * 60,
  afternoon: 16 * 60,
  evening: 20 * 60,
  unknown: null,
  not_booked: null,
};

export const DEPARTURE_PLANNING_MINUTES: Record<ArrivalPrecision, number | null> = {
  exact: null,
  morning: 9 * 60,
  afternoon: 13 * 60,
  evening: 18 * 60,
  unknown: null,
  not_booked: null,
};

export const edgeTimeSchema = z.object({
  precision: arrivalPrecisionSchema,
  time: isoTimeSchema.optional(),
});
export type EdgeTime = z.infer<typeof edgeTimeSchema>;

// ---------------------------------------------------------------------------
// Shape of the trip
// ---------------------------------------------------------------------------

export const TRIP_SHAPES = ['one_base', 'two_bases', 'circuit', 'undecided'] as const;
export const tripShapeSchema = z.enum(TRIP_SHAPES);
export type TripShape = z.infer<typeof tripShapeSchema>;

export const TRIP_SHAPE_LABELS: Record<TripShape, string> = {
  one_base: 'Stay in one place',
  two_bases: 'Two bases, split the trip',
  circuit: 'A route, moving on',
  undecided: 'Whatever suits the region',
};

export const TRANSPORT_INTENTS = ['drive', 'public_transport', 'mixed', 'undecided'] as const;
export const transportIntentSchema = z.enum(TRANSPORT_INTENTS);
export type TransportIntent = z.infer<typeof transportIntentSchema>;

export const TRANSPORT_INTENT_LABELS: Record<TransportIntent, string> = {
  drive: 'Drive',
  public_transport: 'Trains, buses and transfers',
  mixed: 'A bit of both',
  undecided: 'Not decided',
};

export const BUDGET_BANDS = ['budget', 'mid_range', 'premium', 'luxury', 'unstated'] as const;
export const budgetBandSchema = z.enum(BUDGET_BANDS);
export type BudgetBand = z.infer<typeof budgetBandSchema>;

export const BUDGET_BAND_LABELS: Record<BudgetBand, string> = {
  budget: 'Keep it cheap',
  mid_range: 'Mid-range',
  premium: 'Comfortable',
  luxury: 'No ceiling',
  unstated: 'Would rather not say',
};

/**
 * Coarse themes, deliberately not the full interest vocabulary.
 *
 * The composer asks about eight themes; the questionnaire asks about thirty
 * interests at four frequencies. Asking the long version twice would spend the
 * budget the product exists to save, so these seed the questionnaire rather than
 * duplicating it.
 */
export const TRIP_THEMES = [
  'outdoors',
  'mountains',
  'water',
  'wildlife',
  'food',
  'culture',
  'cities',
  'quiet',
] as const;
export const tripThemeSchema = z.enum(TRIP_THEMES);
export type TripTheme = z.infer<typeof tripThemeSchema>;

export const TRIP_THEME_LABELS: Record<TripTheme, string> = {
  outdoors: 'Hiking and being outside',
  mountains: 'Mountains and high country',
  water: 'Lakes, coast and swimming',
  wildlife: 'Wildlife',
  food: 'Eating well',
  culture: 'History, museums and architecture',
  cities: 'City life',
  quiet: 'Quiet places with nobody in them',
};

export const TRIP_COMPOSER_VERSION = 1 as const;

export const tripComposerAnswersSchema = z.object({
  schemaVersion: z.literal(TRIP_COMPOSER_VERSION),
  mode: tripModeSchema,

  /** Set when the traveller picked a row from the index. */
  destination: selectedDestinationSchema.optional(),
  /** Set when they typed something the index did not have. */
  destinationQuery: z.string().max(200).optional(),

  dates: dateIntentSchema,
  duration: durationIntentSchema,
  arrival: edgeTimeSchema.optional(),
  departure: edgeTimeSchema.optional(),
  /** Where they are travelling from. Free text; used for reach, never for flights. */
  origin: z.string().max(120).optional(),

  adults: z.number().int().min(1).max(12).default(2),
  children: z.number().int().min(0).max(12).default(0),
  travelerNeeds: z.array(travelerNeedSchema).default([]),

  shape: tripShapeSchema.optional(),
  /**
   * The preflight strategy the traveller accepted.
   *
   * Its own field rather than inferring acceptance from `shape`, because a
   * region with only one cluster offers no strategies at all — and inferring
   * from `shape` left that traveller on the preflight screen forever, with a
   * button that saved nothing. `'none'` means "we had nothing to offer and they
   * moved on", which is a decision, not an absence.
   */
  scopeStrategy: z.string().max(40).optional(),
  pace: z.enum(['slow', 'balanced', 'packed']).optional(),
  transport: transportIntentSchema.optional(),
  /** Minutes at the wheel a single day may hold. Absent means nobody has said. */
  maxDailyDriveMinutes: z.number().int().min(0).max(480).optional(),
  budget: budgetBandSchema.optional(),
  themes: z.array(tripThemeSchema).default([]),
  outdoorIntensity: z.enum(['gentle', 'moderate', 'strenuous']).optional(),
  crowdTolerance: z.enum(['avoid', 'tolerate', 'unbothered']).optional(),
  foodImportance: z.enum(['fuel', 'matters', 'central']).optional(),
  nightlife: z.enum(['none', 'some', 'important']).optional(),
  freeTime: z.enum(['packed', 'balanced', 'lots']).optional(),

  /**
   * Free text, classified into controlled fields only with confirmation.
   *
   * Stored verbatim as well as classified, because a classification the
   * traveller did not accept must never quietly become the record of what they
   * said — and because a model reading this text is reading untrusted input.
   */
  mustDo: z.string().max(600).optional(),
  avoid: z.string().max(600).optional(),

  /** Which questions have been shown and dismissed, so they are not re-asked. */
  skipped: z.array(z.string().min(1)).default([]),
  updatedAt: z.string().min(1),
});
export type TripComposerAnswers = z.infer<typeof tripComposerAnswersSchema>;

export function emptyComposerAnswers(mode: z.infer<typeof tripModeSchema>, now: Date): TripComposerAnswers {
  return {
    schemaVersion: TRIP_COMPOSER_VERSION,
    mode,
    dates: { mode: 'exact', wantsRecommendation: false },
    duration: { mode: 'unknown', wantsRecommendation: false },
    adults: 2,
    children: 0,
    travelerNeeds: [],
    themes: [],
    skipped: [],
    updatedAt: now.toISOString(),
  };
}

/**
 * The nights this intent implies, when it implies any.
 *
 * Returns null rather than a guess for every mode that has not settled on two
 * dates. A duration invented here would flow into scope, into the radius, into
 * the base count and into the recommendation — which is precisely the chain of
 * fabricated precision this phase exists to remove.
 */
export function nightsFrom(answers: TripComposerAnswers): number | null {
  if (answers.duration.mode === 'fixed' && answers.duration.nights) return answers.duration.nights;
  const { startDate, endDate } = answers.dates;
  if (startDate && endDate) {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) {
      return Math.round((end - start) / 86_400_000);
    }
  }
  if (answers.duration.mode === 'range' && answers.duration.minNights && answers.duration.maxNights) {
    return Math.round((answers.duration.minNights + answers.duration.maxNights) / 2);
  }
  return null;
}

/** Whether the composer holds enough to build a trip row. */
export function composerIsPlannable(answers: TripComposerAnswers): boolean {
  const hasDestination = Boolean(answers.destination ?? answers.destinationQuery);
  return hasDestination && nightsFrom(answers) !== null && Boolean(answers.dates.startDate);
}
