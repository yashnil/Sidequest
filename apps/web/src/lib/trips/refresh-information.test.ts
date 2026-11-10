import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planTrip } from '@sidequest/planner';
import { scanBaseUpgrade, type CompiledRegion, type ImageSubject, type Itinerary } from '@sidequest/core';
import { buildScenario } from '../../../../../packages/planner/src/testing/scenario';
import { TENERIFE_BASES, tenerifeStoredScan } from '../../../../../packages/core/src/scan/tenerife-fixture.test-support';
import { getDb } from '@/lib/db/client';
import { getItinerary, saveItinerary } from '@/lib/db/repository';
import { saveDestinationQuery, saveSelectedCompiledRegion } from '@/lib/db/compiler-repository';
import { addBookedItem, listBookedItems } from '@/lib/db/intelligence-repository';
import { compiledRegionFor } from '@/lib/region';
import { refreshTripInformation, type RefreshDeps } from './refresh-information';
import { planningUpgradeFor } from './planning-upgrade';

/**
 * "REFRESH TRIP INFORMATION" ADDS EVIDENCE AND NEVER MOVES THE PLAN.
 *
 * Offline: a temporary SQLite database, the stored scan built by the real
 * assembler from a fixture shaped like the production Tenerife trip (three
 * bases on one island, the old rule's portfolio), an itinerary stored through
 * the real repository with its days on those three bases, and every outward
 * call — Wikidata, Commons, the forecast — handed in as a stub.
 */

let directory: string;
const TRIP = 'trip-tenerife';
const NOW = new Date('2026-11-08T10:00:00.000Z');

function closeDb(): void {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
}

function rawPayload(regionId: string): Record<string, unknown> {
  const row = getDb().prepare('SELECT payload_json FROM compiled_regions WHERE id = ?').get(regionId) as { payload_json: string };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

/** The stored trip: the scan adopted, and a plan whose days sleep in all three towns. */
function seed(region: CompiledRegion = tenerifeStoredScan()): { region: CompiledRegion; itinerary: Itinerary } {
  const at = NOW.toISOString();
  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date,
         arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at)
       VALUES (?, 'known_destination', 'Tenerife', 'dynamic', '2026-12-01', '2026-12-09',
         '11:00', '17:00', 2, 0, '[]', 'planned', ?, ?)`,
    )
    .run(TRIP, at, at);
  saveDestinationQuery(TRIP, 'known_destination', 'Tenerife');
  getDb()
    .prepare('INSERT INTO compiled_regions (id, trip_id, scope_fingerprint, schema_version, compiler_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(region.id, TRIP, region.scopeFingerprint, region.schemaVersion, region.compilerVersion, JSON.stringify(region), at);
  saveSelectedCompiledRegion(TRIP, region.id);

  const planned = planTrip(buildScenario());
  if (!planned.ok) throw new Error('the fixture scenario did not plan');
  const stays = region.basePortfolio!.bases;
  const placeIds = region.places.map((p) => p.id);
  let next = 0;
  const itinerary: Itinerary = {
    ...planned.itinerary,
    tripId: TRIP,
    days: planned.itinerary.days.map((day, i) => {
      const stay = stays[Math.min(stays.length - 1, i)]!;
      return {
        ...day,
        baseId: stay.baseId,
        baseName: stay.baseName,
        items: day.items.map((item) => (item.placeId ? { ...item, placeId: placeIds[next++ % placeIds.length]! } : item)),
      };
    }),
  };
  saveItinerary(itinerary);
  addBookedItem(TRIP, { type: 'lodging', title: 'Hotel in Puerto de la Cruz', date: '2026-12-01', status: 'booked' } as Parameters<typeof addBookedItem>[1]);
  return { region, itinerary: getItinerary(TRIP)! };
}

/** Wikidata stand-in: links every subject whose name it was told about. */
function linker(byName: Record<string, string>) {
  return vi.fn(async (subjects: readonly { key: string; name: string }[]) => new Map(subjects.flatMap((s) => (byName[s.name] ? [[s.key, byName[s.name]!] as const] : []))));
}

function deps(overrides: Partial<RefreshDeps> = {}): RefreshDeps & { resolveImages: ReturnType<typeof vi.fn>; fetchWeather: ReturnType<typeof vi.fn> } {
  return {
    now: NOW,
    linkIdentities: true,
    linkIds: linker({ 'Lago Martianez': 'Q1001', 'Teide National Park': 'Q1002', 'Masca Village': 'Q1003' }),
    resolveImages: vi.fn(async (subjects: readonly ImageSubject[]) => ({ resolved: subjects.length, accepted: Math.min(2, subjects.length) })),
    fetchWeather: vi.fn(async () => ({ ok: true as const, reason: 'fetched' as const })),
    ...overrides,
  } as never;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-refresh-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'refresh.db');
  closeDb();
  getDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

describe('refreshTripInformation', () => {
  it('links identities onto stored places and leaves the itinerary, bases and bookings exactly as they were', async () => {
    const { region, itinerary } = seed();
    const bookedBefore = listBookedItems(TRIP);
    const payloadBefore = rawPayload(region.id);

    const d = deps();
    const result = await refreshTripInformation(TRIP, d);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.identitiesLinked).toBe(3);
    expect(result.summary.photosAdded).toBe(2);
    expect(result.summary.weather).toBe('updated');
    expect(result.summary.message).toMatch(/2 new photos, weather updated\./);
    expect(result.summary.message).toMatch(/unchanged/);

    /* The plan: byte-for-byte the same, three bases and all. */
    expect(getItinerary(TRIP)).toEqual(itinerary);
    expect(new Set(getItinerary(TRIP)!.days.map((day) => day.baseId)).size).toBe(3);
    expect(listBookedItems(TRIP)).toEqual(bookedBefore);

    /* The stored scan: only `places[].wikidataId` moved. */
    const payloadAfter = rawPayload(region.id);
    const strip = (payload: Record<string, unknown>) => ({ ...payload, places: (payload.places as Record<string, unknown>[]).map(({ wikidataId: _ignored, ...rest }) => rest) });
    expect(strip(payloadAfter)).toEqual(strip(payloadBefore));
    const linked = (payloadAfter.places as { name: string; wikidataId?: string }[]).filter((p) => p.wikidataId).map((p) => [p.name, p.wikidataId]);
    expect(linked).toEqual(expect.arrayContaining([['Lago Martianez', 'Q1001'], ['Teide National Park', 'Q1002'], ['Masca Village', 'Q1003']]));
    expect(compiledRegionFor(TRIP)!.basePortfolio).toEqual(region.basePortfolio);

    /* The photographs asked for are the newly identified places, scheduled stops first. */
    const asked = d.resolveImages.mock.calls[0]![0] as ImageSubject[];
    expect(asked.map((s) => s.wikidataId).sort()).toEqual(['Q1001', 'Q1002', 'Q1003']);
    expect(asked.every((s) => s.kind === 'candidate')).toBe(true);
  });

  it('changes evidence only: the same days, stops, order, times and bases, and no new version', async () => {
    const { itinerary } = seed();
    const structureOf = (plan: Itinerary) => plan.days.map((day) => ({ date: day.date, baseId: day.baseId, items: day.items.map((item) => [item.kind, item.placeId ?? null, item.title, item.startMinute, item.endMinute]) }));
    const before = structureOf(itinerary);
    const result = await refreshTripInformation(TRIP, deps());
    expect(result.ok).toBe(true);
    expect(structureOf(getItinerary(TRIP)!)).toEqual(before);
    expect(getDb().prepare('SELECT COUNT(*) AS count FROM refinement_versions WHERE trip_id = ?').get(TRIP)).toEqual({ count: 0 });
  });

  it('never replaces an identity a place already holds, and never gives two places one item', async () => {
    const base = tenerifeStoredScan();
    const region = { ...base, places: base.places.map((p) => (p.name === 'Lago Martianez' ? { ...p, wikidataId: 'Q777' } : p)) };
    seed(region);
    const d = deps({ linkIds: linker({ 'Lago Martianez': 'Q999', 'Masca Village': 'Q777', 'Teide National Park': 'Q1002' }) });
    const result = await refreshTripInformation(TRIP, d);
    expect(result.ok && result.summary.identitiesLinked).toBe(1);
    const places = compiledRegionFor(TRIP)!.places;
    expect(places.find((p) => p.name === 'Lago Martianez')!.wikidataId).toBe('Q777');
    expect(places.find((p) => p.name === 'Masca Village')!.wikidataId).toBeUndefined();
    expect(places.find((p) => p.name === 'Teide National Park')!.wikidataId).toBe('Q1002');
  });

  it('replays the last answer inside the throttle window and spends nothing', async () => {
    seed();
    await refreshTripInformation(TRIP, deps());
    const again = deps();
    const result = await refreshTripInformation(TRIP, { ...again, now: new Date(NOW.getTime() + 60_000) });
    expect(result.ok && result.summary.throttled).toBe(true);
    expect(again.linkIds).not.toHaveBeenCalled();
    expect(again.resolveImages).not.toHaveBeenCalled();
    expect(again.fetchWeather).not.toHaveBeenCalled();
  });

  it('makes no identity lookup when outward lookups are off, and a failing source changes nothing', async () => {
    const { itinerary } = seed();
    const off = deps({ linkIdentities: false });
    const quiet = await refreshTripInformation(TRIP, off);
    expect(off.linkIds).not.toHaveBeenCalled();
    expect(quiet.ok && quiet.summary.identitiesLinked).toBe(0);

    getDb().prepare('DELETE FROM provider_cache').run();
    const failing = deps({
      linkIds: vi.fn(async () => {
        throw new Error('Wikidata query service answered 503');
      }),
      fetchWeather: vi.fn(async () => ({ ok: false as const, reason: 'provider_failed' as const })),
    });
    const result = await refreshTripInformation(TRIP, failing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.identitiesLinked).toBe(0);
    expect(result.summary.weather).toBe('failed');
    expect(result.summary.message).toMatch(/did not answer/);
    expect(getItinerary(TRIP)).toEqual(itinerary);
  });
});

describe('the Tenerife regression — a stored three-base island trip', () => {
  it('keeps its three bases through a refresh, and is flagged as improvable before and after', async () => {
    const { itinerary } = seed();
    const before = planningUpgradeFor(TRIP);
    expect(before).toEqual({ storedBaseCount: 3, currentBaseCount: expect.any(Number) });
    expect(before!.currentBaseCount).toBeLessThan(3);

    await refreshTripInformation(TRIP, deps());

    const after = getItinerary(TRIP)!;
    expect(after).toEqual(itinerary);
    expect([...new Set(after.days.map((day) => day.baseName))].sort()).toEqual(Object.values(TENERIFE_BASES).map((b) => b.name).sort());
    expect(planningUpgradeFor(TRIP)).toEqual(before);
    expect(scanBaseUpgrade(compiledRegionFor(TRIP)!)?.storedBaseCount).toBe(3);
  });
});
