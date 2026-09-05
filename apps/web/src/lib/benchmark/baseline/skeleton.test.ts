import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { BENCHMARK_CASES } from '@sidequest/bench/cases';
import { benchmarkTripRequestSchema, type BenchmarkTripRequest } from '@sidequest/bench';
import type { StructuredModel } from '../../providers/interpretation-model';
import {
  GENERATION_MAX_TOKENS,
  buildGenerationTask,
  untrustedPayload,
  baselineGenerationSchema,
} from './generate';
import {
  SKELETON_MAX_TOKENS,
  SKELETON_SOFT_PROSE_CAPS,
  TRIP_ARCHETYPES,
  buildSkeletonTask,
  generateTripSkeleton,
  normalizeTripSkeleton,
  skeletonUntrustedPayload,
  tripSkeletonSchema,
  type TripSkeleton,
} from './skeleton';
import { buildSkeletonEvidencePacket } from './skeleton-packet';
import { baselineFixtureInputs, fixturePacketInputs } from './fixtures';
import { buildResearchPacket } from './packet';
import { runPreliminaryScan } from './scan';

function requestWithNights(nights: number): BenchmarkTripRequest {
  return benchmarkTripRequestSchema.parse({
    ...(BENCHMARK_CASES[0]?.request ?? {}),
    requestId: `req-skeleton-${nights}`,
    dates: { ...(BENCHMARK_CASES[0]?.request?.dates ?? {}), mode: 'flexible', nights, startDate: null, endDate: null },
  });
}

describe('the trip skeleton schema', () => {
  it('accepts a maximal skeleton at every one of its own caps', () => {
    const filler = (n: number) => 'x'.repeat(n);
    const maximal = {
      archetype: 'moving_route' as const,
      purpose: filler(220),
      bases: Array.from({ length: 8 }, (_, i) => ({
        id: `base-${i}`,
        placeIndex: i,
        name: filler(100),
        nights: 3,
        why: filler(140),
      })),
      days: Array.from({ length: 40 }, (_, i) => ({
        dayNumber: i + 1,
        baseId: 'base-0',
        theme: filler(100),
        intensity: 'moderate' as const,
        anchors: Array.from({ length: 4 }, (_, a) => ({
          placeIndex: a,
          name: filler(60),
          locality: filler(40),
          estimatedDurationMinutes: 600,
          role: 'primary' as const,
          why: filler(140),
        })),
      })),
      majorOmissions: Array.from({ length: 10 }, (_, i) => ({ placeIndex: i, reason: filler(120) })),
      unresolved: Array.from({ length: 8 }, () => filler(160)),
    };
    expect(tripSkeletonSchema.safeParse(maximal).success).toBe(true);
  });

  it('is a closed vocabulary of archetypes, including the one Phase 16 lost silently', () => {
    expect(TRIP_ARCHETYPES).toContain('moving_route');
    expect(TRIP_ARCHETYPES).toContain('single_base');
  });

  it('rejects an anchor referencing a negative place index', () => {
    const bad = {
      archetype: 'single_base',
      purpose: 'fine',
      bases: [{ id: 'b', placeIndex: 0, name: 'B', nights: 1, why: 'fine' }],
      days: [
        {
          dayNumber: 1,
          baseId: 'b',
          theme: 'fine',
          intensity: 'light',
          anchors: [{ placeIndex: -1, role: 'primary', why: 'fine' }],
        },
      ],
      majorOmissions: [],
      unresolved: [],
    };
    expect(tripSkeletonSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts an anchor with placeIndex null and a real-world name — composing beyond the evidence packet', () => {
    const value = {
      archetype: 'single_base',
      purpose: 'fine',
      bases: [{ id: 'b', placeIndex: 0, name: 'B', nights: 1, why: 'fine' }],
      days: [
        {
          dayNumber: 1,
          baseId: 'b',
          theme: 'fine',
          intensity: 'light',
          anchors: [
            { placeIndex: null, name: 'A real place the packet did not include', locality: 'near the base', role: 'primary', why: 'fine' },
          ],
        },
      ],
      majorOmissions: [],
      unresolved: [],
    };
    expect(tripSkeletonSchema.safeParse(value).success).toBe(true);
  });

  it('still accepts an anchor with neither name nor locality — every anchor before this field existed', () => {
    const value = {
      archetype: 'single_base',
      purpose: 'fine',
      bases: [{ id: 'b', placeIndex: 0, name: 'B', nights: 1, why: 'fine' }],
      days: [
        { dayNumber: 1, baseId: 'b', theme: 'fine', intensity: 'light', anchors: [{ placeIndex: 0, role: 'primary', why: 'fine' }] },
      ],
      majorOmissions: [],
      unresolved: [],
    };
    expect(tripSkeletonSchema.safeParse(value).success).toBe(true);
  });
});

describe('measured against the full-plan composer schema', () => {
  it('is materially smaller on the wire', () => {
    const skeletonBytes = JSON.stringify(zodOutputFormat(tripSkeletonSchema)).length;
    const fullPlanBytes = JSON.stringify(zodOutputFormat(baselineGenerationSchema)).length;
    // Measured, not assumed: report both so a regression is visible in the
    // test output rather than only in a pass/fail bit.
    expect(skeletonBytes).toBeLessThan(fullPlanBytes * 0.5);
  });
});

describe('the output ceiling, measured against a real maximal payload', () => {
  const filler = (n: number) => 'x'.repeat(n);

  function maximalSkeleton(dayCount: number) {
    return {
      archetype: 'moving_route' as const,
      purpose: filler(220),
      bases: Array.from({ length: Math.min(8, dayCount) }, (_, i) => ({
        id: `base-${i}`,
        placeIndex: i,
        name: filler(100),
        nights: 2,
        why: filler(140),
      })),
      days: Array.from({ length: dayCount }, (_, i) => ({
        dayNumber: i + 1,
        baseId: 'base-0',
        theme: filler(100),
        intensity: 'moderate' as const,
        anchors: Array.from({ length: 4 }, (_, a) => ({
          placeIndex: a,
          name: filler(60),
          locality: filler(40),
          estimatedDurationMinutes: 600,
          role: 'primary' as const,
          why: filler(140),
        })),
      })),
      majorOmissions: Array.from({ length: 10 }, (_, i) => ({ placeIndex: i, reason: filler(120) })),
      unresolved: Array.from({ length: 8 }, () => filler(160)),
    };
  }

  /** JSON bytes, then a rough token estimate at ~4 bytes/token — the same conservative ratio used elsewhere in this codebase for planning ceilings. */
  function estimatedTokens(payload: unknown): number {
    return Math.ceil(JSON.stringify(payload).length / 4);
  }

  it.each([5, 13, 21])('a maximal %i-day skeleton fits comfortably under SKELETON_MAX_TOKENS', (dayCount) => {
    const tokens = estimatedTokens(maximalSkeleton(dayCount));
    // Headroom: the ceiling should be well above the measured worst case, not
    // shaved to it — reasoning tokens and formatting overhead are not
    // counted by this byte estimate at all.
    expect(tokens).toBeLessThan(SKELETON_MAX_TOKENS);
  });

  it('the 21-day maximal skeleton still validates against the schema', () => {
    expect(tripSkeletonSchema.safeParse(maximalSkeleton(21)).success).toBe(true);
  });

  it('SKELETON_MAX_TOKENS carries real headroom over the worst measured case, not an arbitrary round number', () => {
    const worst = estimatedTokens(maximalSkeleton(21));
    expect(SKELETON_MAX_TOKENS).toBeGreaterThan(worst * 1.3);
    // And it is a real cut from the full-plan ceiling, not cosmetic.
    // ≤0.5×, relaxed from 0.4× by the composition-call recovery pass: the
    // 2026-09-01 live acceptance call proved 12,700 insufficient at medium
    // effort (reasoning alone consumed it, zero visible bytes), and the
    // corrected ceiling budgets measured visible need plus the *measured*
    // medium-effort reasoning cost even though the call now runs at low —
    // see SKELETON_MAX_TOKENS's own header for the arithmetic. Still a
    // real cut from the full-plan composer's ceiling, which is the claim
    // this assertion exists to keep true.
    expect(SKELETON_MAX_TOKENS).toBeLessThanOrEqual(GENERATION_MAX_TOKENS * 0.5);
  });
});

describe('the skeleton request, measured against the full-plan composer request', () => {
  it('is materially smaller for the same trip', () => {
    const request = requestWithNights(4);
    const packet = buildResearchPacket(baselineFixtureInputs(request, new Date('2026-08-01T00:00:00Z')));
    const scan = runPreliminaryScan({ request, packet });

    const fullPlanTask = buildGenerationTask({ request, packet, scan, followUpAnswers: [] });
    const fullPlanUntrusted = untrustedPayload({ request, packet, followUpAnswers: [] });
    const fullPlanBytes = fullPlanTask.length + JSON.stringify(fullPlanUntrusted).length;

    const skeletonPacket = buildSkeletonEvidencePacket(packet, request);
    const skeletonTask = buildSkeletonTask({ request, packet: skeletonPacket });
    const skeletonUntrusted = skeletonUntrustedPayload({ request, packet: skeletonPacket });
    const skeletonBytes = skeletonTask.length + JSON.stringify(skeletonUntrusted).length;

    expect(skeletonBytes).toBeLessThan(fullPlanBytes);
  });
});

describe('generateTripSkeleton', () => {
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

  it('asks for the skeleton schema, not the full-plan schema', async () => {
    const request = requestWithNights(2);
    const packet = buildResearchPacket(baselineFixtureInputs(request, new Date('2026-08-01T00:00:00Z')));
    const skeletonPacket = buildSkeletonEvidencePacket(packet, request);
    const { model, calls } = fakeModel({
      archetype: 'single_base',
      purpose: 'fine',
      bases: [{ id: 'b', placeIndex: 0, name: 'B', nights: 1, why: 'fine' }],
      days: [],
      majorOmissions: [],
      unresolved: [],
    });
    const result = await generateTripSkeleton({
      model,
      packet: skeletonPacket,
      task: 'a task',
      untrusted: { retrievedContent: skeletonPacket },
    });
    expect(result.ok).toBe(true);
    const sent = calls[0] as { schema: unknown; maxTokens: number };
    expect(sent.schema).toBe(tripSkeletonSchema);
    expect(sent.maxTokens).toBe(SKELETON_MAX_TOKENS);
  });

  it('refuses to spend a call the run does not have', async () => {
    const { model } = fakeModel({});
    (model as { callsRemaining: number }).callsRemaining = 0;
    const result = await generateTripSkeleton({
      model,
      packet: buildSkeletonEvidencePacket(
        buildResearchPacket(fixturePacketInputs()),
        requestWithNights(1),
      ),
      task: 't',
      untrusted: {},
    });
    expect(result).toEqual({
      ok: false,
      failureKind: 'budget_exhausted',
      detail: 'The run reached its model-call ceiling before the skeleton could be generated.',
    });
  });
});

function minimalSkeleton(overrides: Partial<TripSkeleton> = {}): TripSkeleton {
  return {
    archetype: 'single_base',
    purpose: 'A short, well-formed purpose statement.',
    bases: [{ id: 'base-a', placeIndex: 3, name: 'Base A', nights: 2, why: 'Central and convenient.' }],
    days: [
      {
        dayNumber: 1,
        baseId: 'base-a',
        theme: 'A first day',
        intensity: 'moderate',
        anchors: [
          { placeIndex: 5, role: 'primary', why: 'The main draw.' },
          { placeIndex: 9, role: 'secondary', why: 'Worth a look if time allows.' },
        ],
      },
    ],
    majorOmissions: [{ placeIndex: 12, reason: 'Too far for this trip length.' }],
    unresolved: ['Whether the trailhead parking fills up early.'],
    ...overrides,
  };
}

describe('normalizeTripSkeleton — cosmetic fields, and only cosmetic fields', () => {
  it('clips a soft field past its cap, and the clipped answer then passes strict validation', () => {
    const tooLong = minimalSkeleton({ purpose: 'x'.repeat(SKELETON_SOFT_PROSE_CAPS.purpose + 44) });
    expect(tripSkeletonSchema.safeParse(tooLong).success).toBe(false);

    const { value, normalizedFields } = normalizeTripSkeleton(tooLong);
    expect(normalizedFields).toContain('purpose (clip)');
    const revalidated = tripSkeletonSchema.safeParse(value);
    expect(revalidated.success).toBe(true);
    if (revalidated.success) {
      expect(revalidated.data.purpose.length).toBe(SKELETON_SOFT_PROSE_CAPS.purpose);
    }
  });

  it('clips a too-long base why, day theme, anchor why, omission reason and unresolved item, each independently', () => {
    const skeleton = minimalSkeleton({
      bases: [{ id: 'base-a', placeIndex: 3, name: 'Base A', nights: 2, why: 'x'.repeat(SKELETON_SOFT_PROSE_CAPS.baseWhy + 10) }],
      days: [
        {
          dayNumber: 1,
          baseId: 'base-a',
          theme: 'x'.repeat(SKELETON_SOFT_PROSE_CAPS.dayTheme + 10),
          intensity: 'moderate',
          anchors: [{ placeIndex: 5, role: 'primary', why: 'x'.repeat(SKELETON_SOFT_PROSE_CAPS.anchorWhy + 10) }],
        },
      ],
      majorOmissions: [{ placeIndex: 12, reason: 'x'.repeat(SKELETON_SOFT_PROSE_CAPS.omissionReason + 10) }],
      unresolved: ['x'.repeat(SKELETON_SOFT_PROSE_CAPS.unresolvedItem + 10)],
    });
    expect(tripSkeletonSchema.safeParse(skeleton).success).toBe(false);
    const { value, normalizedFields } = normalizeTripSkeleton(skeleton);
    expect([...normalizedFields].sort()).toEqual(
      [
        'bases[0].why (clip)',
        'days[0].theme (clip)',
        'days[0].anchors[0].why (clip)',
        'majorOmissions[0].reason (clip)',
        'unresolved[0] (clip)',
      ].sort(),
    );
    expect(tripSkeletonSchema.safeParse(value).success).toBe(true);
  });

  it('trims whitespace and records the operation as trim, not clip', () => {
    const skeleton = minimalSkeleton({ purpose: '  A short purpose with padding.  ' });
    const { value, normalizedFields } = normalizeTripSkeleton(skeleton);
    expect(normalizedFields).toContain('purpose (trim)');
    expect((value as TripSkeleton).purpose).toBe('A short purpose with padding.');
  });

  it('does not touch a field that is already clean and within its cap', () => {
    const skeleton = minimalSkeleton();
    const { value, normalizedFields } = normalizeTripSkeleton(skeleton);
    expect(normalizedFields).toEqual([]);
    expect(value).toEqual(skeleton);
  });

  it('never normalizes a field that violates the safe-prose pattern — the hard failure survives untouched', () => {
    const skeleton = minimalSkeleton({
      purpose: `See https://example.com for details. ${'x'.repeat(SKELETON_SOFT_PROSE_CAPS.purpose)}`,
    });
    expect(tripSkeletonSchema.safeParse(skeleton).success).toBe(false);
    const { value, normalizedFields } = normalizeTripSkeleton(skeleton);
    expect(normalizedFields).toEqual([]);
    expect((value as TripSkeleton).purpose).toBe(skeleton.purpose);
    expect(tripSkeletonSchema.safeParse(value).success).toBe(false);
  });

  it('never touches archetype, ids, place references, roles, nights, or day numbers', () => {
    const skeleton = minimalSkeleton({ purpose: 'x'.repeat(SKELETON_SOFT_PROSE_CAPS.purpose + 5) });
    const { value } = normalizeTripSkeleton(skeleton);
    const normalized = value as TripSkeleton;
    expect(normalized.archetype).toBe(skeleton.archetype);
    expect(normalized.bases[0]!.id).toBe(skeleton.bases[0]!.id);
    expect(normalized.bases[0]!.placeIndex).toBe(skeleton.bases[0]!.placeIndex);
    expect(normalized.bases[0]!.nights).toBe(skeleton.bases[0]!.nights);
    expect(normalized.bases[0]!.name).toBe(skeleton.bases[0]!.name);
    expect(normalized.days[0]!.baseId).toBe(skeleton.days[0]!.baseId);
    expect(normalized.days[0]!.dayNumber).toBe(skeleton.days[0]!.dayNumber);
    expect(normalized.days[0]!.intensity).toBe(skeleton.days[0]!.intensity);
    expect(normalized.days[0]!.anchors[0]!.placeIndex).toBe(skeleton.days[0]!.anchors[0]!.placeIndex);
    expect(normalized.days[0]!.anchors[0]!.role).toBe(skeleton.days[0]!.anchors[0]!.role);
    expect(normalized.majorOmissions[0]!.placeIndex).toBe(skeleton.majorOmissions[0]!.placeIndex);
  });

  it('never truncates an array to fit a length cap', () => {
    const manyAnchors = minimalSkeleton({
      days: [
        {
          dayNumber: 1,
          baseId: 'base-a',
          theme: 'fine',
          intensity: 'moderate',
          anchors: Array.from({ length: 5 }, (_, i) => ({ placeIndex: i, role: 'primary' as const, why: 'fine' })),
        },
      ],
    });
    // 5 anchors exceeds the schema's own max(4) — a hard, structural cap.
    expect(tripSkeletonSchema.safeParse(manyAnchors).success).toBe(false);
    const { value } = normalizeTripSkeleton(manyAnchors);
    expect((value as TripSkeleton).days[0]!.anchors.length).toBe(5);
    expect(tripSkeletonSchema.safeParse(value).success).toBe(false);
  });

  it('tolerates a non-object payload', () => {
    expect(normalizeTripSkeleton(null)).toEqual({ value: null, normalizedFields: [] });
    expect(normalizeTripSkeleton('not an object')).toEqual({ value: 'not an object', normalizedFields: [] });
    expect(normalizeTripSkeleton([1, 2, 3])).toEqual({ value: [1, 2, 3], normalizedFields: [] });
  });

  it('generateTripSkeleton actually passes normalizeTripSkeleton to structured()', async () => {
    const request = requestWithNights(2);
    const packet = buildResearchPacket(baselineFixtureInputs(request, new Date('2026-08-01T00:00:00Z')));
    const skeletonPacket = buildSkeletonEvidencePacket(packet, request);
    const calls: unknown[] = [];
    const model: StructuredModel = {
      callsRemaining: 2,
      async structured<T>(input: { normalize?: unknown }) {
        calls.push(input);
        return minimalSkeleton() as unknown as T;
      },
    };
    await generateTripSkeleton({ model, packet: skeletonPacket, task: 't', untrusted: {} });
    expect((calls[0] as { normalize?: unknown }).normalize).toBe(normalizeTripSkeleton);
  });
});

/**
 * THE PRESERVED ICELAND REPLAY, AS A REGRESSION FIXTURE.
 *
 * The real observed failure — see `.claude-private/PROGRESS.md`'s own
 * entry — was a complete, correct, `end_turn` 13-day Iceland skeleton whose
 * only defect was `purpose` at 264 characters against a 220 cap. This
 * embeds that exact `purpose` text (the one field that mattered) inside an
 * otherwise-minimal skeleton, rather than depending on the gitignored
 * private artifact — the same pattern `generate.test.ts`'s own "medium-
 * effort malformed response" regression fixture already uses for the
 * full-plan composer's equivalent failure.
 */
describe('the preserved Iceland skeleton replay — a representative regression fixture', () => {
  const REAL_OVERLONG_PURPOSE =
    'A ring-road-style loop from Reykjavík out through the south coast, the southeast glacier country, ' +
    'the east fjords into the north, and back west through Borgarfjörður, matching the traveller’s wish ' +
    'for four bases and a route that returns to its start for departure.';

  it('is exactly 264 characters — the length actually observed, not a round number', () => {
    expect(REAL_OVERLONG_PURPOSE.length).toBe(264);
  });

  it('fails validation before normalization, on purpose alone, exactly as recorded', () => {
    const skeleton = minimalSkeleton({ archetype: 'loop', purpose: REAL_OVERLONG_PURPOSE });
    const result = tripSkeletonSchema.safeParse(skeleton);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]).toMatchObject({ path: ['purpose'], code: 'too_big' });
    }
  });

  it('passes after normalization, with every anchor reference byte-identical', () => {
    const skeleton = minimalSkeleton({ archetype: 'loop', purpose: REAL_OVERLONG_PURPOSE });
    const { value, normalizedFields } = normalizeTripSkeleton(skeleton);
    expect(normalizedFields).toEqual(['purpose (clip)']);

    const result = tripSkeletonSchema.safeParse(value);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.purpose.length).toBe(SKELETON_SOFT_PROSE_CAPS.purpose);
      expect(result.data.archetype).toBe('loop');
      // Every structural value survives untouched — bases, days, anchors.
      expect(result.data.bases).toEqual(skeleton.bases);
      expect(result.data.days).toEqual(skeleton.days);
      expect(result.data.majorOmissions).toEqual(skeleton.majorOmissions);
    }
  });
});
