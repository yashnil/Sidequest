import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import {
  benchmarkTripRequestSchema,
  type BenchReport,
  type BenchmarkPlan,
  type BenchmarkTripRequest,
} from '@sidequest/bench';
import type { StructuredModel } from '../../providers/interpretation-model';
import { createBenchmarkSession } from '../../db/benchmark-repository';
import { getDb } from '../../db/client';
import { fixtureGeneration, fixturePacketInputs } from './fixtures';
import { BASELINE_MAX_MODEL_CALLS, runBaseline } from './orchestrate';
import type { PacketInputs } from './packet';

/**
 * THREE CALLS, ON EVERY PATH, INCLUDING THE ONES THAT GO WRONG.
 *
 * The ceiling is not a target and it is not a matter of care. It is the property
 * that makes this arm's cost comparable at all: a system that quietly retried
 * twice on a bad answer would look accurate and would be measured against a rival
 * that did not.
 *
 * The paths that matter are the failing ones, because that is where a retry
 * looks reasonable to whoever adds it. A malformed answer, a rate limit, an
 * outage and a repair that is itself malformed each end the run — with a partial
 * plan or a failed one — and none of them starts another call.
 *
 * The fake below counts attempts rather than successes, which is the same thing
 * the real fence counts and the same thing a provider bills for.
 */

/** A model that answers however the test says, and remembers how often it was asked. */
class CountingModel implements StructuredModel {
  calls = 0;
  readonly promptVersions: string[] = [];
  readonly usage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  };

  constructor(
    private readonly behaviour: (call: number, promptVersion: string) => unknown,
    private readonly maxCalls = BASELINE_MAX_MODEL_CALLS,
  ) {}

  get callsRemaining(): number {
    return Math.max(0, this.maxCalls - this.calls);
  }

  async structured<T>(input: { promptVersion: string; schema: unknown }): Promise<T> {
    if (this.callsRemaining <= 0) {
      // The same refusal the real fence makes, so a test cannot pass by being
      // given a more forgiving double than production has.
      throw Object.assign(new Error('no calls left'), { code: 'request_failed' });
    }
    this.calls += 1;
    this.usage.calls += 1;
    this.usage.inputTokens += 1000;
    this.usage.outputTokens += 500;
    this.promptVersions.push(input.promptVersion);
    const answer = this.behaviour(this.calls, input.promptVersion);
    if (answer instanceof Error) throw answer;
    return answer as T;
  }
}

function malformed(): Error {
  return Object.assign(new Error('unusable'), { code: 'malformed_output' });
}
function rateLimited(): Error {
  return Object.assign(new Error('slow down'), { code: 'rate_limited' });
}
function outage(): Error {
  return Object.assign(new Error('nothing answered'), { code: 'request_failed' });
}

/** A report with one critical finding, which is what provokes the one repair. */
function reportWithCritical(plan: BenchmarkPlan): BenchReport {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    planFingerprint: 'fingerprint',
    findings: [
      {
        code: 'scheduled_while_closed',
        severity: 'critical',
        subject: { dayNumber: 1, blockIndex: 0, entityId: 'node/1003' },
        message: 'The museum is shut at that hour.',
        groundTruth: 'openingOn',
        observed: {},
        expected: {},
      },
    ],
    counts: { critical: 1, major: 0, minor: 0, informational: 0, unknown: 0 },
    verifiability: { attempted: 10, decided: 9 },
  };
}

function cleanReport(plan: BenchmarkPlan): BenchReport {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    planFingerprint: 'fingerprint',
    findings: [],
    counts: { critical: 0, major: 0, minor: 0, informational: 0, unknown: 0 },
    verifiability: { attempted: 10, decided: 10 },
  };
}

const BASE_REQUEST: BenchmarkTripRequest = benchmarkTripRequestSchema.parse({
  ...(BENCHMARK_CASES[0]?.request ?? {}),
  requestId: 'req-budget',
  dates: {
    mode: 'exact',
    startDate: '2026-09-01',
    endDate: '2026-09-02',
    flexDays: 0,
    month: null,
    year: null,
    nights: 1,
  },
  arrival: { precision: 'exact', time: '09:00' },
  departure: { precision: 'exact', time: '18:00' },
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

/**
 * A request whose gaps the deterministic rules cannot fill, so the one optional
 * synthesis call is warranted. That is the only shape in which three calls can
 * happen at all, and it is therefore the shape the ceiling has to survive.
 */
const QUIET_REQUEST: BenchmarkTripRequest = benchmarkTripRequestSchema.parse({
  ...BASE_REQUEST,
  requestId: 'req-budget-quiet',
});

/** No closures, food everywhere, one forecast day: nothing for a rule to fire on. */
function quietInputs(): PacketInputs {
  const inputs = fixturePacketInputs();
  return {
    ...inputs,
    places: inputs.places.map((place) => ({
      ...place,
      seasonal: { state: 'open_in_season' },
      // Every cluster gets somewhere to eat, so the carry-lunch rule is silent.
      food: place.food ?? { servesSlots: [], dietaryTags: [], cuisine: null, cannotAccommodate: [] },
    })),
    days: inputs.days.map((day) => ({
      ...day,
      weather: {
        state: 'forecast',
        summary: 'A forecast for this date.',
        highCelsius: 21,
        lowCelsius: 12,
        precipitationChance: 10,
        sourceIndex: null,
      },
    })),
  };
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-baseline-budget-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'benchmark.db');
  // Live mode, because fixture mode may reach no model at all and would make
  // every assertion below pass for the wrong reason.
  process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
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
  delete process.env.SIDEQUEST_BENCHMARK_MODE;
  rmSync(directory, { recursive: true, force: true });
});

async function run(input: {
  model: CountingModel;
  request?: BenchmarkTripRequest;
  inputs?: PacketInputs;
  validate?: (plan: BenchmarkPlan) => BenchReport | null;
  followUpAnswers?: readonly { question: string; answer: string }[];
  modelCallsAlreadySpent?: number;
  sessionId?: string;
}) {
  const request = input.request ?? BASE_REQUEST;
  const sessionId =
    input.sessionId ??
    createBenchmarkSession({
      request,
      idempotencyKey: `budget-${request.requestId}-${Math.random()}`,
      now: new Date('2026-08-06T00:00:00.000Z'),
    }).session.id;
  return runBaseline({
    sessionId,
    request,
    now: new Date('2026-08-06T00:00:00.000Z'),
    fixture: { inputs: input.inputs ?? fixturePacketInputs() },
    createModel: () => input.model,
    ...(input.followUpAnswers ? { followUpAnswers: input.followUpAnswers } : {}),
    ...(input.modelCallsAlreadySpent !== undefined
      ? { modelCallsAlreadySpent: input.modelCallsAlreadySpent }
      : {}),
    ...(input.validate ? { validate: input.validate } : {}),
  });
}

/**
 * THE ANSWERS ARE PART OF THE INPUT, SO THEY ARE PART OF ITS IDENTITY.
 *
 * The single-flight claim is keyed on a hash of the run's inputs. While that
 * hash covered only the shared request, a run made *with* confirmed follow-up
 * answers and a run made without them shared one identity — so the second would
 * be told the first had already settled and handed its plan back, with the
 * answers silently discarded and a stored plan that looks as though it used
 * them.
 *
 * The two assertions below are the two halves of the fix: a different set of
 * answers is a different operation, and the same set is the same one.
 */
describe('the operation identity', () => {
  it('treats a run with answers as a different operation from one without', async () => {
    const request = BASE_REQUEST;
    const sessionId = createBenchmarkSession({
      request,
      idempotencyKey: `identity-${Math.random()}`,
      now: new Date('2026-08-06T00:00:00.000Z'),
    }).session.id;

    const first = await run({
      model: new CountingModel(() => fixtureGeneration()),
      sessionId,
      validate: cleanReport,
    });
    expect(first.singleFlight).toBe('won');

    const second = await run({
      model: new CountingModel(() => fixtureGeneration()),
      sessionId,
      followUpAnswers: [{ question: 'When do you arrive?', answer: 'evening' }],
      validate: cleanReport,
    });
    // A fresh claim rather than "already settled": the answers changed the input.
    expect(second.singleFlight).toBe('won');
  });

  it('treats the same answers as the same operation, whatever order they arrive in', async () => {
    const request = BASE_REQUEST;
    const sessionId = createBenchmarkSession({
      request,
      idempotencyKey: `identity-same-${Math.random()}`,
      now: new Date('2026-08-06T00:00:00.000Z'),
    }).session.id;

    const answers = [
      { question: 'When do you arrive?', answer: 'evening' },
      { question: 'Will you carry lunch?', answer: 'yes' },
    ];
    const first = await run({
      model: new CountingModel(() => fixtureGeneration()),
      sessionId,
      followUpAnswers: answers,
      validate: cleanReport,
    });
    expect(first.singleFlight).toBe('won');

    const second = await run({
      model: new CountingModel(() => fixtureGeneration()),
      sessionId,
      // Reversed. A hash that moved on ordering would defeat the claim on every
      // refresh, which is the opposite of what widening it was for.
      followUpAnswers: [...answers].reverse(),
      validate: cleanReport,
    });
    expect(second.singleFlight).toBe('settled');
  });
});

describe('calls the question round already spent', () => {
  it('counts them against the same three, rather than starting over at zero', async () => {
    const model = new CountingModel(() => fixtureGeneration());
    /*
     * The question round happens before this call and may spend one of the three.
     * A run that forgot it could make three more — four in total, past the
     * contract's ceiling — so the count travels with the run.
     */
    const outcome = await run({
      model,
      modelCallsAlreadySpent: BASELINE_MAX_MODEL_CALLS,
      validate: cleanReport,
    });
    expect(model.calls).toBe(0);
    expect(outcome.plan.generationState).toBe('failed');
    expect(outcome.plan.failureKind).toBe('budget_exhausted');
  });
});

describe('the model-call ceiling', () => {
  it('spends exactly one call on a plan that needs no correction', async () => {
    const model = new CountingModel(() => fixtureGeneration());
    const outcome = await run({ model, validate: cleanReport });

    expect(model.calls).toBe(1);
    expect(outcome.modelCalls).toBe(1);
    expect(outcome.repairCalls).toBe(0);
    expect(outcome.plan.generationState).toBe('complete');
  });

  it('spends two on a plan the checker rejects, and stops there', async () => {
    const model = new CountingModel((call) => (call === 1 ? fixtureGeneration() : fixtureGeneration()));
    let seen = 0;
    const outcome = await run({
      model,
      validate: (plan) => {
        seen += 1;
        // Rejected both before and after the repair: the run must accept a
        // partial plan rather than reach for a third call.
        return reportWithCritical(plan);
      },
    });

    expect(model.calls).toBe(2);
    expect(model.promptVersions[1]).toMatch(/repair/);
    expect(seen).toBe(2);
    expect(outcome.repairCalls).toBe(1);
    expect(outcome.plan.generationState).toBe('partial');
    expect(outcome.plan.warnings.join(' ')).toContain('remained after the single correction attempt');
  });

  it('does not loop when the repair is itself unusable', async () => {
    const model = new CountingModel((call) => (call === 1 ? fixtureGeneration() : malformed()));
    const outcome = await run({ model, validate: reportWithCritical });

    expect(model.calls).toBe(2);
    expect(outcome.plan.generationState).toBe('partial');
    expect(outcome.plan.warnings.join(' ')).toContain('did not produce a usable plan');
  });

  /**
   * A rate limit and an outage are facts about the provider, and asking again
   * inside the same second spends a call to learn what the first one already
   * established. Only an unusable *answer* is worth a second ask.
   */
  it.each([
    ['a rate limit', rateLimited],
    ['an outage', outage],
  ])('stops after one call on %s', async (_label, fail) => {
    const model = new CountingModel(() => fail());
    const outcome = await run({ model, validate: cleanReport });

    expect(model.calls).toBe(1);
    expect(outcome.plan.generationState).toBe('failed');
    expect(outcome.plan.failureKind).not.toBeNull();
    expect(outcome.plan.failureDetail).toBeTruthy();
  });

  /**
   * THE PATH THAT USED TO END WITH TWO CALLS UNSPENT.
   *
   * A truncated answer arrives as an unusable one, and the run used to return an
   * empty plan with two thirds of its budget in hand — which the results table
   * counted as this arm failing to plan rather than as one response being cut
   * off. It asks once more, and exactly once.
   */
  it('asks again once when the answer comes back unreadable', async () => {
    const model = new CountingModel((call) => (call === 1 ? malformed() : fixtureGeneration()));
    const outcome = await run({ model, validate: cleanReport });

    expect(model.calls).toBe(2);
    expect(model.promptVersions.every((version) => /generate/.test(version))).toBe(true);
    expect(outcome.modelCalls).toBe(2);
    // A re-ask is a generation, never the one repair the run is allowed.
    expect(outcome.repairCalls).toBe(0);
    expect(outcome.plan.generationState).toBe('complete');
  });

  it('asks again once and no more when the second answer is unreadable too', async () => {
    const model = new CountingModel(() => malformed());
    const outcome = await run({ model, validate: cleanReport });

    expect(model.calls).toBe(2);
    expect(outcome.plan.generationState).toBe('failed');
    expect(outcome.plan.failureKind).toBe('malformed_output');
    expect(outcome.plan.failureDetail).toBeTruthy();
  });

  /**
   * The re-ask and the repair draw from the same three calls rather than adding
   * a fourth, so a run that used both after the optional first call would be the
   * off-by-one this whole file exists to catch.
   */
  it('still fits inside three when a re-ask is followed by a plan needing repair', async () => {
    const model = new CountingModel((call) => (call === 1 ? malformed() : fixtureGeneration()));
    const outcome = await run({ model, validate: reportWithCritical });

    expect(model.calls).toBe(BASELINE_MAX_MODEL_CALLS);
    expect(model.promptVersions[2]).toMatch(/repair/);
    expect(outcome.modelCalls).toBeLessThanOrEqual(BASELINE_MAX_MODEL_CALLS);
    expect(outcome.repairCalls).toBe(1);
    expect(outcome.plan.generationState).toBe('partial');
  });

  /**
   * And the same shape with the optional follow-up call spent first: the budget
   * is gone after the re-ask, so the repair simply does not happen and the plan
   * says so rather than reaching for a fourth call.
   */
  it('lets the budget run out rather than exceeding it', async () => {
    const model = new CountingModel((call) => (call === 2 ? malformed() : fixtureGeneration()));
    const outcome = await run({
      model,
      request: QUIET_REQUEST,
      inputs: quietInputs(),
      validate: reportWithCritical,
    });

    expect(model.calls).toBeLessThanOrEqual(BASELINE_MAX_MODEL_CALLS);
    expect(outcome.modelCalls).toBeLessThanOrEqual(BASELINE_MAX_MODEL_CALLS);
    expect(model.promptVersions[0]).toMatch(/follow-up/);
    expect(model.promptVersions[1]).toMatch(/generate/);
    expect(model.promptVersions[2]).toMatch(/generate/);
  });

  /**
   * The only shape in which all three calls happen. The ceiling has to hold
   * exactly here, because this is where an off-by-one would show up as a fourth.
   */
  it('never exceeds three, even when every stage is used and every stage fails', async () => {
    const model = new CountingModel((call) => (call === 2 ? fixtureGeneration() : malformed()));
    const outcome = await run({
      model,
      request: QUIET_REQUEST,
      inputs: quietInputs(),
      validate: reportWithCritical,
    });

    expect(model.calls).toBeLessThanOrEqual(BASELINE_MAX_MODEL_CALLS);
    expect(outcome.modelCalls).toBeLessThanOrEqual(BASELINE_MAX_MODEL_CALLS);
    expect(model.promptVersions[0]).toMatch(/follow-up/);
    expect(model.promptVersions[1]).toMatch(/generate/);
  });

  /**
   * The second enforcement, checked on its own. The orchestrator's counter and
   * the fence's `callsRemaining` are independent, and a run whose fence is
   * already spent must degrade rather than throw.
   */
  it('degrades honestly when the fence has nothing left', async () => {
    const model = new CountingModel(() => fixtureGeneration(), 0);
    const outcome = await run({ model, validate: cleanReport });

    expect(model.calls).toBe(0);
    expect(outcome.plan.generationState).toBe('failed');
    expect(outcome.plan.failureKind).toBe('budget_exhausted');
  });

  /**
   * A run that reaches no model at all is the default posture of this build, and
   * it must not be reachable *by accident* from a live-mode configuration —
   * which is why the mode is read rather than inferred from whether a key
   * happens to be set.
   */
  it('reaches no model at all in fixture mode', async () => {
    delete process.env.SIDEQUEST_BENCHMARK_MODE;
    const model = new CountingModel(() => fixtureGeneration());
    const outcome = await run({ model, validate: cleanReport });

    expect(model.calls).toBe(0);
    expect(outcome.modelCalls).toBe(0);
    expect(outcome.plan.generationState).toBe('failed');
  });
});
