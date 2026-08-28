import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileRegion, deriveScope } from '@sidequest/compiler';
import { SYNTHETIC_WORLDS, packBackedProviders, syntheticCandidate } from '@sidequest/compiler/testing';

/**
 * WHAT THE COMPILATION LEARNED REACHES THE SCREEN THAT ASKED.
 *
 * The scope is written before a build and carries a *guess* at the civil time
 * zone, derived from the destination's longitude — correct as solar time,
 * routinely wrong as a clock, and labelled `derived_from_longitude` all the way
 * to the plan screen. The compilation then asks a resolver and gets a real
 * answer, which travels on the artifact and reaches weather, daylight and every
 * opening time.
 *
 * The stored intent never heard about it, and the plan screen reads the stored
 * intent. A finished build of a destination on UTC+0 therefore printed "About
 * UTC−1 — estimated from where this is on the map, because we could not confirm
 * the local time zone" while its own artifact held the resolved zone: a wrong
 * number *and* a confession of ignorance about a fact the product had already
 * established.
 *
 * Driven through `completeJob`, which is the one path a compilation commits by.
 */

let dir: string;
const NOW = new Date('2026-08-11T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-scope-zone-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

describe('the stored scope, after a build commits', () => {
  it('adopts the zone the artifact resolved, without moving the revision', async () => {
    const { createTrip } = await import('../db/repository');
    const { saveScope, getIntent, startJob, markJobRunning, completeJob } = await import(
      '../db/compiler-repository'
    );

    const spec = SYNTHETIC_WORLDS.transit_city!;
    const scope = deriveScope({
      candidate: syntheticCandidate(spec),
      clarifications: { schemaVersion: 1, questions: [], answers: [] },
      nights: DATES.length,
      revision: 1,
    });
    const compiled = await compileRegion({
      compilationId: 'zone-writeback',
      scope,
      dates: [...DATES],
      months: [8],
      providers: packBackedProviders(spec),
      now: NOW,
    });
    if (!compiled.ok) throw new Error(`the world did not compile: ${compiled.code}`);

    const trip = createTrip({
      mode: 'known_destination',
      destinationInput: spec.name,
      regionId: 'open-world',
      startDate: DATES[0]!,
      endDate: DATES[DATES.length - 1]!,
      arrivalTime: '10:00',
      departureTime: '18:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
    });

    /*
     * The state a real trip is in when the build starts: the guess, written by
     * the screen that asked for confirmation.
     */
    saveScope(trip.id, {
      ...scope,
      timeZones: ['Etc/GMT+1'],
      timeZoneBasis: 'derived_from_longitude',
    });
    const revisionBefore = getIntent(trip.id)!.scopeRevision;

    const started = startJob({ tripId: trip.id, scopeFingerprint: 'fp-zone', now: NOW });
    if (started.kind !== 'started') throw new Error('the job did not start');
    markJobRunning(started.job.id, NOW);

    /*
     * The artifact has to know better than the stored guess, or this scenario
     * proves nothing. Which *kind* of better it is — a resolver's answer or a
     * zone that travelled with the destination record — is a property of the
     * fixture; both outrank a longitude derivation, which is the whole ordering
     * under test.
     */
    expect(['provider_resolved', 'published']).toContain(compiled.region.scope.timeZoneBasis);

    completeJob({
      jobId: started.job.id,
      tripId: trip.id,
      region: compiled.region,
      state: 'ready',
      now: NOW,
    });

    const after = getIntent(trip.id)!;
    expect(after.scope!.timeZones).toEqual(compiled.region.scope.timeZones);
    expect(after.scope!.timeZoneBasis).toBe(compiled.region.scope.timeZoneBasis);
    /*
     * And the revision is untouched: this is the same scope, better known.
     * Bumping it would change the fingerprint and orphan the artifact the very
     * transaction that wrote it just committed.
     */
    expect(after.scopeRevision).toBe(revisionBefore);
  });

  it('never replaces a better-known zone with a worse one', async () => {
    const { createTrip } = await import('../db/repository');
    const { saveScope, getIntent, startJob, markJobRunning, completeJob } = await import(
      '../db/compiler-repository'
    );

    const spec = SYNTHETIC_WORLDS.transit_city!;
    const scope = deriveScope({
      candidate: syntheticCandidate(spec),
      clarifications: { schemaVersion: 1, questions: [], answers: [] },
      nights: DATES.length,
      revision: 1,
    });
    const compiled = await compileRegion({
      compilationId: 'zone-writeback-2',
      scope,
      dates: [...DATES],
      months: [8],
      providers: packBackedProviders(spec),
      now: NOW,
    });
    if (!compiled.ok) throw new Error('the world did not compile');

    const trip = createTrip({
      mode: 'known_destination',
      destinationInput: spec.name,
      regionId: 'open-world',
      startDate: DATES[0]!,
      endDate: DATES[DATES.length - 1]!,
      arrivalTime: '10:00',
      departureTime: '18:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
    });
    saveScope(trip.id, {
      ...scope,
      timeZones: ['Antarctica/Troll'],
      timeZoneBasis: 'provider_resolved',
    });
    const started = startJob({ tripId: trip.id, scopeFingerprint: 'fp-zone-2', now: NOW });
    if (started.kind !== 'started') throw new Error('the job did not start');
    markJobRunning(started.job.id, NOW);

    completeJob({
      jobId: started.job.id,
      tripId: trip.id,
      region: compiled.region,
      state: 'ready',
      now: NOW,
    });

    expect(getIntent(trip.id)!.scope!.timeZones).toEqual(['Antarctica/Troll']);
  });
});
