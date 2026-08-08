import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE CEILING, AND THE FACT THAT NOTHING USED TO CONSULT IT.
 *
 * `maySpend` was written, was correct, and had no callers. The ledger was
 * written, the total was computed, and every paid call site asked only
 * `paidOperationsPermitted` — which answers "is a budget configured", not "is
 * there any of it left". A pilot could therefore spend past a limit the founder
 * guide states is enforced before every call, and the only thing that would have
 * revealed it is the bill.
 *
 * These tests are about the gate the call sites now use. The interesting cases
 * are the refusals, because a gate that only ever allows is the state this was
 * already in.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  // Cleared here as well as afterwards: the environment is process-wide, and a
  // test asserting "no ceiling was configured" must not inherit one from
  // whatever ran before it in this worker.
  delete process.env.SIDEQUEST_BENCHMARK_BUDGET_USD;
  delete process.env.SIDEQUEST_BENCHMARK_MODE;
  dir = mkdtempSync(join(tmpdir(), 'sidequest-benchmark-budget-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_BENCHMARK_BUDGET_USD;
  delete process.env.SIDEQUEST_BENCHMARK_MODE;
  rmSync(dir, { recursive: true, force: true });
});

/** A bare environment, since the predicates take the whole thing. */
function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
}

async function billOnce(costMicroUsd: number | null, unpriced = false): Promise<void> {
  const { createBenchmarkSession, startRun } = await import('../db/benchmark-repository');
  const { recordArmModelCall } = await import('../db/benchmark-review-repository');
  const { fakeRequest } = await import('@sidequest/bench/testing');

  const now = new Date('2026-08-06T00:00:00.000Z');
  const { session } = createBenchmarkSession({
    request: fakeRequest(),
    idempotencyKey: `budget-${Math.random()}`,
    now,
  });
  const run = startRun({ sessionId: session.id, arm: 'baseline', now });
  recordArmModelCall({
    sessionId: session.id,
    runId: run.id,
    arm: 'baseline',
    operation: 'generate-plan',
    provider: 'anthropic',
    model: 'a-model',
    inputTokens: 10,
    outputTokens: 10,
    costMicroUsd: unpriced ? null : costMicroUsd,
    costUnavailableReason: unpriced ? 'The rate table has no row for this model.' : null,
    outcome: 'succeeded',
    startedAt: now,
    finishedAt: now,
  });
}

describe('the spending gate', () => {
  it('refuses a live run with no ceiling configured at all', async () => {
    process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
    const { gateSpend } = await import('./budget');
    const gate = gateSpend('generation');
    expect(gate.kind).toBe('refused');
    if (gate.kind === 'refused') expect(gate.reason).toContain('No spending ceiling');
  });

  it('stands aside entirely outside live mode, where nothing may spend anyway', async () => {
    /*
     * The offline demonstration is an acceptance criterion, and a gate refusing
     * it for want of a budget nobody was going to spend would break it. Outside
     * live mode the provider switches are what govern, exactly as before.
     */
    const { gateSpend } = await import('./budget');
    expect(gateSpend('compilation').kind).toBe('allowed');
    expect(gateSpend('generation').kind).toBe('allowed');
  });

  it('allows a call that fits inside what is left', async () => {
    process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
    process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '15';
    await billOnce(1_000_000);
    const { gateSpend } = await import('./budget');
    expect(gateSpend('generation').kind).toBe('allowed');
  });

  it('refuses a call that would cross the ceiling, before it is made', async () => {
    /*
     * Fourteen dollars spent against a fifteen-dollar ceiling. A generation is
     * reserved at two and a half, so this refuses — which is the requirement:
     * stop *short* of the boundary rather than discover it by crossing it.
     */
    process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
    process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '15';
    await billOnce(14_000_000);
    const { gateSpend } = await import('./budget');
    const gate = gateSpend('generation');
    expect(gate.kind).toBe('refused');
    if (gate.kind === 'refused') expect(gate.reason).toContain('too little left');
  });

  it('still allows a cheap step where an expensive one is refused', async () => {
    process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
    process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '15';
    await billOnce(14_000_000);
    const { gateSpend } = await import('./budget');
    // A hundred and fifty thousand micro-USD fits in the remaining million.
    expect(gateSpend('followUpSynthesis').kind).toBe('allowed');
    expect(gateSpend('compilation').kind).toBe('refused');
  });

  it('refuses everything once a call could not be priced', async () => {
    /*
     * A total that omits an unpriced call is a floor, and a ceiling compared
     * against a floor is not a ceiling. Refusing is the conservative direction and
     * it is recoverable by adding the rate; spending past the ceiling is not.
     */
    process.env.SIDEQUEST_BENCHMARK_MODE = 'live';
    process.env.SIDEQUEST_BENCHMARK_BUDGET_USD = '15';
    await billOnce(null, true);
    const { gateSpend } = await import('./budget');
    expect(gateSpend('followUpSynthesis').kind).toBe('refused');
  });

  it('treats a malformed or zero budget as no budget, so a typo costs nothing', async () => {
    const { benchmarkBudgetFromEnv } = await import('./budget');
    for (const raw of ['', '  ', 'fifteen', '0', '-3', 'NaN']) {
      expect(benchmarkBudgetFromEnv(env({ SIDEQUEST_BENCHMARK_BUDGET_USD: raw })), raw).toBeNull();
    }
    expect(
      benchmarkBudgetFromEnv(env({ SIDEQUEST_BENCHMARK_BUDGET_USD: '15' })),
    ).not.toBeNull();
  });

  it('needs both switches before any paid operation is permitted', async () => {
    const { paidOperationsPermitted } = await import('./budget');
    expect(paidOperationsPermitted(env({}))).toBe(false);
    expect(paidOperationsPermitted(env({ SIDEQUEST_BENCHMARK_MODE: 'live' }))).toBe(false);
    expect(paidOperationsPermitted(env({ SIDEQUEST_BENCHMARK_BUDGET_USD: '15' }))).toBe(false);
    expect(
      paidOperationsPermitted(
        env({ SIDEQUEST_BENCHMARK_MODE: 'live', SIDEQUEST_BENCHMARK_BUDGET_USD: '15' }),
      ),
    ).toBe(true);
  });

  it('reserves more than the measured pilot spent, so it stops short rather than after', async () => {
    const { SPEND_ESTIMATES_MICRO_USD } = await import('./budget');
    // The measured live figures: a generation billed $1.22, a compilation $1.72.
    expect(SPEND_ESTIMATES_MICRO_USD.generation).toBeGreaterThan(1_220_000);
    expect(SPEND_ESTIMATES_MICRO_USD.compilation).toBeGreaterThan(1_720_000);
  });
});
