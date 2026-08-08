import { describe, expect, it } from 'vitest';
import { runMetricsSchema, timingViolations, valueOf } from '@sidequest/bench';

import { MilestoneRecorder, toRunMetrics, type MilestoneStamps } from './milestones';

/**
 * The one thing these tests are for: proving that a boundary nobody reached is
 * never serialised as a number.
 *
 * A metrics writer that coalesces a missing value to zero produces a row in
 * which "we did not measure this" and "this took no time" are indistinguishable
 * for ever, and the report built on it says the system with no evidence cache
 * has a nought per cent hit rate — which reads as a deficiency rather than as an
 * architectural difference.
 *
 * These run without a database. `toRunMetrics` reads the operational counters
 * only when it is given a job id, so passing `null` exercises the whole shape
 * offline, which is also the shape a run that never compiled anything produces.
 */

function stamps(overrides: Partial<MilestoneStamps> = {}): MilestoneStamps {
  return {
    t0: 1_000,
    questionsAt: null,
    provisionalBoardAt: null,
    compiledRegionAt: null,
    itineraryAt: null,
    terminalAt: null,
    ...overrides,
  };
}

describe('the recorder', () => {
  it('keeps the first stamp, because "time to first" is a claim about the first', () => {
    const recorder = new MilestoneRecorder(0);
    recorder.mark('itineraryAt', 100);
    recorder.mark('itineraryAt', 900);
    expect(recorder.snapshot().itineraryAt).toBe(100);
  });

  it('starts with every boundary unreached', () => {
    const snapshot = new MilestoneRecorder(0).snapshot();
    expect(snapshot.questionsAt).toBeNull();
    expect(snapshot.provisionalBoardAt).toBeNull();
    expect(snapshot.compiledRegionAt).toBeNull();
    expect(snapshot.itineraryAt).toBeNull();
    expect(snapshot.terminalAt).toBeNull();
  });
});

describe('metrics never serialise an absence as a zero', () => {
  const failed = toRunMetrics({
    runId: 'run-failed',
    stamps: stamps({ terminalAt: 1_500 }),
    jobId: null,
    outcome: 'failed',
  });

  it('parses under the shared schema', () => {
    expect(runMetricsSchema.safeParse(failed).success).toBe(true);
  });

  it('reports an unreached boundary as unavailable with a reason, not as 0', () => {
    expect(failed.timeToFirstItineraryMs.state).toBe('unavailable');
    expect(valueOf(failed.timeToFirstItineraryMs)).toBeNull();
    expect(JSON.stringify(failed)).not.toContain('"value":0');
  });

  it('says the run failed rather than that the boundary was merely not reached', () => {
    const measurement = failed.timeToFollowUpQuestionsMs;
    expect(measurement.state === 'unavailable' && measurement.reason).toBe('run_failed');
  });

  it('never leaves an absence unexplained', () => {
    for (const [name, value] of Object.entries(failed)) {
      if (typeof value !== 'object' || value === null) continue;
      const measurement = value as { state?: string; detail?: string };
      if (measurement.state === 'unavailable') {
        expect(measurement.detail?.trim().length, name).toBeGreaterThan(0);
      }
    }
  });

  it('separates "no such concept" from "did not happen"', () => {
    // A deterministic scheduler emits no model output, so there is nothing to
    // repair and no honest zero to report. The reason has to say that rather
    // than blaming the run.
    const repair = failed.repairCalls;
    expect(repair.state === 'unavailable' && repair.reason).toBe('not_applicable_to_system');
  });
});

describe('metrics on a run that finished', () => {
  const complete = toRunMetrics({
    runId: 'run-complete',
    stamps: stamps({
      questionsAt: 1_200,
      provisionalBoardAt: 1_400,
      itineraryAt: 4_000,
      compiledRegionAt: 3_000,
      terminalAt: 4_200,
    }),
    jobId: null,
    outcome: 'complete',
  });

  it('measures every boundary it reached, from t0', () => {
    expect(valueOf(complete.timeToFollowUpQuestionsMs)).toBe(200);
    expect(valueOf(complete.timeToFirstItineraryMs)).toBe(3_000);
    expect(valueOf(complete.totalWallTimeMs)).toBe(3_200);
  });

  it('takes the earlier of a question and a candidate as the first useful result', () => {
    // The definition is "at least one candidate place, or at least one concrete
    // question", so whichever landed first is the answer — not whichever this
    // pipeline happens to produce first.
    expect(valueOf(complete.timeToFirstUsefulResultMs)).toBe(200);
  });

  it('satisfies the ordering the shared instrument requires', () => {
    expect(timingViolations(complete)).toEqual([]);
  });

  it('declares warmth rather than inferring it from counters', () => {
    // No compilation, so nothing classified this run. `unknown` is the honest
    // answer and keeps a synthetic run out of a bucket real ones are compared
    // against.
    expect(complete.warmth).toBe('unknown');
  });

  it('does not claim a validated plan the adapter never validated', () => {
    const validated = complete.timeToValidatedPlanMs;
    expect(validated.state).toBe('unavailable');
    expect(validated.state === 'unavailable' && validated.reason).toBe('not_yet_computed');
  });
});
