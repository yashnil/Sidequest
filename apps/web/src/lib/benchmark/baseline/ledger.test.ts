import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkTripRequestSchema, type BenchmarkTripRequest } from '@sidequest/bench';
import type { StructuredModel } from '../../providers/interpretation-model';
import { createBenchmarkSession } from '../../db/benchmark-repository';
import { getDb } from '../../db/client';
import { fixtureGeneration, fixturePacketInputs } from './fixtures';
import { runBaseline } from './orchestrate';

/**
 * THE LEDGER RECORDS WHAT WAS SPENT, NOT WHAT SUCCEEDED.
 *
 * Two rules, and this repository has already broken the second one once.
 *
 * **A failed call is still a call.** A provider that took the request, burned
 * the tokens and returned something unusable has spent real money. A ledger that
 * only counted successes would report the run that fell over three times as
 * having cost nothing, which is precisely the run somebody would be looking at
 * the ledger to understand.
 *
 * **A cost nobody can source is NULL with a reason, never zero.** The rate table
 * is keyed by exact model id and returns `null` for one it does not hold. Writing
 * `0` there would make "we could not price this" and "this was free" the same
 * row, and no later care recovers the difference. There is no `?? 0` anywhere on
 * this path, and this file is what keeps it that way.
 */

class FailingModel implements StructuredModel {
  calls = 0;
  readonly usage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
    estimatedCostUsd: 0,
    requestIds: [] as string[],
  };

  get callsRemaining(): number {
    return Math.max(0, 3 - this.calls);
  }

  async structured<T>(): Promise<T> {
    this.calls += 1;
    /*
     * Tokens accrue *before* the throw, exactly as the real client's accounting
     * does: the provider recorded usage on the message it returned, and then the
     * output failed to parse. A double that only counted on success would make
     * this file pass while the property it asserts was false in production.
     */
    this.usage.calls += 1;
    this.usage.inputTokens += 4321;
    this.usage.outputTokens += 765;
    this.usage.requestIds.push(`req_${this.calls}`);
    throw Object.assign(new Error('unusable'), { code: 'malformed_output' });
  }
}

class SucceedingModel implements StructuredModel {
  calls = 0;
  readonly usage = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearches: 0,
    estimatedCostUsd: 0,
    requestIds: [] as string[],
  };

  get callsRemaining(): number {
    return Math.max(0, 3 - this.calls);
  }

  async structured<T>(): Promise<T> {
    this.calls += 1;
    this.usage.calls += 1;
    this.usage.inputTokens += 2000;
    this.usage.outputTokens += 1000;
    return fixtureGeneration() as T;
  }
}

const REQUEST: BenchmarkTripRequest = benchmarkTripRequestSchema.parse({
  ...(BENCHMARK_CASES[0]?.request ?? {}),
  requestId: 'req-ledger',
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

interface CallRow {
  operation: string;
  attempt: number;
  outcome: string;
  failure_kind: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_micro_usd: number | null;
  cost_unavailable_reason: string | null;
  request_id: string | null;
  model: string;
  prompt_version: string;
  duration_ms: number | null;
}

function rows(): CallRow[] {
  return getDb()
    .prepare(
      `SELECT operation, attempt, outcome, failure_kind, input_tokens, output_tokens,
              cost_micro_usd, cost_unavailable_reason, request_id, model,
              prompt_version, duration_ms
         FROM benchmark_model_calls ORDER BY started_at`,
    )
    .all() as CallRow[];
}

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sidequest-baseline-ledger-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'benchmark.db');
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
  delete process.env.ANTHROPIC_MODEL;
  rmSync(directory, { recursive: true, force: true });
});

async function run(model: StructuredModel) {
  const session = createBenchmarkSession({
    request: REQUEST,
    idempotencyKey: `ledger-${Math.random()}`,
    now: new Date('2026-08-06T00:00:00.000Z'),
  });
  return runBaseline({
    sessionId: session.session.id,
    runId: null,
    request: REQUEST,
    now: new Date('2026-08-06T00:00:00.000Z'),
    fixture: { inputs: fixturePacketInputs() },
    createModel: () => model,
  });
}

describe('the model-call ledger', () => {
  it('writes a row for a generation that failed, with the tokens it burned', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    const outcome = await run(new FailingModel());

    expect(outcome.plan.generationState).toBe('failed');
    /*
     * Two rows, because an unreadable answer is asked for once more before the
     * run gives up — and the re-ask is billed whether or not it worked. A ledger
     * that wrote one row here would under-report the spend by half on exactly
     * the runs somebody opens the ledger to understand.
     */
    const written = rows();
    expect(written).toHaveLength(2);
    expect(written.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(written.every((entry) => entry.operation === 'generate-plan')).toBe(true);
    expect(written.every((entry) => entry.outcome === 'failed')).toBe(true);

    const row = written[0]!;
    expect(row.failure_kind).toBe('malformed_output');
    // The whole point: the failure did not stop the spend being recorded.
    expect(row.input_tokens).toBe(4321);
    expect(row.output_tokens).toBe(765);
    expect(row.request_id).toBe('req_1');
    expect(row.duration_ms).not.toBeNull();
    expect(row.prompt_version).toMatch(/generate-plan/);
    // And the second is accounted separately rather than folded into the first.
    expect(written[1]?.input_tokens).toBe(4321);
    expect(written[1]?.request_id).toBe('req_2');
  });

  it('prices a known model rather than leaving the cost blank', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    await run(new SucceedingModel());

    const row = rows()[0]!;
    expect(row.outcome).toBe('succeeded');
    expect(row.model).toBe('claude-opus-5');
    expect(row.cost_micro_usd).not.toBeNull();
    expect(row.cost_micro_usd).toBeGreaterThan(0);
    expect(row.cost_unavailable_reason).toBeNull();
  });

  /**
   * The failure this whole rule exists for. A model with no row in the
   * checked-in rate table produces a NULL cost and a stated reason — never a
   * zero, which would read as free and would quietly win a cost comparison.
   */
  it('writes NULL and a reason for a model nobody can price, never nought', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-not-in-the-rate-table';
    const outcome = await run(new SucceedingModel());

    const row = rows()[0]!;
    expect(row.model).toBe('claude-not-in-the-rate-table');
    expect(row.cost_micro_usd).toBeNull();
    expect(row.cost_micro_usd).not.toBe(0);
    expect(row.cost_unavailable_reason).toBe('unpriced_model');
    // And the same absence travels to the metric set rather than being summed
    // into a total that would be a lower bound presented as a figure.
    const cost = outcome.metrics.estimatedCostMicroUsd;
    expect(cost.state).toBe('unavailable');
    if (cost.state === 'unavailable') {
      expect(cost.reason).toBe('unpriced_model');
      expect(cost.detail.length).toBeGreaterThan(0);
    }
  });

  /**
   * A run that asks a model nothing must write nothing. A phantom row is worse
   * than a missing one: it reports spend that never happened, and it would do so
   * on every run, which is exactly the kind of small constant error a cost
   * comparison cannot survive.
   */
  it('writes no row for a stage that never called anything', async () => {
    delete process.env.SIDEQUEST_BENCHMARK_MODE;
    await run(new SucceedingModel());
    expect(rows()).toHaveLength(0);
  });

  it('records the tokens in the metric set as well as in the row', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-opus-5';
    const outcome = await run(new SucceedingModel());

    const input = outcome.metrics.inputTokens;
    const output = outcome.metrics.outputTokens;
    expect(input.state).toBe('measured');
    expect(output.state).toBe('measured');
    if (input.state === 'measured') expect(input.value).toBe(2000);
    if (output.state === 'measured') expect(output.value).toBe(1000);
  });
});
