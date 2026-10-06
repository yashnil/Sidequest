import 'server-only';
import { productEvent } from '../net/product-events';
import { after } from 'next/server';
import {
  BUILD_HEARTBEAT_MS,
  buildRunStateOf,
  beginGeneration,
  finishGeneration,
  getGenerationProgress,
  heartbeatGeneration,
  newFailureRef,
  noteFailureCause,
  type BuildFailureKind,
} from '../db/generation-progress-repository';
import { buildFailure, classifyModelError, encodeBuildFailure } from './build-failure';
import { failureForResult } from './build-preflight';
import { getTripDraft } from '../db/draft-repository';
import { generateSidequestPlanForTrip, type GenerationMode } from './production-plan';
import { viewOf, type BuildRunView } from './build-run-view';

export { buildRunView, retryPlanFor, type BuildRunView } from './build-run-view';

/**
 * V8 — A BUILD IS A DURABLE RUN THE TRAVELLER CAN ALWAYS FIND AGAIN.
 *
 * What this replaces (`.claude-private/V8-BUILD-FAILURE.md`): "Build my trip"
 * awaited the whole generation inside one server-action request. When the
 * browser dropped that request half a second in, the server kept composing —
 * and spent the model call — while the client threw the rejected fetch into an
 * error boundary whose "Try again" remounted the interview on stale props and
 * then overwrote the traveller's answers. Three symptoms, one design fault: a
 * build's fate was a single HTTP request.
 *
 * Now a press **records a run** under the client's idempotency key and
 * **schedules** the generation to run after the acknowledging response is
 * sent (`after()` — the sanctioned way to do work past a response in the App
 * Router). The client navigates to `/trips/[id]/build`, which renders from the
 * run row: running, succeeded, failed or lost. A second press with the same
 * key, a refresh, a back button, a retried request — all reach `beginGeneration`
 * with a key the row already holds and attach to the run. Nothing composes
 * twice. Every failure, thrown or returned, lands on the row as an opaque
 * reference tied to one structured log line, so the traveller sees a
 * reference and never a stack, a schema or a provider name.
 */

export interface StartBuildRunInput {
  tripId: string;
  /** The client's idempotency key: one per press, reused by every retry of that press. */
  buildKey: string;
  caller: string | null;
  mode?: GenerationMode;
  /** V8 — re-verify the saved draft instead of composing; chosen by `retryPlanFor`, never by a page render. */
  reuseStoredDraft?: boolean;
}

export type StartBuildRunResult = { started: boolean; view: BuildRunView };

/**
 * Begin (or attach to) the run for this key and schedule the work.
 *
 * Idempotent by construction: `beginGeneration` refuses to replace an
 * unfinished run under the same key, and a live run under *another* key is
 * also attached to rather than replaced — two presses seconds apart are one
 * build. Only a finished run (either outcome) or a lost one is replaced.
 */
export function startBuildRun(input: StartBuildRunInput, now: Date = new Date()): StartBuildRunResult {
  const existing = getGenerationProgress(input.tripId);
  if (existing) {
    const state = buildRunStateOf(existing, now);
    if (state === 'running') return { started: false, view: viewOf(existing, now) };
    if (existing.buildKey === input.buildKey && existing.finished) return { started: false, view: viewOf(existing, now) };
  }
  if (input.reuseStoredDraft && !getTripDraft(input.tripId)) {
    /* Nothing to re-verify after all: compose. Said here rather than failing the run for a choice the traveller never made. */
    input = { ...input, reuseStoredDraft: false };
  }
  beginGeneration(input.tripId, now, { buildKey: input.buildKey, caller: input.caller });
  schedule(() => runBuild(input));
  const begun = getGenerationProgress(input.tripId);
  return { started: true, view: begun ? viewOf(begun, now) : { state: 'none' } };
}

/**
 * Run the generation to completion, whatever it does, and leave the row telling
 * the truth. The heartbeat keeps a long model call from reading as a lost
 * process; the catch turns a thrown exception into a recorded failure with a
 * reference rather than an unhandled rejection nobody can find.
 */
export async function runBuild(input: StartBuildRunInput): Promise<void> {
  const heartbeat = setInterval(() => {
    try {
      heartbeatGeneration(input.tripId, new Date());
    } catch {
      /* the build is what matters */
    }
  }, BUILD_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const generated = await generateSidequestPlanForTrip(input.tripId, {
      caller: input.caller,
      mode: input.mode ?? 'full',
      buildKey: input.buildKey,
      ...(input.reuseStoredDraft ? { reuseStoredDraft: true } : {}),
    });
    if (!generated.ok) {
      const failure = failureForResult(generated, input.tripId, { caller: input.caller, ...(input.reuseStoredDraft ? { reuseStoredDraft: true } : {}) });
      recordFailure(input, { message: generated.error ?? 'the generation returned no plan', cause: encodeBuildFailure(failure) });
    } else {
      /* Private alpha — one summary line per successful build: who built it, why any fallback, and how much of the clock is measured. */
      const itinerary = generated.result?.itinerary;
      const legs = (itinerary?.days ?? []).flatMap((day) => day.items.flatMap((item) => (item.kind === 'travel' && item.travel ? [item.travel] : [])));
      const planning = itinerary?.package?.planning;
      productEvent('build_completed', input.tripId, {
        mode: planning?.mode ?? 'unknown',
        fallbackReason: planning?.fallbackReason ?? null,
        days: itinerary?.days.length ?? 0,
        legsMeasured: legs.filter((leg) => leg.provenance === 'measured').length,
        legsEstimated: legs.filter((leg) => leg.provenance === 'estimated').length,
        legsUnmeasured: legs.filter((leg) => leg.provenance === 'unmeasured').length,
        regenerate: input.reuseStoredDraft ? false : null,
      });
    }
  } catch (error) {
    recordFailure(input, { message: error instanceof Error ? error.message : 'unknown', name: error instanceof Error ? error.name : 'Error', ...(error instanceof Error && error.stack ? { where: error.stack.split('\n').slice(1, 6).map((l) => l.trim()).join(' | ') } : {}), cause: encodeBuildFailure(buildFailure(classifyModelError(error))) });
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * One structured log line per failed run, keyed by the reference the traveller
 * is shown. Named fields only — never the error object, which for a provider
 * failure carries the outbound request and its headers.
 */
function recordFailure(input: StartBuildRunInput, detail: { message: string; name?: string; cause: string; where?: string }): void {
  const now = new Date();
  let ref: string | null = null;
  let kind: BuildFailureKind | null = null;
  try {
    const row = getGenerationProgress(input.tripId);
    if (row?.finished) {
      ref = row.failure?.ref ?? null;
      kind = row.failure?.kind ?? null;
      /* The generation finished the row itself; the cause it knew is kept, and only a missing one is filled in. */
      noteFailureCause(input.tripId, detail.cause);
    } else {
      const recorded = finishGeneration(input.tripId, 'failed', now, { ref: newFailureRef(), cause: detail.cause });
      ref = recorded.ref;
      kind = recorded.kind;
    }
  } catch {
    /* the log line below still carries the failure */
  }
  productEvent('build_failed', input.tripId, { cause: detail.cause.slice(0, 40), kind: kind ?? 'unknown' });
  console.error('Build failed', {
    ref: ref ?? 'unrecorded',
    kind: kind ?? 'unknown',
    cause: detail.cause,
    tripId: input.tripId,
    buildKey: input.buildKey,
    reuseStoredDraft: Boolean(input.reuseStoredDraft),
    name: detail.name ?? null,
    message: detail.message.slice(0, 300),
    /* Server log only: the first frames, so an unexplained failure names its own location. */
    ...(detail.where ? { where: detail.where.slice(0, 600) } : {}),
  });
}

/**
 * Work that outlives the response.
 *
 * `after()` is the App Router's contract for exactly this; outside a request
 * scope (a unit test, an internal caller) it throws, and the work simply runs
 * detached on the same process.
 */
function schedule(work: () => Promise<void>): void {
  try {
    after(work);
  } catch {
    void work();
  }
}
