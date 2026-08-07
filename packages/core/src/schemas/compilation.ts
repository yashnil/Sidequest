import { z } from 'zod';
import { COMPILATION_STAGES, JOB_STAGES, type CompilationStage } from './stages';

/**
 * A compilation, as a thing that exists in a database rather than a promise in
 * a request.
 *
 * Building a region can take minutes. Nothing else in this product does — every
 * slow thing so far has been an awaited server action, and a browser refresh
 * mid-action simply loses it. That is survivable for a plan that takes two
 * seconds and unacceptable for one that spends money, so the durable artifact
 * is the row, exactly as `traveler_profiles.answers_json` is the durable
 * artifact of the questionnaire.
 */

export const COMPILATION_STATES = [
  'queued',
  'running',
  /** Waiting on the traveller. Not a failure, and not progress either. */
  'awaiting_input',
  'ready',
  /** Finished, usable, and missing things. Never presented as success. */
  'partial',
  'failed',
  'cancelled',
] as const;
export const compilationStateSchema = z.enum(COMPILATION_STATES);
export type CompilationState = z.infer<typeof compilationStateSchema>;

export function isTerminal(state: CompilationState): boolean {
  return state === 'ready' || state === 'partial' || state === 'failed' || state === 'cancelled';
}

/**
 * The stages, in order — derived, not written.
 *
 * The list, the labels and the phase map all come from `STAGE_REGISTRY` in
 * `schemas/stages.ts`. They used to be three hand-keyed literals over one
 * vocabulary, spread across two files, and they disagreed: a stage reached the
 * screen as the raw identifier `reusing_shared_claims` because a second label
 * map did not have it. There is one now.
 *
 * There is still no percentage anywhere: several of these have genuinely unknown
 * duration, and a bar that moves at a rate nobody can predict is a lie told with
 * an animation.
 */
export const compilationStageSchema = z.enum(COMPILATION_STAGES);

/** What each finished stage actually produced. One line, with a real number in it. */
export const stageRecordSchema = z.object({
  stage: compilationStageSchema,
  status: z.enum(['done', 'running', 'waiting', 'skipped', 'failed']),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional(),
  /** "34 candidates across 6 clusters". Absent while running. */
  outcome: z.string().min(1).optional(),
  /**
   * When this stage really started and finished, on a real clock.
   *
   * Separate from `startedAt`/`finishedAt`, which come from the compiler's
   * *injected* clock — advanced by a fixed step per stage so that two runs of the
   * same inputs produce byte-identical artifacts. That reproducibility is worth
   * keeping and it is not a timing: it made every stage claim one millisecond,
   * which made `estimateRemaining` tell a traveller their four-minute build had
   * "roughly 0s–0s to go".
   *
   * So the observed pair is stamped by the *job* as each stage lands, and the
   * progress screen reads these when they are present. Optional because a job
   * row written before this existed has none, and an absent observation must
   * read as "we did not measure" rather than as zero.
   */
  observedStartedAt: z.string().min(1).optional(),
  observedFinishedAt: z.string().min(1).optional(),
  /** Why it was skipped or how it failed. Required when either. */
  note: z.string().min(1).optional(),
  /**
   * Items this stage actually processed, where it has a natural unit.
   *
   * Candidates discovered, pages read, facts extracted, matrix points measured.
   * Absent for the stages that genuinely have none — which is most of the
   * reason there is no percentage anywhere in this product: a completion bar
   * needs work units, and inventing one for a stage that has none is how a bar
   * ends up moving at a rate nobody can predict.
   *
   * It is written here rather than parsed back out of `outcome`, because
   * `outcome` is a sentence for a person and reading a number out of prose is a
   * defect waiting for a reword.
   */
  workUnits: z.number().int().min(0).optional(),
  /**
   * Times this stage had to ask again, having already asked once.
   *
   * Not a configuration: the retrieval and map layers are deliberately
   * one-shot (`retries: 0` at every fetch site), so the only genuine retry in
   * the pipeline today is the routing layer falling back to the road network
   * when the footpath network came back with nothing. Where a stage does not
   * retry, the field is absent rather than zero — "we did not retry" and "we
   * have no idea whether we retried" are different, and only one of them is
   * something an observation may assert.
   */
  retries: z.number().int().min(0).optional(),
  /**
   * Whether this stage completed with something going wrong underneath it.
   *
   * Distinct from `status`. A stage that read eighteen of twenty pages because
   * a publisher rate-limited us is `done` — it produced its result and the
   * progress screen is right to show it as finished — and it is *not*
   * comparable to a stage that read all twenty. `status: 'failed'` is reserved
   * for a stage that could not do its job at all, because the progress screen
   * turns one of those into a failed phase.
   *
   * The estimator reads this: a run that hit a rate limit, lost a provider or
   * exhausted a counter takes a completely different amount of time from a
   * healthy one, usually less, because it stopped doing things. Without it
   * every degraded run was written into the healthy bucket.
   */
  degraded: z.boolean().optional(),
});
export type StageRecord = z.infer<typeof stageRecordSchema>;

export const COMPILATION_ERROR_CODES = [
  'destination_unresolved',
  'destination_ambiguous',
  'clarification_required',
  'scope_not_confirmed',
  'scope_too_broad_for_duration',
  'no_plausible_base',
  'provider_unavailable',
  'provider_rate_limited',
  'provider_credentials_missing',
  'budget_exhausted',
  'ai_output_malformed',
  'ai_fact_missing_citation',
  'route_matrix_incomplete',
  'coverage_insufficient',
  'malicious_source_rejected',
  'cancelled_by_user',
  'internal_error',
] as const;
export const compilationErrorCodeSchema = z.enum(COMPILATION_ERROR_CODES);
export type CompilationErrorCode = z.infer<typeof compilationErrorCodeSchema>;

/**
 * One sentence per code, in the product's register: name what did not happen,
 * and do not offer a guess in its place.
 */
export const COMPILATION_ERROR_COPY: Record<CompilationErrorCode, string> = {
  destination_unresolved: 'We could not find anywhere by that name.',
  destination_ambiguous: 'More than one place matches that, and they are not near each other.',
  clarification_required: 'We need an answer or two before we can start.',
  scope_not_confirmed: 'Nothing has been built yet — the region is still yours to confirm.',
  scope_too_broad_for_duration: 'That covers more ground than this trip has days for.',
  no_plausible_base: 'We could not find anywhere sensible to stay inside that region.',
  provider_unavailable: 'One of our sources did not answer.',
  provider_rate_limited: 'A source asked us to slow down.',
  provider_credentials_missing:
    'This build has no credentials for the live sources, so it can only compile regions we already hold.',
  budget_exhausted: 'We ran out of lookups for this trip before we finished.',
  ai_output_malformed: 'A source came back in a shape we could not read, so we did not use it.',
  ai_fact_missing_citation: 'Something came back without a source, so we left it out.',
  route_matrix_incomplete: 'We could not work out travel times across the whole region.',
  coverage_insufficient: 'There is not enough here to plan on. We would rather say so than pad it.',
  malicious_source_rejected: 'A page we were pointed at was not safe to read, so we did not.',
  cancelled_by_user: 'Stopped.',
  internal_error: 'Something went wrong on our side.',
};

/** Whether trying again could plausibly do better. Shown as a button, so it must be honest. */
export function isRetryable(code: CompilationErrorCode): boolean {
  return (
    code === 'provider_unavailable' ||
    code === 'provider_rate_limited' ||
    code === 'route_matrix_incomplete' ||
    code === 'ai_output_malformed' ||
    code === 'internal_error'
  );
}

export const COMPILATION_JOB_VERSION = 1 as const;

export const compilationJobSchema = z.object({
  schemaVersion: z.literal(COMPILATION_JOB_VERSION),
  id: z.string().min(1),
  tripId: z.string().min(1),
  /**
   * The scope this job is compiling. A job whose fingerprint no longer matches
   * the trip's scope is stale by definition, which is how a second click after
   * an edit starts a new job instead of adopting the old one's answer.
   */
  scopeFingerprint: z.string().min(1),
  state: compilationStateSchema,
  stage: compilationStageSchema,
  stages: z.array(stageRecordSchema).default([]),
  startedAt: z.string().min(1),
  updatedAt: z.string().min(1),
  finishedAt: z.string().min(1).optional(),
  /**
   * Last sign of life. A `running` job whose heartbeat has gone cold was killed
   * with the process, and must be reclaimable — otherwise one crash leaves a
   * trip permanently unable to compile.
   */
  heartbeatAt: z.string().min(1),
  cancelRequested: z.boolean().default(false),
  errorCode: compilationErrorCodeSchema.optional(),
  errorDetail: z.string().min(1).optional(),
  /** Set only on `ready` or `partial`. */
  compiledRegionId: z.string().min(1).optional(),
  /** Follows a request through every provider call it causes. */
  correlationId: z.string().min(1),
});
export type CompilationJob = z.infer<typeof compilationJobSchema>;

/** How long a `running` job may go silent before another request may take it over. */
export const HEARTBEAT_TIMEOUT_MS = 90_000;

export function isAbandoned(job: CompilationJob, now: Date): boolean {
  if (job.state !== 'running' && job.state !== 'queued') return false;
  const beat = Date.parse(job.heartbeatAt);
  if (Number.isNaN(beat)) return true;
  return now.getTime() - beat > HEARTBEAT_TIMEOUT_MS;
}

// ---------------------------------------------------------------------------
// What a run cost — the other side of the semantic boundary
// ---------------------------------------------------------------------------

/**
 * WHAT THIS BUILD DID, AS OPPOSED TO WHAT IT PRODUCED.
 *
 * The counterpart to `CompiledRegion`, and the boundary between them is stated
 * in that file's header: the artifact carries the frozen trip and its source
 * provenance, and everything that changes because a cache was warm, a worker
 * was quicker or a provider retried lives here.
 *
 * It is written to the job row rather than to the artifact, for the same reason
 * `saveWorkPlan` already writes the work plan there: two builds of one
 * destination produce the same region and wildly different numbers, and folding
 * the numbers in made an immutable record's bytes depend on how warm somebody
 * else had left the store.
 *
 * Nothing is lost in the move. Every counter the artifact used to carry is
 * here, plus the ones the runner already recorded separately.
 */
export const COMPILATION_OPERATIONAL_VERSION = 1 as const;

export const compilationOperationalSchema = z.object({
  schemaVersion: z.literal(COMPILATION_OPERATIONAL_VERSION),
  /**
   * Every ceiling and where this run got to.
   *
   * `consumed` counts what was actually bought — searches, pages, bytes, model
   * calls — so a warm store drives most of it to zero for identical output.
   * That is the whole reason it is here and not on the artifact.
   */
  budget: z.object({
    consumed: z.record(z.string(), z.number().int().min(0)),
    limits: z.record(z.string(), z.number().int().min(0)),
    exhausted: z.array(z.string().min(1)).default([]),
  }),
  /** Which stages ran, in the order they ran. Never how long they took. */
  stages: z.array(z.object({ stage: z.string().min(1) })).default([]),
  /**
   * What this run actually downloaded.
   *
   * The artifact's `sourceManifest.pages` is now the list of pages its facts
   * *rest on*, derived from the facts, so it is the same for a cold and a warm
   * build of one region. This is the other thing — the retrieval log — and it
   * is completely different between the two: a warm build answers most subjects
   * from durable claims and calls retrieval for almost nothing. Refusals live
   * here too, because a page we were not allowed to read is an event in a run
   * rather than a source the artifact rests on.
   */
  retrieval: z
    .object({
      pagesRead: z.number().int().min(0),
      pagesRefused: z.number().int().min(0),
      bytesRead: z.number().int().min(0),
    })
    .default({ pagesRead: 0, pagesRefused: 0, bytesRead: 0 }),
  /** Every provider consulted, and how many times. Names and versions are provenance and stay on the artifact too. */
  providers: z
    .array(
      z.object({
        name: z.string().min(1),
        version: z.string().min(1),
        calls: z.number().int().min(0),
        failures: z.number().int().min(0),
      }),
    )
    .default([]),
  /**
   * What the shared evidence layer saved this run.
   *
   * Counts of operations, never a claim about quality. Reuse is allowed to make
   * a run cheap and is not allowed to make anything more certain, so none of
   * these reaches a verification state, a coverage level or a card.
   */
  sharedEvidence: z
    .object({
      claimsHeld: z.number().int().min(0),
      claimsObserved: z.number().int().min(0),
      claimsSuperseded: z.number().int().min(0),
      subjectsAnsweredFromClaims: z.number().int().min(0),
      sharedResolutionsReused: z.number().int().min(0),
    })
    .default({
      claimsHeld: 0,
      claimsObserved: 0,
      claimsSuperseded: 0,
      subjectsAnsweredFromClaims: 0,
      sharedResolutionsReused: 0,
    }),
  /**
   * Whether anything went wrong underneath this run.
   *
   * Derived, never asserted: a counter that ran out, a provider that errored or
   * rate-limited us, or a stage that could not do its job at all. It exists
   * because `degraded` was previously reachable only from a `StageRecord` with
   * `status: 'failed'`, which nothing ever emitted — so every degraded build
   * was written into the estimator's healthy bucket.
   */
  degraded: z.boolean().default(false),
  /** The counters behind `degraded`, so the flag can be explained rather than trusted. */
  degradedReasons: z.array(z.string().min(1)).default([]),
});
export type CompilationOperational = z.infer<typeof compilationOperationalSchema>;

/**
 * The flat numeric view, for anything that wants one number per name.
 *
 * The job row's operational column already held a flat `Record<string, number>`
 * of provider and cache counters, and a live evaluation reads it. This keeps
 * that view working rather than asking every reader to learn a nested shape.
 */
export function flattenOperationalCounters(
  operational: CompilationOperational,
): Record<string, number> {
  const flat: Record<string, number> = {};
  for (const [key, value] of Object.entries(operational.budget.consumed)) {
    flat[`budget.${key}`] = value;
  }
  for (const [key, value] of Object.entries(operational.budget.limits)) {
    flat[`limit.${key}`] = value;
  }
  for (const entry of operational.providers) {
    flat[`provider.${entry.name}.calls`] = entry.calls;
    flat[`provider.${entry.name}.failures`] = entry.failures;
  }
  for (const [key, value] of Object.entries(operational.sharedEvidence)) {
    flat[`claims.${key}`] = value;
  }
  flat['stages.recorded'] = operational.stages.length;
  flat['budget.exhaustedCounters'] = operational.budget.exhausted.length;
  flat['retrieval.pagesRead'] = operational.retrieval.pagesRead;
  flat['retrieval.pagesRefused'] = operational.retrieval.pagesRefused;
  flat['retrieval.bytesRead'] = operational.retrieval.bytesRead;
  return flat;
}

// ---------------------------------------------------------------------------
// Reading a job back out of a row
// ---------------------------------------------------------------------------

/**
 * A stored job row, in the shape a database hands one back.
 *
 * Deliberately loose. This is the boundary where "whatever is in the column"
 * becomes "a job", and typing the input as though it were already correct is
 * how an unreadable row gets past the one place that could have caught it.
 */
export interface StoredJobRow {
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
  /**
   * The version the row was written under.
   *
   * Absent on a database written before the column existed, and `1` is the
   * honest reading of that rather than a guess: version 1 is the only version
   * that has ever been written. What must not happen is the *current* constant
   * being stamped onto whatever was stored, which is a row asserting it was
   * written under rules it has never been read against.
   */
  schema_version?: number | null;
}

/**
 * A job, or nothing.
 *
 * Two rules, both learned from artifacts rather than invented here:
 *
 * 1. **The version comes off the row.** `rowToJob` used to stamp
 *    `COMPILATION_JOB_VERSION` onto whatever it found, so a row written under
 *    v1 and read after the schema moved on would claim to be v2 and be parsed
 *    as one. A stored version this build cannot read degrades to absent, and
 *    the caller offers a rebuild — the same thing it already does for an
 *    artifact whose version has moved on.
 *
 * 2. **An unreadable `stages_json` costs the stage history, not the job.** It
 *    used to be an unguarded `JSON.parse` in a read path, so one truncated
 *    write made a trip permanently un-openable. The stage list is a progress
 *    log; the job is what the trip is waiting on. Losing the first to keep the
 *    second is the right way round, and it is the policy `findCompiledRegion`
 *    and `getCompiledRegion` already follow.
 */
export function decodeStoredJob(row: StoredJobRow): CompilationJob | null {
  const storedVersion = row.schema_version ?? COMPILATION_JOB_VERSION;
  if (storedVersion !== COMPILATION_JOB_VERSION) return null;

  let stages: unknown;
  try {
    stages = JSON.parse(row.stages_json);
  } catch {
    // A progress log we cannot read is a progress log nobody sees. The job it
    // belongs to is still a job, and the trip is still openable.
    stages = [];
  }

  const parsed = compilationJobSchema.safeParse({
    schemaVersion: storedVersion,
    id: row.id,
    tripId: row.trip_id,
    scopeFingerprint: row.scope_fingerprint,
    state: row.state,
    stage: row.stage,
    stages,
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
  if (parsed.success) return parsed.data;

  /*
   * The stage list is the most likely thing to be wrong — it is the only free
   * JSON on the row and the only part that grows during a run. So it is dropped
   * and the job is tried once more without it. If the row is still unreadable,
   * the problem is the job itself and absent is the honest answer.
   */
  const withoutStages = compilationJobSchema.safeParse({
    schemaVersion: storedVersion,
    id: row.id,
    tripId: row.trip_id,
    scopeFingerprint: row.scope_fingerprint,
    state: row.state,
    stage: row.stage,
    stages: [],
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
  return withoutStages.success ? withoutStages.data : null;
}

// ---------------------------------------------------------------------------
// Ending a job's stage history
// ---------------------------------------------------------------------------

/**
 * Close every stage a dead job left open.
 *
 * A job that failed or was cancelled left its in-flight stage recorded as
 * `running` for ever, and `groupStages` computes a phase's elapsed time as
 * `now − start` for as long as anything in it is running. So a build that died
 * eleven minutes ago read "Verifying what matters — 11m" and kept counting,
 * on a job whose state said `failed`. The clock was not lying about the
 * arithmetic; it was lying about there being anything still happening.
 *
 * Pure, so the repository, the runner and a test all agree about what a
 * terminated stage looks like. A stage that already ended is left exactly as it
 * was — a terminal write must not rewrite history that was already true.
 */
export function terminateOpenStages(
  stages: readonly StageRecord[],
  input: { now: Date; outcome: 'failed' | 'cancelled'; note: string; stage?: CompilationStage },
): StageRecord[] {
  const stamp = input.now.toISOString();
  const closed = stages.map((record) =>
    record.status === 'running'
      ? ({
          ...record,
          status: 'failed' as const,
          finishedAt: record.finishedAt ?? stamp,
          observedFinishedAt: record.observedFinishedAt ?? stamp,
          note: input.note,
        } satisfies StageRecord)
      : record,
  );

  /*
   * A job can die before any stage was recorded at all — no scope, no
   * credentials, a crash between `startJob` and the first stage. The phase card
   * for the stage it was sitting on would then have no record in it, so there
   * is nothing for the screen to mark as ended. One terminal record, named
   * after the stage the job row says it was on.
   */
  if (input.stage && !closed.some((record) => record.stage === input.stage)) {
    closed.push({
      stage: input.stage,
      status: 'failed',
      startedAt: stamp,
      finishedAt: stamp,
      observedStartedAt: stamp,
      observedFinishedAt: stamp,
      note: input.note,
    });
  }

  return closed;
}

/**
 * Stage list for display: every stage in order, with the ones that have not
 * started marked `waiting`.
 *
 * Built here rather than in a component so the progress screen and any test
 * agree about what "six stages, two done" means.
 */
export function displayStages(job: CompilationJob): StageRecord[] {
  const recorded = new Map<CompilationStage, StageRecord>(
    job.stages.map((record) => [record.stage, record]),
  );
  /*
   * Only the stages a job actually runs — read off the registry, not listed here.
   *
   * Resolution, clarification and scope confirmation all happen before a job
   * exists; they are screens the traveller has already been through. Listing
   * them here produced a row that read "Waiting: working out where you mean"
   * for the whole compilation, which is not merely noise: it is wrong. This was
   * three hard-coded identifiers and a fourth pre-job stage would not have been
   * added to them, so it is `runsInJob` on the registry instead.
   */
  return JOB_STAGES.map((stage) => recorded.get(stage) ?? { stage, status: 'waiting' as const });
}
