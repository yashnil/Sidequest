import { NextResponse } from 'next/server';
import { formatMinuteOfDay, licence } from '@sidequest/core';
import { loadTripIntelligence } from '@/lib/intelligence/load';
import type { Itinerary, ItineraryItem } from '@sidequest/core';
import { getItinerary, getTrip } from '@/lib/db/repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { resolveTripRegion } from '@/lib/region';

export const dynamic = 'force-dynamic';

/**
 * THE PLAN AS A CALENDAR — `text/calendar`, STANDARD VCALENDAR, NO DEPENDENCIES.
 *
 * Times are written as *floating* local times on purpose. An itinerary's
 * "09:30 at the shrine" means 09:30 on the traveller's wrist at the
 * destination; anchoring it to UTC would shift every event by the viewer's
 * offset, and shipping a full VTIMEZONE definition for every zone on earth is
 * a library's job, not a route's. A floating time renders as 09:30 wherever
 * the calendar is opened — exactly what a person standing in the city wants —
 * and `X-WR-TIMEZONE` names the zone for clients that honour it.
 *
 * Only scheduled *events* are exported: activities, meals with a start, and
 * the travel legs long enough to plan around. Free time is deliberately left
 * out — a calendar full of "Free time" blocks is how people stop reading the
 * calendar. Attribution survives the export (§17): it rides in the calendar
 * description.
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

  /* The zone, read from the compiled base when the artifact carries one. */
  let timeZone: string | undefined;
  let attributions: readonly string[] = [];
  try {
    const resolved = await resolveTripRegion(trip);
    if (resolved.ok) {
      timeZone = resolved.context.compiled.bases.find((base) => base.id === itinerary!.baseId)
        ?.timeZone;
      attributions = resolved.context.compiled.sourceManifest.attributions ?? [];
    }
  } catch {
    /* The calendar is still valid without a zone name; floating times stand. */
  }
  if (attributions.length === 0) attributions = [licence('ODbL-1.0').attribution];

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Sidequest//Itinerary//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    fold(`X-WR-CALNAME:${escapeText(`${itinerary.baseName} — Sidequest itinerary`)}`),
    fold(
      `X-WR-CALDESC:${escapeText(
        `${itinerary.summary} ${attributions.join(' · ')}. All times are local to the destination.`,
      )}`,
    ),
    ...(timeZone ? [fold(`X-WR-TIMEZONE:${escapeText(timeZone)}`)] : []),
  ];

  /*
   * Booked facts first, and the itinerary with those facts applied. A
   * calendar that carried the model's hotel while the traveller has booked a
   * different one would be the wrong calendar.
   */
  const loaded = loadTripIntelligence({ trip, itinerary, ...(timeZone ? { timeZone } : {}), persist: false });
  itinerary = loaded.itinerary;
  const stamp = toIcsInstant(new Date());
  for (const booking of loaded.booked) {
    if (booking.status !== 'booked' || !booking.date) continue;
    const start = booking.startTime ?? (booking.type === 'lodging' ? '15:00' : '09:00');
    const end = booking.endTime ?? (booking.type === 'lodging' ? '11:00' : addMinutes(start, 120));
    const endDate = booking.type === 'lodging' ? (booking.endDate ?? booking.date) : booking.date;
    lines.push(
      'BEGIN:VEVENT',
      fold(`UID:${escapeText(`${itinerary.tripId}-booked-${booking.id}@sidequest`)}`),
      `DTSTAMP:${stamp}`,
      `DTSTART:${booking.date.replace(/-/g, '')}T${start.replace(':', '')}00`,
      `DTEND:${endDate.replace(/-/g, '')}T${end.replace(':', '')}00`,
      fold(`SUMMARY:${escapeText(`Booked: ${booking.title}`)}`),
      fold(`DESCRIPTION:${escapeText([booking.location, booking.notes, booking.url].filter((p): p is string => Boolean(p)).join(' '))}`),
      'PRIORITY:1',
      'END:VEVENT',
    );
  }
  for (const day of itinerary.days) {
    for (const item of day.items) {
      if (!isExportable(item)) continue;
      const summary =
        item.kind === 'meal' && item.food?.venueName
          ? `${item.title} — ${mealLabel(item)}`
          : item.title;
      lines.push(
        'BEGIN:VEVENT',
        fold(`UID:${escapeText(`${itinerary.tripId}-${day.dayNumber}-${item.id}@sidequest`)}`),
        `DTSTAMP:${stamp}`,
        `DTSTART:${day.date.replace(/-/g, '')}T${toIcsTime(item.startMinute)}`,
        `DTEND:${day.date.replace(/-/g, '')}T${toIcsTime(item.endMinute)}`,
        fold(`SUMMARY:${escapeText(summary)}`),
        fold(
          `DESCRIPTION:${escapeText(
            [
              item.reason,
              item.hours
                ? `Open ${formatMinuteOfDay(item.hours.openMinute)}–${formatMinuteOfDay(item.hours.closeMinute)}.`
                : null,
              item.verifyBeforeTravel ? `Check before travel: ${item.verifyBeforeTravel}` : null,
            ]
              .filter((part): part is string => Boolean(part))
              .join(' '),
          )}`,
        ),
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');

  return new NextResponse(lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="sidequest-${id}.ics"`,
    },
  });
}

/** Activities and meals are appointments; short travel legs are noise. */
function addMinutes(time: string, minutes: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = Math.min(23 * 60 + 59, (h ?? 0) * 60 + (m ?? 0) + minutes);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function isExportable(item: ItineraryItem): boolean {
  if (item.id.startsWith('booked:')) return false;
  if (item.kind === 'activity') return true;
  if (item.kind === 'meal') return true;
  if (item.kind === 'travel') return item.durationMinutes >= 45;
  return false;
}

function mealLabel(item: ItineraryItem): string {
  switch (item.food?.slot) {
    case 'breakfast':
      return 'breakfast';
    case 'lunch':
      return 'lunch';
    case 'dinner':
      return 'dinner';
    default:
      return 'food stop';
  }
}

function toIcsTime(minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}00`;
}

function toIcsInstant(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** RFC 5545 §3.3.11: backslashes, semicolons, commas and newlines escape. */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 §3.1: lines longer than 75 octets fold with a leading space. */
function fold(line: string): string {
  if (line.length <= 74) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > 74) {
    parts.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}
