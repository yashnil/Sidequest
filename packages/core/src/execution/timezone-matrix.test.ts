import { describe, expect, it } from 'vitest';
import type { Itinerary, ItineraryDay, ItineraryItem } from '../schemas/itinerary';
import type { BookedPlanItem } from '../intelligence/booking';
import { buildTodayView, localClock } from '../intelligence/today';
import { buildCalendar, vtimezoneFor, yearsBetween, type CalendarEvent } from './calendar';
import { isCivilTimeZone, utcOffsetMinutesOn } from '../time/zone';

/**
 * V9.1 §9 — THE TIMEZONE MATRIX, ON THE CORE BUILDERS.
 *
 * Every row proves the same three things about one shape of trip: Today's
 * `localClock` is the civil zone where the traveller is standing, a leave-by
 * is computed on that clock, and the calendar writes each local time with
 * the civil zone as its `TZID`. The rows are the ones that break products:
 * one zone, a country with no compiled polygon, two zones in one trip, a
 * flight that crosses zones, a daylight-saving change inside the trip, and
 * the date line. Every instant is fixed; nothing reads the wall clock.
 */
function item(overrides: Partial<ItineraryItem> & { id: string; title: string; startMinute: number; endMinute: number }): ItineraryItem {
  return { kind: 'activity', durationMinutes: overrides.endMinute - overrides.startMinute, reason: 'r', weatherSensitive: false, ...overrides } as ItineraryItem;
}

const leg = (id: string, from: string, to: string, start: number, minutes: number) =>
  item({ id, kind: 'travel', title: `${from} → ${to}`, startMinute: start, endMinute: start + minutes, travel: { fromId: from, toId: to, fromName: from, toName: to, minutes, km: 20, mode: 'drive', role: 'approach', provenance: 'measured', basis: 'static' } as ItineraryItem['travel'] });

function day(dayNumber: number, date: string, baseId: string, baseName: string, items: ItineraryItem[]): ItineraryDay {
  return {
    dayNumber,
    date,
    baseId,
    baseName,
    theme: `Day ${dayNumber}`,
    window: { startMinute: 8 * 60, endMinute: 20 * 60, usableMinutes: 12 * 60 },
    items,
    totals: { activityMinutes: 0, travelMinutes: 0, driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, estimatedMinutes: 0, allowanceMinutes: 0, travelKm: 0, freeMinutes: 120, strenuousCount: 0, unmeasuredLegCount: 0 },
    transport: { primaryMode: 'drive', modes: ['drive'], serviceIds: [], parkingNotes: [], accessNotes: [], verifyBeforeTravel: [] },
    availability: { flexiblePlaceIds: [], cautions: [], verifyBeforeTravel: [], bookings: [] },
    weather: { evidence: 'historical_pattern', summary: 'Mild', decisions: [], cautions: [], backups: [], provider: 'fixture', attribution: 'fixture' },
    food: { summary: 'n/a', slots: [], remote: false, notes: [], reservations: [] },
    intensity: 'moderate',
    warnings: [],
  } as unknown as ItineraryDay;
}

function itinerary(days: ItineraryDay[]): Itinerary {
  return { tripId: 'trip-tz', version: 9, regionId: 'dynamic', baseId: days[0]!.baseId, baseName: days[0]!.baseName, startDate: days[0]!.date, endDate: days[days.length - 1]!.date, status: 'ready', summary: 's', days, issues: [], unscheduled: [] } as unknown as Itinerary;
}

/** A morning stop, a measured 30-minute leg, a late-morning stop — on every day of every trip below. */
const standardDay = (n: number, date: string, baseId: string, baseName: string) => day(n, date, baseId, baseName, [item({ id: `d${n}-a`, title: `${baseName} morning`, startMinute: 9 * 60, endMinute: 10 * 60 }), leg(`d${n}-leg`, `${baseName} morning`, `${baseName} late`, 10 * 60, 30), item({ id: `d${n}-b`, title: `${baseName} late morning`, startMinute: 11 * 60, endMinute: 12 * 60 })]);

const event = (uid: string, date: string, startMinute: number, timeZone: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ uid, date, startMinute, endMinute: startMinute + 60, timeZone, summary: uid, status: 'tentative', sequence: 1, ...extra });

function calendarFor(events: CalendarEvent[], zones: string[], primary: string): string {
  const dates = events.map((e) => e.date).sort();
  return buildCalendar({ name: 'tz', description: 'tz', timeZones: zones, years: yearsBetween(dates[0]!, dates[dates.length - 1]!), events, stamp: '2026-09-11T00:00:00.000Z', primaryTimeZone: primary });
}

describe('one zone: Asia/Tokyo', () => {
  const plan = itinerary([standardDay(1, '2026-10-05', 'tokyo', 'Tokyo')]);
  /* 01:30 UTC is 10:30 in Tokyo, between the morning stop and the leg. */
  const now = new Date('2026-10-05T01:30:00Z');

  it('Today runs on the Tokyo clock and leaves by the measured leg on that clock', () => {
    const today = buildTodayView({ itinerary: plan, booked: [], backups: [], now, timeZone: 'Asia/Tokyo' });
    expect(localClock(now, 'Asia/Tokyo')).toEqual({ date: '2026-10-05', minute: 10 * 60 + 30 });
    expect(today.active).toBe(true);
    expect(today.localDate).toBe('2026-10-05');
    expect(today.nowMinute).toBe(10 * 60 + 30);
    expect(today.leaveBy?.time).toBe('10:30');
    expect(today.leaveBy?.basis).toBe('static');
    /* The same instant on UTC would be a different day entirely: the zone is load-bearing. */
    expect(buildTodayView({ itinerary: plan, booked: [], backups: [], now, timeZone: 'UTC' }).localDate).toBe('2026-10-05');
    expect(buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-10-04T16:00:00Z'), timeZone: 'Asia/Tokyo' }).localDate).toBe('2026-10-05');
    expect(buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-10-04T16:00:00Z'), timeZone: 'UTC' }).localDate).toBe('2026-10-04');
  });

  it('the calendar writes one STANDARD component and TZID=Asia/Tokyo on every local time', () => {
    const ics = calendarFor([event('a', '2026-10-05', 9 * 60, 'Asia/Tokyo')], ['Asia/Tokyo'], 'Asia/Tokyo');
    expect(vtimezoneFor('Asia/Tokyo', [2026]).filter((l) => l.startsWith('BEGIN:'))).toEqual(['BEGIN:VTIMEZONE', 'BEGIN:STANDARD']);
    expect(ics).toContain('DTSTART;TZID=Asia/Tokyo:20261005T090000');
    expect(ics).not.toContain('BEGIN:DAYLIGHT');
    expect(isCivilTimeZone('Asia/Tokyo')).toBe(true);
  });
});

describe('a multi-zone trip: America/Denver then America/Los_Angeles', () => {
  const plan = itinerary([standardDay(1, '2026-10-05', 'den', 'Denver'), standardDay(2, '2026-10-06', 'lax', 'Los Angeles')]);
  const zonesByBaseId = { den: 'America/Denver', lax: 'America/Los_Angeles' };

  it('Today clocks each day against its own base zone, and the leave-by follows', () => {
    /* 16:30 UTC on the 5th is 10:30 in Denver. */
    const denver = buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-10-05T16:30:00Z'), timeZone: 'America/Denver', zonesByBaseId });
    expect(denver.dayNumber).toBe(1);
    expect(denver.nowMinute).toBe(10 * 60 + 30);
    expect(denver.leaveBy?.time).toBe('10:30');
    /* 17:30 UTC on the 6th is 10:30 in Los Angeles — and would be 11:30 on the trip's Denver clock. */
    const la = buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-10-06T17:30:00Z'), timeZone: 'America/Denver', zonesByBaseId });
    expect(la.dayNumber).toBe(2);
    expect(la.nowMinute).toBe(10 * 60 + 30);
    expect(la.leaveBy?.time).toBe('10:30');
    expect(la.leaveBy?.minutesFromNow).toBe(0);
    /* Without the per-base zones the trip clock stands, exactly as before. */
    expect(buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-10-06T17:30:00Z'), timeZone: 'America/Denver' }).nowMinute).toBe(11 * 60 + 30);
  });

  it('the day is chosen where its base is: 23:30 in Denver on the 5th is still day 1, not day 2 in Los Angeles', () => {
    /* 05:30 UTC on the 6th: 23:30 on the 5th in Denver, 22:30 on the 5th in Los Angeles — day 1 under its own zone. */
    const late = buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-10-06T05:30:00Z'), timeZone: 'America/Denver', zonesByBaseId });
    expect(late.dayNumber).toBe(1);
    expect(late.localDate).toBe('2026-10-05');
    expect(late.nowMinute).toBe(23 * 60 + 30);
  });

  it('the calendar carries both zones, each event with its own TZID', () => {
    const ics = calendarFor([event('den', '2026-10-05', 9 * 60, 'America/Denver'), event('lax', '2026-10-06', 9 * 60, 'America/Los_Angeles')], ['America/Denver', 'America/Los_Angeles'], 'America/Denver');
    expect(ics.match(/BEGIN:VTIMEZONE/g)).toHaveLength(2);
    expect(ics).toContain('TZID:America/Denver');
    expect(ics).toContain('TZID:America/Los_Angeles');
    expect(ics).toContain('DTSTART;TZID=America/Denver:20261005T090000');
    expect(ics).toContain('DTSTART;TZID=America/Los_Angeles:20261006T090000');
  });
});

describe('a flight crossing zones: the booking keeps its own zone', () => {
  const plan = itinerary([standardDay(1, '2026-10-05', 'lax', 'Los Angeles'), standardDay(2, '2026-10-06', 'den', 'Denver')]);
  const flight: BookedPlanItem = { id: 'bk-flight', tripId: 'trip-tz', type: 'flight', title: 'UA 123 LAX → DEN', date: '2026-10-05', startTime: '14:00', endTime: '17:20', timeZone: 'America/Los_Angeles', status: 'booked', locked: true, createdAt: '2026-09-01T00:00:00.000Z' };

  it('Today lists it on the day it departs, and the calendar writes its own TZID rather than the day base zone', () => {
    const today = buildTodayView({ itinerary: plan, booked: [flight], backups: [], now: new Date('2026-10-05T16:30:00Z'), timeZone: 'America/Los_Angeles', zonesByBaseId: { lax: 'America/Los_Angeles', den: 'America/Denver' } });
    expect(today.bookedToday.map((b) => b.id)).toEqual(['bk-flight']);
    expect(today.bookedToday[0]?.startTime).toBe('14:00');
    const ics = calendarFor([event('bk-flight', '2026-10-05', 14 * 60, flight.timeZone!, { endMinute: 17 * 60 + 20, status: 'confirmed', categories: ['Booked'] })], ['America/Los_Angeles', 'America/Denver'], 'America/Denver');
    expect(ics).toContain('DTSTART;TZID=America/Los_Angeles:20261005T140000');
    expect(ics).toContain('DTEND;TZID=America/Los_Angeles:20261005T172000');
  });
});

describe('a daylight-saving transition inside the trip: America/Edmonton, 2026-11-01', () => {
  const before = utcOffsetMinutesOn('2026-10-31', 'America/Edmonton');
  const after = utcOffsetMinutesOn('2026-11-01', 'America/Edmonton');

  it('the runtime tz data moves the clock on 1 November (the premise of every assertion below)', () => {
    expect(before).toBe(-360);
    expect(after).toBe(-420);
  });

  it('vtimezoneFor emits the STANDARD component dated at local midnight of the change, with the offsets either side', () => {
    const lines = vtimezoneFor('America/Edmonton', [2026]);
    const at = lines.indexOf('DTSTART:20261101T000000');
    expect(at).toBeGreaterThan(0);
    expect(lines[at - 1]).toBe('BEGIN:STANDARD');
    expect(lines[at + 1]).toBe('TZOFFSETFROM:-0600');
    expect(lines[at + 2]).toBe('TZOFFSETTO:-0700');
    expect(lines).toContain('BEGIN:DAYLIGHT');
  });

  it('a 06:00 wall time stays 06:00 before and after: Today, the leave-by and the calendar all read the civil clock', () => {
    const early = (n: number, date: string) => day(n, date, 'yeg', 'Edmonton', [leg(`d${n}-leg`, 'Hotel', 'Trailhead', 5 * 60 + 15, 45), item({ id: `d${n}-a`, title: 'Sunrise walk', startMinute: 6 * 60, endMinute: 8 * 60 })]);
    const plan = itinerary([early(1, '2026-10-31'), early(2, '2026-11-01')]);
    /* 05:00 local on each side of the change is a different instant in UTC; both read 05:00 here. */
    const dayBefore = buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-10-31T11:00:00Z'), timeZone: 'America/Edmonton' });
    const dayAfter = buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-11-01T12:00:00Z'), timeZone: 'America/Edmonton' });
    expect([dayBefore.localDate, dayBefore.nowMinute]).toEqual(['2026-10-31', 5 * 60]);
    expect([dayAfter.localDate, dayAfter.nowMinute]).toEqual(['2026-11-01', 5 * 60]);
    expect(dayBefore.next?.startMinute).toBe(6 * 60);
    expect(dayAfter.next?.startMinute).toBe(6 * 60);
    expect(dayBefore.leaveBy?.time).toBe('05:15');
    expect(dayAfter.leaveBy?.time).toBe('05:15');
    const ics = calendarFor([event('walk-1', '2026-10-31', 6 * 60, 'America/Edmonton'), event('walk-2', '2026-11-01', 6 * 60, 'America/Edmonton')], ['America/Edmonton'], 'America/Edmonton');
    expect(ics).toContain('DTSTART;TZID=America/Edmonton:20261031T060000');
    expect(ics).toContain('DTSTART;TZID=America/Edmonton:20261101T060000');
  });
});

describe('the date line: Pacific/Auckland and Pacific/Honolulu', () => {
  /* 20:00 UTC on 5 October: 09:00 on the 6th in Auckland (NZDT, UTC+13), 10:00 on the 5th in Honolulu (UTC−10). */
  const instant = new Date('2026-10-05T20:00:00Z');

  it('localClock is each side’s civil date and minute — a day apart at the same instant', () => {
    expect(localClock(instant, 'Pacific/Auckland')).toEqual({ date: '2026-10-06', minute: 9 * 60 });
    expect(localClock(instant, 'Pacific/Honolulu')).toEqual({ date: '2026-10-05', minute: 10 * 60 });
    expect(utcOffsetMinutesOn('2026-10-06', 'Pacific/Auckland')).toBe(13 * 60);
    expect(utcOffsetMinutesOn('2026-10-05', 'Pacific/Honolulu')).toBe(-10 * 60);
  });

  it('Today and the calendar each use the side the traveller is on', () => {
    const plan = itinerary([standardDay(1, '2026-10-06', 'akl', 'Auckland'), standardDay(2, '2026-10-07', 'hnl', 'Honolulu')]);
    const zonesByBaseId = { akl: 'Pacific/Auckland', hnl: 'Pacific/Honolulu' };
    const auckland = buildTodayView({ itinerary: plan, booked: [], backups: [], now: instant, timeZone: 'Pacific/Auckland', zonesByBaseId });
    expect([auckland.dayNumber, auckland.localDate, auckland.nowMinute]).toEqual([1, '2026-10-06', 9 * 60]);
    /* 20:00 UTC on the 7th: 09:00 on the 8th in Auckland (past the trip), 10:00 on the 7th in Honolulu — day 2 on its own clock. */
    const honolulu = buildTodayView({ itinerary: plan, booked: [], backups: [], now: new Date('2026-10-07T20:00:00Z'), timeZone: 'Pacific/Auckland', zonesByBaseId });
    expect([honolulu.dayNumber, honolulu.localDate, honolulu.nowMinute]).toEqual([2, '2026-10-07', 10 * 60]);
    const ics = calendarFor([event('akl', '2026-10-06', 9 * 60, 'Pacific/Auckland'), event('hnl', '2026-10-07', 9 * 60, 'Pacific/Honolulu')], ['Pacific/Auckland', 'Pacific/Honolulu'], 'Pacific/Auckland');
    expect(ics).toContain('DTSTART;TZID=Pacific/Auckland:20261006T090000');
    expect(ics).toContain('DTSTART;TZID=Pacific/Honolulu:20261007T090000');
    expect(ics).toContain('TZID:Pacific/Auckland');
    expect(ics).toContain('TZID:Pacific/Honolulu');
  });

  /*
   * WHAT THE SCHEMAS CANNOT SAY, STATED RATHER THAN FORCED.
   *
   * An eastward crossing lands before it took off: a flight leaving Auckland at
   * 20:00 on the 6th arrives in Honolulu at 08:30 on the 6th. `BookedPlanItem`
   * carries one `timeZone` (the departure's) and, for a flight, no `endDate`
   * and no arrival zone, so the arrival's civil time cannot be recorded on the
   * booking; and `ItineraryDay.date` is one calendar date per day in sequence,
   * so a trip cannot hold the 6th twice (once per side). The calendar and Today
   * therefore show the departure side correctly and say nothing false about
   * the arrival — they do not invent it. Both gaps are recorded in report-f.
   */
  it('a booked crossing carries its departure zone only; the arrival side is not expressible on the current shapes', () => {
    const crossing: BookedPlanItem = { id: 'bk-x', tripId: 'trip-tz', type: 'flight', title: 'NZ 10 AKL → HNL', date: '2026-10-06', startTime: '20:00', endTime: '08:30', timeZone: 'Pacific/Auckland', status: 'booked', locked: true, createdAt: '2026-09-01T00:00:00.000Z' };
    expect('endDate' in crossing).toBe(false);
    expect(Object.keys(crossing).filter((k) => /arriv/i.test(k))).toEqual([]);
  });
});
