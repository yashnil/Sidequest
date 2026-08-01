import { z } from 'zod';
import {
  avoidanceSchema,
  budgetStyleSchema,
  crowdToleranceSchema,
  interestLevelSchema,
  interestSchema,
  isoDateSchema,
  paceSchema,
} from './common';

/**
 * What the traveller is actually asking for, before anything has been resolved.
 *
 * Two shapes, because the product genuinely has two front doors and they need
 * different information. Someone who types "Bali" has given us a string to
 * interpret; someone who says "somewhere warm in March that is not heaving" has
 * given us constraints and no string at all. Modelling both as "a destination
 * field that might be empty" is how the second one ends up as a worse version of
 * the first.
 *
 * The mode names are the ones `TRIP_MODES` in `schemas/trip.ts` already uses.
 * There is one vocabulary for this in the product and this is it.
 */

/** How free the traveller's dates are. Decides whether we can use a forecast. */
export const DATE_FLEXIBILITIES = ['fixed', 'shiftable_by_a_week', 'season_only'] as const;
export const dateFlexibilitySchema = z.enum(DATE_FLEXIBILITIES);
export type DateFlexibility = z.infer<typeof dateFlexibilitySchema>;

/**
 * What the traveller wants the weather to be like.
 *
 * Deliberately coarse. A traveller can say "warm" honestly; nobody can say
 * "22-26 °C daytime highs" honestly, and offering that control would imply the
 * system can deliver against it.
 */
export const CLIMATE_PREFERENCES = ['warm', 'mild', 'cool', 'cold_and_snowy', 'no_preference'] as const;
export const climatePreferenceSchema = z.enum(CLIMATE_PREFERENCES);
export type ClimatePreference = z.infer<typeof climatePreferenceSchema>;

export const CLIMATE_PREFERENCE_LABELS: Record<ClimatePreference, string> = {
  warm: 'Warm',
  mild: 'Mild',
  cool: 'Cool',
  cold_and_snowy: 'Cold and snowy',
  no_preference: 'No strong preference',
};

/**
 * What the traveller is willing to get around on.
 *
 * A willingness, not a capability of the destination — the two meet later, in
 * scope confirmation, and a mismatch between them is one of the few things worth
 * interrupting a traveller to ask about.
 */
export const TRANSPORT_WILLINGNESS = [
  'will_drive',
  'public_transport_only',
  'either',
  'guided_or_transfers',
] as const;
export const transportWillingnessSchema = z.enum(TRANSPORT_WILLINGNESS);
export type TransportWillingness = z.infer<typeof transportWillingnessSchema>;

export const TRANSPORT_WILLINGNESS_LABELS: Record<TransportWillingness, string> = {
  will_drive: 'Happy to drive',
  public_transport_only: 'Public transport only',
  either: 'Either is fine',
  guided_or_transfers: 'Prefer transfers or guides',
};

/** Where the traveller is starting from, when they have said. */
export const originSchema = z.object({
  /** Free text as typed: "San Francisco", "SFO", "London". */
  label: z.string().trim().min(1).max(120),
  /** Resolved later, if at all. Absent is a normal state, not an error. */
  countryCode: z.string().length(2).optional(),
});
export type Origin = z.infer<typeof originSchema>;

export const destinationDiscoveryPreferencesSchema = z
  .object({
    dateFlexibility: dateFlexibilitySchema,
    /** Present when the traveller has dates. Absent when they only have a season. */
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    /** Months (1-12) the trip could fall in. Always populated, dates or not. */
    candidateMonths: z.array(z.number().int().min(1).max(12)).min(1).max(12),
    nights: z.number().int().min(1).max(30),
    origin: originSchema.optional(),
    budgetStyle: budgetStyleSchema,
    climatePreference: climatePreferenceSchema,
    avoidExtremeHeat: z.boolean(),
    avoidExtremeCold: z.boolean(),
    crowdTolerance: crowdToleranceSchema,
    transportWillingness: transportWillingnessSchema,
    interests: z.record(interestSchema, interestLevelSchema),
    pace: paceSchema,
    /** How many times they are willing to change hotel. Zero means one base. */
    maxBaseChanges: z.number().int().min(0).max(10),
    avoidances: z.array(avoidanceSchema).default([]),
    /** Free-form steer. Interpreted, never trusted as fact. */
    notes: z.string().trim().max(500).optional(),
  })
  .refine(
    (value) =>
      value.dateFlexibility === 'season_only' ||
      (value.startDate !== undefined && value.endDate !== undefined),
    { message: 'Dates are required unless you are only picking a season', path: ['startDate'] },
  )
  .refine(
    (value) => !value.startDate || !value.endDate || value.endDate >= value.startDate,
    { message: 'The end date has to be on or after the start date', path: ['endDate'] },
  );
export type DestinationDiscoveryPreferences = z.infer<typeof destinationDiscoveryPreferencesSchema>;

export const tripIntentSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('known_destination'),
    /**
     * Exactly what the traveller typed, trimmed and length-bounded and otherwise
     * untouched. Everything downstream treats this as hostile input: it is
     * rendered as text, never as markup, and it is passed to a model as data
     * inside an explicit "this is untrusted" frame.
     */
    destinationQuery: z.string().trim().min(2).max(200),
  }),
  z.object({
    mode: z.literal('help_me_decide'),
    preferences: destinationDiscoveryPreferencesSchema,
  }),
]);
export type TripIntent = z.infer<typeof tripIntentSchema>;
