import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  clarificationSetSchema,
  compilationJobSchema,
  compiledRegionSchema,
  COMPILATION_JOB_VERSION,
  destinationDiscoveryPreferencesSchema,
  destinationResolutionSchema,
  geographicScopeSchema,
  isAbandoned,
  type ClarificationSet,
  type CompilationErrorCode,
  type CompilationJob,
  type CompilationStage,
  type CompilationState,
  type CompiledRegion,
  type DestinationDiscoveryPreferences,
  type DestinationResolution,
  type GeographicScope,
  type StageRecord,
} from '@sidequest/core';
import { getDb } from './client';

/**
 * Everything the open-world flow persists.
 *
 * Kept beside `repository.ts` rather than inside it because the two answer
 * different questions — that one is about a trip that already has a region, this
 * one is about getting to one — and because the read/write discipline is
 * identical, which makes the split cheap: **every read parses through the
 * schema rather than casting**, on the way in and on the way out.
 */

// ---------------------------------------------------------------------------
// Trip intent
// ---------------------------------------------------------------------------

export interface TripIntentRecord {
  tripId: string;
  mode: 'known_destination' | 'help_me_decide';
  destinationQuery: string;
  resolution: DestinationResolution | null;
  selectedCandidateId: string | null;
  clarifications: ClarificationSet;
  scope: GeographicScope | null;
  scopeRevision: number;
  selectedCompiledRegionId: string | null;
  discoveryPreferences: DestinationDiscoveryPreferences | null;
}

interface IntentRow {
  trip_id: string;
  mode: string;
  destination_query: string;
  resolution_json: string | null;
  selected_candidate_id: string | null;
  clarifications_json: string;
  scope_json: string | null;
  scope_revision: number;
  selected_compiled_region_id: string | null;
  discovery_prefs_json: string | null;
}

const EMPTY_CLARIFICATIONS: ClarificationSet = {
  schemaVersion: 1,
  questions: [],
  answers: [],
};

/**
 * A stored intent, or null.
 *
 * A row that will not parse is dropped rather than thrown, and the caller starts
 * the traveller again from the destination screen. That is the right trade for
 * this table specifically: unlike an itinerary, nothing here is a claim about
 * the world, so re-asking is a mild annoyance where rendering a half-parsed
 * scope would be a compilation of the wrong ground.
 */
export function getIntent(tripId: string): TripIntentRecord | null {
  const row = getDb()
    .prepare(
      `SELECT trip_id, mode, destination_query, resolution_json, selected_candidate_id,
              clarifications_json, scope_json, scope_revision, selected_compiled_region_id,
              discovery_prefs_json
         FROM trip_intents WHERE trip_id = ?`,
    )
    .get(tripId) as IntentRow | undefined;
  if (!row) return null;

  try {
    return {
      tripId: row.trip_id,
      mode: row.mode === 'help_me_decide' ? 'help_me_decide' : 'known_destination',
      destinationQuery: row.destination_query,
      resolution: row.resolution_json
        ? destinationResolutionSchema.parse(JSON.parse(row.resolution_json))
        : null,
      selectedCandidateId: row.selected_candidate_id,
      clarifications: clarificationSetSchema.parse(JSON.parse(row.clarifications_json || '{}')),
      scope: row.scope_json ? geographicScopeSchema.parse(JSON.parse(row.scope_json)) : null,
      scopeRevision: row.scope_revision,
      selectedCompiledRegionId: row.selected_compiled_region_id,
      discoveryPreferences: row.discovery_prefs_json
        ? destinationDiscoveryPreferencesSchema.parse(JSON.parse(row.discovery_prefs_json))
        : null,
    };
  } catch (error) {
    console.error('Stored trip intent will not parse; starting that trip over', error);
    return null;
  }
}

function upsertIntent(tripId: string, patch: Partial<Record<string, unknown>>): void {
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO trip_intents (trip_id, mode, destination_query, clarifications_json, created_at, updated_at)
     VALUES (?, 'known_destination', '', ?, ?, ?)
     ON CONFLICT(trip_id) DO NOTHING`,
  ).run(tripId, JSON.stringify(EMPTY_CLARIFICATIONS), now, now);

  const columns = Object.keys(patch);
  if (columns.length === 0) return;
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  db.prepare(`UPDATE trip_intents SET ${assignments}, updated_at = ? WHERE trip_id = ?`).run(
    ...columns.map((column) => patch[column] as never),
    now,
    tripId,
  );
}

export function saveDestinationQuery(
  tripId: string,
  mode: TripIntentRecord['mode'],
  query: string,
): void {
  upsertIntent(tripId, { mode, destination_query: query });
}

export function saveResolution(tripId: string, resolution: DestinationResolution): void {
  // Parsed before it is written, so a malformed provider response never reaches
  // the table it would later be read back out of.
  const parsed = destinationResolutionSchema.parse(resolution);
  upsertIntent(tripId, { resolution_json: JSON.stringify(parsed) });
}

export function saveSelectedCandidate(tripId: string, candidateId: string): void {
  upsertIntent(tripId, { selected_candidate_id: candidateId });
}

export function saveClarifications(tripId: string, set: ClarificationSet): void {
  upsertIntent(tripId, {
    clarifications_json: JSON.stringify(clarificationSetSchema.parse(set)),
  });
}

export function saveDiscoveryPreferences(
  tripId: string,
  preferences: DestinationDiscoveryPreferences,
): void {
  upsertIntent(tripId, {
    discovery_prefs_json: JSON.stringify(
      destinationDiscoveryPreferencesSchema.parse(preferences),
    ),
  });
}

/**
 * Store a scope, bumping its revision.
 *
 * The revision is what makes an edit visible downstream: it travels into the
 * fingerprint, so changing an answer and pressing on cannot silently adopt the
 * artifact compiled from the previous answer.
 */
export function saveScope(tripId: string, scope: GeographicScope): GeographicScope {
  const current = getIntent(tripId);
  const revision = (current?.scopeRevision ?? 0) + 1;
  const next = geographicScopeSchema.parse({ ...scope, revision });
  upsertIntent(tripId, { scope_json: JSON.stringify(next), scope_revision: revision });
  return next;
}

export function saveSelectedCompiledRegion(tripId: string, compiledRegionId: string): void {
  upsertIntent(tripId, { selected_compiled_region_id: compiledRegionId });
}

// ---------------------------------------------------------------------------
// Compilation jobs
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  trip_id: string;
  scope_fingerprint: string;
  state: string;
  stage: string;
  stages_json: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  heartbeat_at: string;
  cancel_requested: number;
  error_code: string | null;
  error_detail: string | null;
  compiled_region_id: string | null;
  correlation_id: string;
}

function rowToJob(row: JobRow): CompilationJob {
  return compilationJobSchema.parse({
    schemaVersion: COMPILATION_JOB_VERSION,
    id: row.id,
    tripId: row.trip_id,
    scopeFingerprint: row.scope_fingerprint,
    state: row.state,
    stage: row.stage,
    stages: JSON.parse(row.stages_json),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    heartbeatAt: row.heartbeat_at,
    cancelRequested: row.cancel_requested === 1,
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_detail ? { errorDetail: row.error_detail } : {}),
    ...(row.compiled_region_id ? { compiledRegionId: row.compiled_region_id } : {}),
    correlationId: row.correlation_id,
  });
}

export function getJob(jobId: string): CompilationJob | null {
  const row = getDb().prepare('SELECT * FROM compilation_jobs WHERE id = ?').get(jobId) as
    | JobRow
    | undefined;
  return row ? rowToJob(row) : null;
}

/** The most recent job for a trip, whatever state it is in. */
export function getLatestJob(tripId: string): CompilationJob | null {
  const row = getDb()
    .prepare('SELECT * FROM compilation_jobs WHERE trip_id = ? ORDER BY started_at DESC LIMIT 1')
    .get(tripId) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function getActiveJob(tripId: string): CompilationJob | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM compilation_jobs
        WHERE trip_id = ? AND state IN ('queued','running')
        ORDER BY started_at DESC LIMIT 1`,
    )
    .get(tripId) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export type StartJobResult =
  | { kind: 'started'; job: CompilationJob }
  | { kind: 'already_running'; job: CompilationJob };

/**
 * Start a compilation, or adopt the one already running.
 *
 * The unique partial index on `(trip_id) WHERE state IN ('queued','running')`
 * does the real work: a second click, a second tab, or a direct POST all hit a
 * constraint violation rather than a second bill. Adopting rather than
 * erroring is deliberate — from the traveller's side, pressing the button twice
 * should show them the thing that is already happening.
 *
 * A job whose heartbeat has gone cold is reclaimed first, because a process that
 * was killed mid-compile must not lock the trip out forever.
 */
export function startJob(input: {
  tripId: string;
  scopeFingerprint: string;
  now: Date;
}): StartJobResult {
  const db = getDb();
  const existing = getActiveJob(input.tripId);

  if (existing) {
    if (!isAbandoned(existing, input.now)) return { kind: 'already_running', job: existing };
    db.prepare(
      `UPDATE compilation_jobs
          SET state = 'failed', error_code = 'internal_error',
              error_detail = 'The process running this compilation stopped answering.',
              finished_at = ?, updated_at = ?
        WHERE id = ?`,
    ).run(input.now.toISOString(), input.now.toISOString(), existing.id);
  }

  const stamp = input.now.toISOString();
  const job: CompilationJob = {
    schemaVersion: COMPILATION_JOB_VERSION,
    id: randomUUID(),
    tripId: input.tripId,
    scopeFingerprint: input.scopeFingerprint,
    state: 'queued',
    stage: 'expanding_region',
    stages: [],
    startedAt: stamp,
    updatedAt: stamp,
    heartbeatAt: stamp,
    cancelRequested: false,
    correlationId: randomUUID(),
  };

  try {
    db.prepare(
      `INSERT INTO compilation_jobs
         (id, trip_id, scope_fingerprint, state, stage, stages_json,
          started_at, updated_at, heartbeat_at, cancel_requested, correlation_id)
       VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, 0, ?)`,
    ).run(
      job.id,
      job.tripId,
      job.scopeFingerprint,
      job.state,
      job.stage,
      job.startedAt,
      job.updatedAt,
      job.heartbeatAt,
      job.correlationId,
    );
  } catch {
    // Lost a race against another request. Whoever won is the live job.
    const winner = getActiveJob(input.tripId);
    if (winner) return { kind: 'already_running', job: winner };
    throw new Error('Could not start a compilation.');
  }

  return { kind: 'started', job };
}

export function markJobRunning(jobId: string, now: Date): void {
  const stamp = now.toISOString();
  getDb()
    .prepare(
      `UPDATE compilation_jobs SET state = 'running', updated_at = ?, heartbeat_at = ? WHERE id = ?`,
    )
    .run(stamp, stamp, jobId);
}

/** One stage completed. Written as it happens, so a refresh sees real progress. */
export function recordStage(jobId: string, stage: StageRecord, now: Date): void {
  const db = getDb();
  const row = db.prepare('SELECT stages_json FROM compilation_jobs WHERE id = ?').get(jobId) as
    | { stages_json: string }
    | undefined;
  if (!row) return;

  const stages = JSON.parse(row.stages_json) as StageRecord[];
  const index = stages.findIndex((entry) => entry.stage === stage.stage);
  if (index >= 0) stages[index] = stage;
  else stages.push(stage);

  const stamp = now.toISOString();
  db.prepare(
    `UPDATE compilation_jobs
        SET stages_json = ?, stage = ?, updated_at = ?, heartbeat_at = ?
      WHERE id = ?`,
  ).run(JSON.stringify(stages), stage.stage, stamp, stamp, jobId);
}

export function heartbeat(jobId: string, now: Date): void {
  getDb()
    .prepare('UPDATE compilation_jobs SET heartbeat_at = ? WHERE id = ?')
    .run(now.toISOString(), jobId);
}

export function requestCancel(tripId: string): void {
  getDb()
    .prepare(
      `UPDATE compilation_jobs SET cancel_requested = 1, updated_at = ?
        WHERE trip_id = ? AND state IN ('queued','running')`,
    )
    .run(new Date().toISOString(), tripId);
}

export function isCancelRequested(jobId: string): boolean {
  const row = getDb()
    .prepare('SELECT cancel_requested FROM compilation_jobs WHERE id = ?')
    .get(jobId) as { cancel_requested: number } | undefined;
  return row?.cancel_requested === 1;
}

/**
 * Finish a job and store its artifact, atomically.
 *
 * The `ready` flip and the artifact insert are one transaction, and the flip is
 * last. There is no instant at which a job claims to be ready without a region
 * behind it — which is the property the whole state machine exists to have, and
 * the one that a second statement outside the transaction would quietly lose.
 *
 * `better-sqlite3` transactions are synchronous, so everything awaited has
 * already happened by the time this is called. That is not a coincidence: it is
 * why the compiler returns a finished artifact rather than writing as it goes.
 */
export function completeJob(input: {
  jobId: string;
  tripId: string;
  region: CompiledRegion;
  state: Extract<CompilationState, 'ready' | 'partial'>;
  now: Date;
}): void {
  const region = compiledRegionSchema.parse(input.region);
  const stamp = input.now.toISOString();
  const db = getDb();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO compiled_regions
         (id, trip_id, scope_fingerprint, schema_version, compiler_version, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(
      region.id,
      input.tripId,
      region.scopeFingerprint,
      region.schemaVersion,
      region.compilerVersion,
      JSON.stringify(region),
      stamp,
    );

    db.prepare(
      `UPDATE trip_intents SET selected_compiled_region_id = ?, updated_at = ? WHERE trip_id = ?`,
    ).run(region.id, stamp, input.tripId);

    db.prepare(
      `UPDATE compilation_jobs
          SET state = ?, compiled_region_id = ?, finished_at = ?, updated_at = ?, heartbeat_at = ?
        WHERE id = ?`,
    ).run(input.state, region.id, stamp, stamp, stamp, input.jobId);
  })();
}

export function failJob(input: {
  jobId: string;
  code: CompilationErrorCode;
  detail?: string;
  now: Date;
  cancelled?: boolean;
}): void {
  const stamp = input.now.toISOString();
  getDb()
    .prepare(
      `UPDATE compilation_jobs
          SET state = ?, error_code = ?, error_detail = ?, finished_at = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      input.cancelled ? 'cancelled' : 'failed',
      input.code,
      input.detail ?? null,
      stamp,
      stamp,
      input.jobId,
    );
}

export function setJobStage(jobId: string, stage: CompilationStage, now: Date): void {
  getDb()
    .prepare('UPDATE compilation_jobs SET stage = ?, updated_at = ?, heartbeat_at = ? WHERE id = ?')
    .run(stage, now.toISOString(), now.toISOString(), jobId);
}

// ---------------------------------------------------------------------------
// Compiled regions
// ---------------------------------------------------------------------------

interface RegionRow {
  id: string;
  payload_json: string;
}

/**
 * A stored artifact.
 *
 * Throws rather than returning null on a parse failure, and that asymmetry with
 * `getIntent` is deliberate: an intent that will not parse costs a traveller a
 * screen, while an artifact that will not parse is the evidence a plan claims to
 * rest on. The caller shows a rebuild offer, exactly as it already does for an
 * itinerary whose version has moved on.
 */
export function getCompiledRegion(id: string): CompiledRegion | null {
  const row = getDb()
    .prepare('SELECT id, payload_json FROM compiled_regions WHERE id = ?')
    .get(id) as RegionRow | undefined;
  if (!row) return null;
  return compiledRegionSchema.parse(JSON.parse(row.payload_json));
}

/** The newest artifact compiled for exactly this scope, if there is one. */
export function findCompiledRegion(
  tripId: string,
  scopeFingerprint: string,
): CompiledRegion | null {
  const row = getDb()
    .prepare(
      `SELECT id, payload_json FROM compiled_regions
        WHERE trip_id = ? AND scope_fingerprint = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(tripId, scopeFingerprint) as RegionRow | undefined;
  if (!row) return null;
  try {
    return compiledRegionSchema.parse(JSON.parse(row.payload_json));
  } catch (error) {
    console.error('Stored compiled region will not parse', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider cache
// ---------------------------------------------------------------------------

/**
 * A cache that is never allowed to be the reason a page does not render.
 *
 * Same discipline the weather cache already follows: a row that will not parse
 * is deleted and the request goes out again, and a failure to read or write is
 * swallowed. The key is the caller's business — it must contain everything that
 * would change the answer, including the provider's own name and version, so a
 * fixture run can never leave rows a live run will read.
 */
export function readProviderCache<T>(key: string, now: Date): T | null {
  try {
    const row = getDb()
      .prepare('SELECT payload_json, expires_at FROM provider_cache WHERE cache_key = ?')
      .get(key) as { payload_json: string; expires_at: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now.getTime()) {
      getDb().prepare('DELETE FROM provider_cache WHERE cache_key = ?').run(key);
      return null;
    }
    return JSON.parse(row.payload_json) as T;
  } catch {
    try {
      getDb().prepare('DELETE FROM provider_cache WHERE cache_key = ?').run(key);
    } catch {
      // Nothing useful to do; the read path already degrades correctly.
    }
    return null;
  }
}

export function writeProviderCache(
  key: string,
  provider: string,
  payload: unknown,
  ttlMs: number,
  now: Date,
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO provider_cache (cache_key, provider, payload_json, stored_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           stored_at = excluded.stored_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        key,
        provider,
        JSON.stringify(payload),
        now.toISOString(),
        new Date(now.getTime() + ttlMs).toISOString(),
      );
    // Bounded, oldest-expiring first, like the weather cache.
    getDb()
      .prepare(
        `DELETE FROM provider_cache WHERE cache_key IN (
           SELECT cache_key FROM provider_cache ORDER BY expires_at DESC LIMIT -1 OFFSET 2000)`,
      )
      .run();
  } catch (error) {
    console.error('Could not cache a provider response', error);
  }
}
