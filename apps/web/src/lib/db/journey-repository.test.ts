import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STAGE_OBSERVATION_VERSION, machineShareOf, type StageObservation } from '@sidequest/core';
import { getDb } from './client';
import { createTrip } from './repository';
import { recordStageObservation } from './timing-repository';
import {
  attributableWorkMs,
  journeySpanOf,
  journeySpansFor,
  recordJourneySpan,
} from './journey-repository';

/**
 * THE CLOCK THAT CROSSES SCREENS.
 *
 * Three claims, and the third is the one the design turns on.
 *
 * 1. A span round-trips, and a second pass over the same milestone replaces the
 *    first rather than accumulating a second answer to one question.
 * 2. The machine share is attributed from observations that actually exist.
 * 3. **Nothing counted is reported as `null`, never as zero.** A bar drawn at
 *    zero reads as "instant"; the truth is "nobody measured", and the two must
 *    not print the same.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-journey-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'journey.db');
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
});

afterEach(() => {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function tripId(): string {
  return createTrip({
    mode: 'known_destination',
    destinationInput: 'Testville',
    regionId: 'eastern-sierra',
    startDate: '2026-08-12',
    endDate: '2026-08-16',
    arrivalTime: '12:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  }).id;
}

function observation(jobId: string, over: Partial<StageObservation> = {}): StageObservation {
  return {
    schemaVersion: STAGE_OBSERVATION_VERSION,
    jobId,
    stage: 'retrieving_pages',
    phase: 'verifying',
    outcome: 'done',
    startedAt: '2026-08-02T12:00:00.000Z',
    completedAt: '2026-08-02T12:00:42.000Z',
    durationMs: 42_000,
    monotonicMs: 41_900,
    breadth: 'city',
    shape: 'city',
    warmth: 'cold',
    degraded: false,
    providerCalls: 3,
    cacheHits: 1,
    retries: 0,
    observedAt: '2026-08-02T12:00:42.000Z',
    ...over,
  };
}

describe('a milestone on the way to a usable trip', () => {
  it('round-trips, and a second pass replaces the first rather than doubling it', () => {
    const id = tripId();
    recordJourneySpan(
      journeySpanOf({
        tripId: id,
        span: 'first_useful_board',
        startedAt: new Date('2026-08-02T12:00:00.000Z'),
        completedAt: new Date('2026-08-02T12:05:00.000Z'),
      }),
    );
    recordJourneySpan(
      journeySpanOf({
        tripId: id,
        span: 'first_useful_board',
        startedAt: new Date('2026-08-02T12:00:00.000Z'),
        completedAt: new Date('2026-08-02T12:09:00.000Z'),
      }),
    );

    const spans = journeySpansFor(id);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.durationMs).toBe(9 * 60_000);
  });

  it('leaves the machine share unknown rather than zero when nothing was measured', () => {
    const id = tripId();
    const span = journeySpanOf({
      tripId: id,
      span: 'usable_itinerary',
      startedAt: new Date('2026-08-02T12:00:00.000Z'),
      completedAt: new Date('2026-08-02T12:05:00.000Z'),
      machineMs: attributableWorkMs(id, '2026-08-02T00:00:00.000Z'),
    });
    expect(span.machineMs).toBeUndefined();
    expect(machineShareOf(span)).toBeNull();
  });

  it('attributes the work the stage observations actually recorded', () => {
    const id = tripId();
    const jobId = 'job-journey-1';
    getDb()
      .prepare(
        `INSERT INTO compilation_jobs
           (id, trip_id, scope_fingerprint, state, stage, stages_json, started_at, updated_at, heartbeat_at, correlation_id)
         VALUES (?, ?, ?, 'ready', 'compiling', '[]', ?, ?, ?, 'corr-1')`,
      )
      .run(
        jobId,
        id,
        'fp-1',
        '2026-08-02T12:00:00.000Z',
        '2026-08-02T12:00:00.000Z',
        '2026-08-02T12:00:00.000Z',
      );
    recordStageObservation(observation(jobId));
    recordStageObservation(observation(jobId, { stage: 'computing_travel_times', monotonicMs: 8_100 }));

    // The monotonic figure is preferred, exactly as the estimator prefers it.
    expect(attributableWorkMs(id, '2026-08-02T00:00:00.000Z')).toBe(41_900 + 8_100);

    const span = journeySpanOf({
      tripId: id,
      span: 'usable_itinerary',
      startedAt: new Date('2026-08-02T12:00:00.000Z'),
      completedAt: new Date('2026-08-02T12:05:00.000Z'),
      machineMs: attributableWorkMs(id, '2026-08-02T00:00:00.000Z'),
    });
    expect(machineShareOf(span)).toBeCloseTo(50_000 / 300_000, 5);
  });

  it('does not attribute another trip\'s work to this one', () => {
    const mine = tripId();
    const theirs = tripId();
    getDb()
      .prepare(
        `INSERT INTO compilation_jobs
           (id, trip_id, scope_fingerprint, state, stage, stages_json, started_at, updated_at, heartbeat_at, correlation_id)
         VALUES (?, ?, ?, 'ready', 'compiling', '[]', ?, ?, ?, 'corr-2')`,
      )
      .run(
        'job-theirs',
        theirs,
        'fp-2',
        '2026-08-02T12:00:00.000Z',
        '2026-08-02T12:00:00.000Z',
        '2026-08-02T12:00:00.000Z',
      );
    recordStageObservation(observation('job-theirs'));

    expect(attributableWorkMs(mine, '2026-08-02T00:00:00.000Z')).toBeNull();
    expect(attributableWorkMs(theirs, '2026-08-02T00:00:00.000Z')).toBe(41_900);
  });

  it('goes with the trip when the trip goes', () => {
    const id = tripId();
    recordJourneySpan(
      journeySpanOf({
        tripId: id,
        span: 'planning',
        startedAt: new Date('2026-08-02T12:00:00.000Z'),
        completedAt: new Date('2026-08-02T12:00:02.000Z'),
        machineMs: 2_000,
      }),
    );
    expect(journeySpansFor(id)).toHaveLength(1);

    getDb().prepare('DELETE FROM trips WHERE id = ?').run(id);
    expect(journeySpansFor(id)).toHaveLength(0);
  });
});
