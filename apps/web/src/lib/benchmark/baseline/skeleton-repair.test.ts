import { describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkTripRequestSchema, type BenchmarkTripRequest } from '@sidequest/bench';
import type { StructuredModel } from '../../providers/interpretation-model';
import { buildResearchPacket } from './packet';
import { fixtureMovingRoutePacketInputs } from './fixtures';
import { MAX_SKELETON_REPAIR_ISSUES, repairTripSkeletonFromResearchPacket } from './skeleton-repair';
import { tripSkeletonSchema, type TripSkeleton } from './skeleton';
import type { HydrationIssue } from './hydrate';

function requestFor(): BenchmarkTripRequest {
  return benchmarkTripRequestSchema.parse({
    ...(BENCHMARK_CASES[0]?.request ?? {}),
    requestId: 'req-skeleton-repair',
  });
}

const SKELETON: TripSkeleton = {
  archetype: 'single_base',
  purpose: 'fine',
  bases: [{ id: 'northgate', placeIndex: null, name: 'Northgate', nights: 2, why: 'fine' }],
  days: [
    { dayNumber: 1, baseId: 'northgate', theme: 'fine', intensity: 'light', anchors: [{ placeIndex: 0, role: 'primary', why: 'fine' }] },
    { dayNumber: 2, baseId: 'northgate', theme: 'fine', intensity: 'light', anchors: [{ placeIndex: 99_999, role: 'primary', why: 'fine' }] },
  ],
  majorOmissions: [],
  unresolved: [],
};

function fakeModel(response: unknown): { model: StructuredModel; calls: unknown[] } {
  const calls: unknown[] = [];
  const model: StructuredModel = {
    callsRemaining: 2,
    async structured<T>(input: unknown) {
      calls.push(input);
      return response as T;
    },
  };
  return { model, calls };
}

describe('repairTripSkeleton', () => {
  it('does nothing without an issue to act on', async () => {
    const { model } = fakeModel(SKELETON);
    const result = await repairTripSkeletonFromResearchPacket({ model, skeleton: SKELETON, issues: [], packet: buildResearchPacket(fixtureMovingRoutePacketInputs()), request: requestFor() });
    expect(result).toEqual({ ok: false, failureKind: 'malformed_output', detail: 'Nothing was found that a repair could act on.' });
  });

  it('refuses to spend a call the run does not have', async () => {
    const { model } = fakeModel(SKELETON);
    (model as { callsRemaining: number }).callsRemaining = 0;
    const issues: HydrationIssue[] = [{ kind: 'unresolvable_anchor', detail: 'x', dayNumber: 2 }];
    const result = await repairTripSkeletonFromResearchPacket({ model, skeleton: SKELETON, issues, packet: buildResearchPacket(fixtureMovingRoutePacketInputs()), request: requestFor() });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failureKind).toBe('budget_exhausted');
  });

  it('sends the skeleton schema, day 2 locked-out, and day 1 in the locked list', async () => {
    const { model, calls } = fakeModel(SKELETON);
    const issues: HydrationIssue[] = [
      { kind: 'unresolvable_anchor', detail: "Day 2's anchor at index 99999 does not exist.", dayNumber: 2 },
    ];
    const result = await repairTripSkeletonFromResearchPacket({
      model,
      skeleton: SKELETON,
      issues,
      packet: buildResearchPacket(fixtureMovingRoutePacketInputs()),
      request: requestFor(),
    });
    expect(result.ok).toBe(true);
    const sent = calls[0] as { schema: unknown; task: string; attempt: number };
    expect(sent.schema).toBe(tripSkeletonSchema);
    expect(sent.attempt).toBe(2);
    expect(sent.task).toContain('day number(s) 1');
    expect(sent.task).not.toMatch(/day number\(s\).*\b2\b/);
  });

  it('is bounded — never sends more than MAX_SKELETON_REPAIR_ISSUES issues', async () => {
    const { model, calls } = fakeModel(SKELETON);
    const manyIssues: HydrationIssue[] = Array.from({ length: MAX_SKELETON_REPAIR_ISSUES + 5 }, (_, i) => ({
      kind: 'unresolvable_anchor' as const,
      detail: `problem ${i}`,
      dayNumber: 1,
    }));
    await repairTripSkeletonFromResearchPacket({
      model,
      skeleton: SKELETON,
      issues: manyIssues,
      packet: buildResearchPacket(fixtureMovingRoutePacketInputs()),
      request: requestFor(),
    });
    const sent = calls[0] as { task: string };
    const listedCount = manyIssues.filter((issue) => sent.task.includes(issue.detail)).length;
    expect(listedCount).toBeLessThanOrEqual(MAX_SKELETON_REPAIR_ISSUES);
  });

  it('offers only real, currently-existing places as verified alternatives', async () => {
    const { model, calls } = fakeModel(SKELETON);
    const issues: HydrationIssue[] = [{ kind: 'empty_day', detail: 'Day 1 lost every anchor.', dayNumber: 1 }];
    await repairTripSkeletonFromResearchPacket({
      model,
      skeleton: SKELETON,
      issues,
      packet: buildResearchPacket(fixtureMovingRoutePacketInputs()),
      request: requestFor(),
    });
    const sent = calls[0] as { task: string };
    expect(sent.task).toContain('VERIFIED ALTERNATIVES');
    expect(sent.task).toMatch(/index \d+/);
  });
});
