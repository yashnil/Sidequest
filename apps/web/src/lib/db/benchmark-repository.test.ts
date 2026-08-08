import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BenchmarkPlan,
  drawAssignment,
  measured,
  seededEntropy,
  unavailable,
} from '@sidequest/bench';
import {
  ALL_FIXTURE_PLANS,
  sampleMetrics,
  fakeRequest,
  sampleQuestion,
  sampleReview,
  validBaselineShapedPlan,
  validSidequestShapedPlan,
} from '@sidequest/bench/testing';

/**
 * THE PROMISES THE BENCHMARK STORE MAKES, EXERCISED RATHER THAN ASSERTED IN A
 * COMMENT.
 *
 * Four of them decide whether this experiment produces evidence or an anecdote,
 * and every one is enforced by SQL rather than by application code — because an
 * `if` statement and a disabled button are both walked past by a second browser
 * tab and by a direct request.
 *
 * - A review locks, and a locked review cannot be edited.
 * - A reveal happens once, only after the lock, and cannot be undone.
 * - A correction round that began against an older plan cannot land on a newer
 *   one.
 * - A metric that nobody measured is stored as an absence with a reason, and
 *   never as a zero.
 *
 * The last is the one most likely to be quietly broken by a well-meaning `?? 0`,
 * and the one whose breakage is least visible afterwards: once "we did not
 * measure this" and "this cost nothing" are the same row, no later care
 * distinguishes them.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  vi.resetModules();
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-benchmark-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-06T09:00:00.000Z');
const LATER = new Date('2026-08-06T09:30:00.000Z');

async function repositories() {
  const store = await import('./benchmark-repository');
  const review = await import('./benchmark-review-repository');
  const operations = await import('./benchmark-operations-repository');
  return { store, review, operations };
}

async function openSession(idempotencyKey = 'idem-1') {
  const { store } = await repositories();
  const start = store.createBenchmarkSession({
    request: fakeRequest(),
    idempotencyKey,
    now: NOW,
  });
  return { store, session: start.session, start };
}

describe('starting a session', () => {
  it('adopts the session a retried submit already made', async () => {
    const first = await openSession('idem-shared');
    const second = first.store.createBenchmarkSession({
      request: fakeRequest(),
      idempotencyKey: 'idem-shared',
      now: LATER,
    });

    expect(first.start.kind).toBe('created');
    expect(second.kind).toBe('adopted');
    expect(second.session.id).toBe(first.session.id);
    // The point is not that the second call succeeded — it is that it did not
    // open a second comparison against a request the reviewer made once.
    expect(first.store.listBenchmarkSessions()).toHaveLength(1);
  });

  it('refuses to advance a session from a state it is not in', async () => {
    const { store, session } = await openSession();
    expect(
      store.advanceSessionState({ sessionId: session.id, from: 'running', to: 'complete', now: NOW }),
    ).toBe(false);
    expect(
      store.advanceSessionState({ sessionId: session.id, from: 'created', to: 'running', now: NOW }),
    ).toBe(true);
  });
});

describe('the blind assignment', () => {
  it('is written once and never redrawn', async () => {
    const { store, session } = await openSession();
    const first = drawAssignment({
      entropy: seededEntropy('one'),
      now: NOW,
      source: 'seeded',
      seed: 'one',
    });
    store.saveAssignment(session.id, first);

    // A second write with a different draw must change nothing. A layout that
    // could move on a refresh would itself be a way to learn the mapping.
    const second = drawAssignment({
      entropy: seededEntropy('two'),
      now: LATER,
      source: 'seeded',
      seed: 'two',
    });
    store.saveAssignment(session.id, second);

    const stored = store.getAssignment(session.id);
    expect(stored?.seed).toBe('one');
    expect(stored?.labelASystem).toBe(first.labelASystem);
    expect(stored?.firstLabel).toBe(first.firstLabel);
  });

  it('reads back byte-identically however many times it is read', async () => {
    const { store, session } = await openSession();
    store.saveAssignment(
      session.id,
      drawAssignment({ entropy: seededEntropy('stable'), now: NOW, source: 'seeded', seed: 'stable' }),
    );
    const reads = [1, 2, 3, 4, 5].map(() => JSON.stringify(store.getAssignment(session.id)));
    expect(new Set(reads).size).toBe(1);
  });
});

describe('plans', () => {
  async function seededRun() {
    const { store, session } = await openSession();
    const run = store.startRun({ sessionId: session.id, arm: 'sidequest', now: NOW });
    return { store, session, run };
  }

  it('starts one run per arm, and a retry adopts it', async () => {
    const { store, session, run } = await seededRun();
    const again = store.startRun({ sessionId: session.id, arm: 'sidequest', now: LATER });
    expect(again.id).toBe(run.id);
    expect(store.getRuns(session.id)).toHaveLength(1);
  });

  it('versions each plan and names the one it supersedes', async () => {
    const { store, session, run } = await seededRun();

    const first = store.insertPlan({
      sessionId: session.id,
      runId: run.id,
      plan: validSidequestShapedPlan,
      expectedSupersedesPlanId: null,
      now: NOW,
    });
    expect(first.kind).toBe('inserted');

    const second = store.insertPlan({
      sessionId: session.id,
      runId: run.id,
      plan: { ...validSidequestShapedPlan, summary: 'After the first correction.' },
      expectedSupersedesPlanId: first.kind === 'inserted' ? first.stored.id : null,
      now: LATER,
    });
    expect(second.kind).toBe('inserted');
    if (second.kind !== 'inserted') return;
    expect(second.stored.planVersion).toBe(2);
    expect(second.stored.supersedesPlanId).toBe(first.kind === 'inserted' ? first.stored.id : null);

    // And the original is still there, unchanged. A correction adds a version;
    // it does not edit the thing the reviewer already rated.
    expect(store.planVersionsForRun(run.id)).toHaveLength(2);
    const original = store.planVersionsForRun(run.id)[0];
    expect(original?.plan.summary).toBe(validSidequestShapedPlan.summary);
  });

  it('refuses a write that began against a plan which is no longer the head', async () => {
    const { store, session, run } = await seededRun();
    const first = store.insertPlan({
      sessionId: session.id,
      runId: run.id,
      plan: validSidequestShapedPlan,
      expectedSupersedesPlanId: null,
      now: NOW,
    });
    if (first.kind !== 'inserted') throw new Error('setup failed');

    store.insertPlan({
      sessionId: session.id,
      runId: run.id,
      plan: { ...validSidequestShapedPlan, summary: 'Round one.' },
      expectedSupersedesPlanId: first.stored.id,
      now: LATER,
    });

    // A second writer that still thinks version 1 is current. Without the guard
    // it would land on top of round one and the reviewer would never know which
    // of their two corrections had been silently discarded.
    const stale = store.insertPlan({
      sessionId: session.id,
      runId: run.id,
      plan: { ...validSidequestShapedPlan, summary: 'A stale round one.' },
      expectedSupersedesPlanId: first.stored.id,
      now: LATER,
    });
    expect(stale.kind).toBe('stale');
    expect(store.planVersionsForRun(run.id)).toHaveLength(2);
  });

  it('round-trips every fixture plan without losing a field', async () => {
    const { store, session } = await repositories().then(async (r) => {
      const opened = await openSession();
      return { store: r.store, session: opened.session };
    });

    for (const [index, plan] of ALL_FIXTURE_PLANS.entries()) {
      const run = store.startRun({
        sessionId: session.id,
        arm: index % 2 === 0 ? 'sidequest' : 'baseline',
        now: NOW,
      });
      const head = store.headPlanForRun(run.id);
      const inserted = store.insertPlan({
        sessionId: session.id,
        runId: run.id,
        plan: plan as BenchmarkPlan,
        expectedSupersedesPlanId: head?.id ?? null,
        now: NOW,
      });
      if (inserted.kind !== 'inserted') continue;
      expect(inserted.stored.plan).toEqual(plan);
    }
  });
});

describe('the review lock', () => {
  async function readyForReview() {
    const { store, session } = await openSession();
    const { review } = await repositories();
    store.advanceSessionState({ sessionId: session.id, from: 'created', to: 'running', now: NOW });
    store.advanceSessionState({
      sessionId: session.id,
      from: 'running',
      to: 'ready_for_review',
      now: NOW,
    });
    return { store, review, session };
  }

  it('locks once, and a second submission changes nothing', async () => {
    const { review, session } = await readyForReview();
    const first = review.lockReview({
      sessionId: session.id,
      review: sampleReview({ sessionId: session.id }),
      now: NOW,
    });
    expect(first).toBe('locked');

    const second = review.lockReview({
      sessionId: session.id,
      review: sampleReview({ sessionId: session.id, explanation: 'A different answer entirely.' }),
      now: LATER,
    });
    expect(second).toBe('already_locked');
    expect(review.getReview(session.id)?.explanation).toBe(
      sampleReview({ sessionId: session.id }).explanation,
    );
  });

  it('refuses to lock a session that is not ready', async () => {
    const { session } = await openSession();
    const { review } = await repositories();
    expect(
      review.lockReview({
        sessionId: session.id,
        review: sampleReview({ sessionId: session.id }),
        now: NOW,
      }),
    ).toBe('wrong_state');
  });

  it('stops accepting drafts once the review is locked', async () => {
    const { review, session } = await readyForReview();
    expect(review.saveReviewDraft(session.id, { ratings: [] }, NOW)).toBe(true);
    review.lockReview({
      sessionId: session.id,
      review: sampleReview({ sessionId: session.id }),
      now: NOW,
    });
    expect(review.saveReviewDraft(session.id, { ratings: ['changed'] }, LATER)).toBe(false);
  });
});

describe('the reveal', () => {
  it('refuses before the lock, which is the whole ordering of the experiment', async () => {
    const { store, session } = await openSession();
    const { review } = await repositories();
    store.advanceSessionState({ sessionId: session.id, from: 'created', to: 'running', now: NOW });
    store.advanceSessionState({
      sessionId: session.id,
      from: 'running',
      to: 'ready_for_review',
      now: NOW,
    });

    expect(review.revealIdentities(session.id, NOW)).toBe('not_locked');
    expect(review.identitiesAreRevealed(session.id)).toBe(false);
  });

  it('happens once and cannot be undone', async () => {
    const { store, session } = await openSession();
    const { review } = await repositories();
    store.advanceSessionState({ sessionId: session.id, from: 'created', to: 'running', now: NOW });
    store.advanceSessionState({
      sessionId: session.id,
      from: 'running',
      to: 'ready_for_review',
      now: NOW,
    });
    review.lockReview({
      sessionId: session.id,
      review: sampleReview({ sessionId: session.id }),
      now: NOW,
    });

    expect(review.revealIdentities(session.id, NOW)).toBe('revealed');
    expect(review.revealIdentities(session.id, LATER)).toBe('already_revealed');
    expect(review.identitiesAreRevealed(session.id)).toBe(true);
  });

  it('refuses post-reveal answers before the reveal', async () => {
    const { session } = await openSession();
    const { review } = await repositories();
    expect(
      review.savePostRevealAnswers({
        schemaVersion: 1,
        sessionId: session.id,
        slowerPlanJustifiesWait: 'yes',
        wouldWaitForTheBetterPlan: null,
        wouldUseForARealTrip: null,
        wouldPayMoreFor: null,
        suspectedIdentityBecause: '',
        answeredAt: NOW.toISOString(),
      }),
    ).toBe(false);
  });
});

describe('correction rounds', () => {
  async function withHeadPlan() {
    const { store, session } = await openSession();
    const { review } = await repositories();
    const run = store.startRun({ sessionId: session.id, arm: 'baseline', now: NOW });
    const inserted = store.insertPlan({
      sessionId: session.id,
      runId: run.id,
      plan: validBaselineShapedPlan,
      expectedSupersedesPlanId: null,
      now: NOW,
    });
    if (inserted.kind !== 'inserted') throw new Error('setup failed');
    return { store, review, session, run, headPlanId: inserted.stored.id };
  }

  it('refuses a round that began against a plan which has moved on', async () => {
    const { review, session } = await withHeadPlan();
    const claim = review.claimCorrectionRound({
      sessionId: session.id,
      system: 'baseline',
      expectedHeadPlanId: 'plan-that-is-not-the-head',
      instructionText: 'Make it less rushed.',
      now: NOW,
    });
    expect(claim.kind).toBe('stale');
  });

  it('stops at three rounds, and says so rather than failing', async () => {
    const { store, review, session, run } = await withHeadPlan();

    let head = store.headPlanForRun(run.id);
    for (let round = 1; round <= 3; round += 1) {
      const claim = review.claimCorrectionRound({
        sessionId: session.id,
        system: 'baseline',
        expectedHeadPlanId: head?.id ?? '',
        instructionText: `Round ${round}.`,
        now: NOW,
      });
      expect(claim.kind).toBe('claimed');
      const next = store.insertPlan({
        sessionId: session.id,
        runId: run.id,
        plan: { ...validBaselineShapedPlan, summary: `After round ${round}.` },
        expectedSupersedesPlanId: head?.id ?? null,
        now: NOW,
      });
      if (next.kind !== 'inserted') throw new Error('setup failed');
      review.completeCorrectionRound({
        sessionId: session.id,
        system: 'baseline',
        round,
        update: { outcome: 'applied', resultPlanId: next.stored.id },
        now: NOW,
      });
      head = next.stored;
    }

    const fourth = review.claimCorrectionRound({
      sessionId: session.id,
      system: 'baseline',
      expectedHeadPlanId: head?.id ?? '',
      instructionText: 'One more.',
      now: NOW,
    });
    // A refusal, not an exception: the reviewer wanting a fourth round is
    // itself worth recording, and throwing at them would lose it.
    expect(fourth.kind).toBe('limit_reached');
    expect(review.listCorrections(session.id)).toHaveLength(3);
  });

  it('refuses a second concurrent round for the same system', async () => {
    const { review, session, headPlanId } = await withHeadPlan();
    const first = review.claimCorrectionRound({
      sessionId: session.id,
      system: 'baseline',
      expectedHeadPlanId: headPlanId,
      instructionText: 'Reduce the driving.',
      now: NOW,
    });
    expect(first.kind).toBe('claimed');

    const second = review.claimCorrectionRound({
      sessionId: session.id,
      system: 'baseline',
      expectedHeadPlanId: headPlanId,
      instructionText: 'Reduce the driving.',
      now: NOW,
    });
    expect(second.kind).toBe('already_running');
  });

  it('sends the same words to both systems, provably', async () => {
    const { store, review, session, headPlanId } = await withHeadPlan();
    const otherRun = store.startRun({ sessionId: session.id, arm: 'sidequest', now: NOW });
    const other = store.insertPlan({
      sessionId: session.id,
      runId: otherRun.id,
      plan: validSidequestShapedPlan,
      expectedSupersedesPlanId: null,
      now: NOW,
    });
    if (other.kind !== 'inserted') throw new Error('setup failed');

    const instruction = 'Add somewhere to eat near the hike.';
    review.claimCorrectionRound({
      sessionId: session.id,
      system: 'baseline',
      expectedHeadPlanId: headPlanId,
      instructionText: instruction,
      now: NOW,
    });
    review.claimCorrectionRound({
      sessionId: session.id,
      system: 'sidequest',
      expectedHeadPlanId: other.stored.id,
      instructionText: instruction,
      now: NOW,
    });

    const rounds = review.listCorrections(session.id);
    expect(rounds).toHaveLength(2);
    expect(new Set(rounds.map((round) => round.instructionHash)).size).toBe(1);
  });

  it('refuses a round once the review is locked', async () => {
    const { store, review, session, headPlanId } = await withHeadPlan();
    store.advanceSessionState({ sessionId: session.id, from: 'created', to: 'running', now: NOW });
    store.advanceSessionState({
      sessionId: session.id,
      from: 'running',
      to: 'ready_for_review',
      now: NOW,
    });
    review.lockReview({
      sessionId: session.id,
      review: sampleReview({ sessionId: session.id }),
      now: NOW,
    });

    const claim = review.claimCorrectionRound({
      sessionId: session.id,
      system: 'baseline',
      expectedHeadPlanId: headPlanId,
      instructionText: 'Actually, make it less rushed.',
      now: LATER,
    });

    // The ratings are in. A round would insert a new head plan version, and the
    // plan on screen would stop being the plan that was rated — with nothing
    // anywhere saying the two had parted company.
    expect(claim.kind).toBe('review_locked');
    expect(review.listCorrections(session.id)).toHaveLength(0);
  });

  it('claims a round for both systems or for neither', async () => {
    const { store, review, session, headPlanId } = await withHeadPlan();
    const otherRun = store.startRun({ sessionId: session.id, arm: 'sidequest', now: NOW });
    const other = store.insertPlan({
      sessionId: session.id,
      runId: otherRun.id,
      plan: validSidequestShapedPlan,
      expectedSupersedesPlanId: null,
      now: NOW,
    });
    if (other.kind !== 'inserted') throw new Error('setup failed');

    const both = review.claimCorrectionRoundForBoth({
      sessionId: session.id,
      heads: [
        { system: 'baseline', expectedHeadPlanId: headPlanId },
        { system: 'sidequest', expectedHeadPlanId: other.stored.id },
      ],
      instructionText: 'Add somewhere to eat near the hike.',
      now: NOW,
    });
    expect(both.kind).toBe('claimed');
    expect(review.listCorrections(session.id)).toHaveLength(2);
  });

  it('leaves neither system a round ahead when one of them refuses', async () => {
    const { review, session, headPlanId } = await withHeadPlan();

    const both = review.claimCorrectionRoundForBoth({
      sessionId: session.id,
      heads: [
        { system: 'baseline', expectedHeadPlanId: headPlanId },
        // The other arm produced no plan, so its round cannot be claimed.
        { system: 'sidequest', expectedHeadPlanId: 'plan-that-does-not-exist' },
      ],
      instructionText: 'Add somewhere to eat near the hike.',
      now: NOW,
    });

    expect(both.kind).toBe('refused');
    // The point of the transaction. Claimed one at a time, the first arm kept its
    // round while the reviewer was told the instruction had gone to both, and the
    // comparison afterwards was between a system that got help and one that did not.
    expect(review.listCorrections(session.id)).toHaveLength(0);
  });
});

describe('answering a question', () => {
  async function askedQuestion() {
    const { store, session } = await openSession();
    const { review } = await repositories();
    store.saveQuestion(
      sampleQuestion({
        sessionId: session.id,
        questionId: 'q-1',
        askedBy: 'baseline',
        sequence: 0,
        answeredAt: null,
        elapsedMs: null,
        answerValues: null,
        answeredFrom: 'unanswered',
      }),
    );
    return { store, review, session };
  }

  it('refuses an answer once the review is locked', async () => {
    const { store, review, session } = await askedQuestion();
    store.advanceSessionState({ sessionId: session.id, from: 'created', to: 'running', now: NOW });
    store.advanceSessionState({
      sessionId: session.id,
      from: 'running',
      to: 'ready_for_review',
      now: NOW,
    });
    review.lockReview({
      sessionId: session.id,
      review: sampleReview({ sessionId: session.id }),
      now: NOW,
    });

    const saved = store.answerQuestion({
      sessionId: session.id,
      questionId: 'q-1',
      values: ['yes'],
      answeredFrom: 'traveller',
      elapsedMs: 4_000,
      now: LATER,
    });

    // `elapsed_ms` is a reported metric. An answer accepted after the lock would
    // change a number the review has already been published against.
    expect(saved).toBe(false);
    expect(store.listQuestions(session.id)[0]?.answeredAt).toBeNull();
  });

  it('refuses an answer too large to read back, and keeps the question', async () => {
    const { store, session } = await askedQuestion();

    const oversized = store.answerQuestion({
      sessionId: session.id,
      questionId: 'q-1',
      values: ['x'.repeat(5_000)],
      answeredFrom: 'traveller',
      elapsedMs: 1_000,
      now: NOW,
    });
    expect(oversized).toBe(false);

    const tooMany = store.answerQuestion({
      sessionId: session.id,
      questionId: 'q-1',
      values: Array.from({ length: 200 }, (_, index) => `option-${index}`),
      answeredFrom: 'traveller',
      elapsedMs: 1_000,
      now: NOW,
    });
    expect(tooMany).toBe(false);

    // The refusal is the visible outcome. A written-and-unreadable row would have
    // been dropped by `listQuestions`, taking the question off the pooled list and
    // out of the counts without anybody being told.
    const questions = store.listQuestions(session.id);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.answeredAt).toBeNull();
  });

  it('accepts an ordinary answer, and only the first one', async () => {
    const { store, session } = await askedQuestion();

    expect(
      store.answerQuestion({
        sessionId: session.id,
        questionId: 'q-1',
        values: ['yes'],
        answeredFrom: 'traveller',
        elapsedMs: 12_000,
        transferredTo: 'sidequest',
        now: NOW,
      }),
    ).toBe(true);
    expect(
      store.answerQuestion({
        sessionId: session.id,
        questionId: 'q-1',
        values: ['no'],
        answeredFrom: 'traveller',
        elapsedMs: 40,
        now: LATER,
      }),
    ).toBe(false);

    const stored = store.listQuestions(session.id)[0];
    expect(stored?.answerValues).toEqual(['yes']);
    expect(stored?.elapsedMs).toBe(12_000);
    expect(stored?.transferredTo).toBe('sidequest');
  });
});

describe('metrics', () => {
  it('stores an unavailable measurement as an absence with a reason', async () => {
    const { store, session } = await openSession();
    const { review } = await repositories();
    const run = store.startRun({ sessionId: session.id, arm: 'baseline', now: NOW });

    review.saveRunMetrics({
      sessionId: session.id,
      runId: run.id,
      metrics: sampleMetrics({
        runId: run.id,
        modelCalls: measured(3, 'calls'),
        cacheHits: unavailable('not_applicable_to_system', 'This system keeps no evidence cache.'),
      }),
      now: NOW,
    });

    const read = review.readRunMetrics(run.id);
    expect(read.modelCalls).toEqual({ state: 'measured', value: 3, unit: 'calls' });
    // And emphatically not a zero. A system with no cache has no hit rate;
    // reporting 0% would read as a deficiency rather than as a difference.
    expect(read.cacheHits?.state).toBe('unavailable');
    if (read.cacheHits?.state === 'unavailable') {
      expect(read.cacheHits.reason).toBe('not_applicable_to_system');
      expect(read.cacheHits.detail.length).toBeGreaterThan(0);
    }
  });

  it('records a measurement that cannot be believed as a broken instrument', async () => {
    const { store, session } = await openSession();
    const { review } = await repositories();
    const run = store.startRun({ sessionId: session.id, arm: 'baseline', now: NOW });

    review.saveRunMetrics({
      sessionId: session.id,
      runId: run.id,
      metrics: {
        ...sampleMetrics({ runId: run.id, modelCalls: measured(3, 'calls') }),
        // The type says this is a measurement and it satisfies a check on the
        // `state` field alone. SQLite stores the NaN as NULL, the CHECK rejects
        // the row, and the exception used to take the whole metric set with it.
        totalWallTimeMs: { state: 'measured', value: Number.NaN, unit: 'ms' },
      },
      now: NOW,
    });

    const read = review.readRunMetrics(run.id);
    expect(read.totalWallTimeMs?.state).toBe('unavailable');
    if (read.totalWallTimeMs?.state === 'unavailable') {
      expect(read.totalWallTimeMs.reason).toBe('instrument_failed');
      expect(read.totalWallTimeMs.detail.length).toBeGreaterThan(0);
    }
    // And one broken instrument costs one metric, not the fourteen beside it.
    expect(read.modelCalls).toEqual({ state: 'measured', value: 3, unit: 'calls' });
  });

  it('refuses an absence that gives no reason', async () => {
    const { store, session } = await openSession();
    const { review } = await repositories();
    const run = store.startRun({ sessionId: session.id, arm: 'baseline', now: NOW });

    review.saveRunMetrics({
      sessionId: session.id,
      runId: run.id,
      metrics: {
        ...sampleMetrics({ runId: run.id }),
        // An empty detail satisfies `IS NOT NULL` and renders as a blank beside
        // the reason, which reads as an absence nobody bothered to explain.
        cacheHits: { state: 'unavailable', reason: 'not_yet_computed', detail: '' },
      },
      now: NOW,
    });

    const read = review.readRunMetrics(run.id);
    expect(read.cacheHits?.state).toBe('unavailable');
    if (read.cacheHits?.state === 'unavailable') {
      expect(read.cacheHits.reason).toBe('instrument_failed');
      expect(read.cacheHits.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('the spend ledger', () => {
  async function ledger() {
    const { store, session } = await openSession();
    const { review } = await repositories();
    const run = store.startRun({ sessionId: session.id, arm: 'baseline', now: NOW });
    return { store, review, session, run };
  }

  function call(
    review: Awaited<ReturnType<typeof repositories>>['review'],
    input: { sessionId: string; runId: string; operation: string; costMicroUsd: number | null },
  ) {
    review.recordArmModelCall({
      sessionId: input.sessionId,
      runId: input.runId,
      arm: 'baseline',
      operation: input.operation,
      provider: 'a-provider',
      model: 'a-model',
      inputTokens: 1_000,
      outputTokens: 500,
      costMicroUsd: input.costMicroUsd,
      outcome: 'succeeded',
      startedAt: NOW,
      finishedAt: LATER,
    });
  }

  it('reports nothing spent as zero, and nothing counted as unknown', async () => {
    const { review, session, run } = await ledger();

    // No calls at all: the total is genuinely zero.
    expect(review.sessionSpend(session.id).costMicroUsd).toBe(0);

    call(review, { sessionId: session.id, runId: run.id, operation: 'generate', costMicroUsd: null });

    // Calls, and not one of them priced. `COALESCE(SUM(...), 0)` reported this as
    // zero, which is the same figure a session that spent nothing reports — and
    // the number is read out on the results screen as a cost comparison.
    const spend = review.sessionSpend(session.id);
    expect(spend.costMicroUsd).toBeNull();
    expect(spend.calls).toBe(1);
    expect(spend.unpricedCalls).toBe(1);
  });

  it('keeps a partial total, and says it is a floor', async () => {
    const { review, session, run } = await ledger();
    call(review, { sessionId: session.id, runId: run.id, operation: 'generate', costMicroUsd: 4_200 });
    call(review, { sessionId: session.id, runId: run.id, operation: 'repair', costMicroUsd: null });

    const spend = review.sessionSpend(session.id);
    expect(spend.costMicroUsd).toBe(4_200);
    expect(spend.pricedMicroUsd).toBe(4_200);
    expect(spend.unpricedCalls).toBe(1);
  });

  it('takes a call from either arm, and refuses to count one twice', async () => {
    const { store, review, session, run } = await ledger();
    const otherRun = store.startRun({ sessionId: session.id, arm: 'sidequest', now: NOW });

    call(review, { sessionId: session.id, runId: run.id, operation: 'generate', costMicroUsd: 1_000 });
    review.recordArmModelCall({
      sessionId: session.id,
      runId: otherRun.id,
      // The arm that had no way to write here at all, so the ceiling was reading
      // a ledger that was short by a whole system.
      arm: 'sidequest',
      operation: 'compilation',
      provider: 'a-provider',
      model: 'a-model',
      inputTokens: 8_000,
      outputTokens: 2_000,
      costMicroUsd: 9_000,
      outcome: 'succeeded',
      startedAt: NOW,
      finishedAt: LATER,
    });
    // A retried write of the same operation, which the unique index refuses.
    call(review, { sessionId: session.id, runId: run.id, operation: 'generate', costMicroUsd: 1_000 });

    const spend = review.sessionSpend(session.id);
    expect(spend.calls).toBe(2);
    expect(spend.costMicroUsd).toBe(10_000);
    expect(new Set(review.modelCallsForSession(session.id).map((entry) => entry.arm)).size).toBe(2);
    expect(review.totalBenchmarkSpendMicroUsd().costMicroUsd).toBe(10_000);
  });
});

describe('single flight', () => {
  it('lets exactly one caller win, and tells the others what happened', async () => {
    const { session } = await openSession();
    const { operations } = await repositories();

    const claims = ['a', 'b', 'c'].map((owner) =>
      operations.claimBenchmarkOperation({
        sessionId: session.id,
        kind: 'generate',
        operationKey: 'key-1',
        owner,
        now: NOW,
      }),
    );

    expect(claims.filter((claim) => claim.kind === 'won')).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === 'lost')).toHaveLength(2);
  });

  it('reclaims a lease whose holder stopped breathing, and records the attempt', async () => {
    const { session } = await openSession();
    const { operations } = await repositories();

    const first = operations.claimBenchmarkOperation({
      sessionId: session.id,
      kind: 'generate',
      operationKey: 'key-2',
      owner: 'crashed',
      now: NOW,
    });
    expect(first.kind).toBe('won');

    const wellAfterTheLease = new Date(NOW.getTime() + 10 * 60_000);
    const second = operations.claimBenchmarkOperation({
      sessionId: session.id,
      kind: 'generate',
      operationKey: 'key-2',
      owner: 'next',
      now: wellAfterTheLease,
    });
    // A crash loop that reclaimed silently would be both invisible and
    // unbounded, so the release is recorded as an attempt that failed.
    expect(second.kind).toBe('won');
    expect(operations.latestBenchmarkOperation('key-2')?.attempt).toBe(2);
  });

  it('closes a terminally failed identity rather than retrying it', async () => {
    const { session } = await openSession();
    const { operations } = await repositories();

    const won = operations.claimBenchmarkOperation({
      sessionId: session.id,
      kind: 'generate',
      operationKey: 'key-3',
      owner: 'first',
      now: NOW,
    });
    if (won.kind !== 'won') throw new Error('setup failed');
    operations.settleBenchmarkOperation({
      id: won.operation.id,
      state: 'failed_terminal',
      failureKind: 'malformed_output',
      now: NOW,
    });

    const again = operations.claimBenchmarkOperation({
      sessionId: session.id,
      kind: 'generate',
      operationKey: 'key-3',
      owner: 'second',
      now: LATER,
    });
    // Re-asking a provider that just returned nonsense would spend money on
    // every retry, so a terminal failure closes the identity even with attempts
    // to spare.
    expect(again.kind).toBe('settled');
  });

  it('keys operations by session, so two sessions never share one', async () => {
    const one = await openSession('idem-one');
    const two = await openSession('idem-two');
    const { operations } = await repositories();

    const first = operations.claimBenchmarkOperation({
      sessionId: one.session.id,
      kind: 'generate',
      operationKey: `${one.session.id}|generate`,
      owner: 'a',
      now: NOW,
    });
    const second = operations.claimBenchmarkOperation({
      sessionId: two.session.id,
      kind: 'generate',
      operationKey: `${two.session.id}|generate`,
      owner: 'b',
      now: NOW,
    });
    expect(first.kind).toBe('won');
    expect(second.kind).toBe('won');
  });
});

describe('retention', () => {
  it('never sweeps a benchmark row away', async () => {
    const { store, session } = await openSession();
    const run = store.startRun({ sessionId: session.id, arm: 'sidequest', now: NOW });
    store.insertPlan({
      sessionId: session.id,
      runId: run.id,
      plan: validSidequestShapedPlan,
      expectedSupersedesPlanId: null,
      now: NOW,
    });

    const { runRetentionSweep } = await import('./retention');
    // A year later, with every grace period long expired.
    runRetentionSweep(new Date(NOW.getTime() + 400 * 86_400_000));

    expect(store.listBenchmarkSessions()).toHaveLength(1);
    expect(store.headPlanForRun(run.id)).not.toBeNull();
  });
});
