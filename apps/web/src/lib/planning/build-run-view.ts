import 'server-only';
import { buildRunStateOf, getGenerationProgress, type BuildFailureKind, type BuildRunState, type GenerationProgress } from '../db/generation-progress-repository';
import { hasItinerary } from '../db/repository';

/**
 * V8 — THE RUN AS A PAGE READS IT.
 *
 * Split from `build-runs.ts` so that a *render* can read a run's state without
 * pulling the generation pipeline — and therefore every provider — into the
 * page's import closure (`render-purity.architecture.test.ts`). Nothing here
 * can call a model or a provider; it is two table reads and the clock.
 */
export type BuildRunView =
  | { state: 'none' }
  | {
      state: BuildRunState;
      buildKey: string | null;
      startedAt: string;
      updatedAt: string;
      /** Present on `failed` and `lost`; what a retry would cost is a function of `kind`. */
      failure: { ref: string | null; kind: BuildFailureKind; modelInvoked: boolean; draftSaved: boolean } | null;
      /** A plan exists on this trip (this run's, or an earlier one's), so "your earlier plan is still there" is true. */
      hasItinerary: boolean;
    };

export function buildRunView(tripId: string, now: Date = new Date()): BuildRunView {
  const progress = getGenerationProgress(tripId);
  if (!progress) return { state: 'none' };
  return viewOf(progress, now);
}

export function viewOf(progress: GenerationProgress, now: Date): Exclude<BuildRunView, { state: 'none' }> {
  const state = buildRunStateOf(progress, now);
  const failure =
    state === 'failed'
      ? { ref: progress.failure?.ref ?? null, kind: progress.failure?.kind ?? 'before_model', modelInvoked: progress.modelInvoked, draftSaved: progress.draftSaved }
      : state === 'lost'
        ? { ref: null, kind: 'lost' as const, modelInvoked: progress.modelInvoked, draftSaved: progress.draftSaved }
        : null;
  return {
    state,
    buildKey: progress.buildKey,
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    failure,
    hasItinerary: hasItinerary(progress.tripId),
  };
}

/** What a retry of this run would do, decided from what the failed run reached. Zero calls whenever the draft survived. */
export function retryPlanFor(view: BuildRunView): { reuseStoredDraft: boolean } {
  if (view.state !== 'failed' && view.state !== 'lost') return { reuseStoredDraft: false };
  return { reuseStoredDraft: Boolean(view.failure?.draftSaved) };
}

