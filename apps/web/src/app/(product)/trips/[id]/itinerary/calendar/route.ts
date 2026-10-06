import { productEvent } from '@/lib/net/product-events';
import { NextResponse } from 'next/server';
import type { Itinerary } from '@sidequest/core';
import { getItinerary, getTrip } from '@/lib/db/repository';
import { buildTripCalendar, loadTripCalendarSource } from '@/lib/execution/calendar-events';
import { tripAccessRefusal } from '@/lib/net/trip-access';

export const dynamic = 'force-dynamic';

/**
 * THE PLAN AS A CALENDAR FILE — `text/calendar`, STANDARD VCALENDAR, NO DEPENDENCIES.
 *
 * V9 §10 — one builder with the subscription feed (`/api/calendar/[token]`),
 * so a file downloaded today and a feed subscribed to tomorrow describe the
 * same events with the same UIDs: importing the file and later subscribing
 * updates rather than duplicates. Every local time carries a `TZID` with its
 * `VTIMEZONE` generated from the runtime's own zone data, `SEQUENCE` is the
 * trip's version, booked facts are `CONFIRMED` and categorised `Booked`, and
 * the model's suggestions are `TENTATIVE`.
 *
 * Only scheduled *events* are exported: activities, meals with a start, and
 * the travel legs long enough to plan around. Free time is deliberately left
 * out — a calendar full of "Free time" blocks is how people stop reading the
 * calendar. Attribution survives the export (§17): it rides in the calendar
 * description. Notes, confirmation references and costs never do.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const trip = getTrip(id);
  if (!trip) return new NextResponse('No such trip.', { status: 404 });
  /*
   * Owner-gated like the page that links here: this response is the whole
   * plan, and the read-only /share/<token> surface is the one unauthenticated
   * copy of it. A foreign browser gets the missing-trip answer, verbatim, so
   * the id cannot be used to tell "hidden" from "gone".
   */
  if (await tripAccessRefusal(id)) return new NextResponse('No such trip.', { status: 404 });
  productEvent('export_used', id, { format: 'ics' });

  let itinerary: Itinerary | null;
  try {
    itinerary = getItinerary(id);
  } catch {
    return new NextResponse(
      'This plan was built by an earlier version of Sidequest. Rebuild it before exporting.',
      { status: 409 },
    );
  }
  if (!itinerary) return new NextResponse('No plan has been built for this trip yet.', { status: 404 });

  const now = new Date();
  const loaded = await loadTripCalendarSource(trip, itinerary, now);
  const body = buildTripCalendar(loaded.source, {
    name: `${loaded.source.itinerary.baseName} — Sidequest itinerary`,
    summary: loaded.source.itinerary.summary,
    attributions: loaded.attributions,
    stamp: now.toISOString(),
  });

  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="sidequest-${id}.ics"`,
    },
  });
}
