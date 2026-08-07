import { describe, expect, it } from 'vitest';
import {
  DESTINATION_SHAPES,
  MIN_OBSERVATIONS_FOR_ESTIMATE,
  MIN_SAMPLES_PER_STAGE,
  STAGE_OBSERVATION_VERSION,
  destinationShapeFrom,
  estimateRemainingFrom,
  failureCategoryFor,
  observationBucket,
  stageObservationSchema,
  type CompilationStage,
  type DestinationShape,
  type StageObservation,
  type Warmth,
} from '../index';

/**
 * WHAT THE ESTIMATOR IS ALLOWED TO SAY, ASSERTED ON THE NUMBERS.
 *
 * The tests these replace asserted on the *shape* of the answer — that a range
 * came back, that it had two ends — and passed the entire time the screen was
 * telling travellers their four-minute build had "roughly 0s–0s to go". A test
 * that checks a range exists cannot see that both ends are zero.
 *
 * So every assertion below is about a magnitude, a refusal or a bucket. The
 * fixtures seed history because an estimator with no input has nothing to test;
 * seeding it in production would be fabricating the evidence the number claims
 * to rest on, which is why the only seeding lives here.
 */

const RUN_STAGES: readonly CompilationStage[] = [
  'retrieving_pages',
  'extracting_facts',
  'reconciling_facts',
  'computing_travel_times',
];

function observation(over: Partial<StageObservation> = {}): StageObservation {
  return stageObservationSchema.parse({
    schemaVersion: STAGE_OBSERVATION_VERSION,
    jobId: 'job-1',
    stage: 'retrieving_pages',
    phase: 'verifying',
    outcome: 'done',
    startedAt: '2026-08-02T12:00:00.000Z',
    completedAt: '2026-08-02T12:00:30.000Z',
    durationMs: 30_000,
    breadth: 'city',
    shape: 'city',
    warmth: 'cold',
    degraded: false,
    providerCalls: 4,
    cacheHits: 0,
    retries: 0,
    observedAt: '2026-08-02T12:00:30.000Z',
    ...over,
  });
}

/**
 * `runs` distinct builds, each recording every stage in `stages`.
 *
 * Distinct job ids on purpose: the bar is five comparable *builds*, and the
 * version this replaces counted rows, so twenty observations from one build
 * cleared a threshold meant to require twenty from five.
 */
function history(input: {
  runs: number;
  stages: readonly CompilationStage[];
  durationMs: number;
  shape?: DestinationShape;
  warmth?: Warmth;
  degraded?: boolean;
}): StageObservation[] {
  const built: StageObservation[] = [];
  for (let run = 0; run < input.runs; run += 1) {
    for (const stage of input.stages) {
      built.push(
        observation({
          jobId: `job-${run}`,
          stage,
          durationMs: input.durationMs,
          ...(input.shape ? { shape: input.shape } : {}),
          ...(input.warmth ? { warmth: input.warmth } : {}),
          ...(input.degraded === undefined ? {} : { degraded: input.degraded }),
        }),
      );
    }
  }
  return built;
}

const CITY_COLD = { shape: 'city', warmth: 'cold', degraded: false } as const;

describe('an observation is a fact about a run, not about a region', () => {
  it('carries the provenance needed to explain a number, not just the number', () => {
    const parsed = observation({ compiledRegionId: 'region-7', workUnits: 42, monotonicMs: 29_900 });
    expect(parsed.jobId).toBe('job-1');
    expect(parsed.compiledRegionId).toBe('region-7');
    expect(parsed.phase).toBe('verifying');
    expect(parsed.startedAt).toBeTruthy();
    expect(parsed.completedAt).toBeTruthy();
    expect(parsed.monotonicMs).toBe(29_900);
    expect(parsed.workUnits).toBe(42);
  });

  it('refuses Infinity, which survives JSON.stringify as null and corrupts on read', () => {
    expect(() => observation({ durationMs: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => observation({ durationMs: -1 })).toThrow();
    expect(() => observation({ monotonicMs: Number.NaN })).toThrow();
  });

  it('will not accept a row that cannot say whether its run was degraded', () => {
    // The whole point of dropping version 1 rather than coercing them: guessing
    // `false` here mixes a provider outage into the healthy bucket.
    const { degraded: _dropped, ...withoutFlag } = observation();
    expect(stageObservationSchema.safeParse(withoutFlag).success).toBe(false);
  });

  it('sorts every failure code into a category an operator can act on', () => {
    expect(failureCategoryFor('provider_rate_limited')).toBe('provider');
    expect(failureCategoryFor('budget_exhausted')).toBe('budget');
    expect(failureCategoryFor('malicious_source_rejected')).toBe('data');
    expect(failureCategoryFor('coverage_insufficient')).toBe('coverage');
    expect(failureCategoryFor('internal_error')).toBe('internal');
  });
});

describe('the comparison bucket', () => {
  it('keeps a country build out of a city build s history', () => {
    expect(destinationShapeFrom({ breadth: 'country', entityType: 'country' })).toBe(
      'broad_country',
    );
    expect(destinationShapeFrom({ breadth: 'city', entityType: 'city' })).toBe('city');
    expect(destinationShapeFrom({ breadth: 'region', entityType: 'protected_area' })).toBe(
      'park_remote',
    );
    expect(destinationShapeFrom({ breadth: 'subregion', entityType: 'island' })).toBe('park_remote');
  });

  it('gives everything else its own bucket rather than defaulting it into city', () => {
    // A region that is neither a settlement, a country nor a park behaves like
    // neither. Folding it into `city` is how a two-hour build lands in the same
    // median as a four-minute one.
    expect(destinationShapeFrom({ breadth: 'subregion', entityType: 'subregion' })).toBe('mixed');
    expect(DESTINATION_SHAPES).toContain('mixed');
  });

  it('a whole country is a country build whatever its entity type says', () => {
    expect(destinationShapeFrom({ breadth: 'country', entityType: 'archipelago' })).toBe(
      'broad_country',
    );
  });

  it('separates cold from warm and degraded from healthy in one key', () => {
    const healthy = observationBucket({ shape: 'city', warmth: 'cold', degraded: false });
    expect(observationBucket({ shape: 'city', warmth: 'warm', degraded: false })).not.toBe(healthy);
    expect(observationBucket({ shape: 'city', warmth: 'cold', degraded: true })).not.toBe(healthy);
    expect(observationBucket({ shape: 'park_remote', warmth: 'cold', degraded: false })).not.toBe(
      healthy,
    );
  });
});

describe('the estimator refuses more often than it answers', () => {
  it('says nothing when there is no history at all', () => {
    expect(
      estimateRemainingFrom({ remainingStages: RUN_STAGES, observations: [], ...CITY_COLD }),
    ).toBeNull();
  });

  it('says nothing when nothing is left to run, rather than 0s to go', () => {
    expect(
      estimateRemainingFrom({
        remainingStages: [],
        observations: history({ runs: 8, stages: RUN_STAGES, durationMs: 30_000 }),
        ...CITY_COLD,
      }),
    ).toBeNull();
  });

  it('will not turn one build into five by counting its rows', () => {
    /*
     * Twenty-four observations, one job id. The version this replaces cleared a
     * threshold of five on this input, because it counted observations.
     */
    const oneBuild = history({ runs: 1, stages: RUN_STAGES, durationMs: 30_000 });
    const extra = [...oneBuild, ...oneBuild.map((entry) => ({ ...entry }))];
    expect(extra.length).toBeGreaterThan(MIN_OBSERVATIONS_FOR_ESTIMATE);
    expect(
      estimateRemainingFrom({ remainingStages: RUN_STAGES, observations: extra, ...CITY_COLD }),
    ).toBeNull();
  });

  it('refuses one build short of the bar and answers one build over it', () => {
    const stages = RUN_STAGES;
    const short = history({ runs: MIN_OBSERVATIONS_FOR_ESTIMATE - 1, stages, durationMs: 30_000 });
    const enough = history({ runs: MIN_OBSERVATIONS_FOR_ESTIMATE, stages, durationMs: 30_000 });

    expect(
      estimateRemainingFrom({ remainingStages: stages, observations: short, ...CITY_COLD }),
    ).toBeNull();
    const answer = estimateRemainingFrom({
      remainingStages: stages,
      observations: enough,
      ...CITY_COLD,
    });
    expect(answer).not.toBeNull();
    expect(answer!.runs).toBe(MIN_OBSERVATIONS_FOR_ESTIMATE);
    expect(answer!.samples).toBe(MIN_OBSERVATIONS_FOR_ESTIMATE * stages.length);
  });

  it('will not offer a city s history for a country build', () => {
    const cityHistory = history({ runs: 10, stages: RUN_STAGES, durationMs: 30_000 });
    expect(
      estimateRemainingFrom({
        remainingStages: RUN_STAGES,
        observations: cityHistory,
        shape: 'broad_country',
        warmth: 'cold',
        degraded: false,
      }),
    ).toBeNull();
  });

  it('will not offer a warm build s history to a cold one', () => {
    const warmHistory = history({ runs: 10, stages: RUN_STAGES, durationMs: 5_000, warmth: 'warm' });
    expect(
      estimateRemainingFrom({ remainingStages: RUN_STAGES, observations: warmHistory, ...CITY_COLD }),
    ).toBeNull();
  });

  it('will not learn how long a healthy build takes from builds that gave up', () => {
    const degradedHistory = history({
      runs: 10,
      stages: RUN_STAGES,
      durationMs: 1_200,
      degraded: true,
    });
    expect(
      estimateRemainingFrom({
        remainingStages: RUN_STAGES,
        observations: degradedHistory,
        ...CITY_COLD,
      }),
    ).toBeNull();
    // The same history answers for a run that is itself degraded.
    expect(
      estimateRemainingFrom({
        remainingStages: RUN_STAGES,
        observations: degradedHistory,
        shape: 'city',
        warmth: 'cold',
        degraded: true,
      }),
    ).not.toBeNull();
  });

  it('excludes failed, cancelled and skipped stages from success durations', () => {
    const failures = history({ runs: 10, stages: RUN_STAGES, durationMs: 2_000 }).map((entry) => ({
      ...entry,
      outcome: 'failed' as const,
      failure: 'provider' as const,
    }));
    expect(
      estimateRemainingFrom({ remainingStages: RUN_STAGES, observations: failures, ...CITY_COLD }),
    ).toBeNull();
  });

  it('will not answer a different question when most of what is left is novel', () => {
    const partial = history({ runs: 8, stages: ['retrieving_pages'], durationMs: 30_000 });
    expect(
      estimateRemainingFrom({ remainingStages: RUN_STAGES, observations: partial, ...CITY_COLD }),
    ).toBeNull();
  });

  it('will not build a zero-width band out of one sample per stage', () => {
    /*
     * Six distinct builds — comfortably past the runs bar — but each of the six
     * stages was seen by exactly one of them. The runs threshold is cleared and
     * the per-stage threshold is not, which is precisely the case a bar that
     * counted only runs would let through: a 25th and a 75th percentile computed
     * from a single number are both that number, and a band of zero width reads
     * as certainty.
     */
    const stages: readonly CompilationStage[] = [
      'retrieving_pages',
      'extracting_facts',
      'reconciling_facts',
      'computing_travel_times',
      'discovering_candidates',
      'classifying',
    ];
    const thin = stages.map((stage, index) =>
      observation({ jobId: `job-${index}`, stage, durationMs: 30_000 }),
    );

    expect(new Set(thin.map((entry) => entry.jobId)).size).toBeGreaterThanOrEqual(
      MIN_OBSERVATIONS_FOR_ESTIMATE,
    );
    for (const stage of stages) {
      expect(thin.filter((entry) => entry.stage === stage).length).toBeLessThan(
        MIN_SAMPLES_PER_STAGE,
      );
    }

    expect(
      estimateRemainingFrom({ remainingStages: stages, observations: thin, ...CITY_COLD }),
    ).toBeNull();
  });

  it('drops a single-sample stage from the sum rather than guessing its median', () => {
    /*
     * Two stages seen twice, two seen once. The estimate is allowed — half of
     * what is left is covered — and the two thin stages must contribute nothing
     * rather than contributing their one reading as if it were a median.
     */
    const observations: StageObservation[] = [
      observation({ jobId: 'job-0', stage: 'retrieving_pages', durationMs: 40_000 }),
      observation({ jobId: 'job-4', stage: 'retrieving_pages', durationMs: 40_000 }),
      observation({ jobId: 'job-1', stage: 'extracting_facts', durationMs: 20_000 }),
      observation({ jobId: 'job-5', stage: 'extracting_facts', durationMs: 20_000 }),
      observation({ jobId: 'job-2', stage: 'reconciling_facts', durationMs: 300_000 }),
      observation({ jobId: 'job-3', stage: 'computing_travel_times', durationMs: 300_000 }),
    ];
    const answer = estimateRemainingFrom({
      remainingStages: RUN_STAGES,
      observations,
      ...CITY_COLD,
    });

    expect(answer).not.toBeNull();
    // 40s + 20s, and not a trace of the two five-minute single readings.
    expect(answer!.highSeconds).toBe(60);
  });

  it('never renders 0s–0s, which is the sentence this subsystem exists because of', () => {
    /*
     * The exact reproduction, with a real clock this time: every stage genuinely
     * took a handful of milliseconds. The old estimator produced a range from a
     * one-millisecond median and rendered "roughly 0s–0s to go". This one has no
     * fabricated clock and still has to refuse, because a range that rounds to
     * nothing is a claim that the build is finished, made while it is running.
     */
    const instant = history({ runs: 10, stages: RUN_STAGES, durationMs: 1 });
    expect(
      estimateRemainingFrom({ remainingStages: RUN_STAGES, observations: instant, ...CITY_COLD }),
    ).toBeNull();
  });
});

describe('when the estimator does answer', () => {
  it('gives a range with real magnitude and says how many builds it came from', () => {
    const observations = [
      ...history({ runs: 6, stages: ['retrieving_pages'], durationMs: 90_000 }),
      ...history({ runs: 6, stages: ['extracting_facts'], durationMs: 45_000 }),
      ...history({ runs: 6, stages: ['reconciling_facts'], durationMs: 15_000 }),
      ...history({ runs: 6, stages: ['computing_travel_times'], durationMs: 20_000 }),
    ];
    const answer = estimateRemainingFrom({
      remainingStages: RUN_STAGES,
      observations,
      ...CITY_COLD,
    });

    expect(answer).not.toBeNull();
    // 90 + 45 + 15 + 20 seconds, and nothing near zero.
    expect(answer!.lowSeconds).toBe(170);
    expect(answer!.highSeconds).toBe(170);
    expect(answer!.runs).toBe(6);
    expect(answer!.samples).toBe(24);
    expect(answer!.shape).toBe('city');
    expect(answer!.warmth).toBe('cold');
    expect(answer!.degraded).toBe(false);
  });

  it('bands a noisy stage rather than pretending it is one number', () => {
    const durations = [10_000, 12_000, 14_000, 60_000, 90_000, 120_000];
    const observations = durations.map((durationMs, index) =>
      observation({ jobId: `job-${index}`, stage: 'retrieving_pages', durationMs }),
    );
    const answer = estimateRemainingFrom({
      remainingStages: ['retrieving_pages'],
      observations,
      ...CITY_COLD,
    });

    expect(answer).not.toBeNull();
    expect(answer!.highSeconds).toBeGreaterThan(answer!.lowSeconds);
    // The band is interquartile, so neither end is the 10s minimum nor the 120s
    // maximum — the extremes of a six-sample distribution are noise.
    expect(answer!.lowSeconds).toBeGreaterThanOrEqual(12);
    expect(answer!.highSeconds).toBeLessThanOrEqual(90);
  });

  it('prefers the monotonic clock, so an NTP correction cannot become a duration', () => {
    /*
     * The wall figures say ten minutes because the system clock jumped mid-build.
     * The monotonic figures say twenty seconds, which is what actually elapsed.
     * A subsystem that took the wall figure would tell the next six travellers
     * their build has ten minutes a stage to go.
     */
    const observations = Array.from({ length: 6 }, (_unused, index) =>
      observation({
        jobId: `job-${index}`,
        stage: 'retrieving_pages',
        durationMs: 600_000,
        monotonicMs: 20_000,
      }),
    );
    const answer = estimateRemainingFrom({
      remainingStages: ['retrieving_pages'],
      observations,
      ...CITY_COLD,
    });
    expect(answer!.highSeconds).toBe(20);
  });

  it('never produces a negative or non-finite bound from any bucketed history', () => {
    const observations = history({ runs: 6, stages: RUN_STAGES, durationMs: 25_000 });
    const answer = estimateRemainingFrom({
      remainingStages: RUN_STAGES,
      observations,
      ...CITY_COLD,
    });
    expect(answer).not.toBeNull();
    expect(Number.isFinite(answer!.lowSeconds)).toBe(true);
    expect(Number.isFinite(answer!.highSeconds)).toBe(true);
    expect(answer!.lowSeconds).toBeGreaterThanOrEqual(0);
    expect(answer!.highSeconds).toBeGreaterThanOrEqual(answer!.lowSeconds);
  });

  it('reports no percentage and no completion fraction anywhere in its answer', () => {
    const answer = estimateRemainingFrom({
      remainingStages: RUN_STAGES,
      observations: history({ runs: 6, stages: RUN_STAGES, durationMs: 25_000 }),
      ...CITY_COLD,
    });
    // A completion bar needs work units and most of these stages do not have
    // any. The estimate's shape is the enforcement: there is nowhere to put one.
    expect(Object.keys(answer!).sort()).toEqual([
      'degraded',
      'highSeconds',
      'lowSeconds',
      'runs',
      'samples',
      'shape',
      'warmth',
    ]);
  });
});
