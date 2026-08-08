import 'server-only';
import {
  METRIC_UNITS,
  TIMING_BOUNDARY_DEFINITIONS,
  measured,
  unavailable,
  type Measurement,
  type MetricKey,
  type RunMetrics,
} from '@sidequest/bench';
import { getLatestJob, getOperationalDiagnostics } from '../../db/compiler-repository';
import { latestBoardIdentity } from '../../db/provisional-repository';
import { runBucket } from '../../db/timing-repository';

/**
 * WATCHING A RUN WITHOUT TOUCHING IT.
 *
 * Every boundary below is read from something the pipeline already persists —
 * a clarification set, a provisional board id, a job state, an itinerary row.
 * Nothing here is a hook, a callback or a counter added for the benchmark's
 * benefit, and that is the property that makes the measurement worth having: an
 * instrument welded into the thing it measures is measuring the weld.
 *
 * The wording each stamp is held to is `TIMING_BOUNDARY_DEFINITIONS`, quoted
 * rather than paraphrased, because the single largest way this benchmark could
 * produce a wrong answer is by letting each system define its own start line.
 *
 * ---
 *
 * A BOUNDARY THAT WAS NOT REACHED IS NEVER ZERO.
 *
 * This is the rule the whole file is arranged around, and the failure it
 * prevents has already happened elsewhere in this repository: a usage record
 * whose writer coalesced a missing token count to `0`, after which "we did not
 * measure this" and "this cost nothing" are the same row for ever. So every
 * absence carries a reason, and the two absences that look alike are kept apart:
 *
 *   - `not_reached` / `run_failed` — the run stopped before this could happen.
 *   - `not_applicable_to_system` — this pipeline has no such concept. Not a
 *     deficiency and not a zero: a deterministic scheduler has no model output
 *     to repair, and reporting a repair rate of nought would read as a triumph
 *     rather than as an architectural difference.
 */

/** Monotonic, so an NTP correction mid-run cannot produce a negative duration. */
const clock = (): number => performance.now();

export interface MilestoneStamps {
  /** The instant the normalised shared request was handed to the adapter. */
  t0: number;
  /** A question set is persisted and answerable. */
  questionsAt: number | null;
  /** The first provisional board id the compilation published. */
  provisionalBoardAt: number | null;
  /** The compiled region reached `ready` or `partial`. */
  compiledRegionAt: number | null;
  /** A day-by-day plan is persisted. */
  itineraryAt: number | null;
  /** The run reached its terminal state, whatever that state was. */
  terminalAt: number | null;
}

export class MilestoneRecorder {
  private readonly stamps: MilestoneStamps;

  constructor(now: number = clock()) {
    this.stamps = {
      t0: now,
      questionsAt: null,
      provisionalBoardAt: null,
      compiledRegionAt: null,
      itineraryAt: null,
      terminalAt: null,
    };
  }

  /**
   * First writer wins.
   *
   * "Time to first X" is a claim about the first one, and a later stamp
   * overwriting an earlier one would quietly turn every boundary into a
   * time-to-last.
   */
  mark(name: Exclude<keyof MilestoneStamps, 't0'>, at: number = clock()): void {
    if (this.stamps[name] === null) this.stamps[name] = at;
  }

  snapshot(): MilestoneStamps {
    return { ...this.stamps };
  }
}

/**
 * Poll the compilation while it runs, and stop when told.
 *
 * A poller rather than a callback because the compiler offers no seam a
 * benchmark may attach to, and adding one would be instrumentation. The board
 * arrives partway through a compilation the caller is awaiting, so the only way
 * to see the moment it lands is to look — which is exactly what the progress
 * screen does, at a comparable interval.
 *
 * The two reads below are the same two `compilationSnapshotAction` makes for
 * these fields, taken directly rather than through the action. That is not a
 * shortcut past the product: the action's other work — the remaining-time
 * estimate, the stage list, the reuse summary — exists to paint a screen, and
 * running it two hundred times to read a job state would have the instrument
 * competing with the thing it measures for the same synchronous driver.
 *
 * Errors are swallowed on purpose: a poll that failed has cost the run nothing,
 * and a benchmark that aborted a compilation because its own instrument tripped
 * would be reporting on itself.
 */
export function watchCompilation(
  tripId: string,
  recorder: MilestoneRecorder,
  intervalMs = 250,
): () => void {
  const timer = setInterval(() => {
    try {
      /*
       * The board's *identity*, not the board. `getProvisionalBoard` parses a
       * forty-card document through Zod on every call, and this runs four times
       * a second beside a compilation that owns the same synchronous driver.
       * The id is what "a board exists" means, and it is one indexed row.
       */
      if (latestBoardIdentity(tripId).known) recorder.mark('provisionalBoardAt');
      const job = getLatestJob(tripId);
      if (job?.state === 'ready' || job?.state === 'partial') recorder.mark('compiledRegionAt');
    } catch {
      // See above: an instrument that can stop a run is worse than a gap.
    }
  }, intervalMs);
  // Never hold the process open for an instrument.
  timer.unref?.();
  return () => clearInterval(timer);
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

export interface MetricsInput {
  runId: string;
  stamps: MilestoneStamps;
  /** The compilation this run produced, when it produced one. */
  jobId: string | null;
  /** Whether the run ended with a plan, partially, or not at all. */
  outcome: 'complete' | 'partial' | 'failed';
}

export function toRunMetrics(input: MetricsInput): RunMetrics {
  const { stamps, jobId, outcome } = input;
  const failed = outcome === 'failed';

  const since = (
    at: number | null,
    boundary: keyof typeof TIMING_BOUNDARY_DEFINITIONS,
  ): Measurement =>
    at === null
      ? unavailable(
          failed ? 'run_failed' : 'not_reached',
          `Never reached: ${TIMING_BOUNDARY_DEFINITIONS[boundary]}`,
        )
      : measured(Math.round(at - stamps.t0), 'ms');

  /*
   * "At least one candidate place, or at least one concrete question", and for
   * this pipeline the question almost always comes first — the clarification set
   * is derived before anything is compiled. Taking the earlier of the two rather
   * than fixing on one is what keeps the definition, rather than this system's
   * ordering, in charge.
   */
  const firstUseful = earliest(stamps.questionsAt, stamps.provisionalBoardAt);

  const counters = jobId ? getOperationalDiagnostics(jobId) : null;
  /*
   * THE UNIT IS THE METRIC'S, NOT THE COUNTER'S.
   *
   * Every one of these used to be labelled `count`, while the other arm labelled
   * the same quantities `calls`, `tokens`, `pairs` and `micro_usd`. The values
   * were right and directly comparable; the labels were not, and the two arms'
   * rows sit next to each other in one table where a reader will take the label
   * at its word — `estimatedCostMicroUsd` reading `count` is one careless glance
   * away from a figure quoted a million times too small.
   *
   * The unit now comes from `METRIC_UNITS`, which both arms and the writer
   * consult, so the label cannot drift from the meaning without a test failing.
   */
  const counter = (
    key: MetricKey,
    sourceKeys: readonly string[],
    absent: Measurement,
  ): Measurement => {
    if (!counters) return absent;
    const present = sourceKeys.filter((source) => typeof counters[source] === 'number');
    if (present.length === 0) return absent;
    return measured(
      present.reduce((total, source) => total + (counters[source] ?? 0), 0),
      METRIC_UNITS[key],
    );
  };

  /*
   * A counter the fixture stack never fills.
   *
   * The deterministic provider set answers from a synthetic world and reports no
   * call counts at all, which is genuinely "a provider that would have produced
   * the figure was switched off" rather than a run that made no calls.
   */
  const noProviderCounters = unavailable(
    'provider_disabled',
    'No provider call counter was recorded for this compilation.',
  );

  const totalWall = stamps.terminalAt === null ? null : Math.round(stamps.terminalAt - stamps.t0);

  return {
    schemaVersion: 1,
    runId: input.runId,

    timeToFirstUsefulResultMs: since(firstUseful, 'timeToFirstUsefulResultMs'),
    timeToFollowUpQuestionsMs: since(stamps.questionsAt, 'timeToFollowUpQuestionsMs'),
    timeToFirstItineraryMs: since(stamps.itineraryAt, 'timeToFirstItineraryMs'),
    /*
     * The shared validators run after this adapter has returned, against the
     * neutral plan, and are not this arm's to time. `not_yet_computed` says that
     * without claiming the boundary is unreachable.
     */
    timeToValidatedPlanMs: unavailable(
      'not_yet_computed',
      'The shared neutral validators run outside the adapter, after the plan is stored.',
    ),
    /*
     * Filled in by the orchestrator, which is the only layer that knows how long
     * the shared preparation took, how long the person took, or when the
     * comparison as a whole began and ended. Stated here as absences rather than
     * left out, because every field of a metric set is required to be present —
     * a missing key is the shape a reader renders as a blank.
     */
    sharedPreparationMs: unavailable(
      'not_yet_computed',
      'The harness records the world purchase; an arm cannot see it.',
    ),
    /*
     * WHAT THIS ARM SPENT BUYING ITS OWN WORLD.
     *
     * The compilation is this pipeline's equivalent of the purchase the harness
     * makes for the other arm: places, routes, hours, forecast, for its own
     * region and its own resolution. It sits inside this arm's total, while the
     * other arm's equivalent sits outside its own — so comparing the two totals
     * compares one planner against another planner *plus a world*, and a
     * pre-registered five-times threshold is satisfied by the accounting boundary
     * before either planner has done anything.
     *
     * `compiledRegionAt` is already stamped, from a job state the pipeline
     * persists. Nothing new is instrumented to get this.
     */
    worldAcquisitionMs: since(stamps.compiledRegionAt, 'worldAcquisitionMs'),
    planningTimeMs:
      totalWall === null || stamps.compiledRegionAt === null
        ? unavailable(
            failed ? 'run_failed' : 'not_reached',
            'This run did not both compile a region and reach a terminal state, so the two cannot be subtracted.',
          )
        : measured(Math.max(0, totalWall - Math.round(stamps.compiledRegionAt - stamps.t0)), 'ms'),
    totalWallTimeMs:
      totalWall === null
        ? unavailable('run_failed', 'The run did not reach a terminal state.')
        : measured(totalWall, 'ms'),
    sessionWallTimeMs: unavailable('not_yet_computed', SESSION_CLOCK_IS_THE_HARNESSS),
    humanAnswerWaitMs: unavailable('not_yet_computed', SESSION_CLOCK_IS_THE_HARNESSS),
    sessionMachineTimeMs: unavailable('not_yet_computed', SESSION_CLOCK_IS_THE_HARNESSS),

    modelCalls: counter('modelCalls', ['modelCalls'], noProviderCounters),
    inputTokens: counter('inputTokens', ['modelInputTokens'], noProviderCounters),
    outputTokens: counter('outputTokens', ['modelOutputTokens'], noProviderCounters),
    estimatedCostMicroUsd: counter(
      'estimatedCostMicroUsd',
      ['modelCostMicroUsd'],
      noProviderCounters,
    ),
    /*
     * There is no model output to repair. The scheduler's revision passes are a
     * different thing entirely — they move stops between days against measured
     * constraints — and they are recorded on the plan's own diagnostics, where
     * they mean something.
     */
    repairCalls: unavailable(
      'not_applicable_to_system',
      'Nothing in this run produces model output that could fail a schema and be asked again.',
    ),

    providerCalls: counter(
      'providerCalls',
      ['geocoderCalls', 'poiCalls', 'routeCalls', 'pagesFetched', 'wikidataCalls', 'sourceSearches'],
      noProviderCounters,
    ),
    routeCalls: counter('routeCalls', ['routeCalls'], noProviderCounters),
    routePairs: counter('routePairs', ['routePairs'], noProviderCounters),
    /*
     * The forecast is bought on the way into planning and no counter records it.
     * Not "zero calls": the run almost certainly made one.
     */
    weatherCalls: unavailable(
      'not_yet_computed',
      'The forecast fetch is not counted by any operational counter this pipeline persists.',
    ),
    cacheHits: counter(
      'cacheHits',
      [
        'geocoderCacheHits',
        'poiCacheHits',
        'routeCacheHits',
        'evidenceDocumentsReused',
        'evidenceExtractionsReused',
      ],
      noProviderCounters,
    ),
    cacheMisses: counter(
      'cacheMisses',
      ['evidenceDiscoveryMisses', 'evidenceDocumentsFetched'],
      noProviderCounters,
    ),
    /*
     * Retries are counted per stage, on the observation rows, and nothing
     * aggregates them for a job. Reading the rows back would be a second,
     * benchmark-only summary of somebody else's data.
     */
    retries: unavailable(
      'not_yet_computed',
      'Retries are recorded per stage and nothing aggregates them for a run.',
    ),

    databaseGrowthBytes: unavailable(
      'not_yet_computed',
      'Nothing measures the store before and after a run.',
    ),

    /*
     * Observed by the run rather than inferred from the counters.
     *
     * `runBucket` reads the classification the compilation made of itself at the
     * moment it started, which is the only honest one: warmth is a property of
     * what the shared store already held, not of what the counters read halfway
     * through. A fixture build records no observation at all and is `unknown`,
     * which is right — a synthetic world is neither cold nor warm.
     *
     * The basis travels with the verdict because the two absences are different
     * facts and used to print the same word: a compilation that never ran and a
     * compilation whose observation row is missing are both `unknown`, and a
     * reader splitting latency on warmth needs to know which of those they are
     * throwing away.
     */
    ...observedWarmth(jobId),
  };
}

/** The warmth verdict and the sentence saying what it was read off. */
function observedWarmth(jobId: string | null): Pick<RunMetrics, 'warmth' | 'warmthBasis'> {
  if (jobId === null) {
    return {
      warmth: 'unknown',
      warmthBasis: 'This run produced no compilation, so nothing classified the state of the store.',
    };
  }
  const bucket = runBucket(jobId);
  if (!bucket) {
    return {
      warmth: 'unknown',
      warmthBasis:
        'The compilation recorded no stage observation, which is what a synthetic world produces: neither cold nor warm.',
    };
  }
  return {
    warmth: bucket.warmth,
    warmthBasis:
      'Read from the classification the compilation made of the shared store at the moment it started.',
  };
}

const SESSION_CLOCK_IS_THE_HARNESSS =
  'The session clock belongs to the harness, which is the only layer that sees both arms and the person between them.';

function earliest(...values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0 ? null : Math.min(...present);
}
