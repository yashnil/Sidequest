'use server';

import { after } from 'next/server';
import { revalidatePath } from 'next/cache';
import {
  candidateById,
  COMPILATION_ERROR_COPY,
  countNights,
  displayStages,
  isRetryable,
  isUnambiguous,
  isTerminal,
  unansweredRequired,
  type ClarificationSet,
  type CompilationState,
  type StageRecord,
} from '@sidequest/core';
import { deriveScope, rebuildClarificationSet, scopeFitsTrip } from '@sidequest/compiler';
import { compilerProviders, providerReadiness } from '@/lib/compiler/providers';
import { runCompilation, startCompilation } from '@/lib/compiler/runner';
import {
  getIntent,
  getLatestJob,
  requestCancel,
  saveClarifications,
  saveResolution,
  saveScope,
  saveSelectedCandidate,
} from '@/lib/db/compiler-repository';
import { getProfile, getTrip } from '@/lib/db/repository';

/**
 * The actions behind the open-world journey.
 *
 * Every one returns a discriminated result and never throws to the browser, and
 * every one writes before it returns — the durable artifact is the row, so a
 * closed laptop between two screens loses nothing.
 */

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/**
 * Ask the resolver what the typed string might mean.
 *
 * Run once, on a button press, and stored — the geocoder's usage policy forbids
 * autocomplete, and re-resolving on every render would be the same abuse with
 * extra steps.
 */
export async function resolveDestinationAction(tripId: string): Promise<ActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };

  const intent = getIntent(tripId);
  const query = intent?.destinationQuery?.trim();
  if (!query) return { ok: false, error: 'Tell us where you are going first.' };

  const readiness = providerReadiness();
  if (!readiness.ready) return { ok: false, error: readiness.message };

  try {
    const { providers } = compilerProviders();
    const resolution = await providers.resolver.resolve({ query, now: new Date() });
    saveResolution(tripId, resolution);

    /**
     * One confident reading needs no screen.
     *
     * A list of one is a question with no alternatives, and the codebase's rule
     * is that a section which is always present is a section nobody reads.
     * `isUnambiguous` is deliberately strict — one candidate, high confidence,
     * no recorded ambiguity — so this never quietly picks between two meanings.
     */
    if (isUnambiguous(resolution)) {
      const only = resolution.candidates[0];
      if (only) {
        saveSelectedCandidate(tripId, only.id);
        const profile = getProfile(tripId);
        saveClarifications(
          tripId,
          rebuildClarificationSet({
            resolution,
            candidate: only,
            nights: countNights(trip.basics.startDate, trip.basics.endDate),
            ...(profile ? { profile } : {}),
          }),
        );
      }
    }
  } catch (error) {
    console.error('Destination resolution failed', { tripId });
    return {
      ok: false,
      error:
        error instanceof Error && error.message.includes('slow down')
          ? 'Our map source asked us to slow down. Give it a moment and try again.'
          : 'We could not look that up just now. Nothing was lost — try again.',
    };
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * Adopt an interpretation, and derive the clarification set from it.
 *
 * Clarification is derived rather than stored-and-forgotten: the same intent and
 * interpretation always produce the same questions, and answers whose questions
 * survive a re-derivation are kept.
 */
export async function selectInterpretationAction(
  tripId: string,
  candidateId: string,
): Promise<ActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };

  const intent = getIntent(tripId);
  if (!intent?.resolution) return { ok: false, error: 'We have not read that destination yet.' };

  const candidate = candidateById(intent.resolution, candidateId);
  if (!candidate) return { ok: false, error: 'That is not one of the readings we found.' };

  saveSelectedCandidate(tripId, candidateId);

  const profile = getProfile(tripId);
  const rebuilt = rebuildClarificationSet(
    {
      resolution: intent.resolution,
      candidate,
      nights: countNights(trip.basics.startDate, trip.basics.endDate),
      ...(profile ? { profile } : {}),
    },
    intent.clarifications,
  );
  saveClarifications(tripId, rebuilt);

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

export async function saveClarificationAnswersAction(
  tripId: string,
  answers: { questionId: string; values: string[] }[],
): Promise<ActionResult> {
  const intent = getIntent(tripId);
  if (!intent) return { ok: false, error: 'We could not find that trip.' };

  const stamp = new Date().toISOString();
  const next: ClarificationSet = {
    ...intent.clarifications,
    answers: answers
      .filter((answer) => answer.values.length > 0)
      .map((answer) => ({ ...answer, answeredAt: stamp })),
  };

  try {
    saveClarifications(tripId, next);
  } catch (error) {
    console.error('Could not save clarification answers', { tripId, error });
    return { ok: false, error: 'We could not save that just then. Try again.' };
  }

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * Derive the scope from the interpretation and the answers, and store it.
 *
 * Not confirmed by this: the traveller sees it first. `saveScope` bumps the
 * revision, which travels into the fingerprint, so editing an answer and coming
 * back cannot silently adopt the artifact compiled from the previous answer.
 */
export async function proposeScopeAction(tripId: string): Promise<ActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };

  const intent = getIntent(tripId);
  if (!intent?.resolution || !intent.selectedCandidateId) {
    return { ok: false, error: 'Pick which reading you meant first.' };
  }
  const candidate = candidateById(intent.resolution, intent.selectedCandidateId);
  if (!candidate) return { ok: false, error: 'That reading is no longer available.' };

  if (unansweredRequired(intent.clarifications).length > 0) {
    return { ok: false, error: 'There are still a couple of questions to answer.' };
  }

  const profile = getProfile(tripId);
  const scope = deriveScope({
    candidate,
    clarifications: intent.clarifications,
    ...(profile ? { profile } : {}),
    nights: countNights(trip.basics.startDate, trip.basics.endDate),
    revision: intent.scopeRevision + 1,
  });

  saveScope(tripId, scope);
  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

export async function confirmScopeAction(tripId: string): Promise<ActionResult> {
  const intent = getIntent(tripId);
  if (!intent?.scope) return { ok: false, error: 'There is no region to confirm yet.' };

  const fits = scopeFitsTrip(intent.scope);
  if (!fits.fits) return { ok: false, error: fits.reason ?? 'That region does not fit this trip.' };

  saveScope(tripId, {
    ...intent.scope,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/**
 * Start the job, then do the work after the response has gone.
 *
 * `after()` is what lets the browser get an answer immediately while the
 * compilation continues — and the job row is what makes that survivable, because
 * the browser reads state from the database rather than from this promise.
 */
export async function startCompilationAction(tripId: string): Promise<ActionResult> {
  const trip = getTrip(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };

  const outcome = startCompilation(trip);
  if (outcome.kind === 'blocked') return { ok: false, error: outcome.message };

  // Already running, or already compiled: both mean "what you asked for is
  // happening or has happened", which is not an error and must not start a
  // second job.
  if (outcome.kind === 'already_running' || outcome.kind === 'already_compiled') {
    revalidatePath(`/trips/${tripId}/plan`);
    return { ok: true };
  }

  const jobId = outcome.jobId;
  after(async () => {
    try {
      await runCompilation({ trip, jobId });
    } catch (error) {
      console.error('Compilation runner failed', { tripId, jobId, error });
    }
  });

  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

/** Explicit, and only from a terminal state. A retry is never automatic. */
export async function retryCompilationAction(tripId: string): Promise<ActionResult> {
  const job = getLatestJob(tripId);
  if (job && !isTerminal(job.state)) {
    return { ok: false, error: 'That compilation is still running.' };
  }
  return startCompilationAction(tripId);
}

export async function cancelCompilationAction(tripId: string): Promise<ActionResult> {
  requestCancel(tripId);
  revalidatePath(`/trips/${tripId}/plan`);
  return { ok: true };
}

export interface CompilationSnapshot {
  state: CompilationState | 'none';
  stages: StageRecord[];
  errorMessage?: string;
  retryable: boolean;
  compiledRegionId?: string;
}

/**
 * What the progress screen polls.
 *
 * Returns what was actually stored rather than leaving the client to guess — the
 * same rule the board's auto-pick already follows, because a server revalidation
 * cannot update client state on its own.
 */
export async function compilationSnapshotAction(tripId: string): Promise<CompilationSnapshot> {
  const job = getLatestJob(tripId);
  if (!job) return { state: 'none', stages: [], retryable: false };

  return {
    state: job.state,
    stages: displayStages(job),
    ...(job.errorCode ? { errorMessage: COMPILATION_ERROR_COPY[job.errorCode] } : {}),
    retryable: job.errorCode ? isRetryable(job.errorCode) : job.state === 'failed',
    ...(job.compiledRegionId ? { compiledRegionId: job.compiledRegionId } : {}),
  };
}
