import 'server-only';
import {
  type BenchReport,
  type BenchmarkGroundTruth,
  type BenchmarkPlan,
  type BenchmarkQuestion,
  type Measurement,
  type MetricKey,
  type ProducingSystem,
  BENCHMARK_PLAN_VERSION,
  BENCHMARK_SESSION_VERSION,
  type RunMetrics,
  drawAssignment,
  emptyRunMetrics,
  measured,
  runNeutralValidation,
  seededEntropy,
  stableHash,
  systemEntropy,
  unavailable,
  valueOf,
} from '@sidequest/bench';
import type { CompilerProviders } from '@sidequest/compiler';
import { estimateCostMicroUsd } from '@sidequest/core';
import {
  attachTripToSession,
  advanceSessionState,
  getAssignment,
  getBenchmarkSession,
  getRunForArm,
  getSessionClock,
  getSharedWorld,
  headPlanForRun,
  insertPlan,
  listQuestions,
  markSessionPaidMode,
  openSessionClock,
  reclaimStalledSession,
  saveAssignment,
  saveNativeArtifact,
  saveQuestion,
  saveSharedWorld,
  settleRun,
  stampSessionClock,
  startRun,
} from '@/lib/db/benchmark-repository';
import {
  getValidation,
  modelCallsForSession,
  recordArmModelCall,
  saveMetric,
  saveRunMetrics,
  saveValidation,
} from '@/lib/db/benchmark-review-repository';
import { getOperationalDiagnostics } from '@/lib/db/compiler-repository';
import { DEFAULT_MODEL } from '@/lib/providers/anthropic';
import { compiledRegionFor } from '@/lib/region';
import {
  BASELINE_MAX_MODEL_CALLS,
  runBaseline,
  resolveTripDates,
  type FollowUpAnswer,
} from './baseline/orchestrate';
import type { WorldWarmth } from './baseline/orchestrate';
import { gatherPacketInputs } from './baseline/gather';
import { baselineFixtureInputs, fixtureGeneration, FIXTURE_DESTINATION } from './baseline/fixtures';
import { resolveDestinationIdentity } from './baseline/identity';
import { buildResearchPacket, type PacketInputs } from './baseline/packet';
import { readStoredWorld } from './baseline/packet-persistence';
import { runPreliminaryScan } from './baseline/scan';
import { runQuestionRound } from './baseline/questions';
import type { FollowUpQuestion } from './baseline/followups';
import { runSidequest } from './sidequest/drive';
import { toBenchmarkPlan } from './sidequest/convert';
import { composeGroundTruth, packetGroundTruth } from './ground-truth';
import { paidOperationsPermitted } from './budget';
import { conceptOf, transferAnswers, type TransferEntry } from './transfer';

/**
 * RUNNING ONE COMPARISON.
 *
 * The order of what happens here is the experiment, so it is written out rather
 * than left to whoever reads the calls.
 *
 * **The assignment is drawn once, before anything runs.** Two independent
 * coins — which system is Plan A, and which plan is shown first — stored
 * immediately. Drawing them later, or drawing them at render time, would make
 * the layout a function of when somebody looked.
 *
 * **Both arms run, whatever either one does.** A failure is a result. An arm
 * that throws is caught here and settled as `failed` with a neutral sentence,
 * because a session that lost one arm to an exception would silently become a
 * session about the other arm.
 *
 * **The instrument is assembled after both arms have gathered, and both plans
 * are scored with it.** Each arm buys its own world; the checker is told about
 * both. That is the difference between "the baseline scheduled somewhere our
 * inventory has never heard of" — an artifact — and "nobody established whether
 * this place is open" — a fact.
 *
 * **The session becomes reviewable only when both arms have stopped.** Not
 * politeness: if panels appeared as they finished, arrival order would announce
 * the faster system on every session, and no amount of neutral wording would fix
 * a tell the reviewer sees before reading a word.
 */

export interface SessionRunOptions {
  now?: Date;
  /** Seeded for the offline suite; the system source for a real session. */
  seed?: string | null;
  /** Injected by the offline harness so a session runs against fixture worlds. */
  providers?: CompilerProviders;
  /** Bounds a single arm. Reaching it settles that arm as failed, not the session. */
  armTimeoutMs?: number;
}

export interface SessionRunResult {
  sessionId: string;
  sidequest: ArmResult;
  baseline: ArmResult;
  readyForReview: boolean;
}

export interface ArmResult {
  system: ProducingSystem;
  runId: string;
  state: 'succeeded' | 'partial' | 'failed';
  planId: string | null;
  report: BenchReport | null;
  failureDetail: string | null;
}

/**
 * PHASE ONE: BUY THE WORLD, THEN ASK.
 *
 * The comparison is two server invocations with a person in between, and this is
 * the first of them. It resolves the destination, buys the places, routes, hours
 * and forecast both arms will plan against, writes them down, derives the
 * follow-up questions from the gaps that purchase actually hit, and stops.
 *
 * It exists because the previous shape had no room for an answer. The questions
 * were derived inside the run, immediately before the generation call, in the
 * same invocation — so they were produced, timed, and discarded, while the
 * prompt contract said the traveller's answers were supplied and an empty list
 * was supplied every time. On a live run that spent a model call to write
 * questions nobody could answer.
 *
 * Two properties are worth stating because they are easy to lose later:
 *
 * **The world is written once and never rewritten.** The questions the traveller
 * is answering were derived from it, so a second preparation adopts the first
 * world rather than buying another. Otherwise the plans would be built against
 * facts the questions did not come from.
 *
 * **The clock opens here, not when the first arm starts.** This is the press.
 * Everything after it — the purchase, the wait for an answer, both arms — is
 * time somebody sat through, and a session clock that started later would report
 * a shorter wait than the one that happened.
 */
export interface SessionPreparation {
  sessionId: string;
  state: 'awaiting_answers' | 'already_prepared' | 'no_session';
  questionCount: number;
}

export async function prepareBenchmarkSession(
  sessionId: string,
  options: SessionRunOptions = {},
): Promise<SessionPreparation> {
  const session = getBenchmarkSession(sessionId);
  if (!session) return { sessionId, state: 'no_session', questionCount: 0 };
  const now = options.now ?? new Date();

  ensureAssignment(sessionId, now, options.seed ?? null);
  // Recorded at the press, from the switches in force then. See `markSessionPaidMode`.
  if (paidOperationsPermitted()) markSessionPaidMode(sessionId, now);
  /*
   * THE SESSION CLOCK IS STAMPED FROM THE REAL CLOCK, NOT FROM `now`.
   *
   * `now` is a logical timestamp the caller may pin so that stored rows are
   * reproducible. These four stamps are a *measurement* of how long somebody
   * waited, and a measurement taken from a pinned clock reports zero — which
   * would make every session look instantaneous and make the human-wait figure
   * structurally incapable of being anything else.
   */
  openSessionClock(sessionId, new Date());

  /*
   * The same compare-and-set the run phase uses, for the same reason: two tabs,
   * a double-pressed button and a retried post all arrive here, and exactly one
   * of them may buy a world.
   */
  // A claim whose holder stopped breathing is returned before anybody asks for
  // it. See `reclaimStalledSession`.
  reclaimStalledSession(sessionId, new Date());

  if (!advanceSessionState({ sessionId, from: 'created', to: 'preparing', now, owner: 'prepare' })) {
    return {
      sessionId,
      state: 'already_prepared',
      questionCount: listQuestions(sessionId).length,
    };
  }

  // Both rows exist before anything else, so a reviewer refreshing mid-flight
  // sees two panels waiting rather than one panel and a gap that would say which
  // arm had got going first.
  startRun({ sessionId, arm: 'sidequest', now });
  const baselineRun = startRun({ sessionId, arm: 'baseline', now });

  const dates = resolveTripDates(session.request, now);
  // Timed, because it belongs to neither arm and used to disappear into one of
  // them. See `sharedPreparationMs`.
  const preparationStarted = performance.now();
  const gathered = await gatherWorld(sessionId, session.request, dates, now);
  const sharedPreparationMs = Math.round(performance.now() - preparationStarted);

  if (gathered) {
    saveSharedWorld({ sessionId, payload: gathered, preparationMs: sharedPreparationMs, now });
  }

  let questionCount = 0;
  if (gathered) {
    const packet = buildResearchPacket(gathered);
    const scan = runPreliminaryScan({ request: session.request, packet });
    const round = await questionRound({
      sessionId,
      runId: baselineRun.id,
      request: session.request,
      packet,
      scan,
    });
    questionCount = persistQuestions(sessionId, round.questions, now);
  }

  stampSessionClock(sessionId, 'questionsReadyAt', new Date());
  advanceSessionState({ sessionId, from: 'preparing', to: 'awaiting_answers', now });
  return { sessionId, state: 'awaiting_answers', questionCount };
}

/**
 * The question round, wrapped so a fault in it cannot cost the comparison.
 *
 * A run with no questions is a poorer comparison and is still a comparison; a
 * run that threw here would leave a session stuck in `preparing` with a world
 * already bought and paid for.
 */
async function questionRound(input: Parameters<typeof runQuestionRound>[0]): Promise<{
  questions: readonly FollowUpQuestion[];
  modelCalls: number;
}> {
  try {
    return await runQuestionRound(input);
  } catch (error) {
    console.error('The benchmark could not derive follow-up questions', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return { questions: [], modelCalls: 0 };
  }
}

/**
 * Write the questions the traveller is about to see.
 *
 * The stored id is hashed rather than composed from the arm's name, because a
 * question id is a string the asking system chose and the obvious
 * `${sessionId}:baseline:1` would put the answer to the whole experiment inside
 * an attribute on the answer form. The render side hashes again on the way out;
 * this is the belt to that pair of braces.
 *
 * The concept each question came from is written with it. Matching a concept
 * back out of the question's prose worked and was brittle in the wrong
 * direction: a rule whose wording was edited would silently stop transferring,
 * and a model-synthesised question could never match at all. Stored, it is a fact
 * about the question rather than a guess about it.
 */
function persistQuestions(
  sessionId: string,
  questions: readonly FollowUpQuestion[],
  now: Date,
): number {
  questions.forEach((question, index) => {
    saveQuestion({
      schemaVersion: BENCHMARK_SESSION_VERSION,
      sessionId,
      questionId: stableHash({ sessionId, id: question.id, sequence: index }),
      askedBy: 'baseline',
      stage: 'preliminary_scan',
      sequence: index,
      questionText: question.text.slice(0, 500),
      whyItMatters: question.whyItMatters.slice(0, 500),
      answerType: question.answerType,
      options: [...question.options],
      required: false,
      presentedAt: now.toISOString(),
      answeredAt: null,
      elapsedMs: null,
      answerValues: null,
      answeredFrom: 'unanswered',
      transferredTo: null,
    });
  });
  return questions.length;
}

/**
 * HOW MANY CALLS THE QUESTION ROUND SPENT, READ FROM THE LEDGER.
 *
 * The two phases are two server invocations with a person between them, so this
 * count has to survive a restart, a second worker and a redeployed process. It
 * was a module-level `Map`, and that is exactly none of those: a dev server
 * restarted while the traveller was answering would report zero, the run would
 * believe it had all three calls left, and a session could spend a generation, a
 * re-ask and a repair on top of a synthesis already made — four model calls for
 * one benchmark trip, against a contract that says three.
 *
 * The ledger is durable, is written by the round itself whether the call
 * succeeded or failed, and is the same table the spending ceiling reads. Counting
 * rows there means the count is a fact about what was billed rather than a fact
 * about which process is running.
 */
function callsSpentOnQuestions(sessionId: string): number {
  try {
    return questionRoundCalls(sessionId).length;
  } catch (error) {
    /*
     * A ledger nobody could read is not a licence to spend.
     *
     * Reporting the ceiling as already reached is the conservative direction: the
     * run produces no plan and says so, rather than quietly making a fourth call.
     */
    console.error('The benchmark could not read its own spend ledger', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return BASELINE_MAX_MODEL_CALLS;
  }
}

export async function runBenchmarkSession(
  sessionId: string,
  options: SessionRunOptions = {},
): Promise<SessionRunResult> {
  const session = getBenchmarkSession(sessionId);
  if (!session) throw new Error(`No benchmark session ${sessionId}.`);
  const now = options.now ?? new Date();

  ensureAssignment(sessionId, now, options.seed ?? null);
  if (paidOperationsPermitted()) markSessionPaidMode(sessionId, now);
  // The real clock; see the note in `prepareBenchmarkSession`. A no-op when the
  // question round already opened it, which is the ordinary path.
  openSessionClock(sessionId, new Date());

  /*
   * THE CLAIM, AND WHY IT IS THE FIRST THING THAT HAPPENS.
   *
   * `advanceSessionState` moves the row only from the state the caller thinks it
   * is in, so exactly one caller gets `true` and everybody else is told the work
   * is already under way. Two tabs, a double-clicked button, a retried form
   * post and a second process all arrive here.
   *
   * Losing this race used to be silent, and my own integration test caught what
   * that cost: a second call ran both arms again and inserted a *second version*
   * of each plan. The reviewer would then have rated version one and, on their
   * next refresh, been shown version two — a different trip, with no correction
   * round behind it and nothing on screen saying anything had changed.
   *
   * So a loser reports what is already there rather than doing it again.
   *
   * `created` is accepted alongside `awaiting_answers` so that a caller which
   * never ran the question round still gets a comparison — an offline
   * demonstration, or a session started before the round existed. It buys its
   * own world and plans with no answers, which is a poorer run and an honest
   * one: the questions are recorded as unanswered rather than as answered by
   * nobody.
   */
  reclaimStalledSession(sessionId, new Date());

  const claimed =
    advanceSessionState({ sessionId, from: 'awaiting_answers', to: 'running', now, owner: 'plan' }) ||
    advanceSessionState({ sessionId, from: 'created', to: 'running', now, owner: 'plan' });
  if (!claimed) {
    return existingResult(sessionId);
  }

  stampSessionClock(sessionId, 'answersClosedAt', new Date());

  const sidequestRun = startRun({ sessionId, arm: 'sidequest', now });
  const baselineRun = startRun({ sessionId, arm: 'baseline', now });

  /*
   * The world, read back from the question round or bought now.
   *
   * Gathered by the harness rather than inside an arm so that the orchestrator
   * can build a checker from it. An arm that supplied the instrument it is
   * measured with could shape the two together, and there is no way to audit
   * that afterwards. What the arm supplies is data it fetched; what is done with
   * it is not the arm's business.
   */
  const dates = resolveTripDates(session.request, now);
  const stored = getSharedWorld(sessionId);
  const reused = stored === null ? null : readStoredWorld(stored.payload);

  /*
   * A STORED WORLD THAT WILL NOT PARSE IS A DIVERGENCE, NOT A REASON TO BUY.
   *
   * `readStoredWorld` refusing a payload it cannot read is right. Falling into
   * the same branch as "there was no stored world" is not: a world *was* bought,
   * the traveller answered questions derived from it, and the run would then buy
   * a different one and plan against that — while still forwarding the old
   * round's questions as though they belonged to it. The schema's own note says
   * the point of storing the world is that the two arms are demonstrably compared
   * on the one the questions came from, and nothing anywhere would have recorded
   * that they were not.
   *
   * So the three cases are kept apart. Nothing stored: buy one, which is the
   * ordinary path for a session that skipped the round. Stored and readable:
   * reuse it. Stored and unreadable: refuse, and settle both arms as failed with
   * a stated reason, so the session is visibly excluded rather than quietly
   * different.
   */
  const worldDiverged = stored !== null && reused === null;

  let gathered: PacketInputs | null = reused;
  let sharedPreparationMs = stored?.preparationMs ?? 0;
  let worldOrigin: WorldWarmth = reused === null ? 'none' : 'reused';

  if (gathered === null && !worldDiverged) {
    const preparationStarted = performance.now();
    gathered = await gatherWorld(sessionId, session.request, dates, now);
    sharedPreparationMs = Math.round(performance.now() - preparationStarted);
    worldOrigin = gathered === null ? 'none' : paidOperationsPermitted() ? 'purchased' : 'fixture';
  } else if (gathered !== null && !paidOperationsPermitted()) {
    worldOrigin = 'fixture';
  }
  if (worldDiverged) {
    console.error('The stored benchmark world could not be read back', { sessionId });
  }

  /*
   * WHAT THE TRAVELLER ANSWERED, READ FROM THE STORE AND GIVEN TO BOTH ARMS.
   *
   * The store is where the answer was written, with a timestamp and a refusal
   * once the review locks, so reading it back is the only way to be sure the
   * thing the plan was built from is the thing the record says was asked.
   *
   * `transferAnswers` then does the half of this that fairness depends on. The
   * follow-up questions are asked by one arm and the answers are free
   * information; a comparison in which only the asking arm heard them would be
   * measuring who asked first. So the answers are folded into the shared request
   * wherever a concept exists in both systems, and every one that has nowhere to
   * land is recorded as `not_representable` rather than quietly dropped.
   */
  const answered = listQuestions(sessionId);
  const transfer = transferAnswers(session.request, answered);
  /*
   * ONLY THE ANSWERS BOTH ARMS CAN HEAR.
   *
   * Every confirmed answer used to reach the baseline's prompt verbatim,
   * including the five concepts the transfer records as having nowhere to land in
   * the other arm. So the parity artifact said "not applied" while the model was
   * reading the answer anyway, and one arm's private channel was exactly as wide
   * as the questions it chose to ask — including any the optional synthesis call
   * invented, which by construction match no transfer rule at all.
   *
   * The goal's rule is that equivalent confirmed answers go to both systems where
   * the concept is representable in both. Where it is not, the honest reading is
   * neither, not one: an answer nobody could give the other arm is exactly the
   * "silently received more traveller information" the goal forbids. It costs the
   * traveller's answer, and the transfer report records that it was given and
   * where it stopped.
   */
  const transferable = new Set(
    transfer.report.filter((entry) => entry.verdict === 'applied').map((entry) => entry.concept),
  );
  const followUpAnswers = confirmedAnswers(answered).filter((entry) =>
    transferable.has(conceptOf(entry.question) ?? ''),
  );
  /*
   * Only when the question round genuinely ran.
   *
   * Keyed on the stored world rather than on the question list being non-empty,
   * because a round that correctly found nothing worth asking also leaves an
   * empty list — and re-deriving from that would let the arm spend the optional
   * synthesis call a second time, on questions nobody will now be shown.
   * `undefined` means "derive your own", which is the path a session that
   * skipped the round takes.
   */
  const askedFollowUps =
    stored === null
      ? undefined
      : answered
          .filter((question) => question.askedBy === 'baseline')
          .map(
            (question): FollowUpQuestion => ({
              id: question.questionId,
              text: question.questionText,
              whyItMatters: question.whyItMatters,
              answerType: question.answerType,
              options: question.options,
              origin: 'deterministic',
            }),
          );

  /*
   * Both arms refuse together when the prepared world is unreadable.
   *
   * Together, because a session in which one arm planned and the other did not
   * is not a comparison — and refusing is what makes the divergence visible as a
   * failed session rather than invisible as a differently-worlded one.
   */
  const divergence = worldDiverged
    ? 'The information this comparison was prepared against could not be read back, so nothing was planned from it.'
    : null;

  const sidequest: Attempt<Awaited<ReturnType<typeof runSidequest>>> = divergence
    ? { ok: false, detail: divergence }
    : await runArm('sidequest', async () =>
    runSidequest({
      // The transferred request, not the original: this is the arm that did not
      // ask, and it plans from the same confirmed facts as the arm that did.
      request: transfer.request,
      answerOverrides: transfer.overrides,
      runId: sidequestRun.id,
      ...(options.providers ? { providers: options.providers } : {}),
      ...(options.armTimeoutMs ? { compilationTimeoutMs: options.armTimeoutMs } : {}),
    }),
  );

  if (sidequest.ok && sidequest.value.tripId) {
    attachTripToSession(sessionId, sidequest.value.tripId, now);
  }

  /*
   * THE INSTRUMENT IS BUILT FROM PROVIDER RECORDS, AND FROM NOTHING EITHER ARM
   * DERIVED.
   *
   * This used to compose two sources — the packet the orchestrator bought, and
   * the deterministic arm's own compiled region — preferring the compiled one
   * because it was richer. Three separate reviews found the same thing wrong
   * with that, and they were right.
   *
   * A compiled region is not the world. It is one competitor's *reading* of the
   * world: hours it parsed, seasons it inferred, and tags like `crowded`,
   * `expensive` and `long_hike` that its own classifier minted from its own
   * scoring inputs. Putting it first meant three things at once, each fatal on
   * its own.
   *
   * It let one arm supply the instrument it was judged by. Where its hours
   * parser was wrong, it scheduled against its own calendar and validated clean
   * by construction, while the other arm — which had seen the raw string — was
   * convicted of scheduling outside opening hours by an error in its rival's
   * pipeline.
   *
   * It judged the other arm on vocabulary it was never given. A hard avoidance
   * of "crowds" is checked against `place.tags`; the compiled region emits
   * `crowded` from a `crowdLevel` its own selector already filters on, so it
   * cannot trip the check, and the arm holding only `tourism=attraction` can.
   * The finding would have read "the fast planner violates hard constraints";
   * the true sentence is "the fast planner was judged against facts only its
   * rival received."
   *
   * And it made the instrument depend on whether one arm succeeded, so the same
   * plan scored differently in a session where the other arm happened to compile.
   *
   * So the truth is the packet, which the orchestrator bought from the open
   * providers before either arm ran, and which is therefore nobody's reading of
   * anything. The cost is real: far more checks come back `unknown`, for both
   * arms equally. That is the correct trade. An instrument that decides more
   * questions by asking one competitor for the answers decides them wrongly.
   */
  const truth = composeGroundTruth(
    [
      /*
       * The transferred request, which is the one both arms actually received.
       *
       * It was `session.request` — the version from before the traveller
       * answered anything. Harmless while the only transferred fields were ones
       * no check reads, and a trap the first time a rule touches a travel cap, a
       * hard avoidance or a must-do: the arm that honoured the traveller's answer
       * would then be convicted by an instrument that never heard it.
       */
      gathered ? packetGroundTruth({ inputs: gathered, request: transfer.request, now }) : null,
    ].filter((source): source is BenchmarkGroundTruth => source !== null),
  );

  const validate = (plan: BenchmarkPlan): BenchReport => runNeutralValidation(plan, truth);

  const baseline: Attempt<Awaited<ReturnType<typeof runBaseline>>> = divergence
    ? { ok: false, detail: divergence }
    : await runArm('baseline', async () =>
    runBaseline({
      sessionId,
      /*
       * The transferred request here too, so the two arms are given one
       * traveller rather than two.
       *
       * `followUpAnswers` still carries the raw question-and-answer pairs into
       * the prompt, because a model reads "you asked X and they said Y" better
       * than it reads a field that quietly changed underneath it — and because
       * four of the concepts have no request field at all and would otherwise
       * reach neither arm.
       */
      request: transfer.request,
      followUpAnswers,
      askedQuestions: askedFollowUps,
      modelCallsAlreadySpent: callsSpentOnQuestions(sessionId),
      worldOrigin,
      runId: baselineRun.id,
      now,
      validate,
      /*
       * In fixture mode the arm is handed a canned generation as well as a
       * canned world.
       *
       * Without it the run correctly refuses — nothing may leave the process —
       * and correctly produces a failed plan. That is the right behaviour and
       * it makes the offline session useless as a demonstration: a reviewer
       * opening it would see two empty panels and learn nothing about whether
       * the blind comparison works.
       *
       * The canned answer is a fixture, not a result. It is never used when the
       * mode is live, and no number derived from it is reported as a measurement
       * of anything.
       */
      ...(gathered
        ? {
            fixture: {
              inputs: gathered,
              ...(paidOperationsPermitted() ? {} : { generation: fixtureGeneration() }),
            },
          }
        : {}),
    }),
  );

  /* ---------------------------------------------------------------- *
   * Persist, score, settle
   * ---------------------------------------------------------------- */

  const sidequestResult = persistSidequest({
    sessionId,
    runId: sidequestRun.id,
    outcome: sidequest,
    validate,
    transfer: transfer.report,
    requestId: session.request.requestId,
    destinationName: session.request.destination.text,
    startDate: dates.startDate,
    endDate: dates.endDate,
    sharedPreparationMs,
    now,
  });

  const baselineResult = persistBaseline({
    sessionId,
    runId: baselineRun.id,
    outcome: baseline,
    validate,
    requestId: session.request.requestId,
    destinationName: session.request.destination.text,
    startDate: dates.startDate,
    endDate: dates.endDate,
    sharedPreparationMs,
    now,
  });

  /*
   * THE SESSION CLOCK, CLOSED AND WRITTEN ONTO BOTH ARMS.
   *
   * Written here rather than by either arm because neither can see it: an arm
   * knows only its own span, and the figure a person would recognise as "how
   * long this took" spans the purchase, the question round, the wait, and both
   * arms. Recorded identically on both, like the shared preparation, and
   * therefore comparable between sessions rather than between systems.
   */
  stampSessionClock(sessionId, 'finishedAt', new Date());
  const sessionClock = sessionClockMetrics(sessionId, new Date());
  for (const runId of [sidequestRun.id, baselineRun.id]) {
    saveSessionClockMetrics({ sessionId, runId, clock: sessionClock, now });
  }

  const readyForReview = advanceSessionState({
    sessionId,
    from: 'running',
    to: 'ready_for_review',
    now,
  });

  return { sessionId, sidequest: sidequestResult, baseline: baselineResult, readyForReview };
}

/**
 * The answered questions, as the pairs the generation prompt is given.
 *
 * Unanswered rows are dropped rather than sent as blanks: a prompt carrying
 * "you asked X and they said nothing" invites the model to fill it in, which is
 * the whole failure the question round exists to avoid.
 */
function confirmedAnswers(questions: readonly BenchmarkQuestion[]): FollowUpAnswer[] {
  return questions
    .filter((question) => question.answeredAt !== null && (question.answerValues ?? []).length > 0)
    .map((question) => ({
      question: question.questionText,
      answer: (question.answerValues ?? []).join('; '),
    }))
    .filter((entry) => entry.answer.trim().length > 0);
}

/* ------------------------------------------------------------------ *
 * The session clock
 * ------------------------------------------------------------------ */

interface SessionClockMetrics {
  wallMs: number | null;
  humanWaitMs: number | null;
  machineMs: number | null;
  /** From the press to the moment the questions were answerable. */
  questionsReadyMs: number | null;
}

/**
 * WHAT A PERSON WAITED, AND WHAT OF THAT THE MACHINES OWNED.
 *
 * Three figures from four stamps, and they are computed here because the
 * harness is the only layer that can see all four: an arm knows its own span and
 * nothing about the other arm or the person between them.
 *
 * The human wait is the span between the questions being ready and the traveller
 * asking for the plans. It is genuinely the only place this harness waits for
 * somebody, which is why the previous attempt to draw this distinction inside an
 * arm could never work — there was no such span in there to find, so machine time
 * and wall time were assigned the same number and the field said nothing.
 *
 * A missing stamp produces `null` rather than a substituted zero. A session that
 * never opened its clock did not take no time.
 */
function sessionClockMetrics(sessionId: string, now: Date): SessionClockMetrics {
  const clock = getSessionClock(sessionId);
  if (clock === null) {
    return { wallMs: null, humanWaitMs: null, machineMs: null, questionsReadyMs: null };
  }

  const at = (stamp: string | null): number | null => {
    if (stamp === null) return null;
    const parsed = Date.parse(stamp);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const started = at(clock.startedAt);
  const finished = at(clock.finishedAt) ?? now.getTime();
  const ready = at(clock.questionsReadyAt);
  const closed = at(clock.answersClosedAt);

  const wallMs = started === null ? null : Math.max(0, finished - started);
  const humanWaitMs = ready === null || closed === null ? null : Math.max(0, closed - ready);
  const machineMs = wallMs === null || humanWaitMs === null ? null : Math.max(0, wallMs - humanWaitMs);
  const questionsReadyMs =
    started === null || ready === null ? null : Math.max(0, ready - started);
  return { wallMs, humanWaitMs, machineMs, questionsReadyMs };
}

/**
 * Write the three session figures onto one arm's metric row.
 *
 * An upsert on top of the metrics the arm already wrote, so the arm keeps
 * ownership of its own clock and the harness owns the session's. A figure the
 * clock could not produce is written as an explicit absence with a reason rather
 * than skipped, because a missing key renders as a blank and a blank reads as a
 * zero.
 */
function saveSessionClockMetrics(input: {
  sessionId: string;
  runId: string;
  clock: SessionClockMetrics;
  now: Date;
}): void {
  const absent = (what: string) =>
    unavailable('instrument_failed', `The session clock recorded no ${what} for this comparison.`);

  const write = (key: MetricKey, measurement: ReturnType<typeof measured> | ReturnType<typeof unavailable>) =>
    saveMetric({ sessionId: input.sessionId, runId: input.runId, key, measurement, now: input.now });

  write(
    'sessionWallTimeMs',
    input.clock.wallMs === null ? absent('start or finish') : measured(input.clock.wallMs, 'ms'),
  );
  write(
    'humanAnswerWaitMs',
    input.clock.humanWaitMs === null
      ? absent('question round')
      : measured(input.clock.humanWaitMs, 'ms'),
  );
  write(
    'sessionMachineTimeMs',
    input.clock.machineMs === null ? absent('machine span') : measured(input.clock.machineMs, 'ms'),
  );
  /*
   * THE QUESTION ROUND, TIMED WHERE IT HAPPENED.
   *
   * Both arms report it and both report the same figure, because in the
   * two-phase flow the round belongs to the harness: it buys the world, derives
   * the questions and puts them on screen, all before either planner is entered.
   * The arm that used to stamp this was timing itself re-reading a list the
   * harness handed it.
   */
  write(
    'timeToFollowUpQuestionsMs',
    input.clock.questionsReadyMs === null
      ? absent('question round')
      : measured(input.clock.questionsReadyMs, 'ms'),
  );
}

function questionRoundCalls(sessionId: string) {
  return modelCallsForSession(sessionId).filter(
    (call) => call.arm === 'baseline' && call.operation === 'follow-up-questions',
  );
}

/**
 * THE QUESTION ROUND'S SPEND, FOLDED BACK INTO THE ARM THAT MADE IT.
 *
 * The arm's own ledger instance is constructed inside `runBaseline` and never
 * saw the round, which happened in the earlier invocation with a ledger of its
 * own. So `modelCalls` was right — it is seeded from the count — and the tokens
 * and the cost beside it covered only the generation. One row reporting two
 * calls and one call's worth of tokens, on the arm whose cost is being compared,
 * and the session total on the same page disagreed with it.
 *
 * Read from the durable ledger rather than threaded through the pause, for the
 * reason the call count is: the two phases are two invocations with a person
 * between them, and anything that has to survive that cannot live in memory.
 */
function foldInQuestionRoundSpend(sessionId: string, metrics: RunMetrics): RunMetrics {
  let calls: ReturnType<typeof questionRoundCalls>;
  try {
    calls = questionRoundCalls(sessionId);
  } catch {
    return metrics;
  }
  if (calls.length === 0) return metrics;

  const add = (
    key: 'inputTokens' | 'outputTokens' | 'estimatedCostMicroUsd',
    extra: number | null,
  ): Measurement => {
    const current = metrics[key];
    // An absence stays an absence. Adding a known number to an unknown one
    // produces a number that looks measured and is not.
    if (extra === null) {
      return unavailable(
        'instrument_failed',
        'Part of this run\'s spend was recorded without a usable figure, so no total can be stated.',
      );
    }
    if (current.state !== 'measured') return current;
    return measured(current.value + extra, current.unit);
  };

  const sum = (pick: (call: (typeof calls)[number]) => number | null): number | null => {
    let total = 0;
    for (const call of calls) {
      const value = pick(call);
      if (value === null) return null;
      total += value;
    }
    return total;
  };

  return {
    ...metrics,
    inputTokens: add('inputTokens', sum((call) => call.inputTokens)),
    outputTokens: add('outputTokens', sum((call) => call.outputTokens)),
    estimatedCostMicroUsd: add('estimatedCostMicroUsd', sum((call) => call.costMicroUsd)),
  };
}

/**
 * What a session already holds, for a caller that lost the start race.
 *
 * Reads rather than runs. Everything it reports came from the call that won,
 * which is the point: two callers must agree about what this session contains,
 * and the only way to guarantee that is for one of them not to produce
 * anything.
 */
function existingResult(sessionId: string): SessionRunResult {
  const armOf = (system: ProducingSystem): ArmResult => {
    const run = getRunForArm(sessionId, system);
    if (!run) {
      return {
        system,
        runId: '',
        state: 'failed',
        planId: null,
        report: null,
        failureDetail: 'This plan stopped before it was complete.',
      };
    }
    const head = headPlanForRun(run.id);
    return {
      system,
      runId: run.id,
      state: run.state === 'pending' || run.state === 'running' ? 'failed' : run.state,
      planId: head?.id ?? null,
      report: head ? getValidation(head.id) : null,
      failureDetail: run.failureDetail,
    };
  };

  return {
    sessionId,
    sidequest: armOf('sidequest'),
    baseline: armOf('baseline'),
    readyForReview: bothArmsTerminal(sessionId),
  };
}

/* ------------------------------------------------------------------ *
 * Assignment
 * ------------------------------------------------------------------ */

function ensureAssignment(sessionId: string, now: Date, seed: string | null): void {
  if (getAssignment(sessionId)) return;
  saveAssignment(
    sessionId,
    seed === null
      ? drawAssignment({ entropy: systemEntropy(), now, source: 'system' })
      : drawAssignment({ entropy: seededEntropy(seed), now, source: 'seeded', seed }),
  );
}

/* ------------------------------------------------------------------ *
 * Running an arm without letting it take the session with it
 * ------------------------------------------------------------------ */

type Attempt<T> = { ok: true; value: T } | { ok: false; detail: string };

/**
 * An arm that throws has failed; it has not broken the comparison.
 *
 * The message is deliberately discarded rather than surfaced. Whatever a stack
 * trace says, it says it in the vocabulary of one system, and the sentence a
 * reviewer reads beside the other plan has to be the same either way. The
 * details go to the server log, where an operator can read them and a reviewer
 * cannot.
 */
async function runArm<T>(system: ProducingSystem, run: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    // The name only. A provider SDK error routinely carries the request that
    // produced it — the outbound headers, the API key among them, and the whole
    // prompt body — and a server log is not a place any of that may end up.
    console.error('A benchmark arm stopped unexpectedly', {
      system,
      error: error instanceof Error ? error.name : 'unknown',
    });
    return { ok: false, detail: 'This plan stopped before it was complete.' };
  }
}

/* ------------------------------------------------------------------ *
 * The world
 * ------------------------------------------------------------------ */

async function gatherWorld(
  sessionId: string,
  request: Parameters<typeof runBaseline>[0]['request'],
  dates: ReturnType<typeof resolveTripDates>,
  now: Date,
): Promise<PacketInputs | null> {
  /*
   * In fixture mode nothing may leave the process, so the world is the canned
   * one. This is also the path every automated test takes, which is why the
   * fixture inputs are a first-class exported artifact rather than a mock
   * assembled inside a test file: the thing the offline suite exercises is the
   * thing a live run would exercise, minus the socket.
   */
  if (!paidOperationsPermitted()) {
    // Re-dated to the request rather than served as-is: a canned world whose
    // days sat on the fixture's own calendar would put every trip date outside
    // the world the checker knows about, and every plan would collect a date
    // finding for a reason that is about the fixture rather than about the plan.
    return baselineFixtureInputs(request, now);
  }
  try {
    const identity = await resolveDestinationIdentity({
      text: request.destination.text,
      identity: request.destination.identity,
      geocoderPermitted: true,
    });
    const gathered = await gatherPacketInputs({
      request,
      // A destination nobody could resolve is not a reason to abandon the
      // session: the arm plans from the little it has and says so. Falling back
      // to the canned identity would be worse — it would silently plan a
      // different trip — so an unresolved destination returns no world at all.
      destination: identity.ok ? identity.destination : FIXTURE_DESTINATION,
      dates: dates.all,
      now,
      sessionId,
    });
    if (!identity.ok) return null;
    return gathered.inputs;
  } catch (error) {
    // A world nobody could buy is a real outcome: the baseline plans from what
    // little it has and says so, rather than the session failing before it
    // starts. Both are recorded; only one is a comparison.
    // The name only, for the reason `runArm` gives: everything a provider error
    // carries beyond its name has been near a credential.
    console.error('The benchmark could not gather a world', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function persistSidequest(input: {
  sessionId: string;
  runId: string;
  outcome: Attempt<Awaited<ReturnType<typeof runSidequest>>>;
  validate: (plan: BenchmarkPlan) => BenchReport;
  /** What became of each answer the other arm's questions produced. */
  transfer: readonly TransferEntry[];
  requestId: string;
  destinationName: string;
  startDate: string;
  endDate: string;
  sharedPreparationMs: number;
  now: Date;
}): ArmResult {
  const { sessionId, runId, now } = input;

  if (!input.outcome.ok) {
    return recordCollapse({
      system: 'sidequest',
      sessionId,
      runId,
      requestId: input.requestId,
      destinationName: input.destinationName,
      startDate: input.startDate,
      endDate: input.endDate,
      detail: input.outcome.detail,
      validate: input.validate,
      sharedPreparationMs: input.sharedPreparationMs,
      now,
    });
  }

  const value = input.outcome.value;
  const compiled = value.tripId ? compiledRegionFor(value.tripId) : null;
  const plan = toBenchmarkPlan(value.itinerary, value.readiness, {
    planId: `sidequest:${sessionId}`,
    requestId: input.requestId,
    compiled,
    destinationName: input.destinationName,
    generationState:
      value.state === 'complete' ? 'complete' : value.state === 'partial' ? 'partial' : 'failed',
    failureKind: value.failureKind,
    failureDetail: value.failureDetail,
    startDate: input.startDate,
    endDate: input.endDate,
  });

  /*
   * THE DETERMINISTIC ARM'S SPEND, WRITTEN TO THE SAME LEDGER.
   *
   * Its compilation makes real model calls — classification, extraction,
   * reconciliation — and until this landed none of them reached
   * `benchmark_model_calls`. So the ledger the budget ceiling reads under-counted
   * total spend by an entire arm, and a comparison of cost showed one system
   * spending and the other apparently free.
   *
   * One row per run rather than one per call, because the compiler reports
   * totals rather than individual requests. That makes `calls` a lower bound and
   * the *cost* — the figure the ceiling actually needs — correct, which is the
   * right way round to be imprecise. Written from here rather than from the
   * compiler because the compiler has no idea it is in a benchmark, and it must
   * stay that way.
   */
  if (value.jobId) {
    const counters = getOperationalDiagnostics(value.jobId);
    const modelCalls = counters?.modelCalls ?? 0;
    if (counters && modelCalls > 0) {
      /*
       * BOTH ARMS PRICED FROM THE SAME TABLE, KEYED BY THE SAME MODEL.
       *
       * The compilation reports a cost of its own, and using it put the two arms
       * on two different rate tables: this one applies a hard-coded input/output
       * pair to whatever `ANTHROPIC_MODEL` names, while the other arm goes
       * through the checked-in table keyed by model id. The checked-in table's
       * own header names that hazard — a run against a cheaper model would report
       * a cost advantage nobody enjoyed — and the benchmark was then using the
       * unfit artifact for one of the two arms it compares.
       *
       * Worse, the difference ran in the direction that hides itself: a model
       * absent from the table makes this arm report a confident figure and the
       * other report an honest absence, so a reader sees one known cost and one
       * unknown and concludes the wrong one is the reliable number. And an
       * always-present figure means `unpricedCalls` never increments for this
       * arm, so the ceiling's conservative refusal could not fire.
       *
       * Recomputed here from the tokens the compilation counted. An unpriced
       * model now produces `null` on both arms, which is the same fact stated
       * the same way twice.
       */
      const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
      const inputTokens = counters.modelInputTokens;
      const outputTokens = counters.modelOutputTokens;
      const measured =
        typeof inputTokens === 'number' &&
        Number.isFinite(inputTokens) &&
        typeof outputTokens === 'number' &&
        Number.isFinite(outputTokens);
      const costMicroUsd = measured
        ? estimateCostMicroUsd(model, {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            webSearches: 0,
          })
        : null;
      recordArmModelCall({
        sessionId,
        runId,
        arm: 'sidequest',
        operation: 'compilation',
        provider: 'anthropic',
        model,
        /*
         * Never `?? 0`.
         *
         * The cost beside them was carefully guarded and these were not, so a
         * compilation whose token counters were absent stored "it used no
         * tokens" in the one table whose own header says there is deliberately no
         * such coalescence anywhere in it.
         */
        inputTokens: measured ? inputTokens : null,
        outputTokens: measured ? outputTokens : null,
        costMicroUsd,
        costUnavailableReason: measured
          ? costMicroUsd === null
            ? 'This model has no row in the checked-in rate table.'
            : null
          : 'The compilation reported no token counts, so nothing could be priced.',
        outcome: value.state === 'failed' ? 'failed' : 'succeeded',
        startedAt: now,
        finishedAt: now,
      });
    }
  }

  if (value.itinerary) {
    // The native artifact, kept because the neutral conversion is lossy by
    // design and somebody will eventually need to know whether a defect was in
    // the plan or in the conversion.
    saveNativeArtifact({ runId, planId: null, kind: 'itinerary', payload: value.itinerary, now });
  }

  /*
   * THE PARITY REPORT, WRITTEN DOWN RATHER THAN RETURNED AND DROPPED.
   *
   * `runSidequest` has always produced a field-by-field verdict on what the
   * shared request could and could not reach inside this pipeline — the single
   * most useful artifact for judging whether a result is about planning or about
   * plumbing — and nothing persisted it. It was computed on every run and thrown
   * away, so the one question a sceptical reader asks first, "did both systems
   * actually get the same trip", had no answer in the record.
   *
   * Kept as a native artifact and shown only after the reveal, because the shape
   * of the report names a system.
   */
  saveNativeArtifact({
    runId,
    planId: null,
    kind: 'parity',
    payload: { fields: value.parity, transfer: input.transfer },
    now,
  });

  return finish({
    system: 'sidequest',
    sessionId,
    runId,
    plan,
    metrics: value.metrics,
    validate: input.validate,
    state: value.state,
    failureDetail: value.failureDetail,
    failureKind: value.failureKind,
    sharedPreparationMs: input.sharedPreparationMs,
    now,
  });
}

function persistBaseline(input: {
  sessionId: string;
  runId: string;
  outcome: Attempt<Awaited<ReturnType<typeof runBaseline>>>;
  validate: (plan: BenchmarkPlan) => BenchReport;
  requestId: string;
  destinationName: string;
  startDate: string;
  endDate: string;
  sharedPreparationMs: number;
  now: Date;
}): ArmResult {
  const { sessionId, runId, now } = input;

  if (!input.outcome.ok) {
    return recordCollapse({
      system: 'baseline',
      sessionId,
      runId,
      requestId: input.requestId,
      destinationName: input.destinationName,
      startDate: input.startDate,
      endDate: input.endDate,
      detail: input.outcome.detail,
      validate: input.validate,
      sharedPreparationMs: input.sharedPreparationMs,
      now,
    });
  }

  const value = input.outcome.value;
  if (value.native) {
    saveNativeArtifact({ runId, planId: null, kind: 'generation', payload: value.native, now });
  }
  if (value.packet) {
    saveNativeArtifact({ runId, planId: null, kind: 'packet', payload: value.packet, now });
  }

  return finish({
    system: 'baseline',
    sessionId,
    runId,
    plan: value.plan,
    metrics: value.metrics,
    validate: input.validate,
    state:
      value.plan.generationState === 'complete'
        ? 'complete'
        : value.plan.generationState === 'partial'
          ? 'partial'
          : 'failed',
    failureDetail: value.plan.failureDetail,
    failureKind: value.plan.failureKind,
    sharedPreparationMs: input.sharedPreparationMs,
    now,
  });
}

/**
 * The last four things every arm does, in one place.
 *
 * Store the plan, score it with the shared instrument, store the score and the
 * metrics, settle the run. Sharing the tail is what keeps the two arms from
 * drifting into being persisted slightly differently — which would be a
 * difference in the record that looked like a difference in the plans.
 */
function finish(input: {
  system: ProducingSystem;
  sessionId: string;
  runId: string;
  plan: BenchmarkPlan;
  metrics: Parameters<typeof saveRunMetrics>[0]['metrics'];
  validate: (plan: BenchmarkPlan) => BenchReport;
  state: 'complete' | 'partial' | 'failed';
  failureDetail: string | null;
  failureKind: string | null;
  sharedPreparationMs: number;
  now: Date;
}): ArmResult {
  const { sessionId, runId, now } = input;

  const head = headPlanForRun(runId);
  const stored = insertPlan({
    sessionId,
    runId,
    plan: input.plan,
    expectedSupersedesPlanId: head?.id ?? null,
    now,
  });
  const planId = stored.kind === 'inserted' ? stored.stored.id : (head?.id ?? null);

  /*
   * VALIDATION IS TIMED HERE, FOR BOTH ARMS, BY THE SAME CLOCK.
   *
   * `timeToValidatedPlanMs` used to be stamped by whichever arm felt like it —
   * the baseline recorded one and the deterministic arm returned an unconditional
   * absence. That is worse than it sounds, because one of the pre-registered
   * decision thresholds is expressed in terms of it: a rule requiring the fast
   * planner to be five times quicker to a *validated* plan could never be
   * satisfied, while the rule favouring the other arm had no such dependency. A
   * reader applying the rules in good faith would have concluded the fast planner
   * never met its bar, when in fact nobody had measured it.
   *
   * So the orchestrator measures it, once, around the call that actually does the
   * validating — which is the only place the boundary's own wording is true of.
   */
  let report: BenchReport | null = null;
  let validationMs: number | null = null;
  if (planId) {
    const validationStarted = performance.now();
    report = input.validate(input.plan);
    validationMs = Math.round(performance.now() - validationStarted);
    saveValidation({ sessionId, planId, report, now });
  }

  const armTotal = valueOf(input.metrics.totalWallTimeMs);
  const metrics: RunMetrics = {
    ...input.metrics,
    // A property of the comparison, recorded identically on both arms. See the
    // field's own note in the metric schema for why it is not "the world both
    // arms were given".
    sharedPreparationMs: measured(input.sharedPreparationMs, 'ms'),
    /*
     * THE ARM THAT WAS HANDED A WORLD REPORTS WHAT BUYING IT COST.
     *
     * The other arm measures its own — the compilation is its equivalent
     * purchase, and it stamps the boundary itself. Filling this one here is what
     * puts the same subtraction on both sides, so `planningTimeMs` compares two
     * planners rather than one planner against a planner plus a world.
     */
    ...(input.system === 'baseline'
      ? { worldAcquisitionMs: measured(input.sharedPreparationMs, 'ms') }
      : {}),
    timeToValidatedPlanMs:
      armTotal !== null && validationMs !== null
        ? measured(armTotal + validationMs, 'ms')
        : unavailable(
            'not_reached',
            'The run did not produce a plan the shared checks could be run against.',
          ),
  };

  saveRunMetrics({
    sessionId,
    runId,
    metrics: input.system === 'baseline' ? foldInQuestionRoundSpend(sessionId, metrics) : metrics,
    now,
  });

  const runState = input.state === 'complete' ? 'succeeded' : input.state;
  settleRun({
    runId,
    state: runState,
    failureKind: input.failureKind,
    failureDetail: input.failureDetail,
    now,
  });

  return {
    system: input.system,
    runId,
    state: runState,
    planId,
    report,
    failureDetail: input.failureDetail,
  };
}

/**
 * AN ARM THAT FELL OVER IS STILL A RESULT, AND IS STILL REVIEWABLE.
 *
 * The first version of this returned early with `planId: null`, which was wrong
 * in two ways at once and my own integration test caught both.
 *
 * A run with no plan row renders as an empty panel, so the reviewer cannot rate
 * it, cannot say "cannot judge" about it, and cannot register that one system
 * produced nothing — which is the most informative thing a failure has to tell
 * them. And a run with no metrics loses its latency and its spend, so a session
 * where one arm burned two minutes and some money before collapsing would report
 * it as having cost nothing.
 *
 * So a collapse writes a plan whose `generationState` is `failed`, a full metric
 * set every one of whose entries is an explicit absence with a reason, and a
 * settled run. The sentence stored is the neutral one; whatever the exception
 * actually said stays in the server log, because the words a stack trace uses
 * would name a system.
 */
function recordCollapse(input: {
  system: ProducingSystem;
  sessionId: string;
  runId: string;
  requestId: string;
  destinationName: string;
  startDate: string;
  endDate: string;
  detail: string;
  validate: (plan: BenchmarkPlan) => BenchReport;
  sharedPreparationMs: number;
  now: Date;
}): ArmResult {
  const plan: BenchmarkPlan = {
    schemaVersion: BENCHMARK_PLAN_VERSION,
    planId: `${input.system}:${input.sessionId}`,
    requestId: input.requestId,
    producedBy: input.system,
    generationState: 'failed',
    failureKind: 'internal_error',
    failureDetail: input.detail,
    summary: '',
    destination: {
      entityId: null,
      name: input.destinationName,
      latitude: null,
      longitude: null,
    },
    scopeNote: '',
    startDate: input.startDate,
    endDate: input.endDate,
    bases: [],
    days: [],
    exclusions: [],
    unknowns: [],
    preparation: [],
    warnings: [],
    sources: [],
  };

  return finish({
    system: input.system,
    sessionId: input.sessionId,
    runId: input.runId,
    plan,
    metrics: emptyRunMetrics(input.runId, 'This plan stopped before anything could be measured.'),
    validate: input.validate,
    state: 'failed',
    failureDetail: input.detail,
    failureKind: 'internal_error',
    sharedPreparationMs: input.sharedPreparationMs,
    now: input.now,
  });
}

/** Whether both arms have stopped, which is what makes a session reviewable. */
export function bothArmsTerminal(sessionId: string): boolean {
  const terminal = new Set(['succeeded', 'partial', 'failed']);
  return (['sidequest', 'baseline'] as const).every((arm) => {
    const run = getRunForArm(sessionId, arm);
    return run !== null && terminal.has(run.state);
  });
}
