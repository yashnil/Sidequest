import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkPlanSchema, benchmarkTripRequestSchema } from '@sidequest/bench';
import { createBenchmarkSession } from '../../db/benchmark-repository';
import { getDb } from '../../db/client';
import { fixtureGeneration, fixturePacketInputs } from './fixtures';
import { buildResearchPacket, type RawDay, type RawPlace } from './packet';
import { runPreliminaryScan } from './scan';
import { runBaseline } from './orchestrate';
import { deterministicFollowUps } from './followups';
import { buildGenerationTask } from './generate';

/**
 * A WORLD NOBODY COULD ESTABLISH STILL PRODUCES A TRIP, AND SAYS SO.
 *
 * This is the case the whole `unknown`-as-a-value design exists for. Open data
 * does not publish opening hours for most of what it holds, and no forecast
 * exists eight months out — so a planner that could only work from complete
 * evidence would work almost nowhere.
 *
 * Two failure modes are being ruled out at once, and they pull in opposite
 * directions. The first is a plan that falls over because a field was missing.
 * The second, and by far the more dangerous, is a plan that fills the gap with a
 * plausible number: "opens at 09:00" for a place nobody published hours for
 * sends a traveller to a locked gate with our confidence behind them.
 */

const REQUEST = benchmarkTripRequestSchema.parse({
  ...(BENCHMARK_CASES[0]?.request ?? {}),
  requestId: 'req-unknown',
  dates: {
    mode: 'exact',
    startDate: '2026-09-01',
    endDate: '2026-09-02',
    flexDays: 0,
    month: null,
    year: null,
    nights: 1,
  },
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

/** Every place unknown, every date without weather. The common case, not an edge. */
function darkInputs() {
  const inputs = fixturePacketInputs();
  const places: RawPlace[] = inputs.places.map((place) => ({
    ...place,
    hours: { state: 'unknown' },
    seasonal: { state: 'unknown' },
  }));
  const days: RawDay[] = inputs.days.map((day) => ({
    ...day,
    weather: { state: 'unknown' },
    weatherSource: null,
    daylight: { state: 'unknown' },
  }));
  return { ...inputs, places, days };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-baseline-unknown-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'benchmark.db');
  delete process.env.SIDEQUEST_BENCHMARK_MODE;
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  getDb();
  createBenchmarkSession({
    request: REQUEST,
    idempotencyKey: 'unknown-suite',
    now: new Date('2026-08-06T00:00:00.000Z'),
  });
});

afterEach(() => {
  const cache = globalThis as unknown as { sidequestDb?: { close: () => void } };
  cache.sidequestDb?.close();
  delete cache.sidequestDb;
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

function sessionId(): string {
  const row = getDb()
    .prepare('SELECT id FROM benchmark_sessions LIMIT 1')
    .get() as { id: string } | undefined;
  if (!row) throw new Error('The suite failed to create a session.');
  return row.id;
}

describe('with nothing established about hours or weather', () => {
  const packet = buildResearchPacket(darkInputs());
  const scan = runPreliminaryScan({ request: REQUEST, packet });

  it('the scan reports the absence as a count rather than as a shrug', () => {
    expect(scan.hours.knownCount).toBe(0);
    expect(scan.hours.unknownCount).toBe(packet.places.length);
    expect(scan.weather.forecastDays).toBe(0);
    expect(scan.weather.climateDays).toBe(0);
    expect(scan.weather.unknownDays).toBe(packet.days.length);
    expect(scan.daylight.shortestDaylightMinutes).toBeNull();
  });

  it('the scan surfaces the unknowns in words a traveller could read', () => {
    const text = scan.unknowns.join(' ');
    expect(text).toContain('Opening hours are unknown');
    expect(text).toContain('No weather evidence exists');
  });

  /**
   * A gap in the evidence is precisely when a question is worth asking, so the
   * deterministic rules must fire here rather than leave the model to invent a
   * questionnaire.
   */
  it('turns the gaps into questions the traveller can actually answer', () => {
    const questions = deterministicFollowUps({ request: REQUEST, packet, scan });
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) {
      expect(question.whyItMatters.length).toBeGreaterThan(0);
      // Never a question about the world, which is a research failure in
      // disguise and would put an unverified fact into the plan.
      expect(question.text.toLowerCase()).not.toMatch(/is it open|what time does .* open/);
    }
  });

  it('tells the model, in our own words, that these things are unknown', () => {
    const task = buildGenerationTask({ request: REQUEST, packet, scan, followUpAnswers: [] });
    expect(task).toContain('unknown for');
    expect(task).toContain('Explicitly unestablished');
  });

  it('still produces a plan, and the plan carries the unknowns forward', async () => {
    const outcome = await runBaseline({
      sessionId: sessionId(),
      request: REQUEST,
      now: new Date('2026-08-06T00:00:00.000Z'),
      fixture: {
        inputs: darkInputs(),
        // No opening claim anywhere in this generation: a plan produced from a
        // packet with no hours must not state one.
        generation: fixtureGeneration({
          days: fixtureGeneration().days.map((day) => ({
            ...day,
            blocks: day.blocks.map((block) => ({ ...block, opening: null })),
          })),
        }),
      },
    });

    expect(benchmarkPlanSchema.safeParse(outcome.plan).success).toBe(true);
    expect(outcome.plan.generationState).toBe('complete');
    expect(outcome.plan.days).toHaveLength(2);
    expect(outcome.plan.unknowns.length).toBeGreaterThan(0);
    // Nothing was spent: fixture mode reaches no model and no provider.
    expect(outcome.modelCalls).toBe(0);
  });

  it('states no opening window anywhere, because nobody published one', async () => {
    const outcome = await runBaseline({
      sessionId: sessionId(),
      request: REQUEST,
      now: new Date('2026-08-06T00:00:00.000Z'),
      fixture: {
        inputs: darkInputs(),
        generation: fixtureGeneration({
          days: fixtureGeneration().days.map((day) => ({
            ...day,
            blocks: day.blocks.map((block) => ({ ...block, opening: null })),
          })),
        }),
      },
    });

    for (const day of outcome.plan.days) {
      for (const block of day.blocks) expect(block.opening).toBeNull();
    }
  });

  /**
   * The metric counterpart of the same rule. A boundary the run never reached is
   * an explicit absence with a reason — never a zero that a dashboard would
   * average into a mean and report as the fastest system in the study.
   */
  it('reports an unreached boundary as an absence rather than as nought milliseconds', async () => {
    const outcome = await runBaseline({
      sessionId: sessionId(),
      request: REQUEST,
      now: new Date('2026-08-06T00:00:00.000Z'),
      fixture: { inputs: darkInputs(), generation: fixtureGeneration() },
    });

    const cost = outcome.metrics.estimatedCostMicroUsd;
    expect(cost.state).toBe('unavailable');
    if (cost.state === 'unavailable') expect(cost.detail.length).toBeGreaterThan(0);

    for (const measurement of Object.values(outcome.metrics)) {
      if (typeof measurement !== 'object' || measurement === null) continue;
      const entry = measurement as { state?: string; detail?: string };
      if (entry.state === 'unavailable') expect(entry.detail?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
