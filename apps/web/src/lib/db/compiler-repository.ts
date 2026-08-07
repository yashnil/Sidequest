import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  clarificationSetSchema,
  compilationWorkPlanSchema,
  type CompilationWorkPlan,
  compiledRegionSchema,
  compilationOperationalSchema,
  isCompilationStage,
  flattenOperationalCounters,
  COMPILATION_ERROR_COPY,
  decodeStoredJob,
  terminateOpenStages,
  COMPILATION_JOB_VERSION,
  COMPILATION_OPERATIONAL_VERSION,
  destinationDiscoveryPreferencesSchema,
  destinationResolutionSchema,
  selectedDestinationSchema,
  tripComposerAnswersSchema,
  tripPreflightSchema,
  geographicScopeSchema,
  isAbandoned,
  scopeFingerprint,
  type ClarificationSet,
  type CompilationErrorCode,
  type CompilationJob,
  type CompilationStage,
  type CompilationState,
  type CompiledRegion,
  type DestinationDiscoveryPreferences,
  type DestinationResolution,
  type GeographicScope,
  type CompilationOperational,
  type SelectedDestination,
  type StageRecord,
  type StoredJobRow,
  type TripComposerAnswers,
  type TripPreflight,
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
  /** What the composer captured. Null for a trip created before it existed. */
  composer: TripComposerAnswers | null;
  /**
   * The index row the traveller pointed at.
   *
   * Its presence is the signal the whole flow turns on: a destination somebody
   * selected needs no resolution, no interpretation screen and no confirmation
   * click, because there is nothing about it left to guess.
   */
  selectedDestination: SelectedDestination | null;
  preflight: TripPreflight | null;
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
  composer_json: string | null;
  selected_destination_json: string | null;
  preflight_json: string | null;
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
              discovery_prefs_json, composer_json, selected_destination_json, preflight_json
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
      /*
       * The three composer columns are parsed *leniently*, unlike everything
       * above them.
       *
       * A scope that will not parse means the compiler would build the wrong
       * ground, so dropping the whole intent is right. A preflight that will not
       * parse means one panel is missing and everything else still works — and
       * throwing away a confirmed scope because a cached climate blob changed
       * shape would be the cure being worse than the disease.
       */
      composer: parseLenient(row.composer_json, tripComposerAnswersSchema),
      selectedDestination: parseLenient(row.selected_destination_json, selectedDestinationSchema),
      preflight: parseLenient(row.preflight_json, tripPreflightSchema),
    };
  } catch (error) {
    console.error('Stored trip intent will not parse; starting that trip over', error);
    return null;
  }
}

/**
 * Parse a nullable JSON column, treating a shape change as absence.
 *
 * Only for columns whose loss costs a panel rather than a plan. Never used for
 * scope, resolution or clarifications.
 */
function parseLenient<T>(raw: string | null, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T | null {
  if (!raw) return null;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveComposerAnswers(tripId: string, answers: TripComposerAnswers): void {
  upsertIntent(tripId, { composer_json: JSON.stringify(answers) });
}

export function saveSelectedDestination(
  tripId: string,
  destination: SelectedDestination | null,
): void {
  upsertIntent(tripId, {
    selected_destination_json: destination ? JSON.stringify(destination) : null,
  });
}

export function savePreflight(tripId: string, preflight: TripPreflight): void {
  upsertIntent(tripId, { preflight_json: JSON.stringify(preflight) });
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

type JobRow = StoredJobRow;

/**
 * A stored job, or nothing.
 *
 * The decision is `decodeStoredJob`, in `schemas/compilation.ts`, so that the
 * repository, a test and anything else reading this table apply one policy. Two
 * things it fixes, both of which were here:
 *
 * - the row's own `schema_version` is read rather than the *current* constant
 *   being stamped onto whatever was stored, which is a row asserting it was
 *   written under rules it has never been read against;
 * - `JSON.parse(row.stages_json)` was unguarded in a read path, so one
 *   truncated write threw out of `getActiveJob` and made a trip permanently
 *   un-openable. It degrades to a job with no stage history — the same policy
 *   `findCompiledRegion` and `getCompiledRegion` already use.
 */
function rowToJob(row: JobRow): CompilationJob | null {
  const job = decodeStoredJob(row);
  if (!job) {
    console.error('Stored compilation job will not parse; treating it as absent', { id: row.id });
  }
  return job;
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

    /**
     * The pages behind the artifact, as an audit row each.
     *
     * Written inside the same transaction as the artifact so a region can never
     * exist without the record of what it was built from. The bodies are not
     * here and never will be: what is stored is a URL, a publisher, a byte count
     * and a hash of the extracted text — enough to notice a page changed, and
     * not a copy of anybody's page.
     *
     * `content_bytes` is `0` where the artifact does not know it. That is now
     * the common case and it is an improvement rather than a loss: the manifest
     * used to be the *retrieval log*, so a warm build — one answering most
     * subjects from durable claims — wrote nine rows where a cold build of the
     * same region wrote thirty-three, and the nine understated what the region
     * rests on. The manifest is derived from the retained facts now, so the
     * audit trail is complete either way; what nobody measured is the byte count
     * of a page this particular run never downloaded.
     */
    const insertDocument = db.prepare(
      `INSERT INTO source_documents
         (url, compiled_region_id, subject_id, publisher, authority, title,
          content_hash, content_bytes, robots_allowed, retrieved_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(compiled_region_id, url, subject_id) DO NOTHING`,
    );
    for (const page of region.sourceManifest.pages) {
      const fact = region.sourceManifest.facts.find((entry) => entry.sourceUrl === page.url);
      insertDocument.run(
        page.url,
        region.id,
        fact?.subjectId ?? 'unattributed',
        fact?.authorityName ?? 'unknown',
        fact?.authorityKind ?? 'unverified_secondary',
        page.title ?? null,
        page.contentHash ?? '',
        page.contentBytes ?? 0,
        page.robotsAllowed ? 1 : 0,
        page.retrievedAt,
        fact?.publishedAt ?? null,
      );
    }

    /**
     * Which durable claims this artifact quotes.
     *
     * Written inside the same transaction, so a region can never exist without
     * the record of what it rests on. A fact id derived from a claim carries the
     * claim id in it — that is why the id is derived rather than sequential —
     * and this index is what lets the retention sweep protect exactly those
     * claims instead of guessing from age.
     */
    const linkClaim = db.prepare(
      `INSERT INTO compiled_region_claims (compiled_region_id, claim_id)
       VALUES (?, ?) ON CONFLICT DO NOTHING`,
    );
    for (const claimId of claimIdsQuotedBy(region)) linkClaim.run(region.id, claimId);

    db.prepare(
      `UPDATE compilation_jobs
          SET state = ?, compiled_region_id = ?, finished_at = ?, updated_at = ?, heartbeat_at = ?
        WHERE id = ?`,
    ).run(input.state, region.id, stamp, stamp, stamp, input.jobId);
  })();
}

/**
 * The claims an artifact's facts came from.
 *
 * A fact built from a durable claim is called `fact-<claim id>`, so the link is
 * derivable rather than stored twice. Facts from any other path — an authored
 * fixture, a provider that supplied its own — simply do not match, and are not
 * claims to protect.
 */
export function claimIdsQuotedBy(region: CompiledRegion): string[] {
  const ids = new Set<string>();
  for (const fact of region.sourceManifest.facts) {
    if (fact.id.startsWith('fact-clm-')) ids.add(fact.id.slice('fact-'.length));
  }
  return [...ids].sort();
}

/**
 * Audit rows for regions that no longer exist.
 *
 * Ownership is explicit: a `source_documents` row belongs to its compiled
 * region, and a region that has been deleted leaves rows nothing can interpret.
 * `compiled_regions` cascades from `trips`, but SQLite will not cascade into a
 * table with no foreign key — and adding one would make the audit trail able to
 * block a delete. So it is swept instead, deliberately and on demand.
 */
export function pruneOrphanedSourceDocuments(): number {
  const db = getDb();
  const documents = db
    .prepare(
      `DELETE FROM source_documents
        WHERE compiled_region_id NOT IN (SELECT id FROM compiled_regions)`,
    )
    .run().changes;
  const claims = db
    .prepare(
      `DELETE FROM compiled_region_claims
        WHERE compiled_region_id NOT IN (SELECT id FROM compiled_regions)`,
    )
    .run().changes;
  return documents + claims;
}

/**
 * End a job, and end its stage history with it.
 *
 * The second half is not bookkeeping. `groupStages` computes a phase's elapsed
 * time as `now − start` for as long as anything in that phase is `running`, and
 * nothing ever terminated the in-flight stage record — so a build that died
 * eleven minutes ago rendered "Verifying what matters — 11m" and kept counting,
 * on a job whose own state said `failed`. The arithmetic was right; the claim
 * that something was still happening was not.
 *
 * One transaction, because a job that says `failed` while its stages say
 * `running` is exactly the inconsistency this is closing. A stage that already
 * ended is left alone: a terminal write must not rewrite history that was
 * already true.
 */
export function failJob(input: {
  jobId: string;
  code: CompilationErrorCode;
  detail?: string;
  now: Date;
  cancelled?: boolean;
}): void {
  const stamp = input.now.toISOString();
  const db = getDb();

  db.transaction(() => {
    const row = db
      .prepare('SELECT stage, stages_json FROM compilation_jobs WHERE id = ?')
      .get(input.jobId) as { stage: string; stages_json: string } | undefined;
    if (!row) return;

    let stages: StageRecord[] = [];
    try {
      const parsed: unknown = JSON.parse(row.stages_json);
      if (Array.isArray(parsed)) stages = parsed as StageRecord[];
    } catch {
      // An unreadable progress log is a progress log nobody sees. It must not
      // stop the job being marked finished.
    }

    const terminated = terminateOpenStages(stages, {
      now: input.now,
      outcome: input.cancelled ? 'cancelled' : 'failed',
      note: input.detail ?? COMPILATION_ERROR_COPY[input.code],
      ...(isCompilationStage(row.stage) ? { stage: row.stage } : {}),
    });

    db.prepare(
      `UPDATE compilation_jobs
          SET state = ?, error_code = ?, error_detail = ?, finished_at = ?, updated_at = ?,
              stages_json = ?
        WHERE id = ?`,
    ).run(
      input.cancelled ? 'cancelled' : 'failed',
      input.code,
      input.detail ?? null,
      stamp,
      stamp,
      JSON.stringify(terminated),
      input.jobId,
    );
  })();
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
  /*
   * "Will not parse" reads as absent here, exactly as it does in
   * `findCompiledRegion` below.
   *
   * This path used to `JSON.parse` and `.parse` unguarded, which is the one read
   * of this table that could throw. It is also the path reached from a trip's
   * stored `selected_compiled_region_id`, so one artifact the current schema
   * cannot read — a version bump, a truncated write — made that trip
   * permanently un-openable rather than offering a rebuild. The row is durable,
   * so there was no self-healing either.
   */
  try {
    const parsed = compiledRegionSchema.safeParse(JSON.parse(row.payload_json));
    if (!parsed.success) return null;
    return currentUnderTodaysContract(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * WHETHER AN ARTIFACT IS STILL AN ANSWER TO THE QUESTION IT WAS BUILT FOR.
 *
 * `findCompiledRegion` looks a trip up by `(trip, fingerprint)`, so it can only
 * ever return something current. This path — a trip's stored
 * `selected_compiled_region_id` — is a **primary-key lookup**, and it never
 * consulted the fingerprint at all. So the pack invalidation could be triple
 * guarded and hold, and the *artifact* built from a bad pack, plus every
 * itinerary built on that artifact, would keep rendering until somebody happened
 * to press rebuild.
 *
 * The check needs nothing external: an artifact carries both the scope it was
 * built from and the key that scope produced. If recomputing the key from the
 * stored scope does not reproduce the stored key, then the derivation changed —
 * a new segment, a new containment contract version — and the verdicts inside
 * are not comparable to the ones a build would produce now.
 *
 * A stale artifact reads as **absent**, exactly as an unparseable one does, so
 * the caller offers a rebuild. Nothing is deleted and nothing is recompiled
 * silently: the row is durable, a historical itinerary that already resolved its
 * places keeps them, and the traveller is asked rather than charged.
 */
function currentUnderTodaysContract(region: CompiledRegion): boolean {
  return contractSegmentOf(scopeFingerprint(region.scope)) === contractSegmentOf(region.scopeFingerprint);
}

/**
 * The containment contract segment of a fingerprint, or nothing.
 *
 * **Only** that segment, and the narrowing matters. Comparing whole
 * fingerprints answers "was this built by today's derivation", which is a
 * stronger question than the one this guard exists to ask and has a cost the
 * guard should not impose: every segment change — a shape rounding, a new
 * transport field — would orphan every stored artifact, and an orphaned artifact
 * silently empties a finished itinerary's preparation checklist and drops it
 * back to UTC, because `/itinerary` degrades a missing region rather than
 * refusing to render.
 *
 * The question this guard actually has to answer is narrower: **is this artifact
 * a set of verdicts under a contract we no longer hold?** A contaminated
 * compiled region that keeps rendering after its pack was invalidated is the
 * failure; an artifact keyed under an older shape rounding is not.
 *
 * Absent on both sides — an artifact from before the segment existed — compares
 * equal, so nothing already stored is disturbed by the segment's introduction.
 */
function contractSegmentOf(fingerprint: string): string | undefined {
  return fingerprint.split('/').find((segment) => segment.startsWith('contract:'));
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
export function readProviderCache<T>(
  key: string,
  now: Date,
  options: { allowExpired?: boolean } = {},
): T | null {
  try {
    const row = getDb()
      .prepare('SELECT payload_json, expires_at FROM provider_cache WHERE cache_key = ?')
      .get(key) as { payload_json: string; expires_at: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= now.getTime()) {
      /**
       * An expired entry is not worthless — it is last week's answer.
       *
       * The normal read deletes it, because serving stale data as fresh is the
       * failure this whole phase exists to prevent. But when a volunteer-run
       * service is refusing every request, last week's map of a city is a far
       * better answer than "this destination has no places in it", which is a
       * claim about the world rather than about a busy server. The caller asks
       * for this deliberately and labels what it renders.
       */
      if (options.allowExpired) return JSON.parse(row.payload_json) as T;
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

// ---------------------------------------------------------------------------
// Compilation work plans
// ---------------------------------------------------------------------------

/**
 * What a compilation decided to reuse, before it ran.
 *
 * Trip-scoped, and therefore here rather than beside the shared evidence
 * tables: two builds of one destination produce the same evidence and wildly
 * different work plans, so a plan is a fact about a run. Persisted separately
 * from the artifact for the same reason — folding it in would make an
 * artifact's checksum depend on how warm the cache happened to be.
 */
export function saveWorkPlan(input: {
  jobId: string;
  tripId: string;
  plan: CompilationWorkPlan;
}): void {
  const parsed = compilationWorkPlanSchema.parse(input.plan);
  try {
    getDb()
      .prepare(
        `INSERT INTO compilation_work_plans (job_id, trip_id, payload_json, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET payload_json = excluded.payload_json`,
      )
      .run(input.jobId, input.tripId, JSON.stringify(parsed), parsed.computedAt);
  } catch (error) {
    console.error('Could not store a compilation work plan', error);
  }
}

/** The newest work plan for a trip. Absent is normal — sharing can be off. */
export function getLatestWorkPlan(tripId: string): CompilationWorkPlan | null {
  try {
    const row = getDb()
      .prepare(
        `SELECT payload_json FROM compilation_work_plans
          WHERE trip_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tripId) as { payload_json: string } | undefined;
    if (!row) return null;
    return compilationWorkPlanSchema.parse(JSON.parse(row.payload_json));
  } catch {
    // A diagnostic that will not parse is a diagnostic nobody sees, never an
    // error a traveller has to read.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Operational diagnostics — what a run cost, kept off the artifact
// ---------------------------------------------------------------------------

/**
 * WHAT THIS BUILD COST, RECORDED WHERE COSTS BELONG.
 *
 * Counts, versions and one ratio. No credential, no request URL, no page body —
 * only how many times each provider was reached and what the model spent.
 *
 * These used to be folded into `CompiledRegion.diagnostics.budget.consumed`
 * after the compiler returned. The reasoning was sound — a stored artifact that
 * cannot say what it cost is one nobody can audit — and the consequence was not:
 * the compiler is deterministic, so two runs of identical inputs produce
 * identical bytes, and then the runner added the cache-hit counts and made the
 * *persisted* artifact differ by exactly how warm the cache happened to be. An
 * immutable record of a region should not change because somebody else compiled
 * a nearby city first.
 *
 * So the audit trail stays, on the row that describes the run. Nothing renders
 * it today; it exists so a live evaluation can be measured and so a cost
 * question has an answer three weeks later.
 */
export interface StoredOperationalDiagnostics {
  schemaVersion: typeof COMPILATION_OPERATIONAL_VERSION;
  /** Provider and cache counters the runner measured. */
  counters: Record<string, number>;
  /** What the compiler itself spent, and which stages ran. */
  compiler?: CompilationOperational;
}

export function saveOperationalDiagnostics(
  jobId: string,
  input: { counters: Record<string, number>; compiler?: CompilationOperational },
): void {
  try {
    const payload: StoredOperationalDiagnostics = {
      schemaVersion: COMPILATION_OPERATIONAL_VERSION,
      counters: input.counters,
      ...(input.compiler ? { compiler: input.compiler } : {}),
    };
    getDb()
      .prepare(`UPDATE compilation_jobs SET operational_json = ? WHERE id = ?`)
      .run(JSON.stringify(payload), jobId);
  } catch (error) {
    console.error('Could not store operational diagnostics', { jobId, error });
  }
}

/**
 * What a run cost, as one flat map of names to numbers.
 *
 * Flat because that is what a cost question wants three weeks later, and
 * because the column already held exactly this shape before the compiler's own
 * ledger moved onto it. A row written under the old flat shape is still read —
 * a job that finished before the split genuinely recorded only the runner's
 * counters, and refusing to read it would lose the audit trail the column was
 * added for.
 *
 * Absent is normal for a job that predates the column entirely.
 */
export function getOperationalDiagnostics(jobId: string): Record<string, number> | null {
  const stored = getStoredOperationalDiagnostics(jobId);
  if (!stored) return null;
  return {
    ...stored.counters,
    ...(stored.compiler ? flattenOperationalCounters(stored.compiler) : {}),
  };
}

/** The structured record, for anything that needs the ceilings and the stage list. */
export function getStoredOperationalDiagnostics(
  jobId: string,
): StoredOperationalDiagnostics | null {
  try {
    const row = getDb()
      .prepare(`SELECT operational_json FROM compilation_jobs WHERE id = ?`)
      .get(jobId) as { operational_json: string | null } | undefined;
    if (!row?.operational_json) return null;
    const parsed: unknown = JSON.parse(row.operational_json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

    const record = parsed as Record<string, unknown>;
    /*
     * The pre-split shape: a bare map of names to numbers, with no version and
     * no `counters` key. Read as what it is rather than dropped.
     */
    const rawCounters =
      typeof record.counters === 'object' && record.counters !== null ? record.counters : record;
    const counters: Record<string, number> = {};
    for (const [key, value] of Object.entries(rawCounters as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) counters[key] = value;
    }

    const compiler = compilationOperationalSchema.safeParse(record.compiler);
    return {
      schemaVersion: COMPILATION_OPERATIONAL_VERSION,
      counters,
      ...(compiler.success ? { compiler: compiler.data } : {}),
    };
  } catch {
    // A diagnostic that will not parse is a diagnostic nobody sees.
    return null;
  }
}
