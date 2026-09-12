import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { planTrip } from '@sidequest/planner';
import { buildTodayView, type BookedPlanItem, type DestinationResolution, type Itinerary, type ItineraryDay, type ItineraryItem } from '@sidequest/core';
import { AUGUST_BASICS, buildScenario } from '../../../../../packages/planner/src/testing/scenario';
import type { TripIntentRecord } from '@/lib/db/compiler-repository';
import { buildTripCalendar, calendarEventsFor, calendarZonesFor } from './calendar-events';
import { destinationTimeZoneOf } from './destination-zone';

/**
 * V9.1 §9 — THE TIMEZONE MATRIX, ON THE WEB RESOLVERS.
 *
 * The core half of the matrix proves the builders; this half proves where
 * the zone they are given comes from. `destinationTimeZoneOf` reads the
 * resolved intent, `calendarZonesFor` ranks compiled base → destination →
 * solar time → UTC, and `loadTripCalendarSource` wires the two to the
 * database. The Iceland case is the live V9 defect: a regionless build whose
 * bases sit at −20° and whose clocks say UTC, which solar time called UTC−1.
 * `deriveTimeZoneFromLongitude` is spied on for the database-backed case so
 * the last resort is proved unreachable when the intent knows a zone — and
 * proved reachable, on a control trip, so the silence means something.
 */
vi.mock('@sidequest/core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, deriveTimeZoneFromLongitude: vi.fn(actual.deriveTimeZoneFromLongitude as (longitude: number) => string) };
});

const DRAFT = JSON.parse(readFileSync(join(__dirname, '..', 'planning', 'acceptance', 'fixtures', 'iceland', 'live-v9-draft.json'), 'utf8')) as {
  window: { startDate: string; endDate: string };
  bases: { id: string; name: string; nights: number; why: string }[];
  days: { dayNumber: number; baseId: string; theme: string; anchors: { name: string }[] }[];
};

/** The live bases, placed: every longitude rounds to solar UTC−1, which is exactly the wrong answer. */
const ICELAND_COORDINATES: Record<string, { lat: number; lng: number }> = {
  reykjavik: { lat: 64.1466, lng: -21.9426 },
  vik: { lat: 63.4194, lng: -19.0061 },
  'hofn-area': { lat: 64.2539, lng: -15.2082 },
  selfoss: { lat: 63.9337, lng: -20.9974 },
  'reykjavik-2': { lat: 64.1466, lng: -21.9426 },
};

const icelandBases = () => DRAFT.bases.map((b) => ({ id: b.id, name: b.name, nights: b.nights, why: b.why, verification: 'verified' as const, coordinates: ICELAND_COORDINATES[b.id]! }));

function candidate(id: string, timeZones: string[]): DestinationResolution['candidates'][number] {
  return { id, displayName: 'Iceland', qualifiedName: 'Iceland', entityType: 'country', breadth: 'country', center: { lat: 64.9631, lng: -19.0208 }, countryCode: 'IS', aliases: [], administrativeAreas: [], timeZones, providerRefs: [], confidence: { level: 'high', signals: [], note: 'One country by that name.' } };
}

function resolution(candidates: DestinationResolution['candidates'], unambiguousCandidateId?: string): DestinationResolution {
  return { schemaVersion: 1, query: 'Iceland', normalizedQuery: 'iceland', candidates, ambiguityReasons: [], ...(unambiguousCandidateId ? { unambiguousCandidateId } : {}), providersConsulted: ['nominatim'], resolvedAt: '2026-09-01T00:00:00.000Z' };
}

function intentWith(overrides: Partial<TripIntentRecord>): TripIntentRecord {
  return { tripId: 't', mode: 'known_destination', destinationQuery: 'Iceland', resolution: null, selectedCandidateId: null, clarifications: {}, scope: null, scopeRevision: 0, selectedCompiledRegionId: null, discoveryPreferences: null, composer: null, selectedDestination: null, preflight: null, destinationIntent: null, ...overrides } as unknown as TripIntentRecord;
}

describe('destinationTimeZoneOf: what the resolved intent knows', () => {
  it('reads the chosen candidate’s civil zone, and nothing from an intent that has none', () => {
    expect(destinationTimeZoneOf(null)).toBeUndefined();
    expect(destinationTimeZoneOf(intentWith({}))).toBeUndefined();
    expect(destinationTimeZoneOf(intentWith({ resolution: resolution([candidate('is', ['Atlantic/Reykjavik'])], 'is') }))).toBe('Atlantic/Reykjavik');
  });

  it('prefers the traveller’s selection over the resolver’s first row, then the unambiguous row, then the first', () => {
    const two = resolution([candidate('a', ['America/Denver']), candidate('b', ['Atlantic/Reykjavik'])]);
    expect(destinationTimeZoneOf(intentWith({ resolution: two, selectedCandidateId: 'b' }))).toBe('Atlantic/Reykjavik');
    expect(destinationTimeZoneOf(intentWith({ resolution: { ...two, unambiguousCandidateId: 'b' } }))).toBe('Atlantic/Reykjavik');
    expect(destinationTimeZoneOf(intentWith({ resolution: two }))).toBe('America/Denver');
  });

  it('never returns a fixed offset as a destination’s clock, and falls back to a resolved part of the intent graph', () => {
    expect(destinationTimeZoneOf(intentWith({ resolution: resolution([candidate('is', ['Etc/GMT+1'])], 'is') }))).toBeUndefined();
    const withGraph = intentWith({ resolution: resolution([candidate('is', [])], 'is'), destinationIntent: { graph: { children: [{ resolution: { timeZone: 'Etc/GMT-9' } }, { resolution: { timeZone: 'Asia/Tokyo' } }] } } as never });
    expect(destinationTimeZoneOf(withGraph)).toBe('Asia/Tokyo');
  });
});

describe('calendarZonesFor: compiled base → destination → solar time → UTC', () => {
  it('a broad region with no compiled polygon takes the destination’s civil zone on every base — Iceland is Atlantic/Reykjavik, never Etc/GMT+1', () => {
    const zones = calendarZonesFor({ compiledBases: [], packageBases: icelandBases(), destinationZone: 'Atlantic/Reykjavik', itineraryBaseId: 'reykjavik' });
    expect(zones.timeZone).toBe('Atlantic/Reykjavik');
    expect(zones.primaryTimeZone).toBe('Atlantic/Reykjavik');
    expect(Object.keys(zones.zonesByBaseId).sort()).toEqual(DRAFT.bases.map((b) => b.id).sort());
    expect(new Set(Object.values(zones.zonesByBaseId))).toEqual(new Set(['Atlantic/Reykjavik']));
  });

  it('solar time is the last resort, reached only when nothing knows a zone, and it names itself as a fixed offset', () => {
    const zones = calendarZonesFor({ compiledBases: [], packageBases: icelandBases(), destinationZone: undefined, itineraryBaseId: 'reykjavik' });
    expect(zones.timeZone).toBeUndefined();
    expect(new Set(Object.values(zones.zonesByBaseId))).toEqual(new Set(['Etc/GMT+1']));
    expect(zones.primaryTimeZone).toBe('Etc/GMT+1');
    expect(calendarZonesFor({ compiledBases: [], packageBases: [{ id: 'x' }], destinationZone: undefined, itineraryBaseId: 'x' })).toEqual({ zonesByBaseId: {}, primaryTimeZone: 'UTC', timeZone: undefined });
  });

  it('a compiled base’s published zone outranks the destination’s; a multi-zone trip keeps one zone per base and the itinerary base sets the wall clock', () => {
    const zones = calendarZonesFor({ compiledBases: [{ id: 'den', timeZone: 'America/Denver' }, { id: 'lax', timeZone: 'America/Los_Angeles' }], packageBases: [{ id: 'den', coordinates: { lat: 39.74, lng: -104.99 } }, { id: 'lax', coordinates: { lat: 34.05, lng: -118.24 } }, { id: 'stopover' }], destinationZone: 'America/Phoenix', itineraryBaseId: 'den' });
    expect(zones.zonesByBaseId).toEqual({ den: 'America/Denver', lax: 'America/Los_Angeles', stopover: 'America/Phoenix' });
    expect(zones.timeZone).toBe('America/Denver');
    expect(zones.primaryTimeZone).toBe('America/Denver');
    const tokyo = calendarZonesFor({ compiledBases: [{ id: 'tokyo', timeZone: 'Asia/Tokyo' }], packageBases: [{ id: 'tokyo', coordinates: { lat: 35.68, lng: 139.69 } }], destinationZone: undefined, itineraryBaseId: 'tokyo' });
    expect(tokyo).toEqual({ zonesByBaseId: { tokyo: 'Asia/Tokyo' }, primaryTimeZone: 'Asia/Tokyo', timeZone: 'Asia/Tokyo' });
  });
});

/* ---- the Iceland live draft, read as days, through the pure calendar ------------------------------------- */

function item(overrides: Partial<ItineraryItem> & { id: string; title: string; startMinute: number; endMinute: number }): ItineraryItem {
  return { kind: 'activity', durationMinutes: overrides.endMinute - overrides.startMinute, reason: 'r', weatherSensitive: false, ...overrides } as ItineraryItem;
}

function day(dayNumber: number, date: string, baseId: string, baseName: string, theme: string, items: ItineraryItem[]): ItineraryDay {
  return {
    dayNumber,
    date,
    baseId,
    baseName,
    theme,
    window: { startMinute: 8 * 60, endMinute: 20 * 60, usableMinutes: 12 * 60 },
    items,
    totals: { activityMinutes: 0, travelMinutes: 0, driveMinutes: 0, transitMinutes: 0, walkMinutes: 0, waitMinutes: 0, unverifiedMinutes: 0, estimatedMinutes: 0, allowanceMinutes: 0, travelKm: 0, freeMinutes: 120, strenuousCount: 0, unmeasuredLegCount: 0 },
    transport: { primaryMode: 'drive', modes: ['drive'], serviceIds: [], parkingNotes: [], accessNotes: [], verifyBeforeTravel: [] },
    availability: { flexiblePlaceIds: [], cautions: [], verifyBeforeTravel: [], bookings: [] },
    weather: { evidence: 'historical_pattern', summary: 'Cool', decisions: [], cautions: [], backups: [], provider: 'fixture', attribution: 'fixture' },
    food: { summary: 'n/a', slots: [], remote: false, notes: [], reservations: [] },
    intensity: 'moderate',
    warnings: [],
  } as unknown as ItineraryDay;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The live draft's ten days and five stays as a bare itinerary: one stop per anchor, 90 minutes apart from 09:00. */
function icelandItinerary(): Itinerary {
  const names = new Map(DRAFT.bases.map((b) => [b.id, b.name] as const));
  const days = DRAFT.days.map((d) =>
    day(d.dayNumber, addDays(DRAFT.window.startDate, d.dayNumber - 1), d.baseId, names.get(d.baseId) ?? d.baseId, d.theme, d.anchors.map((a, i) => item({ id: `d${d.dayNumber}-a${i}`, title: a.name, startMinute: 9 * 60 + i * 150, endMinute: 9 * 60 + i * 150 + 90 }))),
  );
  return { tripId: 'trip-iceland', version: 9, regionId: 'dynamic', baseId: DRAFT.days[0]!.baseId, baseName: 'Iceland', startDate: DRAFT.window.startDate, endDate: DRAFT.window.endDate, status: 'ready', summary: 's', days, issues: [], unscheduled: [], package: { bases: icelandBases(), anchors: [] } } as unknown as Itinerary;
}

describe('the Iceland live draft (regionless), end to end through the pure calendar and Today', () => {
  const itinerary = icelandItinerary();
  const zones = calendarZonesFor({ compiledBases: [], packageBases: icelandBases(), destinationZone: 'Atlantic/Reykjavik', itineraryBaseId: itinerary.baseId });
  const source = { tripId: 'trip-iceland', itinerary, booked: [], zonesByBaseId: zones.zonesByBaseId, primaryTimeZone: zones.primaryTimeZone, coordinates: {}, sequence: 1 };

  it('every one of the 22 stops is written in Atlantic/Reykjavik and no Etc/GMT zone reaches the file', () => {
    const derived = calendarEventsFor(source);
    expect(derived.events).toHaveLength(DRAFT.days.reduce((n, d) => n + d.anchors.length, 0));
    expect(new Set(derived.events.map((e) => e.timeZone))).toEqual(new Set(['Atlantic/Reykjavik']));
    expect(derived.timeZones).toEqual(['Atlantic/Reykjavik']);
    const ics = buildTripCalendar(source, { name: 'Iceland', summary: 'Ten days.', attributions: ['x'], stamp: '2026-09-11T10:00:00.000Z' });
    expect(ics).toContain('TZID:Atlantic/Reykjavik');
    expect(ics).toContain('X-WR-TIMEZONE:Atlantic/Reykjavik');
    expect(ics).not.toContain('Etc/GMT');
    expect(ics).not.toContain('TZID=UTC');
  });

  it('Today at 10:00 UTC on day 2 reads 10:00 in Reykjavík — the civil clock, not solar UTC−1', () => {
    const now = new Date('2026-09-22T10:00:00Z');
    const today = buildTodayView({ itinerary, booked: [], backups: [], now, timeZone: zones.primaryTimeZone, zonesByBaseId: zones.zonesByBaseId });
    expect([today.dayNumber, today.localDate, today.nowMinute]).toEqual([2, '2026-09-22', 10 * 60]);
    expect(today.next?.title).toBe('Sky Lagoon');
    /* Solar time would have said 09:00 — an hour early for every opening time in the plan. */
    expect(buildTodayView({ itinerary, booked: [], backups: [], now, timeZone: 'Etc/GMT+1' }).nowMinute).toBe(9 * 60);
  });
});

describe('a multi-zone trip and a zone-crossing flight, through the pure calendar', () => {
  const itinerary = { tripId: 'trip-mz', version: 9, regionId: 'dynamic', baseId: 'den', baseName: 'Denver', startDate: '2026-10-05', endDate: '2026-10-06', status: 'ready', summary: 's', days: [day(1, '2026-10-05', 'den', 'Denver', 'Denver', [item({ id: 'd1-a', title: 'Red Rocks', startMinute: 9 * 60, endMinute: 11 * 60 })]), day(2, '2026-10-06', 'lax', 'Los Angeles', 'Los Angeles', [item({ id: 'd2-a', title: 'Griffith Observatory', startMinute: 9 * 60, endMinute: 11 * 60 })])], issues: [], unscheduled: [], package: { bases: [], anchors: [] } } as unknown as Itinerary;
  const zones = calendarZonesFor({ compiledBases: [{ id: 'den', timeZone: 'America/Denver' }, { id: 'lax', timeZone: 'America/Los_Angeles' }], packageBases: [], destinationZone: undefined, itineraryBaseId: 'den' });
  const flight: BookedPlanItem = { id: 'bk-flight', tripId: 'trip-mz', type: 'flight', title: 'UA 123 DEN → LAX', date: '2026-10-05', startTime: '18:00', endTime: '19:40', timeZone: 'America/Denver', status: 'booked', locked: true, createdAt: '2026-09-01T00:00:00.000Z' };
  const hotel: BookedPlanItem = { id: 'bk-hotel', tripId: 'trip-mz', type: 'lodging', title: 'Hotel Figueroa', date: '2026-10-06', endDate: '2026-10-07', status: 'booked', locked: true, createdAt: '2026-09-01T00:00:00.000Z' };
  const derived = calendarEventsFor({ tripId: 'trip-mz', itinerary, booked: [flight, hotel], zonesByBaseId: zones.zonesByBaseId, primaryTimeZone: zones.primaryTimeZone, coordinates: {}, sequence: 2 });
  const by = (uid: string) => derived.events.find((e) => e.uid.includes(uid))!;

  it('each day carries its own base zone; the booked flight keeps the zone typed on it; a booking with no zone takes its day’s', () => {
    expect(by('d1-a').timeZone).toBe('America/Denver');
    expect(by('d2-a').timeZone).toBe('America/Los_Angeles');
    expect(by('bk-flight').timeZone).toBe('America/Denver');
    expect(by('bk-hotel').timeZone).toBe('America/Los_Angeles');
    expect(derived.timeZones.sort()).toEqual(['America/Denver', 'America/Los_Angeles']);
  });

  it('Today on the Los Angeles day runs on the Los Angeles clock', () => {
    const today = buildTodayView({ itinerary, booked: [flight, hotel], backups: [], now: new Date('2026-10-06T15:30:00Z'), timeZone: zones.primaryTimeZone, zonesByBaseId: zones.zonesByBaseId });
    expect([today.dayNumber, today.nowMinute]).toEqual([2, 8 * 60 + 30]);
    expect(today.bookedToday.map((b) => b.id)).toEqual(['bk-hotel']);
  });
});

/* ---- the database-backed loader, with the last resort under a spy ----------------------------------------- */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-tz-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_WEATHER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  delete process.env.SIDEQUEST_WEATHER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

const PLAN: Itinerary = (() => {
  const result = planTrip(buildScenario());
  if (!result.ok) throw new Error(`the fixture scenario did not plan: ${result.code}`);
  return result.itinerary;
})();

/** A regionless trip whose package holds the live Iceland bases; the plan's own days come from the fixture planner. */
async function seedRegionlessIceland(withIntent: boolean) {
  const { createTrip, saveItinerary } = await import('@/lib/db/repository');
  const { saveResolution, saveDestinationQuery } = await import('@/lib/db/compiler-repository');
  const trip = createTrip({ ...AUGUST_BASICS, destinationInput: 'Iceland', regionId: 'dynamic' }, 'owner-browser');
  if (withIntent) {
    saveDestinationQuery(trip.id, 'known_destination', 'Iceland');
    saveResolution(trip.id, resolution([candidate('is', ['Atlantic/Reykjavik'])], 'is'));
  }
  const itinerary: Itinerary = {
    ...PLAN,
    tripId: trip.id,
    package: {
      source: 'model_draft',
      draftVersion: 1,
      archetype: 'road_trip',
      purpose: 'The live Iceland loop.',
      routeRationale: 'South coast and Golden Circle.',
      assumptions: [],
      tradeoffs: [],
      bases: icelandBases(),
      foodStrategy: [],
      transport: { summary: 'Hire car.', notes: [] },
      beforeYouGo: [],
      packing: [],
      backups: [],
      omissions: [],
      unresolved: [],
      anchors: [],
      verification: { anchors: 0, verified: 0, partiallyVerified: 0, unverified: 0, scheduled: 0, rejected: 0, legsMeasured: 0, legsUnmeasured: 0, deadlineReached: false, providerNotes: [] },
      bookingPriorities: [],
    } as unknown as Itinerary['package'],
  };
  saveItinerary(itinerary);
  return { trip, itinerary };
}

describe('loadTripCalendarSource on a regionless Iceland trip', () => {
  it('takes Atlantic/Reykjavik from the intent candidate and never reaches deriveTimeZoneFromLongitude', async () => {
    const { trip, itinerary } = await seedRegionlessIceland(true);
    const core = await import('@sidequest/core');
    const spy = core.deriveTimeZoneFromLongitude as unknown as Mock;
    spy.mockClear();
    const { destinationTimeZone } = await import('./destination-zone');
    const { loadTripCalendarSource, calendarEventsFor: eventsFor, buildTripCalendar: calendarFor } = await import('./calendar-events');
    expect(destinationTimeZone(trip.id)).toBe('Atlantic/Reykjavik');
    const loaded = await loadTripCalendarSource(trip, itinerary, new Date('2026-09-11T10:00:00Z'));
    expect(loaded.timeZone).toBe('Atlantic/Reykjavik');
    expect(loaded.source.primaryTimeZone).toBe('Atlantic/Reykjavik');
    expect(new Set(Object.values(loaded.source.zonesByBaseId))).toEqual(new Set(['Atlantic/Reykjavik']));
    expect(spy).not.toHaveBeenCalled();
    expect(eventsFor(loaded.source).timeZones).toEqual(['Atlantic/Reykjavik']);
    const ics = calendarFor(loaded.source, { name: 'Iceland', summary: 's', attributions: ['x'], stamp: '2026-09-11T10:00:00.000Z' });
    expect(ics).toContain('TZID:Atlantic/Reykjavik');
    expect(ics).not.toContain('Etc/GMT');
  });

  it('control: with no intent the loader does fall to solar time, so the silence above is proof', async () => {
    const { trip, itinerary } = await seedRegionlessIceland(false);
    const core = await import('@sidequest/core');
    const spy = core.deriveTimeZoneFromLongitude as unknown as Mock;
    spy.mockClear();
    const { destinationTimeZone } = await import('./destination-zone');
    const { loadTripCalendarSource } = await import('./calendar-events');
    expect(destinationTimeZone(trip.id)).toBeUndefined();
    const loaded = await loadTripCalendarSource(trip, itinerary, new Date('2026-09-11T10:00:00Z'));
    expect(spy).toHaveBeenCalledTimes(DRAFT.bases.length);
    expect(loaded.timeZone).toBeUndefined();
    expect(new Set(Object.values(loaded.source.zonesByBaseId))).toEqual(new Set(['Etc/GMT+1']));
  });
});
