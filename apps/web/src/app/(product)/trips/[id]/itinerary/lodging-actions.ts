'use server';

import { z } from 'zod';
import { lodgingSearchRadiusKm, rankLodgingProperties, readTripForLodging, type Itinerary, type LodgingRecommendation } from '@sidequest/core';
import { guardAction } from '@/lib/net/caller';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { getItinerary, getProfile, getTrip } from '@/lib/db/repository';
import { discoverLodgingNear } from '@/lib/providers/lodging/discover';

/**
 * NAMED PLACES TO STAY FOR ONE BASE — A TRAVELLER-PRESSED SERVER ACTION.
 *
 * Opening Bookings calls nothing. Pressing "Show places to stay" on a stay
 * calls this: it reads lodging candidates around that base from open place
 * data (`providers/lodging/discover.ts`), reads the trip's character from the
 * stored profile and itinerary (`readTripForLodging`), and ranks them
 * (`rankLodgingProperties`). The answer is for display only: nothing is saved
 * to the plan, no price or availability is part of it, and it says so.
 */

export interface LodgingActionResult {
  ok: boolean;
  error?: string;
  available?: boolean;
  reason?: string;
  recommendations?: LodgingRecommendation[];
  /** How many named places were considered within `radiusKm`. */
  considered?: number;
  radiusKm?: number;
  attribution?: string[];
  /** The trip reasons the ranking used, in words ("the hot springs you asked for"). */
  readingFor?: string[];
  checkIn?: string;
  checkOut?: string;
}

const requestSchema = z.object({
  baseId: z.string().min(1).max(120),
  dayStarts: z
    .array(z.object({ dayNumber: z.number().int().min(1).max(400), name: z.string().min(1).max(160), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }))
    .max(30)
    .default([]),
});
export type LodgingActionRequest = z.input<typeof requestSchema>;

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The base's nights as dates, walked in stay order exactly as the Bookings rows do. */
function stayDates(itinerary: Itinerary, baseId: string): { checkIn: string; checkOut: string; nights: number } | null {
  let cursor = itinerary.startDate;
  for (const base of itinerary.package?.bases ?? []) {
    const checkIn = cursor;
    cursor = addDays(cursor, base.nights);
    if (base.id === baseId) return base.nights > 0 ? { checkIn, checkOut: cursor, nights: base.nights } : null;
  }
  return null;
}

function walkedShare(itinerary: Itinerary): number | undefined {
  let walked = 0;
  let total = 0;
  for (const day of itinerary.days) {
    for (const item of day.items) {
      const mode = item.travel?.mode;
      if (!mode || item.kind !== 'travel') continue;
      total += item.durationMinutes;
      if (mode === 'walk') walked += item.durationMinutes;
    }
  }
  return total > 0 ? walked / total : undefined;
}

export async function recommendLodgingAction(tripId: string, input: LodgingActionRequest): Promise<LodgingActionResult> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'That stay could not be read.' };
  const trip = getTrip(tripId);
  const itinerary = getItinerary(tripId);
  if (!trip || !itinerary) return { ok: false, error: 'We could not find that trip any more.' };
  const base = itinerary.package?.bases.find((b) => b.id === parsed.data.baseId);
  if (!base?.coordinates) return { ok: false, error: 'That stay has no verified position to search around.' };
  const dates = stayDates(itinerary, base.id);
  if (!dates) return { ok: false, error: 'That stay has no nights to book.' };
  const limited = await guardAction('place_lookup');
  if (limited) return { ok: false, error: limited };

  const profile = getProfile(tripId);
  const reading = readTripForLodging({
    ...(profile ? { interests: profile.interests as Record<string, string | undefined> } : {}),
    primaryMode: itinerary.transportStrategy.primaryMode,
    ...(profile?.interview.transportChoice ? { transportChoice: profile.interview.transportChoice } : {}),
    ...(profile ? { budgetStyle: profile.budgetStyle, lodgingStyle: profile.interview.lodgingStyle, rusticLodgingOk: profile.interview.rusticLodgingOk, mobilityLimited: profile.accessibility.mobilityLimited } : {}),
    adults: Math.max(1, trip.basics.adults),
    children: trip.basics.children ?? 0,
    ...(walkedShare(itinerary) !== undefined ? { walkedShare: walkedShare(itinerary)! } : {}),
  });
  const radiusKm = lodgingSearchRadiusKm(reading.mode);
  const found = await discoverLodgingNear({ near: base.coordinates, radiusKm });
  const name = base.displayName ?? base.locality ?? base.name;
  const ranked = rankLodgingProperties(
    found.candidates,
    {
      baseId: base.id,
      name,
      coordinates: base.coordinates,
      nights: dates.nights,
      checkIn: dates.checkIn,
      checkOut: dates.checkOut,
      dayStarts: parsed.data.dayStarts.map((s) => ({ dayNumber: s.dayNumber, name: s.name, coordinates: { lat: s.lat, lng: s.lng } })),
    },
    reading,
    { radiusKm },
  );
  return {
    ok: true,
    available: found.available,
    ...(found.reason ? { reason: found.reason } : {}),
    recommendations: ranked.recommendations,
    considered: ranked.considered,
    radiusKm,
    attribution: found.attribution,
    readingFor: reading.themes.filter((t) => t.theme !== 'transit').map((t) => t.because),
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
  };
}
