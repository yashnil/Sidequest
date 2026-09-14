import { z } from 'zod';
import {
  DATE_MODES,
  TRAVELER_NEEDS,
  TRIP_COMPOSER_VERSION,
  emptyComposerAnswers,
  type TripComposerAnswers,
} from '@sidequest/core';

/**
 * THE SHAPE "HELP ME CHOOSE" COLLECTS, AND HOW IT BECOMES A TRIP.
 *
 * Lifted out of the server action for one reason: the intake screen has to read
 * the same conversion the server writes. The intake ladder
 * (`@sidequest/core` → `recommend/intake`) decides what to ask next from a
 * `TripComposerAnswers`, so the browser needs to build one from the answers in
 * hand — and a second, client-side copy of that conversion is how two forms
 * start disagreeing about what was asked.
 *
 * A plain module, deliberately: a `'use server'` file may export only async
 * functions, so a schema living there could never be shared with the screen.
 */

const answersSchema = z.object({
  /*
   * The full timing vocabulary (`DATE_MODES`), even though the decide composer
   * only offers four of them. One enum across the product means a session saved
   * from one surface can always be read by another; a narrower copy here is how
   * a shared type quietly becomes two.
   */
  dateMode: z.enum(DATE_MODES),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  month: z.number().int().min(1).max(12).optional(),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']).optional(),
  nights: z.number().int().min(1).max(30).nullable(),
  minNights: z.number().int().min(1).max(30).nullable().optional(),
  maxNights: z.number().int().min(1).max(30).nullable().optional(),
  shape: z.enum(['one_base', 'two_bases', 'circuit', 'undecided']).nullable(),
  transport: z.enum(['drive', 'public_transport', 'mixed', 'undecided']).nullable(),
  pace: z.enum(['slow', 'balanced', 'packed']).nullable(),
  themes: z.array(z.string().min(1)).max(12),
  outdoorIntensity: z.enum(['gentle', 'moderate', 'strenuous']).nullable(),
  budget: z.enum(['budget', 'mid_range', 'premium', 'luxury', 'unstated']).nullable(),
  adults: z.number().int().min(1).max(12),
  children: z.number().int().min(0).max(12),
  avoid: z.string().max(600),

  /*
   * V11 §A1 — the intake ladder's own answers.
   *
   * Every one is optional, because the intake stops the moment the ranking has
   * enough signal and a traveller who stopped early must not be rejected by a
   * schema that expected the whole ladder. They are carried onto the composer
   * record unchanged — `TripComposerAnswers` has held these fields since V11 §3
   * precisely so that a chosen recommendation needs no mapping layer.
   */
  origin: z.string().max(120).optional(),
  originCountry: z.string().length(2).optional(),
  flightTolerance: z.enum(['short', 'moderate', 'long', 'any']).optional(),
  climatePreference: z.enum(['warm', 'mild', 'cold', 'any']).optional(),
  lodgingComfort: z.enum(['simple', 'comfortable', 'refined']).optional(),
  tripScope: z.enum(['domestic', 'international', 'either']).optional(),
  surpriseAppetite: z.enum(['familiar', 'open', 'surprise_me']).optional(),
  crowdTolerance: z.enum(['avoid', 'tolerate', 'unbothered']).optional(),
  visited: z.array(z.string().min(1).max(120)).max(40).optional(),
  budgetPerPerson: z.number().int().min(0).max(1_000_000).optional(),
  budgetIncludesFlights: z.boolean().optional(),
  travelerNeeds: z.array(z.string().min(1)).max(12).optional(),
  /** Questions the traveller passed over, so the ladder does not re-ask them. */
  skipped: z.array(z.string().min(1).max(40)).max(40).optional(),
});

export type DecisionAnswersInput = z.infer<typeof answersSchema>;

function toComposerAnswers(input: DecisionAnswersInput, now: Date): TripComposerAnswers {
  const base = emptyComposerAnswers('help_me_decide', now);
  /*
   * Themes are validated against the enum here rather than in the input schema,
   * so a value the browser invented is dropped rather than rejecting the whole
   * submission — losing one checkbox is better than losing four screens of
   * answers to a client that sent one bad string.
   */
  const themes = input.themes.filter((theme): theme is TripComposerAnswers['themes'][number] =>
    THEME_VALUES.has(theme),
  );
  return {
    ...base,
    schemaVersion: TRIP_COMPOSER_VERSION,
    dates: {
      mode: input.dateMode,
      ...(input.startDate ? { startDate: input.startDate } : {}),
      ...(input.endDate ? { endDate: input.endDate } : {}),
      ...(input.month ? { month: input.month } : {}),
      ...(input.season ? { season: input.season } : {}),
      year: now.getUTCFullYear(),
      wantsRecommendation: false,
    },
    duration:
      input.nights !== null
        ? { mode: 'fixed', nights: input.nights, wantsRecommendation: false }
        : input.minNights && input.maxNights
          ? {
              mode: 'range',
              minNights: input.minNights,
              maxNights: input.maxNights,
              wantsRecommendation: false,
            }
          : { mode: 'unknown', wantsRecommendation: true },
    adults: input.adults,
    children: input.children,
    ...(input.shape ? { shape: input.shape } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.pace ? { pace: input.pace } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.outdoorIntensity ? { outdoorIntensity: input.outdoorIntensity } : {}),
    themes,
    ...(input.avoid.trim() ? { avoid: input.avoid.trim() } : {}),

    /*
     * Passed through rather than translated. The composer record is the one
     * place trip setup reads from, so a recommendation the traveller accepts
     * arrives with everything they said already in the shape the trip wants —
     * which is the whole of §A5 and the reason these fields live on
     * `TripComposerAnswers` rather than in a decision-only record.
     */
    ...(input.origin?.trim() ? { origin: input.origin.trim() } : {}),
    ...(input.originCountry ? { originCountry: input.originCountry.toUpperCase() } : {}),
    ...(input.flightTolerance ? { flightTolerance: input.flightTolerance } : {}),
    ...(input.climatePreference ? { climatePreference: input.climatePreference } : {}),
    ...(input.lodgingComfort ? { lodgingComfort: input.lodgingComfort } : {}),
    ...(input.tripScope ? { tripScope: input.tripScope } : {}),
    ...(input.surpriseAppetite ? { surpriseAppetite: input.surpriseAppetite } : {}),
    ...(input.crowdTolerance ? { crowdTolerance: input.crowdTolerance } : {}),
    ...(input.visited?.length ? { visited: input.visited } : {}),
    ...(typeof input.budgetPerPerson === 'number' ? { budgetPerPerson: input.budgetPerPerson } : {}),
    ...(input.budgetIncludesFlights === undefined ? {} : { budgetIncludesFlights: input.budgetIncludesFlights }),
    travelerNeeds: (input.travelerNeeds ?? []).filter((need): need is TripComposerAnswers['travelerNeeds'][number] =>
      TRAVELER_NEED_VALUES.has(need),
    ),
    skipped: input.skipped ?? [],
    updatedAt: now.toISOString(),
  };
}

/* Same defence as `THEME_VALUES`: one bad string from a client loses one answer, never the screen. */
const TRAVELER_NEED_VALUES = new Set<string>(TRAVELER_NEEDS);

const THEME_VALUES = new Set([
  'outdoors',
  'mountains',
  'water',
  'wildlife',
  'food',
  'culture',
  'cities',
  'quiet',
]);

export { answersSchema as decisionAnswersSchema, toComposerAnswers as decisionAnswersToComposer };

/** A blank intake. The ladder reads the composer form of this and asks for "when". */
export function emptyDecisionAnswers(): DecisionAnswersInput {
  return {
    dateMode: 'month',
    nights: null,
    shape: null,
    transport: null,
    pace: null,
    themes: [],
    outdoorIntensity: null,
    budget: null,
    adults: 2,
    children: 0,
    avoid: '',
  };
}
