import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkPlanSchema, benchmarkTripRequestSchema } from '@sidequest/bench';
import { createBenchmarkSession } from '../../db/benchmark-repository';
import { getDb } from '../../db/client';
import { benchmarkMode, baselineCapabilities } from './mode';
import { runBaseline } from './orchestrate';

/**
 * NO KEY, NO SWITCH, NO NETWORK — AND STILL NOT AN EXCEPTION.
 *
 * The posture this build defaults to, asserted rather than assumed. Three
 * properties, and the direction of each matters more than the property itself.
 *
 * **The default is `fixture`.** An unset environment variable must never be the
 * reason a benchmark starts billing somebody. Forgetting to configure this
 * should cost nothing and say so; going live is a deliberate act. A default
 * pointing the other way would be one missing line in a deployment away from a
 * bill nobody authorised.
 *
 * **Importing the module reaches nothing.** Not a credential check, not a
 * geocode, not a socket. If merely importing this file could fail, the whole
 * offline suite would depend on somebody's shell.
 *
 * **A run with nothing configured returns a recorded failure.** Not a throw. A
 * benchmark that dropped its failures would report a hundred per cent success
 * for whichever system fell over most often, so the absence of a credential
 * produces a plan row with `failed` and a reason on it — which the results table
 * can count.
 */

const REQUEST = benchmarkTripRequestSchema.parse({
  ...(BENCHMARK_CASES[0]?.request ?? {}),
  requestId: 'req-offline',
  destination: {
    mode: 'known',
    text: 'Ardenholt',
    identity: {
      id: 'relation/900001',
      displayName: 'Ardenholt',
      countryCode: 'ZZ',
      latitude: 45,
      longitude: 9,
    },
  },
});

let directory: string;
let savedKey: string | undefined;
let savedMode: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-baseline-offline-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'benchmark.db');
  savedKey = process.env.ANTHROPIC_API_KEY;
  savedMode = process.env.SIDEQUEST_BENCHMARK_MODE;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SIDEQUEST_BENCHMARK_MODE;
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  getDb();
});

afterEach(() => {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  if (savedMode === undefined) delete process.env.SIDEQUEST_BENCHMARK_MODE;
  else process.env.SIDEQUEST_BENCHMARK_MODE = savedMode;
  rmSync(directory, { recursive: true, force: true });
});

describe('with nothing configured', () => {
  it('defaults to fixture mode rather than to live', () => {
    expect(benchmarkMode()).toBe('fixture');
    const capabilities = baselineCapabilities();
    expect(capabilities.modelPermitted).toBe(false);
    expect(capabilities.providersPermitted).toBe(false);
    expect(capabilities.reason.length).toBeGreaterThan(0);
  });

  it('treats an unrecognised value as fixture, not as permission', () => {
    process.env.SIDEQUEST_BENCHMARK_MODE = 'LIVE_PLEASE';
    expect(benchmarkMode()).toBe('fixture');
    process.env.SIDEQUEST_BENCHMARK_MODE = ' Live ';
    // Trimmed and lowercased, because a stray space in a deployment file should
    // not be the difference between spending and not.
    expect(benchmarkMode()).toBe('live');
  });

  it('imports and runs without throwing, and records the failure instead', async () => {
    const session = createBenchmarkSession({
      request: REQUEST,
      idempotencyKey: 'offline-1',
      now: new Date('2026-08-06T00:00:00.000Z'),
    });

    const outcome = await runBaseline({
      sessionId: session.session.id,
      request: REQUEST,
      now: new Date('2026-08-06T00:00:00.000Z'),
    });

    expect(benchmarkPlanSchema.safeParse(outcome.plan).success).toBe(true);
    expect(outcome.plan.generationState).toBe('failed');
    expect(outcome.plan.failureKind).toBe('insufficient_data');
    expect(outcome.plan.failureDetail).toBeTruthy();
    expect(outcome.modelCalls).toBe(0);
    expect(outcome.packet).toBeNull();
  });

  /**
   * The failure sentence is part of the blinding. A reviewer who could tell the
   * two arms apart by their error text has not been blinded, so no provider
   * name, no model name and no SDK wording may appear in it.
   */
  it('names no provider and no model in what it says went wrong', async () => {
    const session = createBenchmarkSession({
      request: REQUEST,
      idempotencyKey: 'offline-2',
      now: new Date('2026-08-06T00:00:00.000Z'),
    });
    const outcome = await runBaseline({
      sessionId: session.session.id,
      request: REQUEST,
      now: new Date('2026-08-06T00:00:00.000Z'),
    });

    const text = `${outcome.plan.failureDetail ?? ''} ${outcome.plan.warnings.join(' ')}`.toLowerCase();
    for (const forbidden of ['anthropic', 'claude', 'openai', 'nominatim', 'overpass', 'valhalla', 'open-meteo']) {
      expect(text.includes(forbidden), `the failure text mentions ${forbidden}`).toBe(false);
    }
  });

  /**
   * A run that produced nothing still produces a metric set, and every boundary
   * it never reached is an explicit absence with a reason. Never a zero: a
   * dashboard averaging that zero would report the system that crashed as the
   * fastest one in the study.
   */
  it('produces a metric set in which no unreached boundary is nought', async () => {
    const session = createBenchmarkSession({
      request: REQUEST,
      idempotencyKey: 'offline-3',
      now: new Date('2026-08-06T00:00:00.000Z'),
    });
    const outcome = await runBaseline({
      sessionId: session.session.id,
      request: REQUEST,
      now: new Date('2026-08-06T00:00:00.000Z'),
    });

    for (const name of [
      'timeToFirstItineraryMs',
      'timeToValidatedPlanMs',
      'timeToFollowUpQuestionsMs',
    ] as const) {
      const measurement = outcome.metrics[name];
      expect(measurement.state).toBe('unavailable');
      if (measurement.state === 'unavailable') {
        expect(measurement.reason).toBe('run_failed');
        expect(measurement.detail.length).toBeGreaterThan(0);
      }
    }
    expect(outcome.metrics.modelCalls).toEqual({ state: 'measured', value: 0, unit: 'calls' });
  });

  /**
   * The single-flight claim is durable, so a second identical run must not start
   * a second generation. It reports why rather than pretending to have produced
   * the first one's plan, which it never saw.
   */
  it('refuses a second run of the same identity rather than duplicating it', async () => {
    const session = createBenchmarkSession({
      request: REQUEST,
      idempotencyKey: 'offline-4',
      now: new Date('2026-08-06T00:00:00.000Z'),
    });
    const args = {
      sessionId: session.session.id,
      request: REQUEST,
      now: new Date('2026-08-06T00:00:00.000Z'),
    };

    const first = await runBaseline(args);
    const second = await runBaseline(args);

    expect(first.singleFlight).toBe('won');
    expect(second.singleFlight).not.toBe('won');
    expect(second.plan.generationState).toBe('failed');
    expect(second.plan.failureDetail).toBeTruthy();
  });
});
