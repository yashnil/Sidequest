'use server';

import { z } from 'zod';
import {
  ARRIVAL_PLANNING_MINUTES,
  ARRIVAL_PRECISIONS,
  BUDGET_BANDS,
  DATE_MODES,
  DEPARTURE_PLANNING_MINUTES,
  TRANSPORT_INTENTS,
  TRAVELER_NEEDS,
  TRIP_COMPOSER_VERSION,
  TRIP_SHAPES,
  TRIP_THEMES,
  qualifiedNameFor,
  tripBasicsSchema,
  type SelectedDestination,
  type TripComposerAnswers,
} from '@sidequest/core';
import { resolveRegion } from '@sidequest/core/data';
import { createTrip } from '@/lib/db/repository';
import {
  saveComposerAnswers,
  saveDestinationQuery,
  saveSelectedDestination,
} from '@/lib/db/compiler-repository';
import { destinationEntryById } from '@/lib/db/destination-index-repository';
import { DYNAMIC_REGION_ID } from '@/lib/region';

/**
 * TURNING A COMPOSER INTO A TRIP.
 *
 * Three things happen here and the order matters:
 *
 * 1. **The composer answers are validated and stored whole.** They are the
 *    durable record of what the traveller said, and every later screen reads
 *    them rather than re-deriving from the trip row — which only holds the
 *    subset the old schema had columns for.
 * 2. **A selected index row becomes a `SelectedDestination`.** That is the
 *    signal the plan flow turns on: a destination somebody pointed at needs no
 *    resolution request, no interpretation screen and no confirmation click.
 * 3. **Dates that do not exist are materialised, and marked as materialised.**
 *    A trip row needs two dates because everything downstream is built on a
 *    calendar. Somebody who said "some time in July" has not given us two, so we
 *    take the month's midpoint — and the composer keeps `mode: 'month'`, so no
 *    screen can present that placeholder as a decision they made.
 */

export interface ComposerResult {
  ok: boolean;
  href: string;
  error?: string;
  fieldErrors?: Record<string, string>;
}

const inputSchema = z.object({
  destinationText: z.string().trim().min(2, 'Tell us where you are going'),
  destinationEntryId: z.string().nullable(),
  dateMode: z.enum(DATE_MODES),
  startDate: z.string(),
  endDate: z.string(),
  flexDays: z.number().int().min(0).max(14),
  month: z.number().int().min(1).max(12),
  season: z.enum(['spring', 'summer', 'autumn', 'winter']),
  wantsDateRecommendation: z.boolean(),
  wantsLengthRecommendation: z.boolean(),
  nights: z.number().int().min(1).max(30).nullable(),
  arrivalPrecision: z.enum(ARRIVAL_PRECISIONS),
  departurePrecision: z.enum(ARRIVAL_PRECISIONS),
  adults: z.number().int().min(1).max(12),
  children: z.number().int().min(0).max(12),
  travelerNeeds: z.array(z.enum(TRAVELER_NEEDS)),
  shape: z.enum(TRIP_SHAPES).nullable(),
  pace: z.enum(['slow', 'balanced', 'packed']).nullable(),
  transport: z.enum(TRANSPORT_INTENTS).nullable(),
  budget: z.enum(BUDGET_BANDS).nullable(),
  themes: z.array(z.enum(TRIP_THEMES)),
  crowdTolerance: z.enum(['avoid', 'tolerate', 'unbothered']).nullable(),
  outdoorIntensity: z.enum(['gentle', 'moderate', 'strenuous']).nullable(),
  foodImportance: z.enum(['fuel', 'matters', 'central']).nullable(),
  freeTime: z.enum(['packed', 'balanced', 'lots']).nullable(),
  mustDo: z.string().max(600),
  avoid: z.string().max(600),
  origin: z.string().max(120),
});

export type ComposerInput = z.input<typeof inputSchema>;

/** Nights to assume when the traveller has not decided and has not been advised. */
const PLACEHOLDER_NIGHTS = 6;

export async function createTripFromComposer(raw: ComposerInput): Promise<ComposerResult> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, href: '', fieldErrors };
  }
  const input = parsed.data;
  const now = new Date();

  /*
   * The identity, when there is one.
   *
   * Read back from the index rather than trusted from the client: the browser
   * sends an id, and an id somebody made up must not become a destination. This
   * is the only place a `SelectedDestination` is minted.
   */
  let destination: SelectedDestination | null = null;
  if (input.destinationEntryId) {
    const entry = destinationEntryById(input.destinationEntryId);
    if (entry) {
      destination = {
        entryId: entry.id,
        catalog: entry.catalog,
        sourceId: entry.sourceId,
        releaseId: 'pinned',
        displayName: entry.displayName,
        ...(entry.localName ? { localName: entry.localName } : {}),
        qualifiedName: qualifiedNameFor(entry),
        featureType: entry.featureType,
        center: entry.center,
        ...(entry.bounds ? { bounds: entry.bounds } : {}),
        ...(entry.countryCode ? { countryCode: entry.countryCode } : {}),
        hierarchy: entry.hierarchy,
        selectedAt: now.toISOString(),
      };
    }
  }

  const nights = resolveNights(input);
  const { startDate, endDate } = materialiseDates(input, nights, now);

  const answers: TripComposerAnswers = {
    schemaVersion: TRIP_COMPOSER_VERSION,
    mode: 'known_destination',
    ...(destination ? { destination } : {}),
    destinationQuery: input.destinationText,
    dates: {
      mode: input.dateMode,
      ...(input.dateMode === 'exact' || input.dateMode === 'flexible'
        ? { startDate: input.startDate, endDate: input.endDate }
        : { startDate, endDate }),
      ...(input.dateMode === 'flexible' ? { flexDays: input.flexDays } : {}),
      ...(input.dateMode === 'month' ? { month: input.month } : {}),
      ...(input.dateMode === 'season' ? { season: input.season } : {}),
      year: Number(startDate.slice(0, 4)),
      wantsRecommendation: input.wantsDateRecommendation,
    },
    duration: {
      mode: input.nights !== null ? 'fixed' : 'unknown',
      ...(input.nights !== null ? { nights: input.nights } : {}),
      wantsRecommendation: input.wantsLengthRecommendation,
    },
    arrival: { precision: input.arrivalPrecision },
    departure: { precision: input.departurePrecision },
    ...(input.origin ? { origin: input.origin } : {}),
    adults: input.adults,
    children: input.children,
    travelerNeeds: input.travelerNeeds,
    ...(input.shape ? { shape: input.shape } : {}),
    ...(input.pace ? { pace: input.pace } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    themes: input.themes,
    ...(input.outdoorIntensity ? { outdoorIntensity: input.outdoorIntensity } : {}),
    ...(input.crowdTolerance ? { crowdTolerance: input.crowdTolerance } : {}),
    ...(input.foodImportance ? { foodImportance: input.foodImportance } : {}),
    ...(input.freeTime ? { freeTime: input.freeTime } : {}),
    ...(input.mustDo ? { mustDo: input.mustDo } : {}),
    ...(input.avoid ? { avoid: input.avoid } : {}),
    skipped: [],
    updatedAt: now.toISOString(),
  };

  /*
   * The authored region keeps its own door.
   *
   * A string naming a region we already hold in full goes straight to the
   * questionnaire against authored data, exactly as it always has. Everything
   * else goes through the compiler. Preserving this is what keeps every Eastern
   * Sierra journey, fixture and test green through this phase.
   */
  const region = resolveRegion(input.destinationText);

  const basics = tripBasicsSchema.safeParse({
    mode: 'known_destination',
    destinationInput: destination?.displayName ?? input.destinationText,
    regionId: region?.id ?? DYNAMIC_REGION_ID,
    startDate,
    endDate,
    arrivalTime: planningTime(input.arrivalPrecision, ARRIVAL_PLANNING_MINUTES, '15:00'),
    departureTime: planningTime(input.departurePrecision, DEPARTURE_PLANNING_MINUTES, '11:00'),
    adults: input.adults,
    children: input.children,
    travelerNeeds: input.travelerNeeds,
  });
  if (!basics.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of basics.error.issues) {
      const key = String(issue.path[0] ?? 'form');
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, href: '', fieldErrors };
  }

  let tripId: string;
  try {
    tripId = createTrip(basics.data).id;
    saveComposerAnswers(tripId, answers);
    if (!region) {
      saveDestinationQuery(tripId, 'known_destination', input.destinationText);
      saveSelectedDestination(tripId, destination);
    }
  } catch (error) {
    console.error('Failed to create trip', error);
    return { ok: false, href: '', error: 'We could not save that trip. Nothing was lost — try again.' };
  }

  return {
    ok: true,
    href: region ? `/trips/${tripId}/questionnaire` : `/trips/${tripId}/plan`,
  };
}

function resolveNights(input: z.infer<typeof inputSchema>): number {
  if (input.nights !== null) return input.nights;
  if (input.dateMode === 'exact' || input.dateMode === 'flexible') {
    const from = Date.parse(`${input.startDate}T00:00:00Z`);
    const to = Date.parse(`${input.endDate}T00:00:00Z`);
    if (!Number.isNaN(from) && !Number.isNaN(to) && to > from) {
      return Math.round((to - from) / 86_400_000);
    }
  }
  return PLACEHOLDER_NIGHTS;
}

/**
 * Two calendar dates, whatever the traveller actually gave us.
 *
 * The trip row needs them because every downstream layer — hours, weather,
 * seasonal access — is keyed on a date. The important part is that the composer
 * *keeps its own mode*, so a screen showing "some time in July" reads that from
 * `dates.mode` rather than from these two values. Nothing may present a
 * materialised date as a decision.
 */
function materialiseDates(
  input: z.infer<typeof inputSchema>,
  nights: number,
  now: Date,
): { startDate: string; endDate: string } {
  if ((input.dateMode === 'exact' || input.dateMode === 'flexible') && input.startDate && input.endDate) {
    return { startDate: input.startDate, endDate: input.endDate };
  }

  const year = now.getUTCFullYear();
  const month =
    input.dateMode === 'month'
      ? input.month
      : input.dateMode === 'season'
        ? SEASON_MIDPOINT[input.season]
        : now.getUTCMonth() + 2;

  // Next year when the month has already gone: a trip cannot start in the past.
  const targetYear = month <= now.getUTCMonth() + 1 ? year + 1 : year;
  const daysInMonth = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const startDay = Math.max(1, Math.min(daysInMonth - nights, Math.round((daysInMonth - nights) / 2)));
  const start = new Date(Date.UTC(targetYear, month - 1, startDay));
  const end = new Date(start.getTime() + nights * 86_400_000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

/** Northern-hemisphere midpoints; the climate layer is what actually reasons about seasons. */
const SEASON_MIDPOINT: Record<'spring' | 'summer' | 'autumn' | 'winter', number> = {
  spring: 4,
  summer: 7,
  autumn: 10,
  winter: 1,
};

function planningTime(
  precision: (typeof ARRIVAL_PRECISIONS)[number],
  table: Record<string, number | null>,
  fallback: string,
): string {
  const minutes = table[precision];
  if (minutes === null || minutes === undefined) return fallback;
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  const rest = String(minutes % 60).padStart(2, '0');
  return `${hours}:${rest}`;
}
