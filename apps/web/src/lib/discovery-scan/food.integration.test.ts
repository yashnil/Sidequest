import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_WORLDS, syntheticCandidate } from '@sidequest/compiler/testing';
import { DESTINATION_RESOLUTION_VERSION, type TravelerProfile } from '@sidequest/core';
import type * as Repository from '@/lib/db/repository';

/**
 * A SCANNED TRIP, BUILT PLANNER-FIRST, EATS SOMEWHERE REAL.
 *
 * Fixture scan (synthetic venues, zero network) → planner-first build →
 * reconcile names lunch and dinner from the region's own food data, near the
 * stop before the meal, within the traveller's price band and diet, never one
 * venue over and over — and a meal no venue fits stays an honest intent.
 */

vi.mock('next/server', () => ({ after: () => { throw new Error('no request scope'); } }));

/** The profile the build reads, when a test pins one; otherwise the stored one (none → Sidequest's default). */
const pinned: { profile: TravelerProfile | null } = { profile: null };
vi.mock('@/lib/db/repository', async (original) => {
  const actual = await original<typeof Repository>();
  return { ...actual, getProfile: (tripId: string) => pinned.profile ?? actual.getProfile(tripId) };
});

const NOW = new Date('2026-08-11T09:00:00.000Z');
const KEYS = ['SIDEQUEST_DB_PATH', 'SIDEQUEST_COMPOSER_PROVIDER', 'SIDEQUEST_COMPILER_PROVIDER', 'ANTHROPIC_API_KEY', 'SIDEQUEST_GEOCODER_PROVIDER', 'SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_POI_PROVIDER', 'SIDEQUEST_ACTION_FENCES', 'SIDEQUEST_FIXTURES', 'SIDEQUEST_PLANNING_MODE', 'SIDEQUEST_FOOD_PROVIDER'];
const saved: Record<string, string | undefined> = {};
let directory: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  pinned.profile = null;
  directory = mkdtempSync(join(tmpdir(), 'sidequest-scan-food-'));
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.SIDEQUEST_DB_PATH = join(directory, 'scan.db');
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
  process.env.SIDEQUEST_FIXTURES = 'allow';
  for (const key of ['ANTHROPIC_API_KEY', 'SIDEQUEST_GEOCODER_PROVIDER', 'SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_POI_PROVIDER', 'SIDEQUEST_PLANNING_MODE', 'SIDEQUEST_FOOD_PROVIDER']) delete process.env[key];
});

afterEach(() => {
  releaseDatabase();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

async function scannedTrip(destination = 'Testmouth'): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const { saveDestinationQuery, saveResolution } = await import('@/lib/db/compiler-repository');
  const { DYNAMIC_REGION_ID } = await import('@/lib/region');
  const candidate = { ...syntheticCandidate(SYNTHETIC_WORLDS.transit_city!), displayName: destination };
  const trip = createTrip({ mode: 'known_destination', destinationInput: destination, regionId: DYNAMIC_REGION_ID, startDate: '2026-08-12', endDate: '2026-08-17', arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] }, 'owner');
  saveDestinationQuery(trip.id, 'known_destination', destination);
  saveResolution(trip.id, { schemaVersion: DESTINATION_RESOLUTION_VERSION, query: destination, normalizedQuery: destination.toLowerCase(), candidates: [candidate], ambiguityReasons: [], unambiguousCandidateId: candidate.id, providersConsulted: ['fixture'], resolvedAt: NOW.toISOString() });
  const { startDiscoveryScan } = await import('./run');
  startDiscoveryScan(trip.id, { autoBuild: false, caller: 'test', now: NOW });
  const { scanView } = await import('@/lib/db/scan-repository');
  for (let i = 0; i < 200 && scanView(trip.id).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
  expect(scanView(trip.id).state).toBe('ready');
  return trip.id;
}

async function build(tripId: string) {
  const { generateSidequestPlanForTrip } = await import('@/lib/planning/production-plan');
  const result = await generateSidequestPlanForTrip(tripId, { caller: 'test', now: NOW, mode: 'full' });
  expect(result.ok, result.error).toBe(true);
  const { getItinerary } = await import('@/lib/db/repository');
  const itinerary = getItinerary(tripId)!;
  expect(itinerary.package?.planning?.mode).toBe('planner');
  const meals = itinerary.days.flatMap((day) => day.items.filter((item) => item.kind === 'meal').map((item) => ({ day, item })));
  return { itinerary, meals };
}

describe('scan food, end to end', () => {
  it('the scanned region carries a food dataset, and a planner-first build names lunch and dinner from it, honestly', async () => {
    const tripId = await scannedTrip();
    const { getTrip } = await import('@/lib/db/repository');
    const { resolveTripRegion } = await import('@/lib/region');
    const resolved = await resolveTripRegion(getTrip(tripId)!);
    if (!resolved.ok) throw new Error(resolved.error);
    const food = resolved.context.food!;
    expect(food.venues.length).toBeGreaterThan(0);
    expect(resolved.context.compiled.coverage.dimensions.find((d) => d.dimension === 'food')?.covered).toBe(food.venues.length);

    const { meals } = await build(tripId);
    const named = meals.filter(({ item }) => item.food?.stopKind === 'venue');
    expect(named.length).toBeGreaterThan(0);
    const byId = new Map(food.venues.map((v) => [v.id, v]));
    const uses = new Map<string, number>();
    for (const { item } of named) {
      const venue = byId.get(item.food!.venueId!)!;
      expect(venue, item.title).toBeTruthy();
      expect(['lunch', 'dinner']).toContain(item.food!.slot);
      expect(item.title).toContain(venue.name);
      // Named, never claimed as checked: hours unknown, nothing booked, said so.
      expect(item.food!.hoursUnknown).toBe(true);
      expect(item.reason).toMatch(/not checked today that it is open, and nothing is booked/);
      expect(item.reason).not.toMatch(/\bverified\b/i);
      uses.set(venue.id, (uses.get(venue.id) ?? 0) + 1);
    }
    for (const count of uses.values()) expect(count).toBeLessThanOrEqual(2);
    // Never lunch and dinner at the same table on one day.
    for (const day of new Set(named.map(({ day }) => day.dayNumber))) {
      const ids = named.filter(({ day: d }) => d.dayNumber === day).map(({ item }) => item.food!.venueId);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // Every meal that is not named stays the planner's intent — never a venue name it did not get from the data.
    for (const { item } of meals.filter(({ item }) => item.food?.stopKind !== 'venue')) {
      expect(item.title).not.toMatch(/\(fixture\)/);
    }
  }, 60_000);

  it('a vegetarian is never sent to a venue whose record says it cannot do vegetarian, and is sent to one that can where it is near', async () => {
    const tripId = await scannedTrip();
    const { getTrip } = await import('@/lib/db/repository');
    const { defaultProfileFor } = await import('@/lib/planning/default-profile');
    const base = defaultProfileFor(getTrip(tripId)!, null);
    pinned.profile = { ...base, food: { ...base.food, dietaryNeeds: ['vegetarian'] } };
    const { resolveTripRegion } = await import('@/lib/region');
    const resolved = await resolveTripRegion(getTrip(tripId)!);
    if (!resolved.ok) throw new Error(resolved.error);
    const unsuitable = new Set(resolved.context.food!.venues.filter((v) => v.dietary.some((c) => c.need === 'vegetarian' && c.evidence === 'venue_states_unsuitable')).map((v) => v.id));
    expect(unsuitable.size).toBeGreaterThan(0);

    const { meals } = await build(tripId);
    const named = meals.filter(({ item }) => item.food?.stopKind === 'venue');
    expect(named.length).toBeGreaterThan(0);
    for (const { item } of named) {
      expect(unsuitable.has(item.food!.venueId!), item.title).toBe(false);
      expect(item.food!.dietary.every((c) => c.evidence !== 'venue_states_unsuitable')).toBe(true);
    }
    expect(named.some(({ item }) => item.food!.dietary.some((c) => c.need === 'vegetarian' && c.evidence === 'menu_lists_options'))).toBe(true);
  }, 60_000);

  it('with food switched off the region has no food data and every meal stays an intent', async () => {
    process.env.SIDEQUEST_FOOD_PROVIDER = 'off';
    const tripId = await scannedTrip();
    const { meals } = await build(tripId);
    expect(meals.length).toBeGreaterThan(0);
    expect(meals.some(({ item }) => item.food?.stopKind === 'venue')).toBe(false);
  }, 60_000);
});
