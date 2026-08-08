import { describe, expect, it } from 'vitest';
import {
  CLOCK_SKEW_TOLERANCE_MS,
  METRIC_KEYS,
  METRIC_UNITS,
  canonicalUnitFor,
  emptyRunMetrics,
  measured,
  runMetricsSchema,
  timingViolations,
  unavailable,
  unitIsCanonical,
} from './metrics';
import { sampleMetrics } from '../testing/sessions';

/**
 * THE TWO DEFECTS THIS FILE EXISTS TO KEEP CLOSED.
 *
 * **The same quantity, labelled two different ways.** Both arms write into one
 * metrics table. One labelled its cost `micro_usd` and the other labelled it
 * `count`, and the token and call counts slipped the same way. Every value was
 * right and directly comparable; only the labels disagreed — which is the
 * dangerous shape, because a reader trusts a unit column and a cost read as a
 * count is a figure quoted a million times too small.
 *
 * **A distinction the code never actually drew.** `machineTimeMs` and
 * `totalWallTimeMs` were assigned the same value on both arms, so the ordering
 * check between them could not fail for any input whatsoever. A check that
 * cannot fail is not a check. The session-level clock replaces it, and the tests
 * below construct the impossible states to prove each comparison can still fire.
 */

describe('metric units', () => {
  it('names one unit per metric, and the schema holds every field to it', () => {
    const metrics = sampleMetrics();
    for (const key of METRIC_KEYS) {
      const measurement = metrics[key];
      expect(measurement, `${key} is missing from the metric set`).toBeDefined();
      if (measurement.state === 'measured') {
        expect(measurement.unit, `${key} is labelled wrongly`).toBe(METRIC_UNITS[key]);
      }
    }
  });

  it('refuses a value labelled in a unit its metric does not use', () => {
    // The exact slippage that happened: a cost written as a bare count.
    const wrong = runMetricsSchema.safeParse({
      ...sampleMetrics(),
      estimatedCostMicroUsd: measured(214_000, 'count'),
    });
    expect(wrong.success).toBe(false);
  });

  it('accepts an absence whatever it says, because an absence has no unit', () => {
    const absent = runMetricsSchema.safeParse({
      ...sampleMetrics(),
      estimatedCostMicroUsd: unavailable('unpriced_model', 'No rate row for this model.'),
    });
    expect(absent.success).toBe(true);
  });

  it('has nothing to say about a key it does not own', () => {
    expect(canonicalUnitFor('somethingElse')).toBeNull();
    expect(unitIsCanonical('somethingElse', measured(1, 'bananas'))).toBe(true);
  });
});

describe('the session clock', () => {
  const base = () => ({
    ...emptyRunMetrics('run-clock', 'Not computed for this assertion.'),
    timeToFirstUsefulResultMs: measured(1_000, 'ms'),
    timeToFirstItineraryMs: measured(5_000, 'ms'),
    totalWallTimeMs: measured(9_000, 'ms'),
    timeToValidatedPlanMs: measured(9_500, 'ms'),
    sessionWallTimeMs: measured(120_000, 'ms'),
    humanAnswerWaitMs: measured(40_000, 'ms'),
    sessionMachineTimeMs: measured(80_000, 'ms'),
  });

  it('is content with a coherent set', () => {
    expect(timingViolations(runMetricsSchema.parse(base()))).toEqual([]);
  });

  it('catches machine time larger than the wall clock it is a part of', () => {
    const broken = runMetricsSchema.parse({
      ...base(),
      sessionMachineTimeMs: measured(200_000, 'ms'),
    });
    expect(timingViolations(broken)).toContain(
      'sessionMachineTimeMs (200000ms) exceeds sessionWallTimeMs (120000ms)',
    );
  });

  it('catches a human wait longer than the whole comparison', () => {
    const broken = runMetricsSchema.parse({
      ...base(),
      humanAnswerWaitMs: measured(200_000, 'ms'),
    });
    expect(timingViolations(broken)).toContain(
      'humanAnswerWaitMs (200000ms) exceeds sessionWallTimeMs (120000ms)',
    );
  });

  it("catches an arm claiming more time than the whole comparison's machine span", () => {
    const broken = runMetricsSchema.parse({
      ...base(),
      totalWallTimeMs: measured(90_000, 'ms'),
      timeToValidatedPlanMs: measured(90_500, 'ms'),
    });
    expect(timingViolations(broken)).toContain(
      'totalWallTimeMs (90000ms) exceeds sessionMachineTimeMs (80000ms)',
    );
  });

  it('tolerates the skew between a monotonic arm clock and a wall-stamped session one', () => {
    const skewed = runMetricsSchema.parse({
      ...base(),
      totalWallTimeMs: measured(80_000 + CLOCK_SKEW_TOLERANCE_MS - 1, 'ms'),
      timeToValidatedPlanMs: measured(80_000 + CLOCK_SKEW_TOLERANCE_MS, 'ms'),
    });
    expect(timingViolations(skewed)).toEqual([]);
  });

  it('puts the shared validators after the arm that stopped, not before', () => {
    /*
     * The validators are the harness's, so an arm has already reported its total
     * by the time its plan is checked. Ordering them the other way round made
     * this check fire on every healthy run, which is how a check comes to be
     * ignored.
     */
    const healthy = runMetricsSchema.parse(base());
    expect(timingViolations(healthy)).toEqual([]);

    const backwards = runMetricsSchema.parse({
      ...base(),
      timeToValidatedPlanMs: measured(8_000, 'ms'),
    });
    expect(timingViolations(backwards)).toContain(
      'timeToValidatedPlanMs (8000ms) is before totalWallTimeMs (9000ms)',
    );
  });
});
