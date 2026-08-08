import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';

/**
 * WHEN TWO SUBMISSIONS ARE ONE, AND WHEN THEY ARE NOT.
 *
 * A benchmark session absorbs a retried post on purpose: a double-clicked button
 * must not open a second comparison against a request the reviewer made once.
 * Everything depends on the key that decides which submissions count as the same
 * one, and both of the keys this interface used were too coarse.
 *
 * The real path keyed on the request and the current minute, so two reviewers who
 * started the same library case within the same minute were handed one session —
 * one blind assignment, one pair of plans, one review — and the second reviewer's
 * work went into a comparison somebody else had started. The fixture path keyed on
 * a caller-supplied seed alone, so the same seed with a different case or a
 * different shape adopted whatever that seed had made and returned `ok`.
 *
 * Neither failure raises anything. Both produce a session that looks entirely
 * ordinary and is not the one the caller asked for, which is why they are tested
 * from the outside rather than trusted to a comment.
 */

let directory: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-benchmark-identity-'));
  process.env.SIDEQUEST_DB_PATH = join(directory, 'test.db');
  delete process.env.SIDEQUEST_BENCHMARK_MODE;
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(directory, { recursive: true, force: true });
});

const FIRST_CASE = BENCHMARK_CASES[0]?.caseId ?? '';
const SECOND_CASE = BENCHMARK_CASES[1]?.caseId ?? '';

async function seedFixture() {
  const actions = await import('../../app/labs/benchmark/new/actions');
  return actions.seedFixtureComparisonAction;
}

describe('the fixture seam', () => {
  it('adopts only a repeat of the same seed, case and shape', async () => {
    const seed = await seedFixture();

    const first = await seed({ caseId: FIRST_CASE, seed: 'seed-one', shape: 'both_complete' });
    const repeat = await seed({ caseId: FIRST_CASE, seed: 'seed-one', shape: 'both_complete' });

    expect(first.ok).toBe(true);
    expect(repeat.sessionId).toBe(first.sessionId);
  });

  it('does not hand a different case back under a seed it shares', async () => {
    const seed = await seedFixture();
    expect(SECOND_CASE.length).toBeGreaterThan(0);

    const first = await seed({ caseId: FIRST_CASE, seed: 'seed-one', shape: 'both_complete' });
    const other = await seed({ caseId: SECOND_CASE, seed: 'seed-one', shape: 'both_complete' });
    const otherShape = await seed({
      caseId: FIRST_CASE,
      seed: 'seed-one',
      shape: 'partial_and_failed',
    });

    // The seed is entirely caller-controlled. A browser test asking for a
    // partial-and-failed pair used to be handed two complete plans against a
    // different traveller, told `ok`, and would go on to assert against them.
    expect(other.sessionId).not.toBe(first.sessionId);
    expect(otherShape.sessionId).not.toBe(first.sessionId);

    const { listBenchmarkSessions } = await import('./benchmark-repository');
    expect(listBenchmarkSessions()).toHaveLength(3);
  });

  it('keeps its own case, whichever seed asked for it', async () => {
    const seed = await seedFixture();
    const first = await seed({ caseId: FIRST_CASE, seed: 'seed-one', shape: 'both_complete' });
    const second = await seed({ caseId: SECOND_CASE, seed: 'seed-one', shape: 'both_complete' });

    const { getBenchmarkSession } = await import('./benchmark-repository');
    expect(getBenchmarkSession(first.sessionId ?? '')?.caseId).toBe(FIRST_CASE);
    expect(getBenchmarkSession(second.sessionId ?? '')?.caseId).toBe(SECOND_CASE);
  });
});

describe('the submission nonce', () => {
  it('separates two reviewers who start the same case in the same minute', async () => {
    const { createBenchmarkSession } = await import('./benchmark-repository');
    const { fakeRequest } = await import('@sidequest/bench/testing');
    const { stableHash } = await import('@sidequest/bench');

    const request = fakeRequest();
    const now = new Date('2026-08-06T09:00:00.000Z');
    const hash = stableHash(request);

    const one = createBenchmarkSession({
      request,
      idempotencyKey: `${hash}:nonce-one`,
      now,
    });
    const two = createBenchmarkSession({
      request,
      idempotencyKey: `${hash}:nonce-two`,
      now,
    });
    const retry = createBenchmarkSession({
      request,
      idempotencyKey: `${hash}:nonce-one`,
      now: new Date(now.getTime() + 900),
    });

    expect(one.session.id).not.toBe(two.session.id);
    // And the retry, which carries the nonce its page was rendered with, still
    // adopts rather than opening a third comparison.
    expect(retry.kind).toBe('adopted');
    expect(retry.session.id).toBe(one.session.id);
  });
});
