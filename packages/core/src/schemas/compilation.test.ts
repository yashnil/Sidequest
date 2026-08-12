import { describe, expect, it } from 'vitest';
import {
  COMPILATION_ERROR_COPY,
  decodeStoredJob,
  formatCompilationDuration,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isRetryable,
  isTerminal,
} from './compilation';

/**
 * The heartbeat contract and the two things a traveller reads off it: whether
 * a silent build may be called dead, and what a duration looks like when it is
 * printed. "Working — 12198m 51s" reached a real screen; both halves of that
 * sentence get a test here.
 */

describe('the heartbeat contract', () => {
  it('tolerates several missed pulses before calling a build dead', () => {
    /*
     * The pulse writes every interval; the timeout must survive a handful of
     * misses, or a garbage-collection pause reports a healthy build dead and
     * offers a duplicate paid run.
     */
    expect(HEARTBEAT_TIMEOUT_MS).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS * 5);
  });

  it('sits above the longest single provider call the pipeline may make', () => {
    /** The extraction transport's ceiling is 240 s (`anthropic.ts:1049`). */
    expect(HEARTBEAT_TIMEOUT_MS).toBeGreaterThan(240_000);
  });
});

describe('the interrupted verdict', () => {
  it('is retryable, with copy that promises resumption rather than apologising', () => {
    expect(isRetryable('compilation_interrupted')).toBe(true);
    expect(COMPILATION_ERROR_COPY.compilation_interrupted).toContain('Nothing was lost');
  });

  it('remains readable on a stored job row', () => {
    /*
     * The stale-read check the versioning pattern requires: a row written with
     * the new code decodes under the current schema — the code travels in
     * `error_code`, which was always free text at the storage layer.
     */
    const job = decodeStoredJob({
      id: 'job-1',
      trip_id: 'trip-1',
      scope_fingerprint: 'fp',
      state: 'failed',
      stage: 'expanding_region',
      stages_json: '[]',
      started_at: '2026-08-11T09:00:00.000Z',
      updated_at: '2026-08-11T09:00:00.000Z',
      finished_at: '2026-08-11T09:05:00.000Z',
      heartbeat_at: '2026-08-11T09:00:00.000Z',
      cancel_requested: 0,
      error_code: 'compilation_interrupted',
      error_detail: null,
      compiled_region_id: null,
      correlation_id: 'corr-1',
    });
    expect(job?.errorCode).toBe('compilation_interrupted');
    expect(isTerminal(job!.state)).toBe(true);
  });
});

describe('formatCompilationDuration', () => {
  it('rolls minutes into hours instead of printing a stopwatch lap', () => {
    // 12198m 51s was rendered. At this magnitude, hours; seconds are noise.
    expect(formatCompilationDuration(12_198 * 60 + 51)).toBe('203h 18m');
    expect(formatCompilationDuration(3_600)).toBe('1h');
    expect(formatCompilationDuration(3_660)).toBe('1h 1m');
  });

  it('keeps the familiar shapes below the hour', () => {
    expect(formatCompilationDuration(0)).toBe('0s');
    expect(formatCompilationDuration(59)).toBe('59s');
    expect(formatCompilationDuration(60)).toBe('1m');
    expect(formatCompilationDuration(754)).toBe('12m 34s');
  });

  it('renders garbage as zero, never as a negative a traveller sees', () => {
    expect(formatCompilationDuration(-5)).toBe('0s');
    expect(formatCompilationDuration(Number.NaN)).toBe('0s');
    expect(formatCompilationDuration(Number.POSITIVE_INFINITY)).toBe('0s');
  });
});
