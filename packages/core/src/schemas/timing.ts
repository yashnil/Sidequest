import { z } from 'zod';
import { compilationStageSchema, type CompilationErrorCode } from './compilation';
import { compilationPhaseSchema, type CompilationStage } from './stages';
import {
  scopeBreadthSchema,
  type DestinationEntityType,
  type ScopeBreadth,
} from './geography';

/**
 * HOW LONG THINGS ACTUALLY TOOK.
 *
 * The defect this replaces is worth stating exactly, because it looked like a
 * feature. `runStage` stamped every stage's `startedAt` and `finishedAt` from an
 * injected clock advanced by **one millisecond per stage**, and pushed
 * `{ stage, ms: 1 }` into the artifact's `stageTimings`.
 *
 * The reason was real: `compiler.test.ts` asserts that two runs of the same
 * inputs produce byte-identical artifacts, and a wall clock inside the artifact
 * would break that. But the consequence was that every stage claimed to have
 * taken a millisecond — so `PhaseProgress.elapsedSeconds` was always zero, and
 * `estimateRemaining` computed a one-millisecond median and told a traveller
 * their four-minute build had "roughly 0s–0s to go".
 *
 * The fix is a split rather than a swap:
 *
 * | | Clock | Lives in | Property |
 * | --- | --- | --- | --- |
 * | the artifact | none | `CompiledRegion` | reproducible — it no longer claims a duration it did not measure |
 * | the job | real | `compilation_jobs.stages_json` | observed — what this run did, on this machine, this time |
 * | history | real | `stage_observations` | comparable — what runs *like this one* have done before |
 *
 * The artifact stops asserting durations. That is not a loss of information: it
 * never had the information, and a field that said `1` was worse than a field
 * that said nothing, because one of them invites arithmetic.
 *
 * ---
 *
 * WHAT MAY BE IN A SEMANTIC ARTIFACT, AND WHAT MAY ONLY BE IN AN OBSERVATION.
 *
 * The rule the split enforces, stated so it can be checked rather than
 * remembered:
 *
 * - **The artifact** carries provenance and semantic timestamps only. Which
 *   catalogue release, which prompt version, when a claim was retrieved, when
 *   the region was compiled. Everything in it is a property of *the region*, and
 *   two builds of the same region from the same sources must produce the same
 *   bytes.
 * - **An observation** carries everything that is a property of *this run*.
 *   Durations, provider call counts, retries, cache warmth, whether a provider
 *   was having a bad afternoon. None of it is about the region and all of it
 *   differs between two builds that must agree.
 *
 * The line matters because it has already been crossed, twice, in the same way.
 * Live cache counters — `geocoderCacheHits`, `poiCacheHits`, `routeCacheHits`,
 * `evidenceDocumentsReused`, `evidenceBytesAvoided`, `evidenceReusePercent`, and
 * later the shared-claim counters — were folded into
 * `region.diagnostics.budget.consumed`, first by the runner after `compileRegion`
 * returned and then from inside the compiler itself. Neither breaks the
 * compiler's determinism guarantee; both break what is *persisted*. Two runs of
 * identical inputs differ in those fields by exactly how warm the cache happened
 * to be, which is the condition `saveWorkPlan`'s own comment says it exists to
 * avoid ("folding it in would make an artifact's checksum depend on how warm the
 * cache happened to be").
 *
 * The rule that follows, and it is a rule rather than a preference: **an
 * operational counter goes on the observation below or on the run's own
 * diagnostics envelope, never on the artifact.** Anything that is a property of
 * this run and not of this region does not belong in something two runs have to
 * agree on byte for byte.
 *
 * ---
 *
 * THE ESTIMATOR REFUSES MORE OFTEN THAN IT ANSWERS.
 *
 * The single most common lie a progress screen tells is a confident estimate
 * built from nothing, and this codebase has already told it once. So the bar is
 * deliberately high: enough comparable *runs*, bucketed so a city build is not
 * averaged with a country build, cold separated from warm, park-and-remote
 * separated from both, and degraded runs separated from healthy ones. Failures
 * are excluded from success durations. Below the bar the honest output is
 * silence.
 */

// ---------------------------------------------------------------------------
// One observation
// ---------------------------------------------------------------------------

/**
 * How a stage ended.
 *
 * `skipped` is separated from `done` because a stage that was skipped took no
 * time for a reason — no pack provider, no food found — and folding it into the
 * durations of stages that actually ran would drag every estimate towards zero.
 */
export const STAGE_OUTCOMES = ['done', 'skipped', 'failed', 'cancelled'] as const;
export const stageOutcomeSchema = z.enum(STAGE_OUTCOMES);
export type StageOutcome = z.infer<typeof stageOutcomeSchema>;

/**
 * Whether this run had to buy what it used.
 *
 * The single largest source of variance in this pipeline. A warm build of a city
 * somebody else already compiled reuses the pack, the claims and the routes; a
 * cold one buys all three. Averaging them produces a number that describes
 * neither, and it is the bucket a traveller feels most strongly.
 */
export const WARMTH = ['cold', 'warm', 'mixed'] as const;
export const warmthSchema = z.enum(WARMTH);
export type Warmth = z.infer<typeof warmthSchema>;

/**
 * The shape of the ground being compiled.
 *
 * Coarser than `ScopeBreadth` and deliberately so: breadth has six values, which
 * would split the history six ways and leave every bucket below the sample
 * threshold for months. These are the three shapes whose *durations* genuinely
 * differ, plus an explicit `mixed` for everything that is not clearly one of
 * them — because putting the leftovers into `city` is how a two-hour build ends
 * up in the same median as a four-minute one.
 *
 * - `city` — one settlement and its surroundings. Dense data, short routes.
 * - `broad_country` — a country or several. The partition is large, the pack
 *   build dominates, and the research funnel is bounded by budget rather than by
 *   how many places exist.
 * - `park_remote` — a park, an island, an archipelago, a corridor. Sparse data,
 *   long routes, and the highest rate of "nobody publishes this".
 * - `mixed` — a region or subregion that is none of the above. Its own bucket
 *   rather than a default, so it never contaminates the other three.
 */
export const DESTINATION_SHAPES = ['city', 'broad_country', 'park_remote', 'mixed'] as const;
export const destinationShapeSchema = z.enum(DESTINATION_SHAPES);
export type DestinationShape = z.infer<typeof destinationShapeSchema>;

/**
 * Which shape a scope is, derived rather than declared.
 *
 * Pure, so the runner, the progress screen and the tests cannot classify the
 * same trip differently — which they would within a week if each read the scope
 * itself.
 *
 * Breadth wins for whole countries: an archipelago at country breadth is a
 * country-sized build whatever its entity type says, and its duration behaves
 * like one.
 */
const REMOTE_ENTITY_TYPES: ReadonlySet<DestinationEntityType> = new Set([
  'protected_area',
  'island',
  'archipelago',
  'route_or_corridor',
]);

export function destinationShapeFrom(input: {
  breadth: ScopeBreadth;
  entityType: DestinationEntityType;
}): DestinationShape {
  if (input.breadth === 'country' || input.breadth === 'multi_country') return 'broad_country';
  if (REMOTE_ENTITY_TYPES.has(input.entityType)) return 'park_remote';
  if (input.breadth === 'local' || input.breadth === 'city') return 'city';
  return 'mixed';
}

/**
 * Why a stage stopped early, when somebody stopped it.
 *
 * Separated from failure because a cancelled stage is not evidence of anything.
 * It is also not one thing: a traveller pressing stop, a process dying with the
 * deploy that killed it, and a newer job for the same trip superseding this one
 * are three different operational stories, and an operator looking at a run of
 * cancellations needs to know which.
 */
export const CANCELLATION_CATEGORIES = [
  'traveller_requested',
  'process_abandoned',
  'superseded_by_newer_job',
] as const;
export const cancellationCategorySchema = z.enum(CANCELLATION_CATEGORIES);
export type CancellationCategory = z.infer<typeof cancellationCategorySchema>;

/**
 * Why a stage failed, coarsely.
 *
 * Coarse on purpose. Seventeen error codes are the right vocabulary for telling
 * one traveller what happened and the wrong one for asking "is this destination
 * slow, or was our provider slow?" — five categories answer that, and the exact
 * code stays on the job row where the traveller's sentence comes from.
 */
export const FAILURE_CATEGORIES = [
  /** Somebody else's server. Not ours, not the destination's. */
  'provider',
  /** We stopped ourselves: lookups, pages or model calls ran out. */
  'budget',
  /** What came back was unusable, unsourced or unsafe to read. */
  'data',
  /** There is not enough published about this ground to plan on. */
  'coverage',
  /** Ours. */
  'internal',
] as const;
export const failureCategorySchema = z.enum(FAILURE_CATEGORIES);
export type FailureCategory = z.infer<typeof failureCategorySchema>;

export function failureCategoryFor(code: CompilationErrorCode): FailureCategory {
  switch (code) {
    case 'provider_unavailable':
    case 'provider_rate_limited':
    case 'provider_credentials_missing':
    case 'route_matrix_incomplete':
      return 'provider';
    case 'budget_exhausted':
      return 'budget';
    case 'ai_output_malformed':
    case 'ai_fact_missing_citation':
    case 'malicious_source_rejected':
      return 'data';
    case 'coverage_insufficient':
    case 'destination_unresolved':
    case 'destination_ambiguous':
    case 'scope_too_broad_for_duration':
    case 'no_plausible_base':
      return 'coverage';
    default:
      return 'internal';
  }
}

/**
 * Version 2.
 *
 * Version 1 carried a stage, an outcome, a duration and two bucket keys, which
 * is enough to compute a median and not enough to explain one. An observation
 * that cannot say which job it came from, which artifact that job produced, or
 * whether the run was degraded is a number without a provenance — and this
 * codebase's whole posture is that a number without a provenance does not get
 * rendered.
 *
 * Rows written under version 1 are **dropped on read**, not coerced. A version 1
 * row has no `degraded` flag, so coercing it would mean guessing `false` and
 * silently mixing a provider outage into the healthy bucket, which is the exact
 * contamination the bucket exists to prevent.
 */
export const STAGE_OBSERVATION_VERSION = 2 as const;

export const stageObservationSchema = z.object({
  schemaVersion: z.literal(STAGE_OBSERVATION_VERSION),

  // ---- provenance: which run, and what it produced -----------------------
  /** The compilation job. Every observation from one build shares it. */
  jobId: z.string().min(1).max(200),
  /**
   * The semantic artifact this run ended with, when it ended with one.
   *
   * Absent while the build is still running and absent forever if it failed.
   * Present here and *not* on the artifact: the artifact does not know how long
   * it took to make, and this is the join that lets somebody ask anyway.
   */
  compiledRegionId: z.string().min(1).max(200).optional(),
  stage: compilationStageSchema,
  /** Denormalised from the registry so a historical row survives a re-phasing. */
  phase: compilationPhaseSchema,
  outcome: stageOutcomeSchema,

  // ---- the clocks --------------------------------------------------------
  startedAt: z.string().min(1),
  completedAt: z.string().min(1),
  /**
   * Wall-clock milliseconds, measured, persisted.
   *
   * Bounded on both sides: `nonnegative()` alone admits `Infinity`, which
   * survives `JSON.stringify` as `null` and fails to parse on the way back out —
   * a corruption that only appears on read.
   */
  durationMs: z.number().min(0).max(3_600_000),
  /**
   * The same span on a monotonic clock, where the runtime offers one.
   *
   * `performance.now()` does not jump when NTP corrects the system clock or when
   * a container is resumed on a different host, and a wall-clock span that
   * crosses one of those events is not a duration — it is the correction. When
   * both are present and they disagree materially, the monotonic figure is the
   * measurement and the wall figure is the record of when it happened.
   *
   * Optional because not every caller has one, and an absent monotonic reading
   * must read as "we only had a wall clock" rather than as zero.
   */
  monotonicMs: z.number().min(0).max(3_600_000).optional(),

  // ---- the buckets -------------------------------------------------------
  /** How much ground the build covered. Indexed in SQL; kept for the coarse prefilter. */
  breadth: scopeBreadthSchema,
  /** The comparison bucket. Coarser than breadth, and the one the estimator uses. */
  shape: destinationShapeSchema,
  warmth: warmthSchema,
  /**
   * Whether this run was already going wrong when this stage ran.
   *
   * A build that hit a rate limit, lost a provider or exhausted its budget takes
   * a completely different amount of time from a healthy one — usually less,
   * because it stopped doing things. Learning "the verifying phase takes ninety
   * seconds" from six runs that all gave up early is how an estimator becomes
   * confidently wrong, so degraded runs are their own bucket and never mix.
   */
  degraded: z.boolean(),

  // ---- what the stage did ------------------------------------------------
  /** External calls this stage made. Explains an outlier without guessing. */
  providerCalls: z.number().int().min(0).max(100_000).default(0),
  /** Calls this stage did not have to make. The other half of `warmth`, per stage. */
  cacheHits: z.number().int().min(0).max(100_000).default(0),
  retries: z.number().int().min(0).max(10_000).default(0),
  /**
   * Items processed, where the stage has a natural unit.
   *
   * Absent for stages that do not — and its absence is why there is no
   * percentage anywhere: a completion bar needs work units, and most of these
   * stages genuinely do not have them.
   */
  workUnits: z.number().int().min(0).max(1_000_000).optional(),

  // ---- how it ended, when it did not end well ----------------------------
  cancellation: cancellationCategorySchema.optional(),
  failure: failureCategorySchema.optional(),

  observedAt: z.string().min(1),
});
export type StageObservation = z.infer<typeof stageObservationSchema>;

/**
 * The key two observations must share before either may inform the other.
 *
 * One string rather than three comparisons, so the repository's prefilter, the
 * estimator's filter and any diagnostic that groups history all use the same
 * definition of "comparable". Three places that each decide comparability for
 * themselves is how a country build ends up in a city's median.
 */
export function observationBucket(input: {
  shape: DestinationShape;
  warmth: Warmth;
  degraded: boolean;
}): string {
  return `${input.shape}|${input.warmth}|${input.degraded ? 'degraded' : 'healthy'}`;
}

// ---------------------------------------------------------------------------
// The estimator
// ---------------------------------------------------------------------------

/**
 * How many comparable *runs* before a range may be shown.
 *
 * Five, and runs rather than observations. The version this replaces counted
 * observations, which meant five stages of a single build cleared the bar — one
 * run wearing a statistic's clothes, and a range derived from it would be
 * narrower than the truth in exactly the cases where it matters, a provider
 * having a bad afternoon.
 */
export const MIN_OBSERVATIONS_FOR_ESTIMATE = 5;

/**
 * How many samples of one stage before that stage's median counts as known.
 *
 * Two. A single observation is not a distribution, and a 25th and 75th
 * percentile computed from one number are both that number — a band of zero
 * width, which reads as certainty.
 */
export const MIN_SAMPLES_PER_STAGE = 2;

/**
 * A range, and what it is made of.
 *
 * The sample size travels with the number, because "roughly two to five minutes,
 * from six similar builds" is a claim somebody can weigh and "roughly two to
 * five minutes" is not.
 */
export const remainingEstimateSchema = z.object({
  lowSeconds: z.number().min(0).max(86_400),
  highSeconds: z.number().min(0).max(86_400),
  /** Observations behind it. Rendered. */
  samples: z.number().int().positive(),
  /** Distinct builds behind it. Rendered, because it is the number that matters. */
  runs: z.number().int().positive(),
  /** The bucket. Rendered, so an odd number can be explained rather than doubted. */
  shape: destinationShapeSchema,
  warmth: warmthSchema,
  degraded: z.boolean(),
});
export type RemainingEstimate = z.infer<typeof remainingEstimateSchema>;

export interface EstimateInput {
  /** Stages this build has still to run. */
  remainingStages: readonly CompilationStage[];
  /** History. Filtering to the comparable bucket happens here, not at the caller. */
  observations: readonly StageObservation[];
  shape: DestinationShape;
  warmth: Warmth;
  degraded: boolean;
}

/**
 * A remaining-time range, or nothing.
 *
 * Nothing is the common answer and is the correct one. Every refusal below is a
 * specific lie this function is not going to tell:
 *
 * | Refusal | The lie it prevents |
 * | --- | --- |
 * | nothing left to run | "0s–0s to go" on a finished build |
 * | fewer than five comparable *runs* | a median that is really one build |
 * | history from another bucket | a city's median offered for a country |
 * | fewer than two samples for a stage | a zero-width band that reads as certainty |
 * | fewer than half the remaining stages covered | a confident answer to a different question |
 * | a range that rounds to zero seconds | "roughly 0s–0s to go", verbatim, again |
 * | anything non-finite or negative | a duration that cannot exist |
 *
 * The estimator itself is a per-stage median summed across the remaining stages,
 * with the band from the 25th and 75th percentiles. Median rather than mean
 * because one provider timeout would otherwise dominate; an interquartile band
 * rather than min–max because the extremes of a small sample are noise. A
 * *count* of remaining stages multiplied by a global median — which is what this
 * replaced — treats `partitioning_scope`, which is arithmetic, as the same kind
 * of thing as `retrieving_pages`, which fetches ninety pages over somebody
 * else's network.
 *
 * Failed, cancelled and skipped observations are excluded: a stage that failed
 * after two seconds is not evidence that the stage takes two seconds.
 */
export function estimateRemainingFrom(input: EstimateInput): RemainingEstimate | null {
  if (input.remainingStages.length === 0) return null;

  const wanted = observationBucket(input);
  const usable = input.observations.filter(
    (observation) => observation.outcome === 'done' && observationBucket(observation) === wanted,
  );
  if (usable.length === 0) return null;

  /*
   * Runs, not rows.
   *
   * Twenty observations from one build is one build's worth of evidence about
   * how long a build takes, and counting rows made it look like twenty.
   */
  const runs = new Set(usable.map((observation) => observation.jobId)).size;
  if (runs < MIN_OBSERVATIONS_FOR_ESTIMATE) return null;

  const byStage = new Map<string, number[]>();
  for (const observation of usable) {
    /*
     * The monotonic figure when there is one.
     *
     * A wall-clock span that straddles an NTP correction is the correction, not
     * the work, and one of those in a small sample moves the median.
     */
    const duration = observation.monotonicMs ?? observation.durationMs;
    if (!Number.isFinite(duration) || duration < 0) continue;
    const bucket = byStage.get(observation.stage);
    if (bucket) bucket.push(duration);
    else byStage.set(observation.stage, [duration]);
  }

  let low = 0;
  let high = 0;
  let covered = 0;
  for (const stage of input.remainingStages) {
    const durations = byStage.get(stage);
    if (!durations || durations.length < MIN_SAMPLES_PER_STAGE) continue;
    covered += 1;
    const sorted = [...durations].sort((a, b) => a - b);
    low += percentile(sorted, 0.25);
    high += percentile(sorted, 0.75);
  }

  /*
   * Most of what is left has to be something we have seen before.
   *
   * Without this, a build whose remaining stages are all novel produces a range
   * from the two stages we happen to have history for — which is not an
   * underestimate, it is a different question answered confidently.
   */
  if (covered === 0 || covered * 2 < input.remainingStages.length) return null;

  const lowSeconds = Math.round(low / 1000);
  const highSeconds = Math.round(Math.max(high, low) / 1000);

  if (!Number.isFinite(lowSeconds) || !Number.isFinite(highSeconds)) return null;
  if (lowSeconds < 0 || highSeconds < 0) return null;
  /*
   * "roughly 0s–0s to go" is the sentence this whole file exists because of.
   *
   * It is reachable again without this line — not from a fabricated clock this
   * time, but from a bucket of genuinely sub-500ms stages. A range that rounds
   * to nothing is not an estimate; it is a claim that the build is finished,
   * made while it is running.
   */
  if (highSeconds === 0) return null;

  return {
    lowSeconds,
    highSeconds,
    samples: usable.length,
    runs,
    shape: input.shape,
    warmth: input.warmth,
    degraded: input.degraded,
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * fraction)));
  return sorted[index] ?? 0;
}
