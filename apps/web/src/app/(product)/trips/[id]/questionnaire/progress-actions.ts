'use server';

import { GENERATION_STAGES, GENERATION_STAGE_DETAIL, GENERATION_STAGE_LABELS, getGenerationProgress, milestonesFor, type GenerationStage } from '@/lib/db/generation-progress-repository';
import { tripAccessRefusal } from '@/lib/net/trip-access';

/**
 * WHAT THE BUILD HAS ACTUALLY FINISHED, FOR THE SCREEN THAT IS WAITING.
 *
 * MVP V3, Stage 24. A read, owner-gated like every other trip door, of a row the
 * build writes as it crosses each real boundary. There is no percentage here and
 * there never will be: a percentage would be a claim about how long a model is
 * going to take, which nobody can make.
 */

export interface GenerationProgressView {
  stage: GenerationStage;
  label: string;
  detail: string;
  /** Stages the build has finished, in order. */
  reached: GenerationStage[];
  /** Every stage, so the screen can draw the ones still to come without knowing the list. */
  all: { id: GenerationStage; label: string }[];
  elapsedSeconds: number;
  finished: boolean;
  outcome: 'ok' | 'failed' | null;
  /** V7 §16 — what has actually been counted, as sentences a traveller can read. */
  milestones: string[];
}

export async function generationProgressAction(tripId: string): Promise<GenerationProgressView | null> {
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return null;
  const progress = getGenerationProgress(tripId);
  if (!progress) return null;
  const startedAt = Date.parse(progress.startedAt);
  return {
    stage: progress.stage,
    label: GENERATION_STAGE_LABELS[progress.stage],
    detail: GENERATION_STAGE_DETAIL[progress.stage],
    reached: progress.reached,
    all: GENERATION_STAGES.map((id) => ({ id, label: GENERATION_STAGE_LABELS[id] })),
    elapsedSeconds: Number.isNaN(startedAt) ? 0 : Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
    finished: progress.finished,
    outcome: progress.outcome,
    milestones: milestonesFor(progress.counters, progress.stage),
  };
}
