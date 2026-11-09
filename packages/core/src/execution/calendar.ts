import { isKnownTimeZone, utcOffsetMinutesOn } from '../time/zone';

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

/**
 * RFC 5545 §3.3.11: backslashes, semicolons, commas and newlines escape.
 *
 * RELEASE PASS — every line break, not only the two a Unix or Windows editor
 * writes. A bare carriage return was left in the value, and to the calendar
 * clients that treat CR as a line ending it *is* one: text a traveller typed as
 * a booking title, or a model read out of somebody else's confirmation e-mail,
 * ended the property and began whatever followed it. The Unicode line and
 * paragraph separators are folded the same way, and the remaining C0 controls
 * (which RFC 5545 forbids in TEXT outright) are dropped rather than passed to a
 * parser to make of what it will.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, '\\n')
    // eslint-disable-next-line no-control-regex -- the controls are the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
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

/**
 * A local date-time from a date label and a minute on the day's timeline.
 *
 * RELEASE PASS — the timeline runs past midnight (an item carries
 * `timelineMinuteSchema`, 0–48 h, because an overrunning day puts real stops
 * there), and this wrapped the hour without moving the date: a stop at 24:30
 * was written at 00:30 on the day it *started*, a day early, and one that began
 * at 23:30 and ended at 24:30 ended before it began. The days carried over now
 * move the date with the clock.
 */
function icsLocal(date: string, minute: number): string {
  const whole = Math.max(0, Math.floor(Number.isFinite(minute) ? minute : 0));
  const carried = Math.floor(whole / (24 * 60));
  const onDate = carried > 0 ? addDays(date, carried) : date;
  const hours = Math.floor(whole / 60) % 24;
  const minutes = whole % 60;
  return `${onDate.replace(/-/g, '')}T${String(hours).padStart(2, '0')}${String(minutes).padStart(2, '0')}00`;
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
 *
 * RELEASE PASS — the range is bounded here, whatever the caller passes. The
 * years came from the earliest and latest date on a trip *and on every booked
 * fact*, a booked date was any four digits, and this loop probes every day of
 * every year: one fact dated 9999 was eight thousand years of probes — minutes
 * of synchronous CPU per request, per zone — on a calendar feed that needs no
 * cookie to fetch. At most `MAX_VTIMEZONE_YEARS` consecutive years are
 * described, starting from the earliest plausible one; a client that meets an
 * event outside them falls back to its own data for the named zone, which is
 * what it does for every calendar that ships no VTIMEZONE at all.
 */
export const MAX_VTIMEZONE_YEARS = 4;

export function vtimezoneFor(timeZone: string, years: readonly number[]): string[] {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${timeZone}`];
  const sorted = [...new Set(years.filter((year) => Number.isInteger(year) && year >= 1970 && year <= 2200))].sort((a, b) => a - b).slice(0, MAX_VTIMEZONE_YEARS);
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
  /*
   * RELEASE PASS — a zone identifier is a property *parameter* here, written
   * raw, so it is only ever one the runtime recognises (which is also a string
   * with no `:`, `;` or line break in it). An event whose zone it does not
   * recognise is written in the calendar's primary zone, or floating when there
   * is none: a slightly wrong hour on one event, never a calendar that fails to
   * build because one booking said "Pacific time".
   */
  const knownZones = [...new Set(input.timeZones)].filter(isKnownTimeZone);
  const fallbackZone = isKnownTimeZone(input.primaryTimeZone) ? input.primaryTimeZone : knownZones[0];
  if (fallbackZone && !knownZones.includes(fallbackZone)) knownZones.push(fallbackZone);
  for (const zone of knownZones) lines.push(...vtimezoneFor(zone, input.years));
  const stamp = icsInstant(input.stamp);
  for (const event of input.events) {
    const endDate = event.endDate ?? event.date;
    const zone = isKnownTimeZone(event.timeZone) ? event.timeZone : fallbackZone;
    const tzid = zone ? `;TZID=${zone}` : '';
    lines.push(
      'BEGIN:VEVENT',
      foldIcsLine(`UID:${escapeIcsText(event.uid)}`),
      `DTSTAMP:${stamp}`,
      `SEQUENCE:${Math.max(0, Math.floor(event.sequence))}`,
      `DTSTART${tzid}:${icsLocal(event.date, event.startMinute)}`,
      `DTEND${tzid}:${icsLocal(endDate, event.endMinute)}`,
      foldIcsLine(`SUMMARY:${escapeIcsText(event.summary)}`),
      `STATUS:${event.status === 'confirmed' ? 'CONFIRMED' : 'TENTATIVE'}`,
    );
    if (event.description) lines.push(foldIcsLine(`DESCRIPTION:${escapeIcsText(event.description)}`));
    if (event.location) lines.push(foldIcsLine(`LOCATION:${escapeIcsText(event.location)}`));
    if (event.geo) lines.push(`GEO:${event.geo.lat.toFixed(6)};${event.geo.lng.toFixed(6)}`);
    if (event.url && /^https?:\/\/[^\s\p{Cc}]+$/iu.test(event.url)) lines.push(foldIcsLine(`URL:${event.url}`));
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

/**
 * The years a trip touches, for VTIMEZONE generation.
 *
 * Never more than `MAX_VTIMEZONE_YEARS`, counted from the start: the two ends
 * are data, and a loop whose length is the difference between two stored
 * strings is a loop somebody else sizes.
 */
export function yearsBetween(startDate: string, endDate: string): number[] {
  const a = Number(startDate.slice(0, 4));
  const b = Number(endDate.slice(0, 4));
  if (!Number.isInteger(a)) return [];
  const last = Number.isInteger(b) ? Math.min(b, a + MAX_VTIMEZONE_YEARS - 1) : a;
  const years: number[] = [];
  for (let y = a; y <= last; y += 1) years.push(y);
  return years;
}
