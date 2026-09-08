import 'server-only';
import { getDb } from './client';

/**
 * WHAT A RUNNING BUILD HAS ACTUALLY FINISHED.
 *
 * MVP V3, Stage 24. The generation screen's stages advance on this, not on a
 * timer. Every write happens at a real boundary in
 * `production-plan.ts#generateSidequestPlanForTrip`, so a stage that says it is
 * done is done, and a stage that is showing is the one the server is in.
 *
 * Deliberately one row per trip and deliberately lossy: this is a *progress*
 * record, not an audit. `composition_attempts` is the audit.
 */

/** The stages a build passes through, in order. Only stages that are real work. */
export const GENERATION_STAGES = ['understanding', 'composing', 'route', 'places', 'travel', 'preparing'] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number];

export const GENERATION_STAGE_LABELS: Record<GenerationStage, string> = {
  understanding: 'Reading your trip',
  composing: 'Designing the route',
  route: 'Laying out the days',
  places: 'Checking the places',
  travel: 'Timing the travel',
  preparing: 'Preparing the trip',
};

/** One sentence a traveller can read about what is happening now. Never about providers or schemas. */
export const GENERATION_STAGE_DETAIL: Record<GenerationStage, string> = {
  understanding: 'Your answers, your dates and anything already booked.',
  composing: 'Choosing where you sleep, what each day is for, and what to leave out.',
  route: 'Turning the draft into days with room to breathe.',
  places: 'Matching each stop to a real place on the map.',
  travel: 'Timing the legs a router can reach, and being honest about the rest.',
  preparing: 'Bookings, packing, weather and a fallback for each day.',
};

export interface GenerationProgress {
  tripId: string;
  stage: GenerationStage;
  reached: GenerationStage[];
  startedAt: string;
  updatedAt: string;
  finished: boolean;
  outcome: 'ok' | 'failed' | null;
}

interface Row {
  trip_id: string;
  stage: string;
  reached: string;
  started_at: string;
  updated_at: string;
  finished: number;
  outcome: string | null;
}

function parse(row: Row): GenerationProgress {
  const reached = row.reached.split(',').filter((entry): entry is GenerationStage => (GENERATION_STAGES as readonly string[]).includes(entry));
  const stage = (GENERATION_STAGES as readonly string[]).includes(row.stage) ? (row.stage as GenerationStage) : 'understanding';
  return {
    tripId: row.trip_id,
    stage,
    reached,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finished: row.finished === 1,
    outcome: row.outcome === 'ok' || row.outcome === 'failed' ? row.outcome : null,
  };
}

/** A build has started. Replaces any earlier row: a retry is a new build, not an addition to the last one. */
export function beginGeneration(tripId: string, now: Date): void {
  const at = now.toISOString();
  getDb()
    .prepare(
      `INSERT INTO generation_progress (trip_id, stage, reached, started_at, updated_at, finished, outcome)
       VALUES (?, 'understanding', 'understanding', ?, ?, 0, NULL)
       ON CONFLICT(trip_id) DO UPDATE SET stage = 'understanding', reached = 'understanding', started_at = excluded.started_at, updated_at = excluded.updated_at, finished = 0, outcome = NULL`,
    )
    .run(tripId, at, at);
}

/** The build reached a stage. Idempotent: a seam that fires twenty times writes the stage once. */
export function markGenerationStage(tripId: string, stage: GenerationStage, now: Date): void {
  const db = getDb();
  const row = db.prepare('SELECT reached FROM generation_progress WHERE trip_id = ?').get(tripId) as { reached: string } | undefined;
  if (!row) return;
  const reached = row.reached.split(',').filter(Boolean);
  if (reached[reached.length - 1] === stage) return;
  if (!reached.includes(stage)) reached.push(stage);
  db.prepare('UPDATE generation_progress SET stage = ?, reached = ?, updated_at = ? WHERE trip_id = ?').run(stage, reached.join(','), now.toISOString(), tripId);
}

export function finishGeneration(tripId: string, outcome: 'ok' | 'failed', now: Date): void {
  getDb().prepare('UPDATE generation_progress SET finished = 1, outcome = ?, updated_at = ? WHERE trip_id = ?').run(outcome, now.toISOString(), tripId);
}

export function getGenerationProgress(tripId: string): GenerationProgress | null {
  const row = getDb().prepare('SELECT * FROM generation_progress WHERE trip_id = ?').get(tripId) as Row | undefined;
  return row ? parse(row) : null;
}
