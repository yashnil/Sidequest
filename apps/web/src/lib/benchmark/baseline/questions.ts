import 'server-only';
import {
  BENCHMARK_REQUEST_VERSION,
  operationKey,
  stableHash,
  type BenchmarkTripRequest,
} from '@sidequest/bench';
import { DEFAULT_MODEL, ResearchModel } from '../../providers/anthropic';
import type { StructuredModel } from '../../providers/interpretation-model';
import {
  deterministicFollowUps,
  needsSynthesisCall,
  synthesiseFollowUpQuestions,
  type FollowUpQuestion,
} from './followups';
import { gateSpend } from '../budget';
import { BaselineLedger } from './ledger';
import { baselineCapabilities } from './mode';
import type { ResearchPacket } from './packet-types';
import { BASELINE_PROMPT_VERSIONS } from './prompts';
import type { PreliminaryScan } from './scan';

/**
 * THE QUESTION ROUND, LIFTED OUT OF THE RUN.
 *
 * It used to happen inside `runBaseline`, immediately before the generation
 * call, which meant the questions were derived, timed, returned — and thrown
 * away. Nobody could answer them, because the same server invocation went
 * straight on to plan the trip; the prompt contract said the answers were
 * supplied and the arm supplied an empty list every time. A model call was being
 * spent, on a live run, to produce questions with no possible answer.
 *
 * So it is its own stage now, and it runs while the traveller is still there.
 * The harness calls it, persists what it returns, waits for the answers, and
 * only then plans. The one optional model call moves with it, and the calls it
 * spends are handed to `runBaseline` so the three-call ceiling still counts
 * them.
 *
 * ---
 *
 * WHY THIS DOES NOT LET THE ARM ASK FOR MORE.
 *
 * The budget is unchanged: zero-or-one synthesis, one generation with at most
 * one re-ask, zero-or-one repair, three in total. The fence here is built with
 * `maxCalls: 1` and the count it spends is passed forward, so a run whose
 * questions cost a call has two left rather than three.
 */

export const BASELINE_QUESTION_OPERATION_KIND = 'baseline-questions';

export interface QuestionRoundInput {
  sessionId: string;
  runId: string | null;
  request: BenchmarkTripRequest;
  packet: ResearchPacket;
  scan: PreliminaryScan;
  /** Injected by the offline suite so the optional call can be exercised. */
  createModel?: () => StructuredModel;
}

export interface QuestionRoundOutcome {
  questions: readonly FollowUpQuestion[];
  /** Zero or one. Counted against the run's three whether or not it worked. */
  modelCalls: number;
  /** Present when the optional call was attempted and produced nothing usable. */
  modelFailure: string | null;
}

export async function runQuestionRound(
  input: QuestionRoundInput,
): Promise<QuestionRoundOutcome> {
  const deterministic = deterministicFollowUps({
    request: input.request,
    packet: input.packet,
    scan: input.scan,
  });

  const capabilities = baselineCapabilities();
  const mayCall = (capabilities.mode === 'live' && capabilities.modelPermitted) || Boolean(input.createModel);
  if (!needsSynthesisCall(deterministic) || !mayCall) {
    return { questions: deterministic, modelCalls: 0, modelFailure: null };
  }

  /*
   * The ceiling, before the call rather than after it.
   *
   * Skipped only when the caller injected its own model, which is the offline
   * suite: there is nothing to spend and no ledger to read, and asking would make
   * every test depend on an environment variable.
   */
  if (!input.createModel) {
    const gate = gateSpend('followUpSynthesis');
    if (gate.kind === 'refused') {
      return { questions: deterministic, modelCalls: 0, modelFailure: gate.reason };
    }
  }

  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  /*
   * One call, and the fence says so rather than the caller remembering to.
   *
   * `maxCalls: 1` and `maxRetries: 0` for the same reason `createBaselineModel`
   * uses them: an SDK-level retry never reaches `usage`, so a request billed
   * twice would be recorded once and the ceiling would read low by whatever the
   * provider happened to fail.
   */
  const fence = (input.createModel ?? (() => new ResearchModel({ maxCalls: 1, maxRetries: 0 })))();
  const ledger = new BaselineLedger(
    {
      sessionId: input.sessionId,
      runId: input.runId,
      operationKey: operationKey({
        sessionId: input.sessionId,
        requestVersion: BENCHMARK_REQUEST_VERSION,
        inputHash: stableHash(input.request),
        promptVersion: BASELINE_PROMPT_VERSIONS.followUpQuestions,
        schemaVersion: 1,
        model,
        locale: 'en',
        operation: BASELINE_QUESTION_OPERATION_KIND,
      }),
      model,
      provider: 'anthropic',
    },
    fence,
  );

  const synthesised = await ledger.around(
    {
      operation: 'follow-up-questions',
      promptVersion: BASELINE_PROMPT_VERSIONS.followUpQuestions,
      attempt: 1,
    },
    () =>
      synthesiseFollowUpQuestions({
        request: input.request,
        packet: input.packet,
        model: fence,
        deterministic,
      }),
    (result) => result.modelFailure,
  );

  return {
    questions: synthesised.questions,
    // Attempts, not successes: a refused or malformed answer was still billed.
    modelCalls: 1,
    modelFailure: synthesised.modelFailure,
  };
}
