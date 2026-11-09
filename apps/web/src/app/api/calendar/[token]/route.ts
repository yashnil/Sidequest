import { NextResponse } from 'next/server';
import { escapeIcsText, foldIcsLine, type Itinerary } from '@sidequest/core';
import { tripForFeedToken } from '@/lib/db/execution-repository';
import { getItinerary, getTrip } from '@/lib/db/repository';
import { buildTripCalendar, loadTripCalendarSource } from '@/lib/execution/calendar-events';

export const dynamic = 'force-dynamic';

const FEED_HEADERS = {
  'Content-Type': 'text/calendar; charset=utf-8',
  'Cache-Control': 'private, max-age=0, must-revalidate',
} as const;

/** RELEASE PASS — the refusal is as uncacheable as the feed: a token minted a second later must not meet a stored 404, and a revoked one must not meet a stored 200. */
const NO_FEED = { status: 404, headers: { 'Cache-Control': 'private, no-store' } } as const;

/**
 * The valid, empty calendar a subscribed client gets when there is nothing to
 * list. RELEASE PASS — the name goes through the same escape and fold as every
 * other text in a calendar: this line was assembled by hand with only `,;\\`
 * removed, so a destination typed with a line break in it ended the property
 * and wrote whatever followed as calendar content, served from this origin.
 */
function emptyCalendar(name: string, why: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sidequest//Itinerary//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldIcsLine(`X-WR-CALNAME:${escapeIcsText(`${name} — Sidequest`)}`),
    foldIcsLine(`X-WR-CALDESC:${escapeIcsText(why)}`),
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

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
  if (!tripId) return new NextResponse('No such calendar.', NO_FEED);
  const trip = getTrip(tripId);
  if (!trip) return new NextResponse('No such calendar.', NO_FEED);

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
    return new NextResponse(emptyCalendar(trip.basics.destinationInput, 'This trip has no finished plan right now. Events appear here once it is built.'), { headers: FEED_HEADERS });
  }

  /*
   * RELEASE PASS — and the same answer when the plan is there but the calendar
   * cannot be derived from it. Nothing authenticates this request and nothing
   * rate-limits it, so an exception here was a 500 any holder of the URL could
   * repeat, and a client that stopped refreshing because of it.
   */
  try {
    const loaded = await loadTripCalendarSource(trip, itinerary, now);
    const body = buildTripCalendar(loaded.source, {
      name: `${loaded.source.itinerary.baseName} — Sidequest`,
      summary: loaded.source.itinerary.summary,
      attributions: loaded.attributions,
      stamp: now.toISOString(),
      refreshInterval: 'PT1H',
    });
    return new NextResponse(body, { headers: FEED_HEADERS });
  } catch (error) {
    console.error('Calendar feed could not be built', { ref: tripId.slice(0, 8), error: error instanceof Error ? error.name : 'unknown' });
    return new NextResponse(emptyCalendar(trip.basics.destinationInput, 'This calendar could not be prepared just now. It fills again on the next refresh.'), { headers: FEED_HEADERS });
  }
}
