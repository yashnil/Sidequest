import { NextResponse } from 'next/server';
import type { Itinerary } from '@sidequest/core';
import { tripForFeedToken } from '@/lib/db/execution-repository';
import { getItinerary, getTrip } from '@/lib/db/repository';
import { buildTripCalendar, loadTripCalendarSource } from '@/lib/execution/calendar-events';

export const dynamic = 'force-dynamic';

const FEED_HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8',
  'Cache-Control': 'private, max-age=0, must-revalidate',
} as const;

/**
 * V9 §10 — THE CALENDAR SUBSCRIPTION FEED.
 *
 * The token is the only key. It was shown to the traveller once, is stored
 * only as a SHA-256 hash, and can be revoked or regenerated from the Trip
 * Pack; a revoked or unknown token gets the same four words a missing one
 * does, so the URL is not an oracle. No cookie is read — Google fetches this
 * from its own servers, Apple from the traveller's device, Outlook from
 * Microsoft's — and nothing about the request authenticates anybody.
 *
 * The body is the same document the snapshot route writes, with
 * `REFRESH-INTERVAL` and `X-PUBLISHED-TTL` asking clients to re-read hourly
 * (Google will take a day regardless; the interval is a hint, not a promise).
 * The trip id appears nowhere but inside the UIDs, where it is the stable part
 * that lets an edit update an event instead of duplicating it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await params;
  const tripId = tripForFeedToken(token);
  if (!tripId) return new NextResponse('No such calendar.', { status: 404 });
  const trip = getTrip(tripId);
  if (!trip) return new NextResponse('No such calendar.', { status: 404 });

  const now = new Date();
  let itinerary: Itinerary | null;
  try {
    itinerary = getItinerary(tripId);
  } catch {
    itinerary = null;
  }
  /*
   * A subscription outlives a plan: the trip may be mid-rebuild, or built by
   * an earlier version. A subscribed client that gets an error stops
   * refreshing — some for good — so the honest answer is a valid, empty
   * calendar that says why, and fills again on the next read.
   */
  if (!itinerary) {
    const empty = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Sidequest//Itinerary//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${trip.basics.destinationInput.replace(/[,;\\]/g, ' ')} — Sidequest`,
      'X-WR-CALDESC:This trip has no finished plan right now. Events appear here once it is built.',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
      'X-PUBLISHED-TTL:PT1H',
      'END:VCALENDAR',
    ].join('\r\n');
    return new NextResponse(`${empty}\r\n`, { headers: FEED_HEADERS });
  }

  const loaded = await loadTripCalendarSource(trip, itinerary, now);
  const body = buildTripCalendar(loaded.source, {
    name: `${loaded.source.itinerary.baseName} — Sidequest`,
    summary: loaded.source.itinerary.summary,
    attributions: loaded.attributions,
    stamp: now.toISOString(),
    refreshInterval: 'PT1H',
  });
  return new NextResponse(body, { headers: FEED_HEADERS });
}
