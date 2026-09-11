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

/**
 * V7 §16 — REAL COUNTERS, NEVER A PERCENTAGE.
 *
 * Every number here is something the build has actually counted at the moment
 * it wrote the row: how many days and stops the draft holds, how many stops have
 * been matched to a place on the map, how many legs a router has timed. The
 * screen renders them as sentences; nothing on it is an estimate of time left.
 */
export interface GenerationCounters {
  days?: number;
  stops?: number;
  bases?: number;
  episodes?: number;
  placesMatched?: number;
  legsTimed?: number;
  legsEstimated?: number;
}

export interface GenerationProgress {
  tripId: string;
  stage: GenerationStage;
  reached: GenerationStage[];
  counters: GenerationCounters;
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
  detail_json?: string | null;
}

function parseCounters(raw: string | null | undefined): GenerationCounters {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: GenerationCounters = {};
    for (const key of ['days', 'stops', 'bases', 'episodes', 'placesMatched', 'legsTimed', 'legsEstimated'] as const) {
      const value = parsed[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.round(value);
    }
    return out;
  } catch {
    return {};
  }
}

function parse(row: Row): GenerationProgress {
  const reached = row.reached.split(',').filter((entry): entry is GenerationStage => (GENERATION_STAGES as readonly string[]).includes(entry));
  const stage = (GENERATION_STAGES as readonly string[]).includes(row.stage) ? (row.stage as GenerationStage) : 'understanding';
  return {
    tripId: row.trip_id,
    stage,
    reached,
    counters: parseCounters(row.detail_json),
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
       ON CONFLICT(trip_id) DO UPDATE SET stage = 'understanding', reached = 'understanding', started_at = excluded.started_at, updated_at = excluded.updated_at, finished = 0, outcome = NULL, detail_json = '{}'`,
    )
    .run(tripId, at, at);
}

/**
 * The build reached a stage. Idempotent: a seam that fires twenty times writes
 * the stage once. Counters, when given, are merged over what is already there,
 * so a later boundary never erases an earlier count.
 */
export function markGenerationStage(tripId: string, stage: GenerationStage, now: Date, counters?: GenerationCounters): void {
  const db = getDb();
  const row = db.prepare('SELECT reached, detail_json FROM generation_progress WHERE trip_id = ?').get(tripId) as { reached: string; detail_json?: string | null } | undefined;
  if (!row) return;
  const reached = row.reached.split(',').filter(Boolean);
  const merged = { ...parseCounters(row.detail_json), ...(counters ?? {}) };
  const detail = JSON.stringify(merged);
  if (reached[reached.length - 1] === stage) {
    if (counters && detail !== (row.detail_json ?? '{}')) db.prepare('UPDATE generation_progress SET detail_json = ?, updated_at = ? WHERE trip_id = ?').run(detail, now.toISOString(), tripId);
    return;
  }
  if (!reached.includes(stage)) reached.push(stage);
  db.prepare('UPDATE generation_progress SET stage = ?, reached = ?, updated_at = ?, detail_json = ? WHERE trip_id = ?').run(stage, reached.join(','), now.toISOString(), detail, tripId);
}

/** V7 §16 — the counters alone, at a boundary inside a stage (a place matched, a leg timed). */
export function noteGenerationCounters(tripId: string, counters: GenerationCounters, now: Date): void {
  const db = getDb();
  const row = db.prepare('SELECT stage, detail_json FROM generation_progress WHERE trip_id = ?').get(tripId) as { stage: string; detail_json?: string | null } | undefined;
  if (!row) return;
  const detail = JSON.stringify({ ...parseCounters(row.detail_json), ...counters });
  if (detail === (row.detail_json ?? '{}')) return;
  db.prepare('UPDATE generation_progress SET detail_json = ?, updated_at = ? WHERE trip_id = ?').run(detail, now.toISOString(), tripId);
}

export function finishGeneration(tripId: string, outcome: 'ok' | 'failed', now: Date): void {
  getDb().prepare('UPDATE generation_progress SET finished = 1, outcome = ?, updated_at = ? WHERE trip_id = ?').run(outcome, now.toISOString(), tripId);
}

export function getGenerationProgress(tripId: string): GenerationProgress | null {
  const row = getDb().prepare('SELECT * FROM generation_progress WHERE trip_id = ?').get(tripId) as Row | undefined;
  return row ? parse(row) : null;
}

/** The counters as sentences. Only counts that exist are said; nothing here is a forecast. */
export function milestonesFor(counters: GenerationCounters, stage: GenerationStage): string[] {
  const lines: string[] = [];
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (counters.days !== undefined && counters.stops !== undefined) {
    lines.push(`${plural(counters.days, 'day')} drafted with ${plural(counters.stops, 'stop')}${counters.bases !== undefined && counters.bases > 1 ? ` across ${plural(counters.bases, 'base')}` : ''}${counters.episodes ? `, ${counters.episodes === 1 ? 'one multi-day journey' : `${counters.episodes} multi-day journeys`} kept whole` : ''}.`);
  }
  if (counters.placesMatched !== undefined && counters.stops !== undefined && (stage === 'places' || stage === 'travel' || stage === 'preparing')) {
    /* Bases and localities are looked up too, so the count can pass the stop total; the sentence never claims more stops than exist. */
    lines.push(counters.placesMatched > counters.stops ? `${plural(counters.placesMatched, 'place')} matched on the map, every stop among them.` : `${counters.placesMatched} of ${plural(counters.stops, 'stop')} matched to a place on the map.`);
  }
  if ((counters.legsTimed !== undefined || counters.legsEstimated !== undefined) && (stage === 'travel' || stage === 'preparing')) {
    const timed = counters.legsTimed ?? 0;
    const estimated = counters.legsEstimated ?? 0;
    lines.push(`${plural(timed, 'leg')} timed by a router${estimated > 0 ? `, ${estimated} estimated from the map` : ''}.`);
  }
  return lines;
}
