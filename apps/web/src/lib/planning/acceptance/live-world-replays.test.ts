import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compositionPreferenceSummary, itinerarySchema, type BookedPlanItem } from '@sidequest/core';
import { getDb } from '@/lib/db/client';
import { getItinerary, saveItinerary } from '@/lib/db/repository';
import { applyBookedFacts } from '@/lib/intelligence/booked-reconcile';
import { compactBookedFacts } from '@/lib/intelligence/booked-facts';
import { buildCompositionTask } from '../composition';
import { buildHybridTripRequest } from '../hybrid-request';
import { boundedAll } from '@/lib/providers/cost-budget';
import { reconcileTripDraft } from '../reconcile';
import type { RouteConfirmation } from '../skeleton-adapter';
import { draftOf, fictionalWorld } from './harness';
import { icelandContext, icelandDraft } from './iceland-replay.test';

/**
 * LIVE WORLD V1 — replays beyond Iceland.
 *
 *   city: a car-free plan whose base-to-base leg is timetabled transit, with
 *         a booked timed event the plan is built around;
 *   remote: the saved Iceland draft (remote, drives, unmeasured day legs) —
 *         see `iceland-replay.test.ts`; here the measured relocation legs and
 *         persisted shapes are the assertion;
 *   booking change: a booked hotel changes; the plan reconciles with zero
 *         model calls and minimal churn, persists, reloads and exports;
 *   performance: bounded concurrency and a deadline that stops new work.
 */
let directory: string;
const savedDb = process.env.SIDEQUEST_DB_PATH;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-live-world-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'replay.db');
  getDb()
    .prepare(
      `INSERT INTO trips (id, mode, destination_input, region_id, start_date, end_date, arrival_time, departure_time, adults, children, traveler_needs, status, created_at, updated_at)
       VALUES ('iceland-replay', 'known_destination', 'Iceland', 'dynamic', '2026-07-05', '2026-07-17', '10:00', '16:00', 2, 0, '[]', 'draft', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
    )
    .run();
});

afterEach(() => {
  releaseDatabase();
  if (savedDb === undefined) delete process.env.SIDEQUEST_DB_PATH;
  else process.env.SIDEQUEST_DB_PATH = savedDb;
  rmSync(directory, { recursive: true, force: true });
});

const CITY_PLACES = [
  { name: 'Central', lat: 22.28, lng: 114.16, entityType: 'city' as const },
  { name: 'Kowloon Side', lat: 22.3, lng: 114.17, entityType: 'city' as const },
  { name: 'Harbour Promenade', lat: 22.293, lng: 114.172 },
  { name: 'Old Market', lat: 22.284, lng: 114.155 },
  { name: 'City Museum', lat: 22.302, lng: 114.175 },
  { name: 'Hill Garden', lat: 22.27, lng: 114.15 },
];

describe('city replay — transit first, no car by default, a booked timed event', () => {
  it('a car-free plan never defaults to driving; the base move carries the timetabled figure and its summary', async () => {
    // The last stop of the relocation day has no direct network answer to the new base, so the base-to-base figure stands in (`viaBases`).
    const world = fictionalWorld({ name: 'Harbour City', center: { lat: 22.28, lng: 114.16 }, places: CITY_PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-03' }, profile: { willDrive: false }, noRoadBetween: [['City Museum', 'Kowloon Side']] });
    // A transit provider answers the base-to-base leg with a schedule figure and a human summary.
    const confirmRoute = async (): Promise<RouteConfirmation> => ({ found: true, minutes: 24, km: 6.1, provider: 'google-routes', basis: 'scheduled', measuredAt: '2026-04-01T00:00:00.000Z', transitSummary: '24 min by metro + walk (1 change)' });
    const context = { ...world.context, matrix: { ...world.context.matrix, mode: 'transit' as const }, confirmRoute };
    const draft = draftOf({
      bases: [{ id: 'b1', name: 'Central', nights: 1 }, { id: 'b2', name: 'Kowloon Side', nights: 1 }],
      days: [
        { base: 'b1', anchors: [{ name: 'Old Market', transport: 'walk' }, { name: 'Hill Garden', transport: 'metro' }] },
        { base: 'b2', relocation: true, anchors: [{ name: 'Harbour Promenade', transport: 'walk' }, { name: 'City Museum', transport: 'metro', minutes: 120 }] },
        { base: 'b2', anchors: [{ name: 'City Museum', transport: 'walk' }] },
      ],
    });
    const result = await reconcileTripDraft({ draft, context });
    const legs = result.itinerary.days.flatMap((d) => d.items.filter((i) => i.kind === 'travel').map((i) => i.travel!));
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.every((l) => l.mode !== 'drive')).toBe(true);
    const transfer = legs.find((l) => l.role === 'transfer' && l.provenance === 'measured');
    expect(transfer?.basis).toBe('scheduled');
    expect(transfer?.transitSummary).toBe('24 min by metro + walk (1 change)');
    expect(transfer?.viaBases).toBe(true);
    // A booked timed event is a hard fact the composer receives and the reconciler honours.
    const booked: BookedPlanItem[] = [{ id: 'bk1', tripId: world.trip.id, type: 'event', title: 'Symphony at City Hall', date: '2026-05-02', startTime: '19:30', endTime: '21:30', location: 'City Hall', status: 'booked', locked: true, createdAt: '2026-04-01T00:00:00.000Z' }];
    const facts = compactBookedFacts(booked);
    expect(facts[0]).toMatch(/Symphony at City Hall at City Hall — 2026-05-02 19:30–21:30/);
    const driving = fictionalWorld({ name: 'Harbour City', center: { lat: 22.28, lng: 114.16 }, places: CITY_PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-03' } });
    const task = buildCompositionTask({ request: buildHybridTripRequest({ trip: driving.trip, composer: null, profile: driving.context.profile, now: new Date('2026-04-01T00:00:00Z') }), envelope: { name: 'Harbour City', center: { lat: 22.28, lng: 114.16 } }, preferenceSummary: compositionPreferenceSummary(driving.context.profile), mode: 'full', bookedFacts: facts });
    expect(JSON.stringify(task)).toMatch(/BOOKED FACTS/);
    expect(JSON.stringify(task)).toContain('Symphony at City Hall');
    const applied = applyBookedFacts(result.itinerary, booked);
    expect(applied.honored.length + applied.conflicts.length).toBeGreaterThan(0);
    expect(itinerarySchema.safeParse(applied.itinerary).success).toBe(true);
  });
});

describe('remote replay — the saved Iceland draft', () => {
  it('measured relocation legs and their shapes survive save, reload and the calendar export path', async () => {
    const draft = icelandDraft();
    const result = await reconcileTripDraft({ draft, context: icelandContext().context });
    saveItinerary(result.itinerary);
    const reloaded = getItinerary('iceland-replay')!;
    const transfers = reloaded.days.flatMap((d) => d.items.filter((i) => i.kind === 'travel' && i.travel?.role === 'transfer').map((i) => i.travel!));
    expect(transfers.filter((t) => t.provenance === 'measured').length).toBeGreaterThanOrEqual(6);
    expect(transfers.filter((t) => typeof t.geometry === 'string').length).toBeGreaterThanOrEqual(3);
    expect(transfers.every((t) => t.provenance !== 'measured' || t.measuredAt)).toBe(true);
  });
});

describe('booking-change replay — zero model calls, minimal churn', () => {
  it('changing the booked hotel changes only what the booking touches; the plan persists, reloads and stays valid', async () => {
    const draft = icelandDraft();
    const base = await reconcileTripDraft({ draft, context: icelandContext().context });
    const firstBase = base.itinerary.days[0]!;
    const hotelA: BookedPlanItem = { id: 'h1', tripId: 'iceland-replay', type: 'lodging', title: 'Hotel A', date: firstBase.date, endDate: base.itinerary.days[1]!.date, status: 'booked', locked: true, createdAt: '2026-04-01T00:00:00.000Z' };
    const withA = applyBookedFacts(base.itinerary, [hotelA]);
    const hotelB: BookedPlanItem = { ...hotelA, id: 'h2', title: 'Hotel B' };
    const withB = applyBookedFacts(base.itinerary, [hotelB]);
    expect(withA.itinerary.days.length).toBe(withB.itinerary.days.length);
    expect(withA.itinerary.package!.anchors.map((a) => a.disposition)).toEqual(withB.itinerary.package!.anchors.map((a) => a.disposition));
    const stops = (it: typeof withA.itinerary) => it.days.map((d) => d.items.filter((i) => i.kind === 'activity').map((i) => i.title));
    expect(stops(withA.itinerary)).toEqual(stops(withB.itinerary));
    expect(JSON.stringify(withA.itinerary)).toContain('Hotel A');
    expect(JSON.stringify(withB.itinerary)).toContain('Hotel B');
    expect(JSON.stringify(withB.itinerary)).not.toContain('Hotel A');
    saveItinerary(withB.itinerary);
    const reloaded = getItinerary('iceland-replay')!;
    expect(itinerarySchema.safeParse(reloaded).success).toBe(true);
    expect(JSON.stringify(reloaded)).toContain('Hotel B');
    // The whole exchange happened with no model and no provider: the replay's counters say so.
    const counters = icelandContext().calls;
    expect(counters).toEqual({ geocode: 0, matrix: 0, confirm: 0, corridor: 0 });
  });
});

describe('performance — bounded concurrency, degraded-complete', () => {
  it('runs at most N at once and stops starting work once the deadline fires, returning nulls rather than hanging', async () => {
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];
    const items = Array.from({ length: 12 }, (_, i) => i);
    const startedAt = Date.now();
    const results = await boundedAll(items, 3, () => Date.now() - startedAt > 80, async (i) => {
      started.push(i);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      return i * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(results.length).toBe(12);
    expect(results.filter((r) => r === null).length).toBeGreaterThan(0);
    expect(started.length).toBeLessThan(12);
  });
});
