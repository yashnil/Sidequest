import { utcOffsetMinutesOn } from '../time/zone';

/**
 * V9 §10 — ONE CALENDAR BUILDER FOR THE SNAPSHOT AND THE FEED.
 *
 * RFC 5545 output with no dependency: stable UIDs, `SEQUENCE` from the trip's
 * version, `TZID` on every local time with a `VTIMEZONE` generated for each
 * zone from the runtime's own tz data, booked facts distinguished from
 * suggestions, `REFRESH-INTERVAL` (RFC 7986) and `X-PUBLISHED-TTL` for the
 * subscription. No notes and no confirmation references ever enter a
 * description. Pure and deterministic: given the same input it writes the
 * same bytes except for `DTSTAMP`, which the caller supplies.
 */
export interface CalendarEvent {
  uid: string;
  date: string;
  startMinute: number;
  endMinute: number;
  /** For an event that ends on a later date (lodging), the end date; else the same date. */
  endDate?: string;
  timeZone: string;
  summary: string;
  description?: string;
  location?: string;
  geo?: { lat: number; lng: number };
  url?: string;
  status: 'confirmed' | 'tentative';
  categories?: readonly string[];
  sequence: number;
}

export interface CalendarInput {
  name: string;
  description: string;
  prodId?: string;
  timeZones: readonly string[];
  years: readonly number[];
  events: readonly CalendarEvent[];
  /** ISO instant used for DTSTAMP on every event. */
  stamp: string;
  /** Present on the feed only. */
  refreshInterval?: string;
  /** Primary zone for `X-WR-TIMEZONE`. */
  primaryTimeZone?: string;
  /** Base URL for optional per-event links. */
  attributions?: readonly string[];
}

/** RFC 5545 §3.3.11: backslashes, semicolons, commas and newlines escape. */
export function escapeIcsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

const OCTETS = new TextEncoder();

/**
 * RFC 5545 §3.1: a physical line carries at most 75 octets, and a longer one
 * folds onto continuations that begin with a space.
 *
 * V9.1 — the limit is octets, not characters. Folding on UTF-16 code units let
 * any line holding multi-byte text — the ODbL attribution's `©`, an em dash in
 * a reason, an accented or non-Latin place name — run to 79 octets, which
 * Google's parser has been known to drop the whole event over. Iterating the
 * string by code point also means a surrogate pair is never split across a fold.
 */
export function foldIcsLine(line: string): string {
  if (OCTETS.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const character of line) {
    const size = OCTETS.encode(character).length;
    if (octets + size > 75) {
      parts.push(current);
      current = ' ';
      octets = 1;
    }
    current += character;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n');
}

function icsLocal(date: string, minute: number): string {
  const hours = Math.floor(minute / 60) % 24;
  const minutes = minute % 60;
  return `${date.replace(/-/g, '')}T${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}00`;
}

export function icsInstant(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function offsetToken(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A VTIMEZONE for one zone over the given years, from the runtime tz data.
 *
 * Every day of each year is probed for its offset; each change is written as
 * an explicit STANDARD or DAYLIGHT component dated at local midnight of the
 * day the new offset first applies. Explicit components per year are valid
 * RFC 5545 and need no RRULE guesswork. A zone with one offset all year gets
 * a single STANDARD component.
 */
export function vtimezoneFor(timeZone: string, years: readonly number[]): string[] {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`];
  const sorted = [...new Set(years)].sort((a, b) => a - b);
  const firstDate = `${sorted[0] ?? new Date().getUTCFullYear()}-01-01`;
  let previous = utcOffsetMinutesOn(firstDate, timeZone);
  let components = 0;
  const component = (kind: 'STANDARD' | 'DAYLIGHT', date: string, from: number, to: number) => {
    lines.push(`BEGIN:${kind}`, `DTSTART:${icsLocal(date, 0)}`, `TZOFFSETFROM:${offsetToken(from)}`, `TZOFFSETTO:${offsetToken(to)}`, `END:${kind}`);
    components += 1;
  };
  /* The state at the start of the range, so a client reading the first event has an offset to use. */
  component('STANDARD', addDays(firstDate, -1), previous, previous);
  for (const year of sorted) {
    for (let day = `${year}-01-01`; day.startsWith(String(year)); day = addDays(day, 1)) {
      const offset = utcOffsetMinutesOn(day, timeZone);
      if (offset !== previous) {
        component(offset > previous ? 'DAYLIGHT' : 'STANDARD', day, previous, offset);
        previous = offset;
      }
    }
  }
  if (components === 0) component('STANDARD', firstDate, previous, previous);
  lines.push('END:VTIMEZONE');
  return lines;
}

export function buildCalendar(input: CalendarInput): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${input.prodId ?? '-//Sidequest//Trip//EN'}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldIcsLine(`X-WR-CALNAME:${escapeIcsText(input.name)}`),
    foldIcsLine(`X-WR-CALDESC:${escapeIcsText(input.description)}`),
  ];
  if (input.primaryTimeZone) lines.push(foldIcsLine(`X-WR-TIMEZONE:${escapeIcsText(input.primaryTimeZone)}`));
  if (input.refreshInterval) {
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${input.refreshInterval}`, `X-PUBLISHED-TTL:${input.refreshInterval}`);
  }
  for (const zone of [...new Set(input.timeZones)]) lines.push(...vtimezoneFor(zone, input.years));
  const stamp = icsInstant(input.stamp);
  for (const event of input.events) {
    const endDate = event.endDate ?? event.date;
    lines.push(
      'BEGIN:VEVENT',
      foldIcsLine(`UID:${escapeIcsText(event.uid)}`),
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${Math.max(0, Math.floor(event.sequence))}`,
      `DTSTART;TZID=${event.timeZone}:${icsLocal(event.date, event.startMinute)}`,
      `DTEND;TZID=${event.timeZone}:${icsLocal(endDate, event.endMinute)}`,
      foldIcsLine(`SUMMARY:${escapeIcsText(event.summary)}`),
      `STATUS:${event.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`,
    );
    if (event.description) lines.push(foldIcsLine(`DESCRIPTION:${escapeIcsText(event.description)}`));
    if (event.location) lines.push(foldIcsLine(`LOCATION:${escapeIcsText(event.location)}`));
    if (event.geo) lines.push(`GEO:${event.geo.lat.toFixed(6)};${event.geo.lng.toFixed(6)}`);
    if (event.url) lines.push(foldIcsLine(`URL:${event.url}`));
    if (event.categories && event.categories.length > 0) lines.push(foldIcsLine(`CATEGORIES:${event.categories.map(escapeIcsText).join(',')}`));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

/**
 * "Add to Google Calendar" — the TEMPLATE link. Local times with `ctz` naming
 * the zone; Google reads the pair as local to `ctz` when neither ends in `Z`.
 */
export function googleCalendarLink(event: Pick<CalendarEvent, 'date' | 'startMinute' | 'endMinute' | 'endDate' | 'timeZone' | 'summary' | 'description' | 'location'>): string {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.summary,
    dates: `${icsLocal(event.date, event.startMinute)}/${icsLocal(event.endDate ?? event.date, event.endMinute)}`,
    ctz: event.timeZone,
  });
  if (event.description) params.set('details', event.description);
  if (event.location) params.set('location', event.location);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** The years a trip touches, for VTIMEZONE generation. */
export function yearsBetween(startDate: string, endDate: string): number[] {
  const a = Number(startDate.slice(0, 4));
  const b = Number(endDate.slice(0, 4));
  const years: number[] = [];
  for (let y = a; y <= (Number.isNaN(b) ? a : b); y += 1) years.push(y);
  return years;
}
