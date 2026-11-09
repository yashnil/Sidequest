import { describe, expect, it } from 'vitest';
import { bookedPlanItemInputSchema, bookedPlanItemPatchSchema } from '../intelligence/booking';
import { isKnownTimeZone } from '../time/zone';
import { buildCalendar, escapeIcsText, vtimezoneFor, yearsBetween, MAX_VTIMEZONE_YEARS, type CalendarEvent } from './calendar';
import { redactSensitive } from './confirmation-extract';

/**
 * RELEASE PASS — WHAT SOMEBODY ELSE'S TEXT CAN DO TO THE ONE THREAD.
 *
 * Each case is a finding from the release audit, stated as what must hold.
 */

const EVENT: CalendarEvent = { uid: 'u@sidequest', date: '2026-09-01', startMinute: 600, endMinute: 660, timeZone: 'Europe/Lisbon', summary: 'A stop', status: 'tentative', sequence: 1 };
const DOCUMENT = { name: 'Trip', description: 'Plan', timeZones: ['Europe/Lisbon'], years: [2026], stamp: '2026-08-01T00:00:00.000Z', events: [EVENT] };

function unfolded(ics: string): string[] {
  return ics.replace(/\r\n /g, '').split('\r\n');
}

describe('calendar text cannot end its own property', () => {
  it.each([
    ['CRLF', 'x\r\nATTENDEE:evil'],
    ['LF', 'x\nATTENDEE:evil'],
    ['a bare CR', 'x\rATTENDEE:evil'],
    ['U+2028', 'x\u2028ATTENDEE:evil'],
    ['NEL', 'x\u0085ATTENDEE:evil'],
  ])('escapes %s', (_name, value) => {
    const escaped = escapeIcsText(value);
    expect(escaped).not.toMatch(/[\r\n\u0085\u2028\u2029]/);
    const lines = unfolded(buildCalendar({ ...DOCUMENT, events: [{ ...EVENT, summary: value }] }));
    expect(lines.some((line) => line.startsWith('ATTENDEE'))).toBe(false);
  });

  it('drops the control characters RFC 5545 forbids and keeps tabs out of nothing else', () => {
    expect(escapeIcsText('a\u0000b\u0007c\u001fd')).toBe('abcd');
    expect(escapeIcsText('a;b,c\\d')).toBe('a\\;b\\,c\\\\d');
  });
});

describe('a calendar is bounded by the trip, not by a stored string', () => {
  it('never probes more than the cap, whatever years it is handed', () => {
    expect(yearsBetween('2026-01-01', '9999-12-31').length).toBe(MAX_VTIMEZONE_YEARS);
    const started = performance.now();
    vtimezoneFor('Europe/Lisbon', Array.from({ length: 8000 }, (_, i) => 2000 + i));
    expect(performance.now() - started).toBeLessThan(1500);
  });

  it('ignores years no calendar can mean', () => {
    expect(() => vtimezoneFor('Europe/Lisbon', [Number.NaN, -5, 99999])).not.toThrow();
  });
});

describe('a time zone nobody recognises is not a failed calendar', () => {
  it('knows a zone from a sentence', () => {
    expect(isKnownTimeZone('Asia/Tokyo')).toBe(true);
    for (const bad of ['PST (local)', 'Not/AZone', '', 'x'.repeat(200), null, undefined, 7]) expect(isKnownTimeZone(bad)).toBe(false);
  });

  it('writes the event in the primary zone and never prints the bad string', () => {
    const ics = buildCalendar({ ...DOCUMENT, primaryTimeZone: 'Europe/Lisbon', timeZones: ['Not/AZone', 'Europe/Lisbon'], events: [{ ...EVENT, timeZone: 'Not/AZone\r\nX-EVIL:1' }] });
    expect(ics).not.toContain('Not/AZone');
    expect(ics).not.toContain('X-EVIL');
    expect(ics).toContain('DTSTART;TZID=Europe/Lisbon:20260901T100000');
  });

  it('writes a floating time when no zone at all is known', () => {
    const ics = buildCalendar({ ...DOCUMENT, timeZones: ['Not/AZone'], events: [{ ...EVENT, timeZone: 'Not/AZone' }] });
    expect(ics).toContain('DTSTART:20260901T100000');
  });
});

describe('a stop past midnight is on the next day', () => {
  it('moves the date with the clock', () => {
    const ics = buildCalendar({ ...DOCUMENT, events: [{ ...EVENT, date: '2026-12-31', startMinute: 23 * 60 + 30, endMinute: 24 * 60 + 30 }] });
    expect(ics).toContain(':20261231T233000');
    expect(ics).toContain(':20270101T003000');
  });
});

describe('what may be written as a booked fact', () => {
  const base = { type: 'lodging' as const, title: 'Hotel' };

  it('refuses a date that is not a date, or not this era', () => {
    for (const date of ['9999-12-31', '2026-13-40', '2026-02-31', '1200-01-01']) {
      expect(bookedPlanItemInputSchema.safeParse({ ...base, date }).success, date).toBe(false);
    }
    expect(bookedPlanItemInputSchema.safeParse({ ...base, date: '2026-09-01' }).success).toBe(true);
  });

  it('drops a zone it cannot read rather than refusing the booking', () => {
    const parsed = bookedPlanItemInputSchema.parse({ ...base, timeZone: 'Pacific time' });
    expect(parsed.timeZone).toBeUndefined();
    expect(bookedPlanItemInputSchema.parse({ ...base, timeZone: 'Asia/Tokyo' }).timeZone).toBe('Asia/Tokyo');
  });

  it('accepts only http(s) links', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://user:pass@example.com/']) {
      expect(bookedPlanItemInputSchema.safeParse({ ...base, url }).success, url).toBe(false);
    }
    expect(bookedPlanItemInputSchema.safeParse({ ...base, url: 'https://example.com/booking' }).success).toBe(true);
  });

  it('a patch changes what it names and nothing else — an idea stays an idea', () => {
    expect(bookedPlanItemPatchSchema.parse({ cost: { amount: 10, currency: 'EUR' } })).toEqual({ cost: { amount: 10, currency: 'EUR' } });
    expect(bookedPlanItemPatchSchema.parse({})).toEqual({});
    expect(bookedPlanItemPatchSchema.parse({ status: 'idea' })).toEqual({ status: 'idea' });
  });
});

describe('redaction', () => {
  it('still removes what it always removed', () => {
    const out = redactSensitive('Mail jane.doe+x@example.co.uk, call +44 20 7946 0958, card 4111 1111 1111 1111.');
    for (const leak of ['jane.doe', 'example.co.uk', '7946', '4111']) expect(out).not.toContain(leak);
  });

  it.each([
    ['a run of letters', 'a'.repeat(512_000)],
    ['a run of zeros', '0'.repeat(512_000)],
    ['at-signs', 'a@'.repeat(256_000)],
  ])('is linear on %s at the import cap', (_name, input) => {
    const started = performance.now();
    redactSensitive(input);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
