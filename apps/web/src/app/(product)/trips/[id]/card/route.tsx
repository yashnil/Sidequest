import { ImageResponse } from 'next/og';
import type { Itinerary } from '@sidequest/core';
import { getItinerary } from '@/lib/db/repository';
import { OVERVIEW_CARD_SIZE, OverviewCard, overviewCardModel } from '@/lib/execution/trip-cards';
import { ownedTrip } from '@/lib/net/trip-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * V9 §11 — THE OVERVIEW CARD, 1200×630, FOR THE TRAVELLER TO POST.
 *
 * Owner-gated like the plan it pictures, and drawn from `overviewCardModel`,
 * which carries destination, dates, the bases and a readiness word from the
 * feasibility report — never a booking, a price, a reference or the party.
 * The share link's own preview (`/share/[token]/opengraph-image`) draws the
 * same model from the token, so a posted picture and a shared link agree.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const trip = await ownedTrip(id);
  if (!trip) return new Response('No such trip.', { status: 404 });
  let itinerary: Itinerary | null;
  try {
    itinerary = getItinerary(id);
  } catch {
    return new Response('This plan was built by an earlier version of Sidequest. Rebuild it before exporting.', { status: 409 });
  }
  if (!itinerary) return new Response('No plan has been built for this trip yet.', { status: 404 });
  const model = overviewCardModel(trip, itinerary);
  return new ImageResponse(<OverviewCard model={model} />, {
    ...OVERVIEW_CARD_SIZE,
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `inline; filename="sidequest-${id}-overview.png"`,
    },
  });
}
