import { describe, expect, it } from 'vitest';
import { STAGES, stageOf, stageSegments } from './StagePath';

describe('stageSegments', () => {
  it('fills everything before the current stage, marks the current one live, leaves the rest ahead', () => {
    const segments = stageSegments('rhythm');
    expect(segments.map((s) => s.state)).toEqual(['done', 'done', 'now', 'ahead', 'ahead']);
    expect(segments.map((s) => s.stage)).toEqual([...STAGES]);
  });

  it('the first stage has nothing done and the last has nothing ahead', () => {
    expect(stageSegments('trip').map((s) => s.state)).toEqual(['now', 'ahead', 'ahead', 'ahead', 'ahead']);
    expect(stageSegments('ready').map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'now']);
  });

  it('carries a human label for every segment', () => {
    for (const segment of stageSegments('love')) expect(segment.label.length).toBeGreaterThan(2);
  });
});

describe('stageOf', () => {
  it('maps question ids to their stage', () => {
    expect(stageOf(null)).toBe('trip');
    expect(stageOf('priorities')).toBe('love');
    expect(stageOf('priority_role:hiking')).toBe('love');
    expect(stageOf('effort')).toBe('rhythm');
    expect(stageOf('transport_mode')).toBe('logistics');
    expect(stageOf('review')).toBe('ready');
  });
});
