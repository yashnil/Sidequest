import { z } from 'zod';
import { freeTimeAppetiteSchema, isoDateSchema, isoTimeSchema } from './common';
import { selectedDestinationSchema } from './destination-index';
import { travelerNeedSchema, tripModeSchema } from './trip';
import { interpretationSetSchema } from './interpretation';
import { mustDoDecisionSchema } from './must-do';

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

/**
 * HOW SETTLED THE TIMING IS — EIGHT REAL ANSWERS, NOT TWO DATES.
 *
 * MVP V3, Stage 5. The five modes here before this could not express the two
 * things travellers say most often: "I'm free between these two dates, pick the
 * best stretch", and "tell me when this place is at its best". Both were forced
 * through a date picker that demanded a decision the traveller had come here to
 * get help with.
 *
 * `best_time` and `window` are the load-bearing additions. Neither requires a
 * date from the traveller; both produce one from evidence (`dates/windows.ts`),
 * recorded on `recommendation` with the reasons and the tradeoffs, so no screen
 * can present Sidequest's arithmetic as the traveller's decision.
 */
export const DATE_MODES = [
  /** Two dates, decided. */
  'exact',
  /** Two dates, but they can move. */
  'flexible',
  /** A month, no dates. */
  'month',
  /** Any of a few named months. */
  'months',
  /** Free between two dates; the best stretch inside them is chosen. */
  'window',
  /** A season, no month. */
  'season',
  /** No constraint at all: Sidequest picks the strongest time to go. */
  'best_time',
  /** Nothing decided yet. */
  'undecided',
] as const;
export const dateModeSchema = z.enum(DATE_MODES);
export type DateMode = z.infer<typeof dateModeSchema>;

export const DATE_MODE_LABELS: Record<DateMode, string> = {
  exact: 'These exact dates',
  flexible: 'Around these dates',
  month: 'Some time in a month',
  months: 'One of a few months',
  window: 'Free between two dates',
  season: 'Some time in a season',
  best_time: 'Tell me when it is best',
  undecided: 'Not decided yet',
};

/** Whether a mode expects the traveller to have supplied two calendar dates. */
export function dateModeNeedsDates(mode: DateMode): boolean {
  return mode === 'exact' || mode === 'flexible';
}

/** Whether Sidequest is expected to choose the timing for this mode. */
export function dateModeAsksSidequest(mode: DateMode): boolean {
  return mode === 'best_time' || mode === 'window' || mode === 'months';
}

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export const seasonSchema = z.enum(SEASONS);
export type Season = z.infer<typeof seasonSchema>;

/** How far either date may move, in days. Only meaningful when mode is `flexible`. */
export const FLEX_DAYS = [1, 3, 7] as const;

/**
 * The timing Sidequest chose, and everything a traveller needs to argue with it.
 *
 * Stored rather than recomputed so a plan built on a recommended window can
 * always say where those dates came from, and so the review screen and the
 * itinerary agree. `reasons` and `tradeoffs` are the recommender's own sentences,
 * each derived from a climate number; `basis` names the evidence class. Nothing
 * here may be presented as something the traveller decided.
 */
export const dateRecommendationSchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  /** "Late May to mid-June" — the part of the month the window sits in. */
  label: z.string().max(80),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  reasons: z.array(z.string().max(200)).max(6).default([]),
  tradeoffs: z.array(z.string().max(200)).max(6).default([]),
  unknowns: z.array(z.string().max(200)).max(6).default([]),
  /** The runner-up, so "show me another window" is an answer rather than a reshuffle. */
  alternative: z
    .object({ startDate: isoDateSchema, endDate: isoDateSchema, label: z.string().max(80), month: z.number().int().min(1).max(12), year: z.number().int().min(2000).max(2100), note: z.string().max(200).optional() })
    .optional(),
  /**
   * Where the window came from.
   *
   * `composed_with_trip` is PRODUCTION LOCK V5 §6: the composition call chose
   * the dates in the same call that designed the route, because the strongest
   * month depends on which trip this is — a high-country traverse and a
   * food-and-neighbourhood trip in the same country do not share one. Recorded
   * distinctly from `climate_normals`, which is the intake screen's own
   * climate-only pick, so a traveller can always tell which question was
   * answered and by what.
   */
  basis: z.enum(['climate_normals', 'traveller_window', 'composed_with_trip']).default('climate_normals'),
  attribution: z.string().max(200).optional(),
  generatedAt: z.string().min(1),
  /** True once the question is closed — the traveller pressed "Use this timing", or the composition chose the window. `decidedBy` says which. */
  accepted: z.boolean().default(false),
  /**
   * V6 — who closed the question. `traveller` is a press; `sidequest` is
   * the composition's own choice (`basis: composed_with_trip`). Absent on a
   * record written before V6, which reads as `traveller` when `accepted` is
   * true because that was the only way the flag could be set then.
   */
  decidedBy: z.enum(['traveller', 'sidequest']).optional(),
});
export type DateRecommendationRecord = z.infer<typeof dateRecommendationSchema>;

export const dateIntentSchema = z.object({
  mode: dateModeSchema,
  startDate: isoDateSchema.optional(),
  endDate: isoDateSchema.optional(),
  flexDays: z.number().int().min(0).max(14).optional(),
  /** 1–12. Set for `month`. */
  month: z.number().int().min(1).max(12).optional(),
  /** 1–12, a handful. Set for `months`. */
  months: z.array(z.number().int().min(1).max(12)).max(12).optional(),
  /** The outer bounds a `window` traveller is free between. */
  earliest: isoDateSchema.optional(),
  latest: isoDateSchema.optional(),
  season: seasonSchema.optional(),
  /** The calendar year the month or season refers to. */
  year: z.number().int().min(2000).max(2100).optional(),
  /** What Sidequest proposed, when it was asked to choose. */
  recommendation: dateRecommendationSchema.optional(),
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
  /**
   * When the traveller pressed "Explore experiences first".
   *
   * Research (compilation) is optional and secondary: the plan page runs its
   * research steps only for a trip that asked for them, and otherwise hands
   * a resolved destination straight to the interview. Stored on the composer
   * record because it is a thing a person decided, and it survives refreshes.
   */
  researchRequestedAt: z.string().optional(),
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
  freeTime: freeTimeAppetiteSchema.optional(),

  /**
   * Free text, classified into controlled fields only with confirmation.
   *
   * Stored verbatim as well as classified, because a classification the
   * traveller did not accept must never quietly become the record of what they
   * said — and because a model reading this text is reading untrusted input.
   */
  mustDo: z.string().max(600).optional(),
  avoid: z.string().max(600).optional(),
  /**
   * V1 — "I already have a plan": the plan as the traveller wrote it, one day
   * per line. Stored verbatim; its places are read as their own must-dos and
   * the plan is checked against the board (`planning/plan-critique.ts`).
   */
  existingPlan: z.string().max(2000).optional(),

  /**
   * What we made of that text, and whether they accepted it.
   *
   * Added at `schemaVersion: 1` as an optional field, deliberately, rather than
   * bumping the literal. `getIntent` parses this object *leniently* — a shape it
   * cannot read becomes `null` and the trip reads as pre-composer — so a version
   * bump would silently discard every stored composer answer in the database.
   * An optional field costs nothing and an absent one reads correctly as
   * "nobody has interpreted this yet".
   */
  interpretation: interpretationSetSchema.optional(),

  /**
   * What the traveller decided about a named must-do we could not settle.
   *
   * Here rather than in a table of its own, for one reason that matters more
   * than tidiness: this column is the trip's record of *what a person said*, it
   * is already parsed leniently, and a decision that outlives a recompilation
   * has to be stored beside the text that produced the request. Defaulted and
   * additive at `schemaVersion: 1`, exactly as `interpretation` was — a stored
   * composer written before this existed parses to an empty list, which reads
   * correctly as "nobody has decided anything".
   */
  mustDoDecisions: z.array(mustDoDecisionSchema).max(24).default([]),

  /**
   * V11 §3 — WHAT "WHERE SHOULD I GO?" NEEDS AND A KNOWN DESTINATION DOES NOT.
   *
   * Added here rather than in a record of their own, and additively at the same
   * `schemaVersion`, exactly as `interpretation` and `mustDoDecisions` were. The
   * reason is the product requirement: a traveller who accepts a recommendation
   * must not re-enter anything, so the recommender has to write into the same
   * record trip setup reads. A stored composer written before this existed
   * parses with every field absent, which reads correctly as "nobody asked".
   *
   * Every one of these changes the ranking. Nothing is collected for its own
   * sake: which question is worth asking next is decided by
   * `shortlistSeparation`, which reports the dimensions no candidate could be
   * measured on because the traveller has not said — heaviest weight first — so
   * the intake asks for the answer that would actually break the tie.
   */
  /** How far the traveller will fly to get there. */
  flightTolerance: z.enum(['short', 'moderate', 'long', 'any']).optional(),
  /** Warm, mild or cold — a preference about the destination, not a forecast. */
  climatePreference: z.enum(['warm', 'mild', 'cold', 'any']).optional(),
  /** How comfortable the beds have to be. Separate from budget: money and fussiness are different. */
  lodgingComfort: z.enum(['simple', 'comfortable', 'refined']).optional(),
  /** Whether crossing a border is wanted, tolerated or ruled out. */
  tripScope: z.enum(['domestic', 'international', 'either']).optional(),
  /** How far from the familiar the traveller wants to be taken. */
  surpriseAppetite: z.enum(['familiar', 'open', 'surprise_me']).optional(),
  /** Places already visited, as the traveller named them. Lowers similarity, never excludes. */
  /* `.optional()` rather than `.default([])`: a default makes the field REQUIRED on the output type, so every existing literal that builds a composer record would stop compiling — which is not what "additive" means. Read as `?? []`. */
  visited: z.array(z.string().min(1).max(120)).max(40).optional(),
  /** Budget per person, and whether the figure is meant to include getting there. */
  budgetPerPerson: z.number().int().min(0).max(1_000_000).optional(),
  budgetIncludesFlights: z.boolean().optional(),
  /** The country the traveller is departing from, ISO 3166-1 alpha-2, when known. Decides what "domestic" means. */
  originCountry: z.string().length(2).optional(),

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
    mustDoDecisions: [],
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
