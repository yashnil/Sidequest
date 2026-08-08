import { z } from 'zod';

/**
 * OPERATIONAL METRICS — KEPT AWAY FROM THE PLAN, AND FROM ZERO.
 *
 * Two separations are doing the work here.
 *
 * **Metrics are not part of the plan.** A semantic artifact that carries its own
 * clock cannot be compared byte for byte between two runs of the same inputs,
 * and — more importantly for a blind benchmark — a renderer that receives a
 * plan carrying a latency has already leaked which system produced it. So the
 * timings live here, in a structure the pre-reveal UI never receives.
 *
 * **An unavailable measurement is never a number.** This is the rule that the
 * rest of the file exists to make unbreakable. The failure it prevents is
 * specific and has already happened elsewhere in this repository: a usage record
 * whose writer coalesced a missing token count to `0`, after which "we did not
 * measure this" and "this cost nothing" are the same row and nobody can tell
 * them apart afterwards. A benchmark built on that reports a system with no
 * evidence cache as having a 0% cache hit rate, which reads as a deficiency
 * rather than as an architectural difference.
 *
 * The discriminated union below cannot express a measured value without a
 * number, or an absence without a reason.
 */

export const METRIC_UNAVAILABLE_REASONS = [
  /** The run never reached the point where this could be measured. */
  'not_reached',
  /** The run failed before this boundary. */
  'run_failed',
  /** This system has no such concept — not a deficiency, a difference. */
  'not_applicable_to_system',
  /** A provider that would have produced the figure was switched off. */
  'provider_disabled',
  /** A model was used whose price is not in the checked-in rate table. */
  'unpriced_model',
  /** Measured, but the instrument itself failed. */
  'instrument_failed',
  /** Deliberately not computed yet. */
  'not_yet_computed',
] as const;
export const metricUnavailableReasonSchema = z.enum(METRIC_UNAVAILABLE_REASONS);
export type MetricUnavailableReason = z.infer<typeof metricUnavailableReasonSchema>;

/**
 * A finite number, stated as a bounded range rather than as `.nonnegative()`.
 *
 * Zod rejects `NaN` but accepts `Infinity`; `JSON.stringify(Infinity)` is
 * `null`; and the row then fails to parse on read, which surfaces the corruption
 * a long way from where it was written. Bounds make the infinity unrepresentable
 * at the point it is created.
 */
const finite = (min: number, max: number) =>
  z
    .number()
    .min(min)
    .max(max)
    .refine((value) => Number.isFinite(value), 'Not a finite number');

export const measurementSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('measured'),
    value: finite(-1e12, 1e12),
    unit: z.string().min(1),
  }),
  z.object({
    state: z.literal('unavailable'),
    reason: metricUnavailableReasonSchema,
    /** One readable sentence. Never empty — an unexplained absence is a defect. */
    detail: z.string().min(1).max(300),
  }),
]);
export type Measurement = z.infer<typeof measurementSchema>;

/** Throws on a non-finite value, so a bad measurement cannot be created at all. */
export function measured(value: number, unit: string): Measurement {
  if (!Number.isFinite(value)) {
    throw new Error(`Refusing to record a non-finite measurement in ${unit}.`);
  }
  return { state: 'measured', value, unit };
}

export function unavailable(
  reason: MetricUnavailableReason,
  detail: string,
): Measurement {
  if (detail.trim().length === 0) {
    throw new Error('An unavailable measurement must say why.');
  }
  return { state: 'unavailable', reason, detail };
}

export function isMeasured(
  measurement: Measurement,
): measurement is Extract<Measurement, { state: 'measured' }> {
  return measurement.state === 'measured';
}

/**
 * The value, or `null` — and callers must handle the null.
 *
 * Deliberately not `valueOr(fallback)`: a default is precisely the mechanism
 * this module exists to prevent, and offering one as a convenience is how it
 * comes back.
 */
export function valueOf(measurement: Measurement): number | null {
  return isMeasured(measurement) ? measurement.value : null;
}

/* ------------------------------------------------------------------ *
 * The metric set
 * ------------------------------------------------------------------ */

/**
 * THE UNIT EVERY METRIC IS REQUIRED TO CARRY.
 *
 * One table, consulted by both arms and by the writer, because the alternative
 * has already happened here: the same figure reached the store labelled
 * `micro_usd` from one arm and `count` from the other, and the token and call
 * counts slipped the same way. The *values* were right and comparable; the
 * labels were not, and a unit column nobody trusts is exactly how a later reader
 * mis-scales a figure by a million.
 *
 * A label is not a comment. It is the only thing telling a reader what the
 * number means once the code that produced it has been rewritten, so it is
 * validated at construction, again at the schema, and again on the way into the
 * database — where a mismatch becomes an explicit `instrument_failed` absence
 * rather than a plausible-looking row.
 */
export const METRIC_UNITS = {
  timeToFirstUsefulResultMs: 'ms',
  timeToFollowUpQuestionsMs: 'ms',
  timeToFirstItineraryMs: 'ms',
  timeToValidatedPlanMs: 'ms',
  sharedPreparationMs: 'ms',
  worldAcquisitionMs: 'ms',
  planningTimeMs: 'ms',
  totalWallTimeMs: 'ms',
  sessionWallTimeMs: 'ms',
  humanAnswerWaitMs: 'ms',
  sessionMachineTimeMs: 'ms',
  modelCalls: 'calls',
  inputTokens: 'tokens',
  outputTokens: 'tokens',
  estimatedCostMicroUsd: 'micro_usd',
  repairCalls: 'calls',
  providerCalls: 'calls',
  routeCalls: 'calls',
  routePairs: 'pairs',
  weatherCalls: 'calls',
  cacheHits: 'events',
  cacheMisses: 'events',
  retries: 'attempts',
  databaseGrowthBytes: 'bytes',
} as const satisfies Record<string, string>;

export type MetricKey = keyof typeof METRIC_UNITS;

export const METRIC_KEYS = Object.keys(METRIC_UNITS) as MetricKey[];

export function canonicalUnitFor(key: string): string | null {
  return Object.prototype.hasOwnProperty.call(METRIC_UNITS, key)
    ? METRIC_UNITS[key as MetricKey]
    : null;
}

/**
 * Whether a measurement is labelled the way its key requires.
 *
 * Returns a verdict rather than throwing, because the writer's job on a
 * mis-labelled value is to record the fault, not to lose the other twenty
 * metrics beside it.
 */
export function unitIsCanonical(key: string, measurement: Measurement): boolean {
  if (measurement.state !== 'measured') return true;
  const expected = canonicalUnitFor(key);
  return expected === null || measurement.unit === expected;
}

const withUnit = (key: MetricKey) =>
  measurementSchema.refine(
    (measurement) => unitIsCanonical(key, measurement),
    `A ${key} measurement must be labelled "${METRIC_UNITS[key]}".`,
  );

/**
 * Every field is required to be *present*, and each is a `Measurement`, so a
 * metric nobody computed is an explicit `unavailable` with a reason rather than
 * a missing key that a reader would render as a blank or a zero.
 *
 * The boundaries are defined by persisted artifacts rather than by internal
 * events, so that neither system is advantaged by a definitional quirk. See
 * `TIMING_BOUNDARY_DEFINITIONS` for the exact wording each is measured against.
 */
export const runMetricsSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),

  /* Latency. Monotonic, single-process, taken at the adapter boundary. */
  timeToFirstUsefulResultMs: withUnit('timeToFirstUsefulResultMs'),
  timeToFollowUpQuestionsMs: withUnit('timeToFollowUpQuestionsMs'),
  timeToFirstItineraryMs: withUnit('timeToFirstItineraryMs'),
  timeToValidatedPlanMs: withUnit('timeToValidatedPlanMs'),
  /**
   * THE WORLD THE HARNESS BOUGHT — AND WHICH ARM ACTUALLY GOT IT.
   *
   * Before either planner starts, the harness buys an open place inventory, a
   * bounded route matrix, the hours it can read, the forecast and the daylight.
   * That purchase does two things: it is the fast planner's entire world, and it
   * is the only source the shared checker is built from. It is *not* the
   * deterministic arm's world — that arm compiles its own region, from its own
   * resolution, inside its own clock.
   *
   * The field's first note said "the world both arms were given… recorded
   * identically on both arms. A reader comparing totals adds it to whichever
   * figure excludes it." The first sentence was wrong and the instruction that
   * followed from it was worse: adding this to *both* totals double-counts
   * acquisition for the arm that already paid its own, which moves a
   * pre-registered five-times threshold across its boundary on arithmetic alone.
   *
   * So it is still recorded identically on both arms — it is a property of the
   * comparison, like the session clock — and it is now named as what it is. The
   * figure to compare planners on is `planningTimeMs`, which subtracts each arm's
   * own acquisition from its own total.
   */
  sharedPreparationMs: withUnit('sharedPreparationMs'),
  /**
   * What *this* arm spent acquiring the world it planned against.
   *
   * The harness's purchase for the arm that was handed it; the arm's own
   * compilation for the arm that builds its own. One boundary, reported by both,
   * so the thing being subtracted is the same kind of thing on each side.
   */
  worldAcquisitionMs: withUnit('worldAcquisitionMs'),
  /**
   * This arm's total, less what it spent acquiring a world.
   *
   * The figure a latency comparison between the two planners should use, and the
   * one the pre-registered rules are read against. Without it, one arm's total is
   * model time and the other's is mostly provider traffic that the first arm's
   * clock never saw — a five-times ratio produced by an accounting boundary
   * before either planner had done anything.
   */
  planningTimeMs: withUnit('planningTimeMs'),
  /**
   * ONE ARM'S OWN OPERATION TIME. NOT WHAT ANYBODY WAITED.
   *
   * From the instant this arm was handed the request to the instant it stopped.
   * It excludes the shared preparation, it excludes the other arm, and it
   * excludes every second the harness spent waiting for a person — so it is a
   * property of the planner and is the right figure to compare between the two.
   *
   * It is emphatically *not* the figure to quote as "how long this takes". The
   * three session-level fields below are, and they are recorded separately
   * precisely so that nobody has to add these two together and hope.
   */
  totalWallTimeMs: withUnit('totalWallTimeMs'),

  /* ---------------------------------------------------------------- *
   * The session clock: what a person actually sat through.
   *
   * Recorded identically on both arms, because they describe the comparison
   * rather than either planner. Kept apart from the per-arm figures above for a
   * reason that had already produced a wrong number here: `machineTimeMs` and
   * `totalWallTimeMs` were assigned the same value on both arms, so the field
   * that was supposed to separate machine time from human time separated
   * nothing, the hand-off helpers were never called, and the ordering check
   * could never fire. The distinction is now drawn where it actually exists —
   * at the question round, which is the only place this harness waits for a
   * person — and the three figures below cannot collapse into one another
   * without `timingViolations` saying so.
   * ---------------------------------------------------------------- */

  /**
   * From the press that started the comparison to the moment both arms stopped.
   *
   * The only figure that answers "how long did this take me". It contains the
   * shared preparation, both arms, and the time the traveller spent answering
   * the follow-up questions.
   */
  sessionWallTimeMs: withUnit('sessionWallTimeMs'),
  /** Of that, the part spent waiting for a person to answer. */
  humanAnswerWaitMs: withUnit('humanAnswerWaitMs'),
  /**
   * Of that, the part the machines owned: the session wall clock less the human
   * wait. This is the figure a latency comparison should use when the two arms
   * asked different numbers of questions, because a system that asks good
   * questions must not be charged for the time somebody took to answer them.
   */
  sessionMachineTimeMs: withUnit('sessionMachineTimeMs'),

  /* Spend. */
  modelCalls: withUnit('modelCalls'),
  inputTokens: withUnit('inputTokens'),
  outputTokens: withUnit('outputTokens'),
  /** Integer micro-USD, estimated from a checked-in rate table. Never a bill. */
  estimatedCostMicroUsd: withUnit('estimatedCostMicroUsd'),
  repairCalls: withUnit('repairCalls'),

  /* Provider work. */
  providerCalls: withUnit('providerCalls'),
  routeCalls: withUnit('routeCalls'),
  routePairs: withUnit('routePairs'),
  weatherCalls: withUnit('weatherCalls'),
  cacheHits: withUnit('cacheHits'),
  cacheMisses: withUnit('cacheMisses'),
  retries: withUnit('retries'),

  /* Footprint. */
  databaseGrowthBytes: withUnit('databaseGrowthBytes'),

  /**
   * COLD OR WARM, OBSERVED RATHER THAN ASSUMED — AND PERSISTED.
   *
   * Two things were wrong with this field and both mattered. It was a plain enum
   * on a structure whose writer stores one row per `Measurement`, so it had
   * nowhere to go and never came back: every latency figure on the dashboard
   * pooled cold and warm runs, which is the one covariate the pre-registered
   * rules name as making latency readable at all. And both arms declared
   * `unknown` unconditionally, which is an inferred default wearing the clothes
   * of an observation.
   *
   * It is now written to its own column by the run writer, and each arm derives
   * it from something it actually saw: the deterministic arm from the
   * classification its own compilation made of itself at the moment it started,
   * the other from whether the world it planned against was bought during this
   * session or reused from an earlier preparation of it.
   */
  warmth: z.enum(['cold', 'warm', 'mixed', 'unknown']),
  /** One sentence naming what the warmth above was read off. Never empty. */
  warmthBasis: z.string().min(1).max(300),
});
export type RunMetrics = z.infer<typeof runMetricsSchema>;

/**
 * The wording each latency boundary is measured against.
 *
 * Written down because the single largest way this benchmark could produce a
 * wrong answer is by letting each system define its own start line. Both
 * adapters are held to these sentences, and the symmetry test asserts that a
 * boundary either has a value for both systems or an explicit reason for each.
 */
export const TIMING_BOUNDARY_DEFINITIONS = {
  t0: 'The instant the normalised shared request is handed to the adapter, after parsing and before any work.',
  timeToFirstUsefulResultMs:
    'The first instant a persisted artifact exists that a traveller could act on: at least one candidate place, or at least one concrete question.',
  timeToFollowUpQuestionsMs:
    'The first instant a question set is persisted and answerable.',
  timeToFirstItineraryMs:
    'The first instant a persisted day-by-day plan covers at least one day, valid or not.',
  timeToValidatedPlanMs:
    "The first instant a plan has been through the shared neutral validators, including after at most one repair. Later than the arm's own total, because the validators are the harness's rather than either arm's.",
  sharedPreparationMs:
    'The time the harness spent buying the open inventory, routes, hours, forecast and daylight that the fast planner plans against and that the shared checker is built from. Recorded identically on both arms because it is a property of the comparison; it is not the deterministic arm\'s world.',
  worldAcquisitionMs:
    "What this arm spent acquiring the world it planned against: the harness purchase for the arm handed it, the arm's own compilation for the arm that builds its own.",
  planningTimeMs:
    "This arm's total less its own world acquisition. The figure to compare the two planners on.",
  totalWallTimeMs:
    "From t0 to this arm's terminal state. One arm's own operation time: it excludes the shared preparation, the other arm, and every second spent waiting for a person.",
  sessionWallTimeMs:
    'From the press that started the comparison to the instant both arms had stopped. The only figure that answers "how long did this take me". Identical on both arms.',
  humanAnswerWaitMs:
    'The part of the session wall clock spent waiting for a person to answer the follow-up questions. Identical on both arms.',
  sessionMachineTimeMs:
    'The session wall clock less the human wait: the part the machines owned. Identical on both arms.',
} as const;

export function emptyRunMetrics(runId: string, detail: string): RunMetrics {
  const absent = unavailable('not_yet_computed', detail);
  return {
    schemaVersion: 1,
    runId,
    timeToFirstUsefulResultMs: absent,
    timeToFollowUpQuestionsMs: absent,
    timeToFirstItineraryMs: absent,
    timeToValidatedPlanMs: absent,
    sharedPreparationMs: absent,
    worldAcquisitionMs: absent,
    planningTimeMs: absent,
    totalWallTimeMs: absent,
    sessionWallTimeMs: absent,
    humanAnswerWaitMs: absent,
    sessionMachineTimeMs: absent,
    modelCalls: absent,
    inputTokens: absent,
    outputTokens: absent,
    estimatedCostMicroUsd: absent,
    repairCalls: absent,
    providerCalls: absent,
    routeCalls: absent,
    routePairs: absent,
    weatherCalls: absent,
    cacheHits: absent,
    cacheMisses: absent,
    retries: absent,
    databaseGrowthBytes: absent,
    warmth: 'unknown',
    warmthBasis: 'Nothing observed the state of the caches beneath this run.',
  };
}

/**
 * Ordering the latency stamps must satisfy, returned rather than thrown.
 *
 * A violation means the instrument is wrong, not that a system is slow, and the
 * two must never be confused in a report. Returning the list keeps it testable
 * and keeps a broken clock from aborting a run that otherwise produced a plan.
 */
export function timingViolations(metrics: RunMetrics): string[] {
  const problems: string[] = [];
  /*
   * The order these boundaries actually occur in, which is not the order they
   * are declared in.
   *
   * `timeToValidatedPlanMs` sits *after* the arm's own total, and that is a fact
   * about where the validators run rather than a quirk of the wording. The
   * shared checks are the harness's, not either arm's — running them inside an
   * arm is precisely how one competitor would come to supply the instrument it
   * is measured by — so an arm has already stopped, and already reported its
   * total, by the time its plan is checked.
   *
   * Listing them the other way round made this fire on every healthy run, which
   * is the failure mode that teaches people to ignore a check.
   */
  const ordered: [string, Measurement][] = [
    ['timeToFirstUsefulResultMs', metrics.timeToFirstUsefulResultMs],
    ['timeToFirstItineraryMs', metrics.timeToFirstItineraryMs],
    ['totalWallTimeMs', metrics.totalWallTimeMs],
    ['timeToValidatedPlanMs', metrics.timeToValidatedPlanMs],
  ];

  let previousName: string | null = null;
  let previousValue: number | null = null;
  for (const [name, measurement] of ordered) {
    const value = valueOf(measurement);
    if (value === null) {
      // An unmeasured boundary breaks the chain rather than being stepped over:
      // comparing the two boundaries either side of a gap would silently assert
      // an ordering nobody observed.
      previousName = null;
      previousValue = null;
      continue;
    }
    if (previousValue !== null && previousName !== null && value < previousValue) {
      problems.push(`${name} (${value}ms) is before ${previousName} (${previousValue}ms)`);
    }
    previousName = name;
    previousValue = value;
  }

  /*
   * The session clock, checked against itself and against the arm inside it.
   *
   * These three comparisons are the whole reason the session-level fields are
   * separate values rather than one. While machine time and wall time were
   * assigned the same number on both arms, the equivalent check here could not
   * fire under any input at all — a test that passes for every possible run is
   * not a test — so each of the following is a statement that a real instrument
   * fault would break.
   */
  const armTotal = valueOf(metrics.totalWallTimeMs);
  const sessionWall = valueOf(metrics.sessionWallTimeMs);
  const humanWait = valueOf(metrics.humanAnswerWaitMs);
  const sessionMachine = valueOf(metrics.sessionMachineTimeMs);

  if (sessionMachine !== null && sessionWall !== null && sessionMachine > sessionWall) {
    problems.push(
      `sessionMachineTimeMs (${sessionMachine}ms) exceeds sessionWallTimeMs (${sessionWall}ms)`,
    );
  }
  if (humanWait !== null && sessionWall !== null && humanWait > sessionWall) {
    problems.push(
      `humanAnswerWaitMs (${humanWait}ms) exceeds sessionWallTimeMs (${sessionWall}ms)`,
    );
  }
  /*
   * The one cross-instrument comparison, and it carries a tolerance for that
   * reason.
   *
   * An arm times itself with a monotonic counter and the session clock is stamped
   * from the wall clock, so the two are different instruments and a strict
   * inequality between them would fire on rounding rather than on a fault. The
   * tolerance is generous enough to absorb that and far too small to absorb the
   * failure this exists to catch — an arm reporting more elapsed time than the
   * whole comparison, which means one of the two clocks is measuring the wrong
   * span.
   */
  if (armTotal !== null && sessionMachine !== null && armTotal > sessionMachine + CLOCK_SKEW_TOLERANCE_MS) {
    problems.push(
      `totalWallTimeMs (${armTotal}ms) exceeds sessionMachineTimeMs (${sessionMachine}ms)`,
    );
  }
  return problems;
}

/** Slack between the monotonic arm clock and the wall-stamped session clock. */
export const CLOCK_SKEW_TOLERANCE_MS = 1_000;
