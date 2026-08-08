import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkTripRequest } from '@sidequest/bench';

/**
 * THE ONE THING A TEST HAS TO STAND IN FOR.
 *
 * The deterministic arm drives the product's own server actions — that is the
 * point of it, and the reason its benchmark result is its production result.
 * Every one of those actions ends by telling Next which route to re-render, and
 * `revalidatePath` reaches for a store that exists only while a request is being
 * served. Inside the app it works; inside vitest it throws an invariant before
 * the action can return, after its writes have already landed.
 *
 * So the cache hint is stubbed and nothing else is. The writes, the gates, the
 * ordering and the planner are all the real ones. The same stub is what
 * `interpretation-repository.test.ts` already uses to test an action's body.
 */
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

/**
 * ONE WHOLE COMPARISON, OFFLINE, END TO END.
 *
 * The integration test for the piece nobody else owns: the sequence that draws
 * the assignment, runs both arms, assembles one instrument out of both their
 * worlds, scores both plans with it, and decides when a reviewer may look.
 *
 * Everything here runs in fixture mode, so no socket opens and no credential is
 * read. That is not a limitation of the test — it is the mode the entire
 * automated suite runs in, and a session that could not complete without a
 * network would be a session the browser suite could never exercise.
 *
 * What is deliberately *not* asserted: anything about which plan is better. The
 * orchestrator's job is to produce two comparable artifacts and a blind way to
 * look at them. A test that asserted one arm scored higher would be inventing
 * the finding this whole phase exists to collect from a person.
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
  dir = mkdtempSync(join(tmpdir(), 'sidequest-orchestrate-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  // Both switches absent is the default and the point: no paid operation may
  // happen, and the session still completes rather than refusing to start.
  delete process.env.SIDEQUEST_BENCHMARK_MODE;
  delete process.env.SIDEQUEST_BENCHMARK_BUDGET_USD;
  // The deterministic worlds, and the invented five-country index the browser
  // suite already ships. Together they are what lets the whole pipeline —
  // resolution, compilation, planning — run with nothing reachable.
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_DESTINATION_INDEX_SEED = SEED_PATH;
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  delete process.env.SIDEQUEST_DESTINATION_INDEX_SEED;
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date('2026-08-06T09:00:00.000Z');

const SEED_PATH = new URL(
  '../../../../../e2e/support/destination-index.ndjson',
  import.meta.url,
).pathname;

async function runOneSession(seed = 'orchestrate-fixture') {
  const { createBenchmarkSession } = await import('@/lib/db/benchmark-repository');
  const { runBenchmarkSession } = await import('./orchestrate');

  const { demonstrationRequest, DEMONSTRATION_CASE_ID } = await import('./demonstration');

  const { session } = createBenchmarkSession({
    request: demonstrationRequest(),
    idempotencyKey: `idem-${seed}`,
    caseId: DEMONSTRATION_CASE_ID,
    now: NOW,
  });

  const result = await runBenchmarkSession(session.id, { now: NOW, seed });
  return { sessionId: session.id, result };
}

describe('a complete offline session', () => {
  it('produces a reviewable plan for both arms, whatever either one did', async () => {
    const { sessionId, result } = await runOneSession();
    const { getRuns } = await import('@/lib/db/benchmark-repository');

    const runs = getRuns(sessionId);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      // Succeeded, partial or failed — all three are results. What must not
      // happen is a run still sitting in `running` after the orchestrator has
      // returned, which is a session no reviewer can ever open.
      expect(['succeeded', 'partial', 'failed']).toContain(run.state);
    }

    for (const arm of [result.sidequest, result.baseline]) {
      expect(arm.state).not.toBe('running');
    }
  }, 120_000);

  it('gives the reviewer two plans with days in them, not two apologies', async () => {
    /*
     * THE ACCEPTANCE CRITERION, AS A TEST.
     *
     * "A reviewer can run at least one complete blind comparison locally" is
     * only satisfied if both panels have something to read. Two honest failures
     * would exercise every code path and demonstrate nothing about whether a
     * blind comparison of two *plans* works, which is the thing being built.
     *
     * This is not a claim that either plan is good. It is a claim that both
     * exist.
     */
    const { sessionId } = await runOneSession();
    const { blindPanels } = await import('./blind');

    const presentation = blindPanels(sessionId);
    expect(presentation).not.toBeNull();
    if (!presentation) return;

    for (const panel of presentation.panels) {
      expect(panel.plan, `panel ${panel.label} has no plan`).not.toBeNull();
      expect(panel.plan?.days.length, `panel ${panel.label} has no days`).toBeGreaterThan(0);
      expect(
        panel.plan?.days.some((day) => day.blocks.length > 0),
        `panel ${panel.label} has days but nothing in them`,
      ).toBe(true);
    }
  }, 120_000);

  it('draws the assignment once, before either arm runs', async () => {
    const { sessionId } = await runOneSession();
    const { getAssignment } = await import('@/lib/db/benchmark-repository');
    const { assignmentIsConsistent } = await import('@sidequest/bench');

    const assignment = getAssignment(sessionId);
    expect(assignment).not.toBeNull();
    if (!assignment) return;

    expect(assignment.labelASystem).not.toBe(assignment.labelBSystem);
    expect(assignment.source).toBe('seeded');
    // The stored mapping still agrees with the coin that supposedly produced
    // it. A row edited by anything other than the draw fails here.
    expect(assignmentIsConsistent(assignment)).toBe(true);
  }, 120_000);

  it('is reproducible from its seed, which is what makes the fixtures stable', async () => {
    const first = await runOneSession('reproducible');
    const { getAssignment } = await import('@/lib/db/benchmark-repository');
    const one = getAssignment(first.sessionId);

    releaseDatabase();
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), 'sidequest-orchestrate-'));
    process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
    vi.resetModules();

    const second = await runOneSession('reproducible');
    const { getAssignment: getAgain } = await import('@/lib/db/benchmark-repository');
    const two = getAgain(second.sessionId);

    expect(two?.labelASystem).toBe(one?.labelASystem);
    expect(two?.firstLabel).toBe(one?.firstLabel);
  }, 120_000);

  it('scores both plans with one instrument', async () => {
    const { sessionId } = await runOneSession();
    const { getRuns, headPlanForRun } = await import('@/lib/db/benchmark-repository');
    const { getValidation } = await import('@/lib/db/benchmark-review-repository');

    for (const run of getRuns(sessionId)) {
      const head = headPlanForRun(run.id);
      if (!head) continue;
      const report = getValidation(head.id);
      expect(report, `${run.arm} has a plan and no validation`).not.toBeNull();
      // Attempted is the honest denominator. A report claiming to have decided
      // more checks than it tried would mean the ledger is wrong.
      if (report) {
        expect(report.verifiability.decided).toBeLessThanOrEqual(report.verifiability.attempted);
      }
    }
  }, 120_000);

  it('records a metric for every boundary, and an absence where it could not', async () => {
    const { sessionId } = await runOneSession();
    const { getRuns } = await import('@/lib/db/benchmark-repository');
    const { readRunMetrics } = await import('@/lib/db/benchmark-review-repository');

    for (const run of getRuns(sessionId)) {
      const metrics = readRunMetrics(run.id);
      expect(Object.keys(metrics).length).toBeGreaterThan(5);
      for (const [key, measurement] of Object.entries(metrics)) {
        if (measurement.state === 'unavailable') {
          // The rule the whole metric layer exists for: an absence says why,
          // and never arrives as a zero somebody will later average.
          expect(measurement.detail.length, `${key} is unavailable for no reason`).toBeGreaterThan(0);
        } else {
          expect(Number.isFinite(measurement.value)).toBe(true);
        }
      }
    }
  }, 120_000);

  it('spends nothing, because no switch permitted it to', async () => {
    const { sessionId } = await runOneSession();
    const { sessionSpend } = await import('@/lib/db/benchmark-review-repository');
    const spend = sessionSpend(sessionId);
    expect(spend.calls).toBe(0);
    expect(spend.costMicroUsd).toBe(0);
  }, 120_000);

  it('hands the reviewer two panels and no way to tell them apart', async () => {
    const { sessionId } = await runOneSession();
    const { blindPanels } = await import('./blind');

    const presentation = blindPanels(sessionId);
    expect(presentation).not.toBeNull();
    if (!presentation) return;

    expect(presentation.panels).toHaveLength(2);
    expect(presentation.bothTerminal).toBe(true);
    for (const panel of presentation.panels) {
      // The projection's whole job. `producedBy` is absent from the type, so
      // this is belt and braces against somebody widening it later.
      expect(panel.plan === null || !('producedBy' in panel.plan)).toBe(true);
    }
    expect(new Set(presentation.panels.map((panel) => panel.label)).size).toBe(2);
  }, 120_000);

  it('keeps the identities server-side until the review is locked', async () => {
    const { sessionId } = await runOneSession();
    const { revealedMapping } = await import('./blind');
    const { identitiesAreRevealed } = await import('@/lib/db/benchmark-review-repository');

    expect(identitiesAreRevealed(sessionId)).toBe(false);
    // Not "hidden in the response" — absent. A caller that asks before the lock
    // gets nothing, whatever route it came in through.
    expect(revealedMapping(sessionId)).toBeNull();
  }, 120_000);

  it('refuses a second run of the same session rather than starting one over', async () => {
    const { sessionId } = await runOneSession();
    const { runBenchmarkSession } = await import('./orchestrate');
    const { planVersionsForRun, getRuns } = await import('@/lib/db/benchmark-repository');

    const before = getRuns(sessionId).map((run) => planVersionsForRun(run.id).length);
    await runBenchmarkSession(sessionId, { now: NOW, seed: 'orchestrate-fixture' });
    const after = getRuns(sessionId).map((run) => planVersionsForRun(run.id).length);

    // A second call must not silently mint a second version of each plan: the
    // reviewer would then be rating something the first call did not produce.
    expect(after).toEqual(before);
    expect(getRuns(sessionId)).toHaveLength(2);
  }, 120_000);
});

/* ------------------------------------------------------------------ *
 * The question round
 * ------------------------------------------------------------------ */

/**
 * THE ROUND THAT USED TO PRODUCE ANSWERS NOBODY COULD GIVE.
 *
 * The follow-up questions were derived inside the run, immediately before the
 * generation call, in the same server invocation — so they were produced, timed,
 * and thrown away, while the prompt contract stated the traveller's answers were
 * supplied and an empty list was supplied every time.
 *
 * These tests hold the fix to the three things that make it a fix rather than a
 * rearrangement: the questions are persisted and answerable; the answers reach
 * the generation input; and they change the versioned operation identity, so a
 * run made with answers can never be handed the plan of a run made without them.
 */
async function prepareOneSession(
  seed = 'question-round',
  /**
   * The traveller, with the edges left unstated by default.
   *
   * Two of the standing rules fire on an unstated arrival or departure, and they
   * are the two whose answers transfer to both systems — so a fixture that
   * happened to state both would exercise the round without ever exercising the
   * transfer, which is the half that fairness depends on.
   */
  shape: (request: BenchmarkTripRequest) => BenchmarkTripRequest = (request) => ({
    ...request,
    arrival: { ...request.arrival, precision: 'unknown' },
    departure: { ...request.departure, precision: 'unknown' },
  }),
) {
  const { createBenchmarkSession } = await import('@/lib/db/benchmark-repository');
  const { prepareBenchmarkSession } = await import('./orchestrate');
  const { demonstrationRequest, DEMONSTRATION_CASE_ID } = await import('./demonstration');

  const { session } = createBenchmarkSession({
    request: shape(demonstrationRequest()),
    idempotencyKey: `idem-${seed}`,
    caseId: DEMONSTRATION_CASE_ID,
    now: NOW,
  });
  const preparation = await prepareBenchmarkSession(session.id, { now: NOW, seed });
  return { sessionId: session.id, preparation };
}

describe('the question round', () => {
  it('stops at the traveller rather than planning straight through', async () => {
    const { sessionId, preparation } = await prepareOneSession();
    const { getBenchmarkSession } = await import('@/lib/db/benchmark-repository');

    expect(preparation.state).toBe('awaiting_answers');
    expect(getBenchmarkSession(sessionId)?.state).toBe('awaiting_answers');
  }, 120_000);

  it('persists the questions it asked, unanswered and answerable', async () => {
    const { sessionId, preparation } = await prepareOneSession('question-round-persist');
    const { listQuestions } = await import('@/lib/db/benchmark-repository');

    const questions = listQuestions(sessionId);
    expect(questions.length).toBe(preparation.questionCount);
    expect(questions.length).toBeGreaterThan(0);
    for (const question of questions) {
      expect(question.answeredAt).toBeNull();
      expect(question.answeredFrom).toBe('unanswered');
      // The id never names its author. A stored `${sessionId}:baseline:1` would
      // put the answer to the whole experiment in an attribute on the form.
      expect(question.questionId.toLowerCase()).not.toContain(question.askedBy);
    }
  }, 120_000);

  it('writes the world down once and does not buy a second one', async () => {
    const { sessionId } = await prepareOneSession('question-round-world');
    const { getSharedWorld } = await import('@/lib/db/benchmark-repository');
    const { prepareBenchmarkSession } = await import('./orchestrate');

    const first = getSharedWorld(sessionId);
    expect(first).not.toBeNull();

    const second = await prepareBenchmarkSession(sessionId, { now: NOW, seed: 'again' });
    expect(second.state).toBe('already_prepared');
    // Same content, same purchase. A world replaced between the question and the
    // answer would mean the plans were built against facts the questions did not
    // come from.
    expect(getSharedWorld(sessionId)?.contentHash).toBe(first?.contentHash);
  }, 120_000);

  it('refuses an answer once the traveller has asked for the plans', async () => {
    const { sessionId } = await prepareOneSession('question-round-closed');
    const { answerQuestion, listQuestions } = await import('@/lib/db/benchmark-repository');
    const { runBenchmarkSession } = await import('./orchestrate');

    await runBenchmarkSession(sessionId, { now: NOW, seed: 'question-round-closed' });

    const question = listQuestions(sessionId)[0];
    expect(question).toBeDefined();
    if (!question) return;

    /*
     * Refused rather than written. An answer accepted after the plans were built
     * could not reach either planner, but it would still be stored — and the
     * record would then show a question answered before a plan produced without
     * it, which is a false account of what each system was told.
     */
    const accepted = answerQuestion({
      sessionId,
      questionId: question.questionId,
      values: ['morning'],
      answeredFrom: 'traveller',
      elapsedMs: 1_000,
      now: NOW,
    });
    expect(accepted).toBe(false);
  }, 120_000);

  it('carries a confirmed answer into the plan, and into the identity that names it', async () => {
    const { sessionId } = await prepareOneSession('question-round-transfer');
    const { answerQuestion, listQuestions } = await import('@/lib/db/benchmark-repository');
    const { transferAnswers } = await import('./transfer');
    const { getBenchmarkSession } = await import('@/lib/db/benchmark-repository');

    const arrival = listQuestions(sessionId).find((question) =>
      question.questionText.toLowerCase().includes('what time do you expect to arrive'),
    );
    // The demonstration traveller states an unknown arrival, which is what makes
    // this rule fire. If that changes, this assertion is the thing that says so.
    expect(arrival, 'the arrival question was not asked').toBeDefined();
    if (!arrival) return;

    expect(
      answerQuestion({
        sessionId,
        questionId: arrival.questionId,
        values: ['evening'],
        answeredFrom: 'traveller',
        elapsedMs: 4_000,
        now: NOW,
      }),
    ).toBe(true);

    const session = getBenchmarkSession(sessionId);
    expect(session).not.toBeNull();
    if (!session) return;

    const transfer = transferAnswers(session.request, listQuestions(sessionId));
    // The arm that did *not* ask hears the answer too. That is the whole of what
    // stops this benchmark from measuring who asked first.
    expect(transfer.request.arrival.precision).toBe('evening');
    expect(
      transfer.report.some((entry) => entry.concept === 'arrival-window' && entry.verdict === 'applied'),
    ).toBe(true);
  }, 120_000);

  it('keeps the session clock apart from either arm\'s own', async () => {
    const { sessionId } = await prepareOneSession('question-round-clock');
    const { runBenchmarkSession } = await import('./orchestrate');
    const { getRuns } = await import('@/lib/db/benchmark-repository');
    const { readRunMetrics } = await import('@/lib/db/benchmark-review-repository');
    const { timingViolations, runMetricsSchema, emptyRunMetrics } = await import('@sidequest/bench');

    await runBenchmarkSession(sessionId, { now: NOW, seed: 'question-round-clock' });

    for (const run of getRuns(sessionId)) {
      const stored = readRunMetrics(run.id);
      /*
       * Every session-level figure is present on every arm, because they
       * describe the comparison rather than either planner. An arm missing one
       * would mean a reader comparing latencies had one clock for one system and
       * a different clock for the other.
       */
      for (const key of ['sessionWallTimeMs', 'humanAnswerWaitMs', 'sessionMachineTimeMs']) {
        expect(stored[key], `${run.arm} has no ${key}`).toBeDefined();
      }

      const merged = runMetricsSchema.parse({
        ...emptyRunMetrics(run.id, 'Filled from the store for this assertion.'),
        ...stored,
      });
      // The ordering check can now actually fire, which it could not while
      // machine time and wall time were the same assignment.
      expect(timingViolations(merged), `${run.arm} has an impossible clock`).toEqual([]);
    }
  }, 120_000);

  it('records warmth where it can be read back, rather than dropping it on write', async () => {
    const { sessionId } = await prepareOneSession('question-round-warmth');
    const { runBenchmarkSession } = await import('./orchestrate');
    const { getRuns } = await import('@/lib/db/benchmark-repository');

    await runBenchmarkSession(sessionId, { now: NOW, seed: 'question-round-warmth' });

    for (const run of getRuns(sessionId)) {
      // It used to be silently discarded: a plain enum in a table that stores one
      // row per measurement. The verdict may honestly be `unknown` offline; what
      // must not happen is the column coming back empty.
      expect(run.warmth, `${run.arm} recorded no warmth`).not.toBeNull();
      expect((run.warmthBasis ?? '').length, `${run.arm} gave no basis`).toBeGreaterThan(0);
    }
  }, 120_000);
});
