import { describe, expect, it } from 'vitest';
import { formatElapsed, formatTimeAgo } from './elapsed';

/**
 * THE REGRESSION IS `12458m 52s`.
 *
 * That string reached a real progress screen, beside a badge reading "Working",
 * for a build that had died eight and a half days earlier. The formatter had no
 * unit above the minute, so it kept counting; these assertions are the half of
 * the fix that is about units, and `CompilationProgress` holds the half that is
 * about liveness.
 */
describe('an elapsed span in units a person uses', () => {
  it('counts seconds under a minute and minutes under two hours', () => {
    expect(formatElapsed(8)).toBe('8s');
    expect(formatElapsed(60)).toBe('1m');
    expect(formatElapsed(260)).toBe('4m 20s');
    expect(formatElapsed(119 * 60)).toBe('119m');
  });

  it('stops using minutes past two hours', () => {
    expect(formatElapsed(120 * 60)).toBe('2h');
    expect(formatElapsed(120 * 60 + 12 * 60)).toBe('2h 12m');
    // The exact figure from the defect: 12,458 minutes.
    expect(formatElapsed(12_458 * 60 + 52)).toBe('9 days');
    expect(formatElapsed(12_458 * 60 + 52)).not.toMatch(/m /);
  });

  it('never renders 60 minutes as part of an hour', () => {
    // 1h 59m 58s rounds to 120 minutes on the remainder, which would have read
    // "1h 60m" without the carry.
    expect(formatElapsed(2 * 3600 + 3599)).toBe('3h');
  });

  it('clamps a clock that ran backwards rather than printing a negative', () => {
    // A browser a few seconds behind the server that stamped the row.
    expect(formatElapsed(-3)).toBe('0s');
    expect(formatElapsed(Number.NaN)).toBe('0s');
  });
});

describe('how long ago a build stopped', () => {
  const now = new Date('2026-08-11T12:00:00.000Z');

  it('reads as a phrase that can end a sentence', () => {
    expect(formatTimeAgo('2026-08-11T11:59:40.000Z', now)).toBe('just now');
    expect(formatTimeAgo('2026-08-11T11:30:00.000Z', now)).toBe('30 minutes ago');
    expect(formatTimeAgo('2026-08-11T06:00:00.000Z', now)).toBe('6 hours ago');
    expect(formatTimeAgo('2026-08-03T06:39:28.000Z', now)).toBe('8 days ago');
  });

  it('answers null rather than composing a sentence around undefined', () => {
    expect(formatTimeAgo(undefined, now)).toBeNull();
    expect(formatTimeAgo('not a timestamp', now)).toBeNull();
  });
});
