import { describe, expect, it } from 'vitest';
import type { BookedPlanItem, Itinerary } from '@sidequest/core';
import { buildTripCalendar, calendarEventsFor, calendarUidFor, isCalendarItem, type TripCalendarSource } from './calendar-events';

/**
 * V9 §10 — THE PURE HALF: EVENTS WITH STABLE UIDS AND NO PRIVATE FACT.
 *
 * A hand-built itinerary rather than a planned one, because the properties
 * under test are about identity and privacy, not about planning: an anchor's
 * UID survives a rebuild, a day-scoped id is the fallback, a booked fact is
 * `CONFIRMED` and categorised, and the confirmation reference typed on it
 * never reaches the calendar.
 */
const item = (id: string, kind: 'activity' | 'meal' | 'travel' | 'free_time', start: number, minutes: number, extra: Record<string, unknown> = {}) => ({
  id,
  kind,
  title: `Item ${id}`,
  startMinute: start,
  endMinute: start + minutes,
  durationMinutes: minutes,
  reason: `Why ${id}.`,
  weatherSensitive: false,
  ...extra,
});

const itinerary = {
  version: 9,
  tripId: 'trip-a',
  regionId: 'r',
  baseId: 'base-1',
  baseName: 'Reykjavík',
  startDate: '2026-09-20',
  endDate: '2026-09-21',
  status: 'ready',
  summary: 'Two days.',
  days: [
    {
      dayNumber: 1,
      date: '2026-09-20',
      baseId: 'base-1',
      baseName: 'Reykjavík',
      theme: 'Arrival',
      items: [
        item('it-1', 'activity', 9 * 60, 90, { placeId: 'harpa', hours: { openMinute: 8 * 60, closeMinute: 20 * 60 }, verifyBeforeTravel: 'Winter hours may differ.' }),
        item('it-2', 'travel', 11 * 60, 20),
        item('it-3', 'travel', 12 * 60, 60),
        item('it-4', 'meal', 13 * 60, 60, { food: { slot: 'lunch', venueName: 'Sægreifinn' } }),
        item('it-5', 'free_time', 14 * 60, 120),
      ],
    },
    {
      dayNumber: 2,
      date: '2026-09-21',
      baseId: 'base-2',
      baseName: 'Vík',
      theme: 'South coast',
      items: [item('it-6', 'activity', 10 * 60, 60, { placeId: 'reynisfjara' })],
    },
  ],
  package: {
    anchors: [
      { id: 'anchor-harpa', dayNumber: 1, name: 'Harpa', role: 'core', category: 'landmark', disposition: 'preserved', verification: 'verified', placeId: 'harpa' },
      { id: 'it-6', dayNumber: 2, name: 'Reynisfjara', role: 'core', category: 'nature', disposition: 'preserved', verification: 'verified' },
    ],
    bases: [],
  },
} as unknown as Itinerary;

const booked: BookedPlanItem = {
  id: 'bk-1',
  tripId: 'trip-a',
  type: 'lodging',
  title: 'Hotel Borg',
  date: '2026-09-20',
  endDate: '2026-09-21',
  location: 'Pósthússtræti 11, Reykjavík',
  confirmationRef: 'CONF-SECRET-42',
  notes: 'Ask for the quiet side.',
  cost: { amount: 420, currency: 'EUR' },
  url: 'https://example.test/booking/42',
  status: 'booked',
  locked: true,
  createdAt: '2026-09-01T00:00:00.000Z',
};

const source: TripCalendarSource = {
  tripId: 'trip-a',
  itinerary,
  booked: [booked],
  zonesByBaseId: { 'base-1': 'Atlantic/Reykjavik', 'base-2': 'Etc/GMT+1' },
  primaryTimeZone: 'Atlantic/Reykjavik',
  coordinates: { harpa: { lat: 64.1505, lng: -21.9325 } },
  sequence: 3,
};

describe('calendarEventsFor', () => {
  const derived = calendarEventsFor(source);

  it('exports activities, meals and legs of 45 minutes or more, never free time or a short leg', () => {
    expect(derived.events.map((e) => e.uid)).toEqual([
      'trip-a-booked-bk-1@sidequest',
      'trip-a-anchor-anchor-harpa@sidequest',
      'trip-a-day-1-it-3@sidequest',
      'trip-a-day-1-it-4@sidequest',
      'trip-a-anchor-it-6@sidequest',
    ]);
    expect(isCalendarItem(item('x', 'free_time', 0, 60) as never)).toBe(false);
    expect(isCalendarItem(item('x', 'travel', 0, 30) as never)).toBe(false);
    expect(isCalendarItem(item('booked:x', 'activity', 0, 30) as never)).toBe(false);
  });

  it('keys an item to its package anchor by item id, then by place id, then falls back to the day-scoped id', () => {
    expect(calendarUidFor('trip-a', itinerary.days[0]!.items[0]!, 1, itinerary)).toBe('trip-a-anchor-anchor-harpa@sidequest');
    expect(calendarUidFor('trip-a', itinerary.days[1]!.items[0]!, 2, itinerary)).toBe('trip-a-anchor-it-6@sidequest');
    expect(calendarUidFor('trip-a', itinerary.days[0]!.items[3]!, 1, itinerary)).toBe('trip-a-day-1-it-4@sidequest');
  });

  it('marks a booked fact confirmed and categorised, and a suggestion tentative', () => {
    const lodging = derived.events[0]!;
    expect(lodging.status).toBe('confirmed');
    expect(lodging.categories).toEqual(['Booked']);
    expect(lodging.summary).toBe('Booked: Hotel Borg');
    expect(lodging.location).toBe('Pósthússtræti 11, Reykjavík');
    expect(lodging.endDate).toBe('2026-09-21');
    expect(lodging.startMinute).toBe(15 * 60);
    expect(lodging.endMinute).toBe(11 * 60);
    for (const event of derived.events.slice(1)) expect(event.status).toBe('tentative');
  });

  it('gives every event the day base zone and the trip version, and lists every zone and year once', () => {
    expect(derived.events.find((e) => e.uid.includes('it-6'))?.timeZone).toBe('Etc/GMT+1');
    expect(derived.events.find((e) => e.uid.includes('harpa'))?.timeZone).toBe('Atlantic/Reykjavik');
    expect(derived.events.every((e) => e.sequence === 3)).toBe(true);
    expect(derived.timeZones.sort()).toEqual(['Atlantic/Reykjavik', 'Etc/GMT+1']);
    expect(derived.years).toEqual([2026]);
  });

  it('writes reason, hours and verify-before-travel into the description, and a GEO where a position is known', () => {
    const harpa = derived.events[1]!;
    expect(harpa.description).toBe('Why it-1. Open 08:00–20:00. Check before travel: Winter hours may differ.');
    expect(harpa.geo).toEqual({ lat: 64.1505, lng: -21.9325 });
    expect(derived.events[3]!.summary).toBe('Item it-4 — lunch');
  });
});

describe('buildTripCalendar', () => {
  const body = buildTripCalendar(source, { name: 'Test', summary: 'Two days.', attributions: ['© OpenStreetMap contributors'], stamp: '2026-09-11T10:00:00.000Z', refreshInterval: 'PT1H' });

  it('is a VCALENDAR with TZID on every local time, a VTIMEZONE per zone, SEQUENCE and STATUS', () => {
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(body.match(/BEGIN:VTIMEZONE/g)).toHaveLength(2);
    expect(body).toContain('TZID:Atlantic/Reykjavik');
    expect(body).toContain('DTSTART;TZID=Atlantic/Reykjavik:20260920T150000');
    expect(body).toContain('DTEND;TZID=Atlantic/Reykjavik:20260921T110000');
    expect(body.match(/^SEQUENCE:3$/gm)).toHaveLength(5);
    expect(body).toContain('STATUS:CONFIRMED');
    expect(body).toContain('CATEGORIES:Booked');
    expect(body).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT1H');
    expect(body).toContain('X-PUBLISHED-TTL:PT1H');
    expect(body).toContain('OpenStreetMap');
  });

  it('carries no confirmation reference, no note, no cost and no booking URL', () => {
    expect(body).not.toContain('CONF-SECRET-42');
    expect(body).not.toContain('quiet side');
    expect(body).not.toContain('420');
    expect(body).not.toContain('example.test');
  });

  it('is byte-stable for the same input and stamp', () => {
    expect(buildTripCalendar(source, { name: 'Test', summary: 'Two days.', attributions: ['x'], stamp: '2026-09-11T10:00:00.000Z' })).toBe(
      buildTripCalendar(source, { name: 'Test', summary: 'Two days.', attributions: ['x'], stamp: '2026-09-11T10:00:00.000Z' }),
    );
  });
});
