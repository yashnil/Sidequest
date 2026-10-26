import { describe, expect, it } from 'vitest';
import { stageTimings } from './run';

describe('stageTimings', () => {
  it('splits a scan into its stages, each until the next one began', () => {
    const t = stageTimings(1_000, { proposing: 1_200, placing: 5_200, timing: 9_000, assembling: 9_500 }, 10_000);
    expect(t).toEqual({ preparingMs: 200, totalMs: 9_000, proposingMs: 4_000, placingMs: 3_800, timingMs: 500, assemblingMs: 500 });
  });

  it('closes a stage on the next one that happened, when one was skipped', () => {
    const t = stageTimings(0, { proposing: 100, timing: 600 }, 1_000);
    expect(t.proposingMs).toBe(500);
    expect(t.placingMs).toBeUndefined();
    expect(t.timingMs).toBe(400);
  });
});
