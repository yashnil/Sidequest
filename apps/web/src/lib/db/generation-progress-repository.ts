import 'server-only';
import { randomBytes } from 'node:crypto';
import { getDb } from './client';

/**
 * WHAT A RUNNING BUILD HAS ACTUALLY FINISHED — AND, SINCE V8, WHICH BUILD IT IS.
 *
 * MVP V3, Stage 24. The generation screen's stages advance on this, not on a
 * timer. Every write happens at a real boundary in
 * `production-plan.ts#generateSidequestPlanForTrip`, so a stage that says it is
 * done is done, and a stage that is showing is the one the server is in.
 *
 * V8 — the row is also the durable record of a build *run*. A run is begun
 * under the client's idempotency key before the response that acknowledges
 * the press is sent; the worker heartbeats it while the model is silent; a
 * failure is recorded with an opaque reference and a traveller-facing kind;
 * and the same key pressed twice attaches to the run rather than starting a
 * second one. See `.claude-private/V8-BUILD-FAILURE.md` for the production
 * session this is built from.
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

/**
 * V8 — WHY A BUILD DID NOT FINISH, IN THE TRAVELLER'S TERMS.
 *
 * - `before_model`: nothing was composed; the profile is saved and a retry
 *   costs nothing that was not already going to be spent.
 * - `model_failed`: the composition was invoked and produced nothing usable;
 *   the raw answer is in `composition_attempts`; a retry is a fresh call.
 * - `after_model`: the draft was written and saved, and something after it
 *   failed; a retry re-verifies the saved draft with no model call.
 * - `lost`: the process went away mid-build (no heartbeat); a retry composes
 *   again unless a draft was saved.
 */
export const BUILD_FAILURE_KINDS = ['before_model', 'model_failed', 'after_model', 'lost'] as const;
export type BuildFailureKind = (typeof BUILD_FAILURE_KINDS)[number];

export type BuildRunState = 'running' | 'succeeded' | 'failed' | 'lost';

/**
 * V8 §14 — A PLACE THE BUILD HAS PUT ON THE MAP, AS IT HAPPENS.
 *
 * Every locality the reconciler resolves through the geocoder is noted with
 * the coordinates the geocoder returned, so the generation screen can draw
 * the trip physically appearing — bases and stops lighting up on the
 * destination's own map. Never invented: a point is written only when a
 * lookup answered. Bounded so the row stays small.
 */
export interface PlacedPoint {
  name: string;
  lat: number;
  lng: number;
}
export const MAX_PLACED_POINTS = 40;

export interface GenerationProgress {
  tripId: string;
  stage: GenerationStage;
  reached: GenerationStage[];
  counters: GenerationCounters;
  placed: PlacedPoint[];
  startedAt: string;
  updatedAt: string;
  finished: boolean;
  outcome: 'ok' | 'failed' | null;
  /** V8 — the client's idempotency key for this run; null for a run begun by an internal caller. */
  buildKey: string | null;
  caller: string | null;
  heartbeatAt: string | null;
  modelInvoked: boolean;
  draftSaved: boolean;
  failure: { ref: string; kind: BuildFailureKind } | null;
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
  build_key?: string | null;
  caller?: string | null;
  heartbeat_at?: string | null;
  model_invoked?: number | null;
  draft_saved?: number | null;
  failure_ref?: string | null;
  failure_kind?: string | null;
}

/**
 * How long a silent run is believed. The model call is the longest silence a
 * build contains (its deadline is 100 s) and the worker heartbeats every ten
 * seconds through it, so a row nothing has touched for this long belongs to a
 * process that is gone.
 */
export const BUILD_STALE_MS = 60_000;
export const BUILD_HEARTBEAT_MS = 10_000;

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

function parsePlaced(raw: string | null | undefined): PlacedPoint[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { placed?: unknown };
    if (!Array.isArray(parsed.placed)) return [];
    return parsed.placed
      .filter((p): p is PlacedPoint => typeof p === 'object' && p !== null && typeof (p as PlacedPoint).name === 'string' && Number.isFinite((p as PlacedPoint).lat) && Number.isFinite((p as PlacedPoint).lng))
      .slice(0, MAX_PLACED_POINTS)
      .map((p) => ({ name: p.name.slice(0, 80), lat: p.lat, lng: p.lng }));
  } catch {
    return [];
  }
}

function parse(row: Row): GenerationProgress {
  const reached = row.reached.split(',').filter((entry): entry is GenerationStage => (GENERATION_STAGES as readonly string[]).includes(entry));
  const stage = (GENERATION_STAGES as readonly string[]).includes(row.stage) ? (row.stage as GenerationStage) : 'understanding';
  const kind = (BUILD_FAILURE_KINDS as readonly string[]).includes(row.failure_kind ?? '') ? (row.failure_kind as BuildFailureKind) : null;
  return {
    tripId: row.trip_id,
    stage,
    reached,
    counters: parseCounters(row.detail_json),
    placed: parsePlaced(row.detail_json),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finished: row.finished === 1,
    outcome: row.outcome === 'ok' || row.outcome === 'failed' ? row.outcome : null,
    buildKey: row.build_key ?? null,
    caller: row.caller ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    modelInvoked: row.model_invoked === 1,
    draftSaved: row.draft_saved === 1,
    failure: row.outcome === 'failed' && row.failure_ref ? { ref: row.failure_ref, kind: kind ?? 'before_model' } : null,
  };
}

/**
 * The state of a run, decided from the row and the clock — never from a route.
 *
 * A row that has not finished and has not been touched inside `BUILD_STALE_MS`
 * is `lost`: the process that owned it is gone and nothing will ever finish
 * it. Everything else is what the row says.
 */
export function buildRunStateOf(progress: GenerationProgress, now: Date): BuildRunState {
  if (progress.finished) return progress.outcome === 'ok' ? 'succeeded' : 'failed';
  const last = Math.max(Date.parse(progress.updatedAt) || 0, Date.parse(progress.heartbeatAt ?? '') || 0, Date.parse(progress.startedAt) || 0);
  return now.getTime() - last > BUILD_STALE_MS ? 'lost' : 'running';
}

export type BeginGenerationOutcome = 'started' | 'attached';

/**
 * A build has started.
 *
 * Replaces any earlier row: a retry is a new build, not an addition to the last
 * one — **unless** the row already holds an unfinished run under the same
 * `buildKey`, in which case this is the worker catching up with a run the
 * press already recorded, and the row is left exactly as it is (`attached`).
 * That is what makes a duplicate press, a refresh or a retried request
 * harmless: every one of them reaches this line with the key it already has.
 */
export function beginGeneration(tripId: string, now: Date, options: { buildKey?: string | null; caller?: string | null } = {}): BeginGenerationOutcome {
  const at = now.toISOString();
  const db = getDb();
  const buildKey = options.buildKey ?? null;
  if (buildKey) {
    const existing = db.prepare('SELECT build_key, finished FROM generation_progress WHERE trip_id = ?').get(tripId) as { build_key?: string | null; finished: number } | undefined;
    if (existing && existing.build_key === buildKey && existing.finished === 0) return 'attached';
  }
  db.prepare(
    `INSERT INTO generation_progress (trip_id, stage, reached, started_at, updated_at, finished, outcome, detail_json, build_key, caller, heartbeat_at, model_invoked, draft_saved, failure_ref, failure_kind)
     VALUES (?, 'understanding', 'understanding', ?, ?, 0, NULL, '{}', ?, ?, ?, 0, 0, NULL, NULL)
     ON CONFLICT(trip_id) DO UPDATE SET stage = 'understanding', reached = 'understanding', started_at = excluded.started_at, updated_at = excluded.updated_at, finished = 0, outcome = NULL, detail_json = '{}',
       build_key = excluded.build_key, caller = excluded.caller, heartbeat_at = excluded.heartbeat_at, model_invoked = 0, draft_saved = 0, failure_ref = NULL, failure_kind = NULL`,
  ).run(tripId, at, at, buildKey, options.caller ?? null, at);
  return 'started';
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
  const placed = parsePlaced(row.detail_json);
  const merged = { ...parseCounters(row.detail_json), ...(counters ?? {}), ...(placed.length > 0 ? { placed } : {}) };
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
  const placed = parsePlaced(row.detail_json);
  const detail = JSON.stringify({ ...parseCounters(row.detail_json), ...counters, ...(placed.length > 0 ? { placed } : {}) });
  if (detail === (row.detail_json ?? '{}')) return;
  db.prepare('UPDATE generation_progress SET detail_json = ?, updated_at = ? WHERE trip_id = ?').run(detail, now.toISOString(), tripId);
}

/** V8 §14 — a locality the build has just placed. Deduplicated by name; bounded; never a percentage of anything. */
export function noteGenerationPlaced(tripId: string, point: PlacedPoint, now: Date): void {
  const db = getDb();
  const row = db.prepare('SELECT detail_json FROM generation_progress WHERE trip_id = ?').get(tripId) as { detail_json?: string | null } | undefined;
  if (!row) return;
  const placed = parsePlaced(row.detail_json);
  if (placed.length >= MAX_PLACED_POINTS || placed.some((p) => p.name === point.name)) return;
  placed.push({ name: point.name.slice(0, 80), lat: point.lat, lng: point.lng });
  const detail = JSON.stringify({ ...parseCounters(row.detail_json), placed });
  db.prepare('UPDATE generation_progress SET detail_json = ?, updated_at = ?, heartbeat_at = ? WHERE trip_id = ?').run(detail, now.toISOString(), now.toISOString(), tripId);
}

/** V8 — the worker is alive. Touched every `BUILD_HEARTBEAT_MS` while the run is open, including through the model's silence. */
export function heartbeatGeneration(tripId: string, now: Date): void {
  getDb().prepare('UPDATE generation_progress SET heartbeat_at = ? WHERE trip_id = ? AND finished = 0').run(now.toISOString(), tripId);
}

/** V8 — the composition was invoked. From here a failure has a cost, and the raw answer lives in `composition_attempts`. */
export function markGenerationModelInvoked(tripId: string, now: Date): void {
  getDb().prepare('UPDATE generation_progress SET model_invoked = 1, heartbeat_at = ? WHERE trip_id = ?').run(now.toISOString(), tripId);
}

/** V8 — the draft is persisted. From here a retry re-verifies it and calls no model. */
export function markGenerationDraftSaved(tripId: string, now: Date): void {
  getDb().prepare('UPDATE generation_progress SET draft_saved = 1, heartbeat_at = ? WHERE trip_id = ?').run(now.toISOString(), tripId);
}

/** Eight url-safe characters: enough to find one log line, too few to mean anything. */
export function newFailureRef(): string {
  return randomBytes(6).toString('base64url').slice(0, 8);
}

/**
 * The build ended. A failure records its kind and an opaque reference; the
 * kind, when the caller does not know it, is read off what the row reached.
 */
export function finishGeneration(tripId: string, outcome: 'ok' | 'failed', now: Date, failure?: { ref?: string; kind?: BuildFailureKind }): { ref: string | null; kind: BuildFailureKind | null } {
  const db = getDb();
  if (outcome === 'ok') {
    db.prepare("UPDATE generation_progress SET finished = 1, outcome = 'ok', updated_at = ?, failure_ref = NULL, failure_kind = NULL WHERE trip_id = ?").run(now.toISOString(), tripId);
    return { ref: null, kind: null };
  }
  const row = db.prepare('SELECT model_invoked, draft_saved, finished, failure_ref, failure_kind FROM generation_progress WHERE trip_id = ?').get(tripId) as
    | { model_invoked?: number | null; draft_saved?: number | null; finished: number; failure_ref?: string | null; failure_kind?: string | null }
    | undefined;
  /* Already recorded as failed: keep the first reference, which is the one the log line carries. */
  if (row?.finished === 1 && row.failure_ref) return { ref: row.failure_ref, kind: (row.failure_kind as BuildFailureKind | null) ?? 'before_model' };
  const kind: BuildFailureKind = failure?.kind ?? (row?.draft_saved === 1 ? 'after_model' : row?.model_invoked === 1 ? 'model_failed' : 'before_model');
  const ref = failure?.ref ?? newFailureRef();
  db.prepare("UPDATE generation_progress SET finished = 1, outcome = 'failed', updated_at = ?, failure_ref = ?, failure_kind = ? WHERE trip_id = ?").run(now.toISOString(), ref, kind, tripId);
  return { ref, kind };
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
