import { describe, expect, it } from 'vitest';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkTripRequestSchema, runNeutralValidation, type BenchmarkTripRequest } from '@sidequest/bench';
import { packetGroundTruth } from '../ground-truth';
import { buildResearchPacket } from './packet';
import { placeAt } from './packet-types';
import { baselineGenerationSchema } from './generate';
import { toBenchmarkPlan } from './convert';
import { hydrateSkeleton } from './hydrate';
import { normalizeTripSkeleton, tripSkeletonSchema, SKELETON_SOFT_PROSE_CAPS, type TripSkeleton } from './skeleton';
import { fixtureMovingRoutePacketInputs } from './fixtures';

function requestFor(overrides: Record<string, unknown> = {}): BenchmarkTripRequest {
  return benchmarkTripRequestSchema.parse({
    ...(BENCHMARK_CASES[0]?.request ?? {}),
    requestId: 'req-hydrate',
    ...overrides,
  });
}

/** Northgate only — a single-base skeleton over the two-region fixture. */
function singleBaseSkeleton(overrides: Partial<TripSkeleton> = {}): TripSkeleton {
  return {
    archetype: 'single_base',
    purpose: 'A relaxed few days based in Northgate.',
    bases: [{ id: 'northgate', placeIndex: null, name: 'Northgate', nights: 2, why: 'Central to everything nearby.' }],
    days: [
      {
        dayNumber: 1,
        baseId: 'northgate',
        theme: 'The overlook and the old quarter',
        intensity: 'moderate',
        anchors: [
          { placeIndex: 0, role: 'primary', why: 'The best view in the region.' },
          { placeIndex: 2, role: 'secondary', why: 'Worth an hour if there is time.' },
        ],
      },
    ],
    majorOmissions: [],
    unresolved: [],
    ...overrides,
  };
}

function packetAndSkeleton() {
  const packet = buildResearchPacket(fixtureMovingRoutePacketInputs());
  return { packet, request: requestFor() };
}

describe('hydrateSkeleton — produces a complete itinerary', () => {
  it('produces a plan the full-plan schema accepts', () => {
    const { packet, request } = packetAndSkeleton();
    const result = hydrateSkeleton({ skeleton: singleBaseSkeleton(), packet, request });
    const parsed = baselineGenerationSchema.safeParse(result.plan);
    expect(parsed.success).toBe(true);
  });

  it('schedules the day with actual blocks, not an empty shell', () => {
    const { packet, request } = packetAndSkeleton();
    const result = hydrateSkeleton({ skeleton: singleBaseSkeleton(), packet, request });
    expect(result.plan.days[0]!.blocks.length).toBeGreaterThan(0);
    expect(result.plan.days[0]!.blocks.some((block) => block.kind === 'activity')).toBe(true);
  });
});

describe('skeleton anchors resolve to real place identities', () => {
  it('every activity block with a placeIndex addresses a place the packet actually holds', () => {
    const { packet, request } = packetAndSkeleton();
    const result = hydrateSkeleton({ skeleton: singleBaseSkeleton(), packet, request });
    for (const day of result.plan.days) {
      for (const block of day.blocks) {
        if (block.kind === 'activity') {
          expect(block.placeIndex).not.toBeNull();
          expect(placeAt(packet, block.placeIndex)).not.toBeNull();
        }
      }
    }
  });
});

describe('deterministic routing/timing remains authoritative', () => {
  it('a measured leg is stated as measured, never invented', () => {
    const { packet, request } = packetAndSkeleton();
    const result = hydrateSkeleton({ skeleton: singleBaseSkeleton(), packet, request });
    const travelBlocks = result.plan.days[0]!.blocks.filter((b) => b.kind === 'travel');
    expect(travelBlocks.length).toBeGreaterThan(0);
    // Northgate Overlook <-> Northgate Old Quarter is a measured leg in the fixture.
    const measuredBlock = travelBlocks.find((b) => b.travel?.provenance === 'measured');
    expect(measuredBlock).toBeDefined();
    expect(measuredBlock!.travel!.minutes).not.toBeNull();
  });

  it('blocks within a day are in non-decreasing time order', () => {
    const { packet, request } = packetAndSkeleton();
    const result = hydrateSkeleton({ skeleton: singleBaseSkeleton(), packet, request });
    const blocks = result.plan.days[0]!.blocks;
    for (let i = 1; i < blocks.length; i += 1) {
      expect(blocks[i]!.startMinute).toBeGreaterThanOrEqual(blocks[i - 1]!.startMinute!);
    }
  });

  it('statedTotals are computed from the actual schedule, not left null', () => {
    const { packet, request } = packetAndSkeleton();
    const result = hydrateSkeleton({ skeleton: singleBaseSkeleton(), packet, request });
    expect(result.plan.days[0]!.statedTotals.travelMinutes).not.toBeNull();
    expect(result.plan.days[0]!.statedTotals.travelMinutes).toBeGreaterThan(0);
  });
});

describe('impossible anchors are substituted or surfaced, never fabricated', () => {
  it('substitutes a seasonally-closed anchor with the nearest same-kind alternative', () => {
    const { packet, request } = packetAndSkeleton();
    const shutOverlook = packet.places.find((p) => p.name === 'Northgate Shut Overlook')!;
    const skeleton = singleBaseSkeleton({
      days: [
        {
          dayNumber: 1,
          baseId: 'northgate',
          theme: 'The overlook',
          intensity: 'light',
          anchors: [{ placeIndex: shutOverlook.index, role: 'primary', why: 'The best view.' }],
        },
      ],
    });
    const result = hydrateSkeleton({ skeleton, packet, request });
    expect(result.substitutions).toHaveLength(1);
    expect(result.substitutions[0]!.originalPlaceIndex).toBe(shutOverlook.index);
    const substitute = placeAt(packet, result.substitutions[0]!.substitutePlaceIndex);
    expect(substitute).not.toBeNull();
    expect(substitute!.kind).toBe(shutOverlook.kind);
    expect(substitute!.seasonal.state).not.toBe('closed_in_season');
    // The substitute actually made it into the schedule.
    expect(result.plan.days[0]!.blocks.some((b) => b.placeIndex === substitute!.index)).toBe(true);
  });

  it('surfaces a dangling anchor index as an issue rather than inventing a place for it', () => {
    const { packet, request } = packetAndSkeleton();
    const skeleton = singleBaseSkeleton({
      days: [
        {
          dayNumber: 1,
          baseId: 'northgate',
          theme: 'Something',
          intensity: 'light',
          anchors: [{ placeIndex: 99_999, role: 'primary', why: 'fine' }],
        },
      ],
    });
    const result = hydrateSkeleton({ skeleton, packet, request });
    expect(result.issues.some((issue) => issue.kind === 'unresolvable_anchor')).toBe(true);
    // Nothing was invented in its place.
    expect(result.plan.days[0]!.blocks.every((b) => b.placeIndex !== 99_999)).toBe(true);
  });
});

describe('unused bases/placeholders cannot survive', () => {
  it('drops a base no day actually stayed at', () => {
    const { packet, request } = packetAndSkeleton();
    const skeleton = singleBaseSkeleton({
      bases: [
        { id: 'northgate', placeIndex: null, name: 'Northgate', nights: 2, why: 'Used.' },
        { id: 'ghost-base', placeIndex: null, name: 'Ghost Town', nights: 1, why: 'Never actually used.' },
      ],
    });
    const result = hydrateSkeleton({ skeleton, packet, request });
    expect(result.plan.bases.map((b) => b.id)).toEqual(['northgate']);
  });
});

describe('major omissions survive into the rendered explanation', () => {
  it('carries skeleton.majorOmissions through to plan.exclusions', () => {
    const { packet, request } = packetAndSkeleton();
    const shutOverlook = packet.places.find((p) => p.name === 'Northgate Shut Overlook')!;
    const skeleton = singleBaseSkeleton({
      majorOmissions: [{ placeIndex: shutOverlook.index, reason: 'The access road is closed for these dates.' }],
    });
    const result = hydrateSkeleton({ skeleton, packet, request });
    expect(result.plan.exclusions).toHaveLength(1);
    expect(result.plan.exclusions[0]!.placeIndex).toBe(shutOverlook.index);
  });
});

describe('departure closure is independently verified', () => {
  it('a single-base trip trivially closes', () => {
    const { packet, request } = packetAndSkeleton();
    const result = hydrateSkeleton({ skeleton: singleBaseSkeleton(), packet, request });
    expect(result.departureClosure.ok).toBe(true);
  });

  it('a moving-route trip that never returns toward its start is flagged, not silently accepted', () => {
    const { packet } = packetAndSkeleton();
    const request = requestFor({
      movement: {
        preference: 'drive',
        publicTransit: 'accept',
        carAvailable: true,
        maxDailyDriveMinutes: 120,
        maxDailyTravelMinutes: 150,
        desiredBaseCount: 2,
        maxBaseChanges: 1,
      },
    });
    const northgateOverlook = packet.places.find((p) => p.name === 'Northgate Overlook')!;
    const valeLake = packet.places.find((p) => p.name === 'Vale Hollow Lakeshore')!;
    const skeleton: TripSkeleton = {
      archetype: 'moving_route',
      purpose: 'From Northgate onward to Vale Hollow, one-way.',
      bases: [
        { id: 'northgate', placeIndex: null, name: 'Northgate', nights: 1, why: 'Start here.' },
        { id: 'vale-hollow', placeIndex: null, name: 'Vale Hollow', nights: 1, why: 'End here — no return leg planned.' },
      ],
      days: [
        {
          dayNumber: 1,
          baseId: 'northgate',
          theme: 'Northgate',
          intensity: 'light',
          anchors: [{ placeIndex: northgateOverlook.index, role: 'primary', why: 'fine' }],
        },
        {
          dayNumber: 2,
          baseId: 'vale-hollow',
          theme: 'Vale Hollow',
          intensity: 'light',
          anchors: [{ placeIndex: valeLake.index, role: 'primary', why: 'fine' }],
        },
      ],
      majorOmissions: [],
      unresolved: [],
    };
    const result = hydrateSkeleton({ skeleton, packet, request });
    // The fixture's own measured Northgate<->Vale Hollow leg is 195 minutes,
    // past this request's 150-minute daily travel ceiling.
    expect(result.departureClosure.ok).toBe(false);
    expect(result.issues.some((issue) => issue.kind === 'departure_unreachable')).toBe(true);
    expect(result.plan.unknowns.some((u) => u.includes('past the traveller'))).toBe(true);
  });
});

describe("the moving-route regression — Phase 16's failure, guarded", () => {
  it('a two-base moving-route skeleton hydrates into a two-base trip, not one base with day trips', () => {
    const { packet, request } = packetAndSkeleton();
    const northgateOverlook = packet.places.find((p) => p.name === 'Northgate Overlook')!;
    const valeLake = packet.places.find((p) => p.name === 'Vale Hollow Lakeshore')!;
    const valeSummit = packet.places.find((p) => p.name === 'Vale Hollow Summit')!;
    const skeleton: TripSkeleton = {
      archetype: 'moving_route',
      purpose: 'A route from Northgate through to Vale Hollow.',
      bases: [
        { id: 'northgate', placeIndex: null, name: 'Northgate', nights: 1, why: 'Start of the route.' },
        { id: 'vale-hollow', placeIndex: null, name: 'Vale Hollow', nights: 2, why: 'The route’s second region.' },
      ],
      days: [
        {
          dayNumber: 1,
          baseId: 'northgate',
          theme: 'Northgate, then onward',
          intensity: 'moderate',
          anchors: [{ placeIndex: northgateOverlook.index, role: 'primary', why: 'fine' }],
        },
        {
          dayNumber: 2,
          baseId: 'vale-hollow',
          theme: 'Settling into Vale Hollow',
          intensity: 'light',
          anchors: [{ placeIndex: valeLake.index, role: 'primary', why: 'fine' }],
        },
        {
          dayNumber: 3,
          baseId: 'vale-hollow',
          theme: 'The summit',
          intensity: 'moderate',
          anchors: [{ placeIndex: valeSummit.index, role: 'primary', why: 'fine' }],
        },
      ],
      majorOmissions: [],
      unresolved: [],
    };
    const result = hydrateSkeleton({ skeleton, packet, request });

    // The regression this test exists for: a moving-route skeleton must not
    // silently collapse to one base with every day trip radiating from it.
    expect(result.plan.bases).toHaveLength(2);
    expect(result.plan.bases.map((b) => b.id).sort()).toEqual(['northgate', 'vale-hollow']);
    const baseIdsUsed = new Set(result.plan.days.map((d) => d.baseId));
    expect(baseIdsUsed.has('northgate')).toBe(true);
    expect(baseIdsUsed.has('vale-hollow')).toBe(true);

    // Day 1 actually relocates — a `transfer` block, not merely another
    // `travel` block, carrying the traveller from one base's region to the
    // other's rather than back to where the day started.
    const relocationDay = result.plan.days.find((d) => d.dayNumber === 1)!;
    expect(relocationDay.blocks.some((b) => b.kind === 'transfer')).toBe(true);
  });
});

describe('one hydrated trip can pass the existing validator, and Phase 13 machinery can evaluate it', () => {
  it('runs end to end: hydrate -> toBenchmarkPlan -> packetGroundTruth -> runNeutralValidation', () => {
    const inputs = fixtureMovingRoutePacketInputs();
    const packet = buildResearchPacket(inputs);
    const request = requestFor();
    const result = hydrateSkeleton({ skeleton: singleBaseSkeleton(), packet, request });

    const { plan } = toBenchmarkPlan({
      planId: 'plan-hydrate-test',
      requestId: request.requestId,
      output: result.plan,
      packet,
      startDate: packet.days[0]!.date,
      endDate: packet.days[packet.days.length - 1]!.date,
      generationState: 'complete',
      failureKind: null,
      failureDetail: null,
    });

    const truth = packetGroundTruth({ inputs, request, now: new Date('2026-08-01T00:00:00Z') });
    const report = runNeutralValidation(plan, truth);

    expect(report.planId).toBe('plan-hydrate-test');
    expect(typeof report.counts.critical).toBe('number');
    expect(typeof report.counts.major).toBe('number');
    expect(typeof report.counts.minor).toBe('number');
    expect(typeof report.counts.unknown).toBe('number');
    expect(Number.isNaN(report.counts.critical)).toBe(false);
  });
});

/**
 * THE FULL OFFLINE CHAIN: A COSMETICALLY-INVALID SKELETON, NORMALIZED,
 * VALIDATED, THEN HYDRATED — PROVING NORMALIZATION'S OUTPUT IS SOMETHING
 * HYDRATION CAN ACTUALLY USE, NOT JUST SOMETHING ZOD ACCEPTS.
 */
describe('hydrateSkeleton accepts a skeleton that only validates after normalization', () => {
  it('a raw skeleton with an over-length purpose hydrates once normalized', () => {
    const { packet, request } = packetAndSkeleton();
    const raw = singleBaseSkeleton({ purpose: 'x'.repeat(SKELETON_SOFT_PROSE_CAPS.purpose + 30) });
    expect(tripSkeletonSchema.safeParse(raw).success).toBe(false);

    const { value, normalizedFields } = normalizeTripSkeleton(raw);
    expect(normalizedFields).toContain('purpose (clip)');
    const validated = tripSkeletonSchema.safeParse(value);
    expect(validated.success).toBe(true);
    if (!validated.success) return;

    const result = hydrateSkeleton({ skeleton: validated.data, packet, request });
    expect(result.plan.days[0]!.blocks.length).toBeGreaterThan(0);
    expect(result.issues).toEqual([]);
  });

  it('departure closure and moving-route structure both survive normalization', () => {
    const { packet } = packetAndSkeleton();
    const request = requestFor({
      movement: {
        preference: 'drive',
        publicTransit: 'accept',
        carAvailable: true,
        maxDailyDriveMinutes: 600,
        maxDailyTravelMinutes: 600,
        desiredBaseCount: 2,
        maxBaseChanges: 1,
      },
    });
    const northgateOverlook = packet.places.find((p) => p.name === 'Northgate Overlook')!;
    const valeLake = packet.places.find((p) => p.name === 'Vale Hollow Lakeshore')!;
    const raw: TripSkeleton = {
      archetype: 'moving_route',
      purpose: 'x'.repeat(SKELETON_SOFT_PROSE_CAPS.purpose + 40), // over-length, cosmetic only
      bases: [
        { id: 'northgate', placeIndex: null, name: 'Northgate', nights: 1, why: 'Start here.' },
        { id: 'vale-hollow', placeIndex: null, name: 'Vale Hollow', nights: 1, why: 'End here.' },
      ],
      days: [
        {
          dayNumber: 1,
          baseId: 'northgate',
          theme: 'Northgate',
          intensity: 'light',
          anchors: [{ placeIndex: northgateOverlook.index, role: 'primary', why: 'fine' }],
        },
        {
          dayNumber: 2,
          baseId: 'vale-hollow',
          theme: 'Vale Hollow',
          intensity: 'light',
          anchors: [{ placeIndex: valeLake.index, role: 'primary', why: 'fine' }],
        },
      ],
      majorOmissions: [],
      unresolved: [],
    };
    expect(tripSkeletonSchema.safeParse(raw).success).toBe(false);

    const { value } = normalizeTripSkeleton(raw);
    const validated = tripSkeletonSchema.safeParse(value);
    expect(validated.success).toBe(true);
    if (!validated.success) return;
    // archetype/bases/days survive the normalization pass untouched.
    expect(validated.data.archetype).toBe('moving_route');
    expect(validated.data.bases).toHaveLength(2);

    const result = hydrateSkeleton({ skeleton: validated.data, packet, request });
    expect(result.departureClosure.ok).toBe(true);
    expect(result.plan.bases).toHaveLength(2);
    const baseIdsUsed = new Set(result.plan.days.map((d) => d.baseId));
    expect(baseIdsUsed.has('northgate')).toBe(true);
    expect(baseIdsUsed.has('vale-hollow')).toBe(true);
    // No unused base survives — both bases were used by at least one day.
    expect(result.plan.bases.map((b) => b.id).sort()).toEqual(['northgate', 'vale-hollow']);
  });
});
