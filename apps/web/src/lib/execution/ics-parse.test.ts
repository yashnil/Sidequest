import { describe, expect, it } from 'vitest';
import { buildCalendar, escapeIcsText, foldIcsLine } from '@sidequest/core';
import { findComponents, hasUnescapedSeparator, icsSyntaxDefects, octetLength, parseIcs, parseIcsLine, property, rawIcsLines, unescapeIcsText, unfoldIcs } from './ics-parse';

/**
 * V9.1 §8 — THE READER READS WHAT A CALENDAR CLIENT READS.
 *
 * First the reader on hand-written documents (folding, parameters, quoting,
 * nesting, escapes, the defect list), then the writer through the reader:
 * `buildCalendar` on the shapes that stress the physical layer — a
 * multi-byte summary long enough to fold, a comma in a location, an
 * apostrophe in a description — must produce a document with no syntax
 * defect and with the properties the three big clients key on.
 */
describe('the RFC 5545 reader', () => {
  it('unfolds a continuation line and keeps a line that only looks folded', () => {
    const text = 'BEGIN:VCALENDAR\r\nDESCRIPTION:one two\r\n  three\r\n\tfour\r\nEND:VCALENDAR\r\n';
    expect(rawIcsLines(text)).toHaveLength(5);
    expect(unfoldIcs(text)).toEqual(['BEGIN:VCALENDAR', 'DESCRIPTION:one two three' + 'four', 'END:VCALENDAR']);
  });

  it('splits a content line into name, parameters and value, honouring quoted parameter values', () => {
    const p = parseIcsLine('DTSTART;TZID=America/Los_Angeles;X-NOTE="a:b;c,d":20260812T093000');
    expect(p.name).toBe('DTSTART');
    expect(p.params).toEqual({ TZID: 'America/Los_Angeles', 'X-NOTE': 'a:b;c,d' });
    expect(p.value).toBe('20260812T093000');
    expect(parseIcsLine('url:https://example.test/a?b=c').name).toBe('URL');
    expect(() => parseIcsLine('NOVALUE')).toThrow(/no value separator/);
    expect(() => parseIcsLine('X;P:v')).toThrow(/Parameter without a value/);
  });

  it('walks BEGIN/END into nested components and refuses unbalanced nesting', () => {
    const doc = parseIcs(['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTIMEZONE', 'TZID:Z', 'BEGIN:STANDARD', 'DTSTART:20260101T000000', 'END:STANDARD', 'END:VTIMEZONE', 'BEGIN:VEVENT', 'UID:a', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'));
    expect(doc.name).toBe('VCALENDAR');
    expect(property(doc, 'version')?.value).toBe('2.0');
    expect(findComponents(doc, 'STANDARD')).toHaveLength(1);
    expect(findComponents(doc, 'VEVENT')[0]!.properties[0]!.value).toBe('a');
    expect(() => parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nEND:VCALENDAR\r\n')).toThrow(/closes VEVENT/);
    expect(() => parseIcs('BEGIN:VCALENDAR\r\n')).toThrow(/Unclosed/);
    expect(() => parseIcs('VERSION:2.0\r\n')).toThrow(/outside any component/);
  });

  it('undoes text escapes and spots a separator that was not escaped', () => {
    expect(unescapeIcsText('a\\, b\\; c\\\\ d\\nline')).toBe('a, b; c\\ d\nline');
    expect(hasUnescapedSeparator('Pósthússtræti 11\\, Reykjavík')).toBe(false);
    expect(hasUnescapedSeparator('Pósthússtræti 11, Reykjavík')).toBe(true);
    expect(hasUnescapedSeparator('a\\\\;b')).toBe(true);
    expect(escapeIcsText('a, b; c')).toBe('a\\, b\\; c');
  });

  it('names each physical defect a strict client rejects', () => {
    const long = `SUMMARY:${'x'.repeat(80)}`;
    expect(icsSyntaxDefects(`BEGIN:VCALENDAR\r\n${long}\r\nEND:VCALENDAR\r\n`)).toEqual([expect.stringContaining('Line 2 is 88 octets')]);
    expect(icsSyntaxDefects('BEGIN:VCALENDAR\nEND:VCALENDAR\r\n')).toContain('A bare LF is present; every line end must be CRLF.');
    expect(icsSyntaxDefects('BEGIN:VCALENDAR\r\nEND:VCALENDAR')).toContain('The document does not end with CRLF.');
    expect(icsSyntaxDefects('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')).toEqual([]);
    expect(octetLength('Reykjavík')).toBe(10);
  });
});

describe('the calendar writer, read back', () => {
  const stamp = '2026-09-11T10:00:00.000Z';
  const body = buildCalendar({
    name: 'Reykjavík — Sidequest',
    description: 'Ten autumn days. © OpenStreetMap contributors · Data © OpenMapTiles. All times are local to the destination.',
    timeZones: ['Atlantic/Reykjavik', 'America/Los_Angeles'],
    years: [2026],
    stamp,
    refreshInterval: 'PT1H',
    primaryTimeZone: 'Atlantic/Reykjavik',
    events: [
      {
        uid: 'trip-1-anchor-a@sidequest',
        date: '2026-09-21',
        startMinute: 9 * 60,
        endMinute: 10 * 60 + 30,
        timeZone: 'Atlantic/Reykjavik',
        summary: 'Þingvellir — the rift valley, Öxarárfoss, Silfra; then Geysir, Strokkur’s eruptions, Gullfoss',
        description: 'Iconic viewpoint; easy first stop after arrival, weather permitting.',
        location: 'Pósthússtræti 11, Reykjavík',
        status: 'tentative',
        sequence: 3,
      },
      {
        uid: 'trip-1-booked-b@sidequest',
        date: '2026-09-21',
        startMinute: 15 * 60,
        endMinute: 11 * 60,
        endDate: '2026-09-23',
        timeZone: 'America/Los_Angeles',
        summary: 'Booked: Hótel Borg',
        status: 'confirmed',
        categories: ['Booked'],
        sequence: 3,
      },
    ],
  });

  it('has no physical defect: CRLF, final CRLF, every line within 75 octets even when it folds multi-byte text', () => {
    expect(icsSyntaxDefects(body)).toEqual([]);
    /* A long non-ASCII summary was folded — the fold happened, and it happened within the octet limit. */
    expect(body).toMatch(/\r\n [^\r\n]/);
    for (const line of rawIcsLines(body)) expect(octetLength(line)).toBeLessThanOrEqual(75);
  });

  it('carries the properties Apple, Google and Outlook rely on', () => {
    const doc = parseIcs(body);
    expect(property(doc, 'VERSION')?.value).toBe('2.0');
    expect(property(doc, 'PRODID')?.value).toMatch(/^-\/\/Sidequest\/\//);
    expect(property(doc, 'METHOD')?.value).toBe('PUBLISH');
    expect(property(doc, 'CALSCALE')?.value).toBe('GREGORIAN');
    expect(property(doc, 'X-WR-CALNAME')?.value).toBe('Reykjavík — Sidequest');
    expect(property(doc, 'X-WR-TIMEZONE')?.value).toBe('Atlantic/Reykjavik');
    const refresh = property(doc, 'REFRESH-INTERVAL');
    expect(refresh?.params).toEqual({ VALUE: 'DURATION' });
    expect(refresh?.value).toBe('PT1H');
    expect(property(doc, 'X-PUBLISHED-TTL')?.value).toBe('PT1H');

    const zones = findComponents(doc, 'VTIMEZONE');
    expect(zones.map((z) => property(z, 'TZID')?.value).sort()).toEqual(['America/Los_Angeles', 'Atlantic/Reykjavik']);
    /* Los Angeles changes offset in 2026; Reykjavík does not. Each has at least the opening STANDARD. */
    expect(findComponents(zones.find((z) => property(z, 'TZID')?.value === 'America/Los_Angeles')!, 'DAYLIGHT').length).toBeGreaterThanOrEqual(1);
    for (const zone of zones) for (const part of zone.components) expect(['STANDARD', 'DAYLIGHT']).toContain(part.name);

    const events = findComponents(doc, 'VEVENT');
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(property(event, 'DTSTAMP')?.value).toBe('20260911T100000Z');
      expect(property(event, 'SEQUENCE')?.value).toMatch(/^\d+$/);
      expect(['CONFIRMED', 'TENTATIVE']).toContain(property(event, 'STATUS')?.value);
      expect(property(event, 'DTSTART')?.params.TZID).toBeDefined();
      expect(property(event, 'DTEND')?.params.TZID).toBe(property(event, 'DTSTART')?.params.TZID);
      expect(zones.map((z) => property(z, 'TZID')?.value)).toContain(property(event, 'DTSTART')?.params.TZID);
      for (const name of ['SUMMARY', 'DESCRIPTION', 'LOCATION']) {
        const value = property(event, name)?.value;
        if (value !== undefined) expect(hasUnescapedSeparator(value), `${name} left a separator unescaped: ${value}`).toBe(false);
      }
    }
    expect(unescapeIcsText(property(events[0]!, 'LOCATION')!.value)).toBe('Pósthússtræti 11, Reykjavík');
    expect(unescapeIcsText(property(events[0]!, 'SUMMARY')!.value)).toContain('Öxarárfoss, Silfra; then');
    expect(property(events[1]!, 'STATUS')?.value).toBe('CONFIRMED');
    expect(property(events[1]!, 'CATEGORIES')?.value).toBe('Booked');
    expect(property(events[1]!, 'DTEND')?.value).toBe('20260923T110000');
  });

  it('writes byte-identical output for the same input, so a subscribed client sees an update only when something changed', () => {
    const again = buildCalendar({ name: 'x', description: 'y', timeZones: ['UTC'], years: [2026], stamp, events: [] });
    expect(again).toBe(buildCalendar({ name: 'x', description: 'y', timeZones: ['UTC'], years: [2026], stamp, events: [] }));
    expect(foldIcsLine('short')).toBe('short');
  });
});
