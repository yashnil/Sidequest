import { z } from 'zod';
import { coordinatesSchema, httpUrlSchema } from './common';

/**
 * CLIMATE, WHICH IS NOT WEATHER, AND MUST NEVER BE RENDERED AS IF IT WERE.
 *
 * The product needs to answer "when should I go to Kyrgyzstan?" for a trip nine
 * months away. No forecast reaches nine months. What does reach nine months is
 * the record of what that place has actually done in that month for the last
 * couple of decades — and the entire risk of this file is that somebody renders
 * one as the other.
 *
 * So the vocabulary is kept deliberately separate from `schemas/weather.ts`:
 *
 * | Concept | Lives in | Answers |
 * | --- | --- | --- |
 * | forecast | `weather.ts` | what will happen on the 14th |
 * | historical pattern | `weather.ts` | what this week has done, for these dates |
 * | **climate normal** | here | what this *month* does, for choosing dates |
 *
 * A `ClimateNormal` has no date on it and cannot acquire one: `month` is a
 * number from one to twelve, and there is no field a calendar date could go in.
 * That is the structural guarantee. `CLIMATE_EVIDENCE_NOTE` is the sentence that
 * has to travel with it wherever it is shown.
 */

export const CLIMATE_EVIDENCE_NOTE =
  'Typical conditions for this month from past years, not a forecast for your dates.';

export const CLIMATE_DATASET_VERSION = 1 as const;

/**
 * A range, with the sample it came from.
 *
 * The mean is not enough and the extremes are misleading, so what is carried is
 * the typical daily low and high plus the count of years behind them. A range
 * with no sample size is a number somebody made up.
 */
export const climateRangeSchema = z.object({
  low: z.number(),
  high: z.number(),
});
export type ClimateRange = z.infer<typeof climateRangeSchema>;

export const climateNormalSchema = z.object({
  /** 1–12. There is deliberately no field a date could be written into. */
  month: z.number().int().min(1).max(12),
  /** Typical daily low and high, °C. */
  temperature: climateRangeSchema,
  /** Millimetres across the whole month. */
  precipitationMm: z.number().min(0),
  /** Days in the month with measurable precipitation. */
  wetDays: z.number().min(0).max(31),
  /** Days in the month with measurable snowfall. Zero is meaningful. */
  snowDays: z.number().min(0).max(31),
  /** Mean daylight hours on the fifteenth, computed locally, never fetched. */
  daylightHours: z.number().min(0).max(24),
  /** Days above 32 °C. The heat-avoidance signal. */
  hotDays: z.number().min(0).max(31),
  /** Days whose minimum fell below 0 °C. */
  freezeDays: z.number().min(0).max(31),
});
export type ClimateNormal = z.infer<typeof climateNormalSchema>;

export const climateProfileSchema = z.object({
  schemaVersion: z.literal(CLIMATE_DATASET_VERSION),
  /** The point these normals describe. Never a region — a region has several. */
  coordinates: coordinatesSchema,
  /** Which years the normals were computed from, inclusive. */
  sampleYearFrom: z.number().int().min(1940).max(2100),
  sampleYearTo: z.number().int().min(1940).max(2100),
  /** Exactly twelve, in month order. A partial profile is not a profile. */
  months: z.array(climateNormalSchema).length(12),
  provider: z.string().min(1),
  dataset: z.string().min(1),
  attribution: z.string().min(1),
  attributionUrl: httpUrlSchema.optional(),
  retrievedAt: z.string().min(1),
});
export type ClimateProfile = z.infer<typeof climateProfileSchema>;

export const CLIMATE_UNAVAILABLE_REASONS = [
  'provider_unavailable',
  'provider_rate_limited',
  'no_data_for_location',
  'response_malformed',
  'not_configured',
] as const;
export const climateUnavailableReasonSchema = z.enum(CLIMATE_UNAVAILABLE_REASONS);
export type ClimateUnavailableReason = z.infer<typeof climateUnavailableReasonSchema>;

export const CLIMATE_UNAVAILABLE_COPY: Record<ClimateUnavailableReason, string> = {
  provider_unavailable: 'Our climate source did not answer, so we have nothing to say about timing.',
  provider_rate_limited: 'Our climate source asked us to slow down.',
  no_data_for_location: 'There are no climate records for this location.',
  response_malformed: 'The climate data came back in a shape we could not read.',
  not_configured: 'This build has no climate source configured.',
};

export type ClimateResult =
  | { kind: 'profile'; profile: ClimateProfile }
  | { kind: 'unavailable'; reason: ClimateUnavailableReason };

export function monthNormal(profile: ClimateProfile, month: number): ClimateNormal | undefined {
  return profile.months.find((entry) => entry.month === month);
}

/**
 * Which months a season covers, for the hemisphere the coordinates sit in.
 *
 * Latitude-aware rather than northern-by-default, because "spring" in Patagonia
 * is September and a product that assumed otherwise would recommend the wrong
 * half of the year to half the planet. Within the tropics the four-season model
 * does not describe anything, and the honest answer is all twelve months —
 * the recommender then ranks on conditions rather than on a label.
 */
export function seasonMonths(season: string, latitude: number): number[] {
  if (Math.abs(latitude) < 15) return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const northern: Record<string, number[]> = {
    spring: [3, 4, 5],
    summer: [6, 7, 8],
    autumn: [9, 10, 11],
    winter: [12, 1, 2],
  };
  const months = northern[season];
  if (!months) return [];
  if (latitude >= 0) return months;
  return months.map((month) => ((month + 5) % 12) + 1);
}
