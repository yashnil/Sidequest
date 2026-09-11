import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * V7 §16 — THE GENERATION SCREEN'S NUMBERS ARE COUNTS, NOT FORECASTS.
 *
 * Counters are merged across boundaries and never replaced; a retry starts
 * them again; the sentences the screen shows are derived from them and say
 * nothing about time left or providers.
 */
describe('generation progress counters', () => {
  let dir: string;
  function releaseDatabase(): void {
    const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
    holder.sidequestDb?.close();
    delete holder.sidequestDb;
  }
  beforeEach(() => {
    releaseDatabase();
    dir = mkdtempSync(join(tmpdir(), 'sq-progress-'));
    process.env.SIDEQUEST_DB_PATH = join(dir, 'progress.db');
    vi.resetModules();
  });
  afterEach(() => {
    releaseDatabase();
    delete process.env.SIDEQUEST_DB_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  it('merges counters across stages, renders them as sentences, and resets on a new build', async () => {
    const repo = await import('./repository');
    const progress = await import('./generation-progress-repository');
    const now = new Date('2026-09-10T12:00:00Z');
    const trip = repo.createTrip({ mode: 'known_destination', destinationInput: 'Somewhere', regionId: 'dynamic', startDate: '2026-10-10', endDate: '2026-10-14', arrivalTime: '15:00', departureTime: '11:00', adults: 2, children: 0, travelerNeeds: [] });
    progress.beginGeneration(trip.id, now);
    progress.markGenerationStage(trip.id, 'composing', now);
    progress.markGenerationStage(trip.id, 'route', now);
    progress.noteGenerationCounters(trip.id, { days: 5, stops: 12, bases: 2, episodes: 1 }, now);
    progress.markGenerationStage(trip.id, 'places', now);
    progress.noteGenerationCounters(trip.id, { placesMatched: 7 }, now);
    progress.markGenerationStage(trip.id, 'travel', now, { legsTimed: 3 });
    const row = progress.getGenerationProgress(trip.id)!;
    expect(row.counters).toEqual({ days: 5, stops: 12, bases: 2, episodes: 1, placesMatched: 7, legsTimed: 3 });
    const lines = progress.milestonesFor(row.counters, row.stage);
    expect(lines).toEqual(['5 days drafted with 12 stops across 2 bases, one multi-day journey kept whole.', '7 of 12 stops matched to a place on the map.', '3 legs timed by a router.']);
    expect(lines.join(' ')).not.toMatch(/%|percent|remaining|valhalla|nominatim|provider/i);
    /* V8 §14 — a placed point survives later counter writes, is deduplicated, and is bounded. */
    progress.noteGenerationPlaced(trip.id, { name: 'Nairobi', lat: -1.29, lng: 36.82 }, now);
    progress.noteGenerationPlaced(trip.id, { name: 'Nairobi', lat: -1.29, lng: 36.82 }, now);
    progress.noteGenerationCounters(trip.id, { legsEstimated: 2 }, now);
    progress.markGenerationStage(trip.id, 'preparing', now);
    expect(progress.getGenerationProgress(trip.id)!.placed).toEqual([{ name: 'Nairobi', lat: -1.29, lng: 36.82 }]);
    expect(progress.getGenerationProgress(trip.id)!.counters.legsEstimated).toBe(2);
    /* A retry is a new build. */
    progress.beginGeneration(trip.id, new Date('2026-09-10T12:05:00Z'));
    expect(progress.getGenerationProgress(trip.id)!.counters).toEqual({});
    expect(progress.getGenerationProgress(trip.id)!.placed).toEqual([]);
  });
});
