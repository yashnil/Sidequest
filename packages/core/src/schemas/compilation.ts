import { z } from 'zod';

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
 * The stages, in order.
 *
 * These are shown to the traveller as they happen, so they are named for what
 * is being done rather than for the module doing it. There is no percentage
 * anywhere: several of these have genuinely unknown duration, and a bar that
 * moves at a rate nobody can predict is a lie told with an animation.
 */
export const COMPILATION_STAGES = [
  'resolving_destination',
  'awaiting_clarification',
  'confirming_scope',
  'expanding_region',
  'discovering_candidates',
  'deduplicating',
  'classifying',
  'filtering_quality',
  'enriching_priority_candidates',
  'discovering_sources',
  'retrieving_pages',
  'extracting_facts',
  'reconciling_facts',
  'researching_official_constraints',
  'resolving_hours_and_access',
  'resolving_costs',
  'resolving_safety',
  'discovering_food',
  'enriching_food',
  'computing_travel_times',
  'validating_routes',
  'resolving_weather_locations',
  'calculating_coverage',
  'compiling',
] as const;
export const compilationStageSchema = z.enum(COMPILATION_STAGES);
export type CompilationStage = z.infer<typeof compilationStageSchema>;

export const COMPILATION_STAGE_LABELS: Record<CompilationStage, string> = {
  resolving_destination: 'Working out where you mean',
  awaiting_clarification: 'Waiting on your answers',
  confirming_scope: 'Settling the region',
  expanding_region: 'Expanding it into a travel region',
  discovering_candidates: 'Looking for places',
  deduplicating: 'Merging duplicates',
  classifying: 'Sorting what we found',
  filtering_quality: 'Dropping the thin records',
  enriching_priority_candidates: 'Choosing what is worth researching',
  discovering_sources: 'Finding who publishes this',
  retrieving_pages: 'Reading the official pages',
  extracting_facts: 'Pulling out the facts',
  reconciling_facts: 'Working out who to believe',
  researching_official_constraints: 'Checking how you get in',
  resolving_hours_and_access: 'Settling opening hours',
  resolving_costs: 'Settling what things cost',
  resolving_safety: 'Collecting cautions and preparation',
  discovering_food: 'Finding somewhere to eat',
  enriching_food: 'Checking the kitchens are open',
  computing_travel_times: 'Working out travel times',
  validating_routes: 'Checking the legs hang together',
  resolving_weather_locations: 'Choosing where to read the weather',
  calculating_coverage: 'Counting what we found and what we missed',
  compiling: 'Putting it together',
};

/** What each finished stage actually produced. One line, with a real number in it. */
export const stageRecordSchema = z.object({
  stage: compilationStageSchema,
  status: z.enum(['done', 'running', 'waiting', 'skipped', 'failed']),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional(),
  /** "34 candidates across 6 clusters". Absent while running. */
  outcome: z.string().min(1).optional(),
  /** Why it was skipped or how it failed. Required when either. */
  note: z.string().min(1).optional(),
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

/**
 * Stage list for display: every stage in order, with the ones that have not
 * started marked `waiting`.
 *
 * Built here rather than in a component so the progress screen and any test
 * agree about what "six stages, two done" means.
 */
export function displayStages(job: CompilationJob): StageRecord[] {
  const recorded = new Map(job.stages.map((record) => [record.stage, record]));
  /**
   * Only the stages a job actually runs.
   *
   * Resolution, clarification and scope confirmation all happen before a job
   * exists — they are screens the traveller has already been through. Listing
   * them here produced a row that read "Waiting: working out where you mean"
   * for the whole compilation, which is not merely noise: it is wrong.
   */
  const shown = COMPILATION_STAGES.filter(
    (stage) =>
      stage !== 'resolving_destination' &&
      stage !== 'awaiting_clarification' &&
      stage !== 'confirming_scope',
  );
  return shown.map(
    (stage) => recorded.get(stage) ?? { stage, status: 'waiting' as const },
  );
}
