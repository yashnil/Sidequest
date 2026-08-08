import {
  TIMING_BOUNDARY_DEFINITIONS,
  measured,
  unavailable,
  type MetricUnavailableReason,
  type RunMetrics,
} from '@sidequest/bench';

/**
 * THE CLOCK, AND WHY A BOUNDARY NOBODY REACHED IS NEVER ZERO.
 *
 * Two properties, and both are about not lying with a number.
 *
 * **The clock is monotonic and it is taken at the adapter boundary.** `t0` is
 * the instant the normalised request is handed over, before any work, exactly as
 * `TIMING_BOUNDARY_DEFINITIONS` words it. Wall-clock time would be adjusted by
 * NTP mid-run and produce a negative latency roughly once a month, which reads
 * as an instrument fault in a results table and is one.
 *
 * **A boundary the run never reached is an explicit absence with a reason.** Not
 * zero, not null, not a missing key. A run that failed before it had questions
 * did not answer them in nought milliseconds, and a dashboard averaging that
 * zero into a mean would report the failing system as the fastest one. The
 * measurement union in `@sidequest/bench` cannot express an absence without a
 * reason, and this module never reaches for `measured(0, …)` to get past it.
 */

export const TIMING_BOUNDARIES = [
  'timeToFirstUsefulResultMs',
  'timeToFollowUpQuestionsMs',
  'timeToFirstItineraryMs',
  'timeToValidatedPlanMs',
] as const;
export type TimingBoundary = (typeof TIMING_BOUNDARIES)[number];

/** Milliseconds since some fixed point in this process. Never a date. */
export type MonotonicClock = () => number;

export function defaultMonotonicClock(): MonotonicClock {
  return () => performance.now();
}

export class RunTimeline {
  private readonly clock: MonotonicClock;
  private readonly t0: number;
  private readonly stamps = new Map<TimingBoundary, number>();
  private endedAt: number | null = null;

  constructor(clock: MonotonicClock = defaultMonotonicClock()) {
    this.clock = clock;
    this.t0 = clock();
  }

  /**
   * Stamp a boundary, once.
   *
   * First-write-wins, because every definition in the shared table says "the
   * first instant". A later stage that re-stamped would quietly convert "when it
   * became available" into "when it was last touched", and the two differ by the
   * whole of the repair.
   */
  mark(boundary: TimingBoundary): void {
    if (this.stamps.has(boundary)) return;
    this.stamps.set(boundary, this.clock() - this.t0);
  }

  /**
   * The arm stops.
   *
   * There is no hand-off-to-human pair here any more, and their absence is the
   * fix rather than an omission. They existed to let one arm subtract the time a
   * person spent answering, and nothing ever called them — the arm runs after
   * the question round has closed, so no span inside it is ever waiting on
   * anybody. Keeping them meant `machineTimeMs` and `totalWallTimeMs` were
   * assigned the same value on both arms while the schema described them as
   * different clocks.
   *
   * The human wait is real and is now measured where it happens: at the session,
   * between the questions being persisted and the reviewer asking for the plans.
   * See `sessionWallTimeMs`, `humanAnswerWaitMs` and `sessionMachineTimeMs`,
   * which the orchestrator writes onto both arms.
   */
  finish(): void {
    if (this.endedAt !== null) return;
    this.endedAt = this.clock() - this.t0;
  }

  elapsedMs(): number {
    return this.clock() - this.t0;
  }

  /**
   * The metric set for this run.
   *
   * Every field is present, and every field that was not measured says which of
   * the closed reasons applies. The reason is chosen from what the run actually
   * did — `run_failed` when it fell over, `not_reached` when it simply never got
   * there — because a dashboard that could not tell those apart would report a
   * system that never validates anything and one that crashed on the way as the
   * same thing.
   */
  toRunMetrics(input: {
    runId: string;
    failed: boolean;
    modelCalls: number;
    repairCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    costMicroUsd: number | null;
    unpricedCalls: number;
    providerCalls: number | null;
    routeCalls: number | null;
    routePairs: number | null;
    weatherCalls: number | null;
    warmth: RunMetrics['warmth'];
    warmthBasis: string;
  }): RunMetrics {
    const boundaryReason: MetricUnavailableReason = input.failed ? 'run_failed' : 'not_reached';
    const boundary = (name: TimingBoundary) => {
      const value = this.stamps.get(name);
      return value === undefined
        ? unavailable(boundaryReason, `${TIMING_BOUNDARY_DEFINITIONS[name]} This run never got there.`)
        : measured(Math.round(value), 'ms');
    };

    const total = this.endedAt;

    return {
      schemaVersion: 1,
      runId: input.runId,
      timeToFirstUsefulResultMs: boundary('timeToFirstUsefulResultMs'),
      timeToFollowUpQuestionsMs: boundary('timeToFollowUpQuestionsMs'),
      timeToFirstItineraryMs: boundary('timeToFirstItineraryMs'),
      timeToValidatedPlanMs: boundary('timeToValidatedPlanMs'),
      /*
       * Filled in by the orchestrator, which is the only layer that knows how long
       * the shared preparation took, how long the person took, or when the
       * comparison as a whole began and ended. Stated here as absences rather
       * than left out, because every field of a metric set is required to be
       * present — a missing key is the shape a reader renders as a blank.
       */
      sharedPreparationMs: unavailable(
        'not_yet_computed',
        'The harness records the world purchase; an arm cannot see it.',
      ),
      /*
       * This arm was handed its world, so what it spent acquiring one is the
       * harness's purchase — a figure only the harness holds. Filled in there.
       */
      worldAcquisitionMs: unavailable(
        'not_yet_computed',
        'The harness bought this arm its world and records what that took.',
      ),
      /*
       * Nothing to subtract: every millisecond on this arm's clock is planning,
       * because the acquisition happened before it started. Recorded explicitly
       * rather than left equal to the total by omission, so the two figures are
       * separately readable and the comparison has one boundary on both sides.
       */
      planningTimeMs:
        total === null
          ? unavailable('instrument_failed', 'The run never reported a terminal state.')
          : measured(Math.round(total), 'ms'),
      totalWallTimeMs:
        total === null
          ? unavailable('instrument_failed', 'The run never reported a terminal state.')
          : measured(Math.round(total), 'ms'),
      sessionWallTimeMs: unavailable('not_yet_computed', SESSION_CLOCK_IS_THE_HARNESSS),
      humanAnswerWaitMs: unavailable('not_yet_computed', SESSION_CLOCK_IS_THE_HARNESSS),
      sessionMachineTimeMs: unavailable('not_yet_computed', SESSION_CLOCK_IS_THE_HARNESSS),

      modelCalls: measured(input.modelCalls, 'calls'),
      inputTokens: countOrAbsence(input.inputTokens, 'tokens', 'No usage was reported for this run.'),
      outputTokens: countOrAbsence(
        input.outputTokens,
        'tokens',
        'No usage was reported for this run.',
      ),
      estimatedCostMicroUsd:
        input.costMicroUsd === null || input.unpricedCalls > 0
          ? unavailable(
              'unpriced_model',
              input.unpricedCalls > 0
                ? `${input.unpricedCalls} call(s) used a model with no row in the checked-in rate table, so no total can be stated.`
                : 'No priced usage was reported for this run.',
            )
          : measured(input.costMicroUsd, 'micro_usd'),
      repairCalls: measured(input.repairCalls, 'calls'),

      providerCalls: countOrAbsence(
        input.providerCalls,
        'calls',
        'Provider calls were not counted on this path.',
      ),
      routeCalls: countOrAbsence(input.routeCalls, 'calls', 'No routing engine was consulted.'),
      routePairs: countOrAbsence(input.routePairs, 'pairs', 'No routing engine was consulted.'),
      weatherCalls: countOrAbsence(
        input.weatherCalls,
        'calls',
        'No weather provider was consulted.',
      ),
      /*
       * Not a deficiency — a difference, and the metric vocabulary has a word
       * for it. This arm holds no evidence cache of its own, so reporting a nil
       * hit rate would read as a cache that never works rather than as a system
       * that does not have one.
       */
      cacheHits: unavailable(
        'not_applicable_to_system',
        'This arm keeps no evidence cache, so there is nothing to hit or miss.',
      ),
      cacheMisses: unavailable(
        'not_applicable_to_system',
        'This arm keeps no evidence cache, so there is nothing to hit or miss.',
      ),
      retries: measured(0, 'attempts'),
      databaseGrowthBytes: unavailable(
        'not_yet_computed',
        'Database growth is measured by the harness around the run, not inside it.',
      ),
      warmth: input.warmth,
      warmthBasis: input.warmthBasis,
    };
  }
}

const SESSION_CLOCK_IS_THE_HARNESSS =
  'The session clock belongs to the harness, which is the only layer that sees both arms and the person between them.';

function countOrAbsence(
  value: number | null,
  unit: string,
  detail: string,
): ReturnType<typeof measured> | ReturnType<typeof unavailable> {
  return value === null ? unavailable('instrument_failed', detail) : measured(value, unit);
}
