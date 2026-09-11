import { NextResponse } from 'next/server';
import { GENERATION_STAGES, GENERATION_STAGE_DETAIL, GENERATION_STAGE_LABELS, getGenerationProgress, milestonesFor } from '@/lib/db/generation-progress-repository';
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
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const refusal = await tripAccessRefusal(id);
  if (refusal) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const progress = getGenerationProgress(id);
  if (!progress) return NextResponse.json({ error: 'not_started' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  const startedAt = Date.parse(progress.startedAt);
  return NextResponse.json(
    {
      stage: progress.stage,
      label: GENERATION_STAGE_LABELS[progress.stage],
      detail: GENERATION_STAGE_DETAIL[progress.stage],
      reached: progress.reached,
      all: GENERATION_STAGES.map((stage) => ({ id: stage, label: GENERATION_STAGE_LABELS[stage] })),
      elapsedSeconds: Number.isNaN(startedAt) ? 0 : Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      finished: progress.finished,
      outcome: progress.outcome,
      milestones: milestonesFor(progress.counters, progress.stage),
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}
