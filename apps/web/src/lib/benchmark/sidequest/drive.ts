import 'server-only';
import type { CompilerProviders } from '@sidequest/compiler';
import type { Itinerary, PlannerReadiness } from '@sidequest/core';
import type { RunMetrics } from '@sidequest/bench';

import { createTripFromComposer } from '../../../app/(product)/trips/new/actions';
import {
  applyStrategyAction,
  confirmScopeAction,
  ensurePreflightAction,
  proposeScopeAction,
  resolveDestinationAction,
  saveClarificationAnswersAction,
} from '../../../app/(product)/trips/[id]/plan/actions';
import {
  completeQuestionnaireAction,
  confirmInterpretationAction,
} from '../../../app/(product)/trips/[id]/questionnaire/actions';
import { autoPickAction } from '../../../app/(product)/trips/[id]/discover/actions';
import { runCompilation, startCompilation } from '../../compiler/runner';
import { getIntent, getLatestJob } from '../../db/compiler-repository';
import { getItinerary, getReadiness, getTrip } from '../../db/repository';
import { buildItinerary } from '../../planning/build';
import { DYNAMIC_REGION_ID } from '../../region';

import { gateSpend } from '../budget';
import { MilestoneRecorder, toRunMetrics, watchCompilation } from './milestones';
import {
  toClarificationAnswers,
  toComposerAnswers,
  toQuestionnaireAnswers,
  toScopeStrategyId,
  type ParityEntry,
} from './request-adapter';

import type { BenchmarkTripRequest } from '@sidequest/bench';
import type { QuestionnaireOverrides } from '../transfer';

/**
 * DRIVING THE PRODUCT, NOT A COPY OF IT.
 *
 * Every step below is the same call a browser makes. The trip is created by the
 * composer's own action, the destination goes through the resolver, the scope is
 * confirmed by the action that confirms scopes, the compilation is the runner's,
 * and the plan is built by `buildItinerary` — the single extracted planning path
 * that the server action also wraps.
 *
 * The temptation this file exists to resist is assembling the seven planning
 * calls here, where they would be easier to control. That version works, and it
 * is the version where Sidequest's benchmark result slowly stops being
 * Sidequest's production result because somebody fixed a bug in one of the two
 * copies. So: no handcrafted candidates, no direct write to a selection, a scope
 * or a readiness row, no stage observation, no repair of a plan that came back
 * wrong. If the pipeline loses, the losing is the finding.
 *
 * ## Two places where the shape of the product forces something
 *
 * **The runner is called directly rather than through `startCompilationAction`.**
 * That action schedules the work in `after()`, which exists so a browser gets its
 * response immediately and the compilation continues behind it. Outside a
 * request there is no `after()` to run in, so the adapter does what the action
 * does — `startCompilation` for the gate and the job row, then `runCompilation`
 * — and awaits it. The gate is not skipped: `startCompilation` is what checks
 * `providerReadiness()` and refuses an unconfirmed scope, and both refusals are
 * honoured here as failures rather than worked around.
 *
 * **`completeQuestionnaireAction` throws.** It ends in `redirect()`, which is
 * implemented as an exception carrying a `NEXT_REDIRECT` digest. Only that exact
 * digest is caught, and only around that one call; anything else propagates,
 * because a questionnaire that failed for a real reason must not be mistaken for
 * one that succeeded and navigated.
 */

export interface SidequestInput {
  request: BenchmarkTripRequest;
  runId: string;
  /**
   * The compiler's provider set, injected.
   *
   * Supplied by an offline harness so a benchmark session runs against the
   * deterministic worlds rather than volunteer-run services. Omitted in a live
   * run, in which case the runner resolves its own — which is also what makes
   * the operational counters available, since an injected set reports none.
   */
  providers?: CompilerProviders;
  /** How long to allow the compilation before giving up. */
  compilationTimeoutMs?: number;
  /**
   * Answers to the other arm's follow-up questions that no field of the shared
   * request can carry.
   *
   * Exactly one concept needs this today — whether the traveller will carry
   * lunch — and it is a named field rather than a general override bag, so a
   * later addition has to be argued for rather than slipped in. Everything else
   * transfers by rewriting the shared request itself, which keeps the mapping in
   * one place.
   */
  answerOverrides?: QuestionnaireOverrides;
}

export interface SidequestOutcome {
  state: 'complete' | 'partial' | 'failed';
  tripId: string | null;
  jobId: string | null;
  itinerary: Itinerary | null;
  readiness: PlannerReadiness | null;
  parity: ParityEntry[];
  metrics: RunMetrics;
  /**
   * One neutral sentence about what did not work.
   *
   * Never names a provider, a stage or a system, because it is rendered beside
   * the other arm's failure in a review that must not be able to tell them
   * apart. The step that actually stopped is `diagnosticStep`, which no
   * conversion reads.
   */
  failureDetail: string | null;
  failureKind: SidequestFailureKind | null;
  /** Operator-facing only. Never reaches a plan, a validator or a renderer. */
  diagnosticStep: string | null;
}

export type SidequestFailureKind =
  | 'provider_unavailable'
  | 'insufficient_data'
  | 'internal_error'
  | 'timeout'
  | 'budget_exhausted';

const DEFAULT_COMPILATION_TIMEOUT_MS = 15 * 60_000;

export async function runSidequest(input: SidequestInput): Promise<SidequestOutcome> {
  const recorder = new MilestoneRecorder();
  const { parity, answers } = toQuestionnaireAnswers(input.request, input.answerOverrides);

  let tripId: string | null = null;
  let jobId: string | null = null;

  const stop = (
    failure: { detail: string; kind: SidequestFailureKind; step: string },
    partial = false,
  ): SidequestOutcome => {
    recorder.mark('terminalAt');
    const state = partial ? 'partial' : 'failed';
    return {
      state,
      tripId,
      jobId,
      itinerary: tripId ? readItinerary(tripId) : null,
      readiness: tripId ? getReadiness(tripId) : null,
      parity,
      metrics: toRunMetrics({
        runId: input.runId,
        stamps: recorder.snapshot(),
        jobId,
        outcome: state,
      }),
      failureDetail: failure.detail,
      failureKind: failure.kind,
      diagnosticStep: failure.step,
    };
  };

  // --- The trip ---------------------------------------------------------
  const created = await createTripFromComposer(toComposerAnswers(input.request));
  if (!created.ok) {
    return stop({
      detail: 'The trip could not be started from what the traveller stated.',
      kind: 'internal_error',
      step: 'create_trip',
    });
  }
  tripId = tripIdFrom(created.href);
  if (!tripId) {
    return stop({
      detail: 'The trip could not be started from what the traveller stated.',
      kind: 'internal_error',
      step: 'create_trip',
    });
  }

  const trip = getTrip(tripId);
  if (!trip) {
    return stop({
      detail: 'The trip could not be started from what the traveller stated.',
      kind: 'internal_error',
      step: 'create_trip',
    });
  }

  /*
   * What the traveller wrote, accepted as read.
   *
   * The classification is deterministic and offline, and it changes nothing
   * until somebody presses the button beside it — so leaving it unconfirmed
   * would mean the stated must-dos and dislikes reached the composer and stopped
   * there. Confirming every proposed chip is what a traveller reading back their
   * own words would do; rejecting one is a judgement nobody in this run is
   * entitled to make.
   */
  const proposed = (getIntent(tripId)?.composer?.interpretation?.chips ?? [])
    .filter((chip) => chip.status === 'proposed')
    .map((chip) => chip.id);
  if (proposed.length > 0) await confirmInterpretationAction(tripId, [...proposed]);

  /*
   * An authored region needs none of the open-world flow.
   *
   * A destination the product already holds in full goes straight to the
   * questionnaire — that is a real branch of the product rather than a shortcut,
   * and forcing it through a compilation it does not need would be measuring a
   * path no traveller takes.
   */
  const needsCompilation = trip.basics.regionId === DYNAMIC_REGION_ID;

  if (needsCompilation) {
    // --- The destination ------------------------------------------------
    const resolved = await resolveDestinationAction(tripId);
    if (!resolved.ok) {
      return stop({
        detail: 'The destination could not be matched to a place on the map.',
        kind: 'provider_unavailable',
        step: 'resolve_destination',
      });
    }

    /*
     * The preflight comes before the answers, and that ordering is forced.
     *
     * It is what derives the clarification set on the path where the traveller
     * typed rather than picked, so answering first would be answering an empty
     * question set. Where the resolver already derived one, this is idempotent.
     */
    const preflight = await ensurePreflightAction(tripId);
    if (!preflight.ok) {
      return stop({
        detail: 'The region around the destination could not be read.',
        kind: 'provider_unavailable',
        step: 'preflight',
      });
    }
    recorder.mark('questionsAt');

    const answered = await saveClarificationAnswersAction(
      tripId,
      toClarificationAnswers(input.request),
    );
    if (!answered.ok) {
      return stop({
        detail: 'The follow-up answers could not be recorded.',
        kind: 'internal_error',
        step: 'clarifications',
      });
    }

    // --- The scope ------------------------------------------------------
    // May propose the scope on its own when nothing required is left, which is
    // why the propose below is conditional rather than unconditional.
    await applyStrategyAction(tripId, toScopeStrategyId(input.request));
    if (!getIntent(tripId)?.scope) {
      const proposedScope = await proposeScopeAction(tripId);
      if (!proposedScope.ok) {
        return stop({
          detail: 'The area to plan across could not be settled from what was stated.',
          kind: 'insufficient_data',
          step: 'propose_scope',
        });
      }
    }

    const confirmed = await confirmScopeAction(tripId);
    if (!confirmed.ok) {
      return stop({
        detail: 'The area to plan across could not be settled from what was stated.',
        kind: 'insufficient_data',
        step: 'confirm_scope',
      });
    }

    /*
     * THE MONEY CEILING, ASKED BEFORE THE EXPENSIVE PART.
     *
     * A compilation makes real model calls — classification, extraction,
     * reconciliation — and they reach the same ledger the pilot's ceiling is read
     * from. Nothing used to ask: `maySpend` existed and had no callers, so this
     * arm could spend past a limit the founder guide says is enforced before every
     * call. Asked here rather than inside the compiler, which has no idea it is in
     * a benchmark and must stay that way.
     *
     * Refusing is a recorded outcome rather than an exception, because running out
     * of budget is a normal end to a bounded experiment.
     */
    const gate = gateSpend('compilation');
    if (gate.kind === 'refused') {
      return stop({
        detail: 'This plan was not built, because the run had reached its spending ceiling.',
        kind: 'budget_exhausted',
        step: 'budget_gate',
      });
    }

    // --- The compilation ------------------------------------------------
    const started = startCompilation(trip);
    if (started.kind === 'blocked') {
      return stop({
        detail: 'The information needed to plan this destination could not be assembled.',
        kind: 'provider_unavailable',
        step: 'start_compilation',
      });
    }
    if (started.kind !== 'already_compiled') {
      jobId = started.jobId;
      const unwatch = watchCompilation(tripId, recorder);
      try {
        await withTimeout(
          runCompilation({
            trip,
            jobId,
            ...(input.providers ? { providers: input.providers } : {}),
          }),
          input.compilationTimeoutMs ?? DEFAULT_COMPILATION_TIMEOUT_MS,
        );
      } catch {
        return stop({
          detail: 'Assembling the information needed to plan this destination took too long.',
          kind: 'timeout',
          step: 'run_compilation',
        });
      } finally {
        unwatch();
      }
    }

    const job = getLatestJob(tripId);
    jobId = job?.id ?? jobId;
    if (job && (job.state === 'ready' || job.state === 'partial')) {
      recorder.mark('compiledRegionAt');
    } else if (!getIntent(tripId)?.selectedCompiledRegionId) {
      return stop({
        detail: 'The information needed to plan this destination could not be assembled.',
        kind: 'insufficient_data',
        step: 'compilation_outcome',
      });
    }
  }

  // --- The questionnaire, the board and the plan ------------------------
  const profiled = await completeQuestionnaire(tripId, answers);
  if (!profiled.ok) {
    return stop({
      detail: 'What the traveller asked for could not be recorded against the trip.',
      kind: 'internal_error',
      step: 'questionnaire',
    });
  }

  /*
   * Auto-pick, and nothing else. The traveller in a benchmark session states
   * their preferences once and never opens the board, so the plan is built from
   * exactly the starting set the product proposes on its own. Hand-picking here
   * would be a second, invisible round of preferences that the other arm never
   * got.
   */
  const picked = await autoPickAction(tripId);
  if (!picked.ok) {
    return stop({
      detail: 'Nothing could be shortlisted from what was found around the destination.',
      kind: 'insufficient_data',
      step: 'auto_pick',
    });
  }

  const built = await buildItinerary(tripId);
  const readiness = getReadiness(tripId);
  const itinerary = readItinerary(tripId);

  if (!built.ok || !itinerary) {
    return stop(
      {
        detail: 'No day-by-day plan could be built from what was available for these dates.',
        kind: 'insufficient_data',
        step: 'build_itinerary',
      },
      // A refusal that still produced a readiness account is a partial result
      // rather than a blank: it says what was considered and why nothing fitted,
      // which is a reviewable answer and must not be filed as a crash.
      readiness !== null,
    );
  }

  recorder.mark('itineraryAt');
  recorder.mark('terminalAt');

  /*
   * `partial` is read off the plan's own account of itself rather than guessed.
   * A plan holding four of nine chosen places is a real result and a lesser one,
   * and reporting it as complete would flatter this arm.
   */
  const state: SidequestOutcome['state'] =
    readiness === null || readiness.level === 'ready' ? 'complete' : 'partial';

  return {
    state,
    tripId,
    jobId,
    itinerary,
    readiness,
    parity,
    metrics: toRunMetrics({
      runId: input.runId,
      stamps: recorder.snapshot(),
      jobId,
      outcome: state,
    }),
    failureDetail: null,
    failureKind: null,
    diagnosticStep: null,
  };
}

/* ------------------------------------------------------------------ *
 * Boundaries
 * ------------------------------------------------------------------ */

/**
 * The one action in the flow that ends by navigating.
 *
 * `redirect()` throws, and its exception carries a `NEXT_REDIRECT` digest. That
 * digest — and only that digest — is treated as success here, because on this
 * action the redirect *is* the success path: everything before it has already
 * been written, and a return value is never produced. Any other throw is a real
 * failure and is left to the caller's error handling.
 */
async function completeQuestionnaire(
  tripId: string,
  answers: Parameters<typeof completeQuestionnaireAction>[1],
): Promise<{ ok: boolean }> {
  try {
    const result = await completeQuestionnaireAction(tripId, answers);
    return { ok: result?.ok !== false };
  } catch (error) {
    if (isRedirect(error)) return { ok: true };
    throw error;
  }
}

function isRedirect(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const digest = (error as { digest?: unknown }).digest;
  return typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT');
}

/**
 * A stored plan written by an older build throws on read rather than parsing
 * into something half-current. Treated as absent: this run produced no plan a
 * reviewer could be shown, which is the honest reading and a failure rather than
 * an exception thrown through the harness.
 */
function readItinerary(tripId: string): Itinerary | null {
  try {
    return getItinerary(tripId);
  } catch {
    return null;
  }
}

function tripIdFrom(href: string): string | null {
  return /^\/trips\/([^/]+)\//.exec(href)?.[1] ?? null;
}

/**
 * A ceiling on the compilation, and nothing more.
 *
 * The work is not cancelled — a compilation has already paid its providers by
 * the time anybody would want to stop it, and `cancelCompilationAction` exists
 * for the traveller who means it. This bounds how long the harness waits before
 * recording that the run did not finish.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
