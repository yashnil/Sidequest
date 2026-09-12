import { ImageResponse } from 'next/og';
import type { Itinerary } from '@sidequest/core';
import { getItinerary } from '@/lib/db/repository';
import { DAY_CARD_SIZE, DayCard, dayCardModel } from '@/lib/execution/trip-cards';
import { ownedTrip } from '@/lib/net/trip-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * V9 §11 — ONE DAY AS A VERTICAL CARD, 1080×1350.
 *
 * Owner-gated. The day's number, its theme, where it sleeps and up to five
 * stops with their times — what a traveller sends the group the night before.
 * Nothing booked, nothing priced, nobody named.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; n: string }> }): Promise<Response> {
  const { id, n } = await params;
  const trip = await ownedTrip(id);
  if (!trip) return new Response('No such trip.', { status: 404 });
  let itinerary: Itinerary | null;
  try {
    itinerary = getItinerary(id);
  } catch {
    return new Response('This plan was built by an earlier version of Sidequest. Rebuild it before exporting.', { status: 409 });
  }
  if (!itinerary) return new Response('No plan has been built for this trip yet.', { status: 404 });
  const dayNumber = Number(n);
  const day = Number.isInteger(dayNumber) ? itinerary.days.find((entry) => entry.dayNumber === dayNumber) : undefined;
  if (!day) return new Response('No such day.', { status: 404 });
  const model = dayCardModel(trip, itinerary, day);
  return new ImageResponse(<DayCard model={model} />, {
    ...DAY_CARD_SIZE,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="sidequest-${id}-day-${day.dayNumber}.png"`,
    },
  });
}
