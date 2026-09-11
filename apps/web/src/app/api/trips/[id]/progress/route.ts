import { NextResponse } from 'next/server';
import { GENERATION_STAGES, GENERATION_STAGE_DETAIL, GENERATION_STAGE_LABELS, buildRunStateOf, getGenerationProgress, milestonesFor, type BuildFailureKind, type BuildRunState, type GenerationStage } from '@/lib/db/generation-progress-repository';
import { hasItinerary } from '@/lib/db/repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * V7 §16 — THE GENERATION SCREEN POLLS A ROUTE, NOT A SERVER ACTION.
 *
 * The overlay used to poll `generationProgressAction` while the build ran
 * inside another server action. Next.js serialises a tab's server actions,
 * so every poll queued behind the build and the screen sat on "Reading your
 * trip" for ninety seconds, then jumped to the finished plan — the static
 * screen production showed. A GET route is not part of that queue. Same
 * owner gate, same row, same sentences.
 *
 * V8 — the same route is the build's state of record for the client: which
 * run (`buildKey`), whether it is running, finished, failed or lost, and on a
 * failure the opaque reference and what the run had reached. A client whose
 * Build request died on the wire asks here whether its press landed.
 */
export const dynamic = 'force-dynamic';

export interface GenerationProgressView {
  stage: GenerationStage;
  label: string;
  detail: string;
  reached: GenerationStage[];
  all: { id: GenerationStage; label: string }[];
  elapsedSeconds: number;
  finished: boolean;
  outcome: 'ok' | 'failed' | null;
  milestones: string[];
  /** V8 — the run's state, decided from the row and the clock. */
  state: BuildRunState;
  buildKey: string | null;
  failure: { ref: string | null; kind: BuildFailureKind; modelInvoked: boolean; draftSaved: boolean } | null;
  hasItinerary: boolean;
  /** V8 §14 — places the build has put on the map so far, in the order they were placed. Real lookups only. */
  placed: { name: string; lat: number; lng: number }[];
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const refusal = await tripAccessRefusal(id);
  if (refusal) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const progress = getGenerationProgress(id);
  if (!progress) return NextResponse.json({ error: 'not_started' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  const now = new Date();
  const startedAt = Date.parse(progress.startedAt);
  const state = buildRunStateOf(progress, now);
  const view: GenerationProgressView = {
    stage: progress.stage,
    label: GENERATION_STAGE_LABELS[progress.stage],
    detail: GENERATION_STAGE_DETAIL[progress.stage],
    reached: progress.reached,
    all: GENERATION_STAGES.map((stage) => ({ id: stage, label: GENERATION_STAGE_LABELS[stage] })),
    elapsedSeconds: Number.isNaN(startedAt) ? 0 : Math.max(0, Math.round((now.getTime() - startedAt) / 1000)),
    finished: progress.finished,
    outcome: progress.outcome,
    milestones: milestonesFor(progress.counters, progress.stage),
    state,
    buildKey: progress.buildKey,
    failure:
      state === 'failed'
        ? { ref: progress.failure?.ref ?? null, kind: progress.failure?.kind ?? 'before_model', modelInvoked: progress.modelInvoked, draftSaved: progress.draftSaved }
        : state === 'lost'
          ? { ref: null, kind: 'lost', modelInvoked: progress.modelInvoked, draftSaved: progress.draftSaved }
          : null,
    hasItinerary: hasItinerary(id),
    placed: progress.placed,
  };
  return NextResponse.json(view, { headers: { 'cache-control': 'no-store' } });
}
