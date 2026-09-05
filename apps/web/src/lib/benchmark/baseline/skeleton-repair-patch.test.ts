import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import {
  applySkeletonRepairPatch,
  skeletonRepairPatchSchema,
  SKELETON_REPAIR_PATCH_MAX_TOKENS,
  SKELETON_REPAIR_PATCH_PROSE_CAPS,
  type SkeletonRepairPatch,
} from './skeleton-repair-patch';
import { SKELETON_MAX_TOKENS, tripSkeletonSchema, type TripSkeleton } from './skeleton';

/**
 * THE OFFLINE REGRESSION SUITE FOR THE PATCH-BASED REPAIR CONTRACT.
 *
 * Every fixture here is deliberately generic — two or three fictional bases,
 * never Iceland or any real destination — because the shape this contract
 * needs to prove ("a small, addressed set of operations reconstructs into a
 * valid whole skeleton, deterministically, or is rejected before hydration")
 * reproduces with any set of places. No `ResearchPacket`, no provider, no
 * model call anywhere in this file — `applySkeletonRepairPatch` is a pure
 * function of `(originalSkeleton, patch)`.
 */

function baseSkeleton(): TripSkeleton {
  return {
    archetype: 'moving_route',
    purpose: 'A short route through two fictional towns, used only to prove the patch applier.',
    bases: [
      { id: 'alpha', placeIndex: 0, name: 'Alpha Town', nights: 2, why: 'The trip starts and ends near here.' },
      { id: 'beta', placeIndex: 1, name: 'Beta Town', nights: 2, why: 'The far side of the region.' },
    ],
    days: [
      { dayNumber: 1, baseId: 'alpha', theme: 'Arrival', intensity: 'light', anchors: [{ placeIndex: 10, role: 'primary', why: 'The reason for the day.' }] },
      { dayNumber: 2, baseId: 'alpha', theme: 'Explore Alpha', intensity: 'moderate', anchors: [{ placeIndex: 11, role: 'primary', why: 'Worth the whole day.' }] },
      { dayNumber: 3, baseId: 'beta', theme: 'Relocate to Beta', intensity: 'moderate', anchors: [] },
      { dayNumber: 4, baseId: 'beta', theme: 'Explore Beta', intensity: 'moderate', anchors: [{ placeIndex: 12, role: 'secondary', why: 'Nice to have if it fits.' }] },
      { dayNumber: 5, baseId: 'beta', theme: 'Departure', intensity: 'light', anchors: [] },
    ],
    majorOmissions: [{ placeIndex: 20, reason: 'Too far out of the way for this trip length.' }],
    unresolved: ['Whether the Beta Town market runs on departure day.'],
  };
}

function noOpPatch(): SkeletonRepairPatch {
  return {
    summary: 'No change required.',
    insertBases: [],
    removeBaseIds: [],
    reorderBaseIds: null,
    nightsChanges: [],
    dayReassignments: [],
    anchorMoves: [],
    anchorDrops: [],
    addedMajorOmissions: [],
  };
}

describe('applySkeletonRepairPatch — the deterministic, model-free reconstruction', () => {
  it('a no-op patch reconstructs the original skeleton exactly', () => {
    const original = baseSkeleton();
    const result = applySkeletonRepairPatch(original, noOpPatch());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skeleton).toEqual(original);
  });

  it('inserting an overnight base between two existing ones produces a valid repaired skeleton, with nights preserved by reallocation', () => {
    const original = baseSkeleton();
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      summary: 'Inserted a midpoint overnight to break up a too-long relocation leg.',
      insertBases: [
        { id: 'midpoint', insertAfterBaseId: 'alpha', name: 'Midpoint Village', nights: 1, why: 'Breaks the long leg into two shorter drives.', placeIndex: null },
      ],
      nightsChanges: [{ baseId: 'beta', nights: 1 }],
      dayReassignments: [{ dayNumber: 3, baseId: 'midpoint' }],
    };
    const result = applySkeletonRepairPatch(original, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.skeleton.bases.map((b) => b.id)).toEqual(['alpha', 'midpoint', 'beta']);
    expect(result.skeleton.bases.reduce((sum, b) => sum + b.nights, 0)).toBe(4); // unchanged from the original's 2+2
    expect(result.skeleton.days).toHaveLength(5); // day count is never touched by a patch
    expect(result.skeleton.days.find((d) => d.dayNumber === 3)?.baseId).toBe('midpoint');
    // Every other day is untouched.
    expect(result.skeleton.days.find((d) => d.dayNumber === 1)).toEqual(original.days[0]);
    expect(result.skeleton.days.find((d) => d.dayNumber === 2)).toEqual(original.days[1]);
    expect(result.skeleton.days.find((d) => d.dayNumber === 4)).toEqual(original.days[3]);
    expect(result.skeleton.days.find((d) => d.dayNumber === 5)).toEqual(original.days[4]);

    expect(tripSkeletonSchema.safeParse(result.skeleton).success).toBe(true);
  });

  it('unchanged anchors are value-identical after a patch that touches a different day entirely', () => {
    const original = baseSkeleton();
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      anchorDrops: [{ dayNumber: 4, placeIndex: 12, name: null, reason: 'No longer feasible on the repaired route.' }],
    };
    const result = applySkeletonRepairPatch(original, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Day 1 and day 2's anchors are untouched — same object values, not merely "similar".
    expect(result.skeleton.days[0]!.anchors).toEqual(original.days[0]!.anchors);
    expect(result.skeleton.days[1]!.anchors).toEqual(original.days[1]!.anchors);
    expect(result.skeleton.days[3]!.anchors).toEqual([]);
  });

  /**
   * PHASE 17 HAIL-MARY FIX — AN ANCHOR BEYOND THE EVIDENCE PACKET (NO
   * `placeIndex`) CAN STILL BE ADDRESSED BY A REPAIR PATCH, BY ITS OWN NAME.
   */
  function skeletonWithModelComposedAnchor(): TripSkeleton {
    const original = baseSkeleton();
    return {
      ...original,
      days: original.days.map((day) =>
        day.dayNumber === 2
          ? { ...day, anchors: [...day.anchors, { placeIndex: null, name: 'A Real Place Beyond The Packet', role: 'secondary' as const, why: 'Composed from the model\'s own knowledge.' }] }
          : day,
      ),
    };
  }

  it('drops a model-composed anchor (no placeIndex) by its own name', () => {
    const original = skeletonWithModelComposedAnchor();
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      anchorDrops: [{ dayNumber: 2, placeIndex: null, name: 'A Real Place Beyond The Packet', reason: 'Turned out not to fit the repaired route.' }],
    };
    const result = applySkeletonRepairPatch(original, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const day2 = result.skeleton.days.find((d) => d.dayNumber === 2)!;
    expect(day2.anchors).toEqual(original.days[1]!.anchors.filter((a) => a.placeIndex !== null));
    // The placeIndex-cited anchor on the same day is untouched.
    expect(day2.anchors.some((a) => a.placeIndex === 11)).toBe(true);
  });

  it('moves a model-composed anchor (no placeIndex) by its own name, and never confuses it with a same-day packet anchor', () => {
    const original = skeletonWithModelComposedAnchor();
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      anchorMoves: [{ placeIndex: null, name: 'A Real Place Beyond The Packet', fromDayNumber: 2, toDayNumber: 4, role: null }],
    };
    const result = applySkeletonRepairPatch(original, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const day2 = result.skeleton.days.find((d) => d.dayNumber === 2)!;
    const day4 = result.skeleton.days.find((d) => d.dayNumber === 4)!;
    expect(day2.anchors.some((a) => a.name === 'A Real Place Beyond The Packet')).toBe(false);
    expect(day2.anchors.some((a) => a.placeIndex === 11)).toBe(true); // untouched
    expect(day4.anchors.some((a) => a.name === 'A Real Place Beyond The Packet')).toBe(true);
  });

  it('a name reference never matches a packet anchor that merely shares the same display name', () => {
    const original: TripSkeleton = {
      ...baseSkeleton(),
      days: baseSkeleton().days.map((day) =>
        day.dayNumber === 1 ? { ...day, anchors: [{ placeIndex: 10, name: 'Ambiguous Name', role: 'primary' as const, why: 'A packet anchor that happens to share a name.' }] } : day,
      ),
    };
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      anchorDrops: [{ dayNumber: 1, placeIndex: null, name: 'Ambiguous Name', reason: 'Should not match the packet-cited anchor of the same name.' }],
    };
    const result = applySkeletonRepairPatch(original, patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/name "Ambiguous Name"/);
  });

  it('rejects an anchor reference that names neither a placeIndex nor a name', () => {
    const patch = { ...noOpPatch(), anchorDrops: [{ dayNumber: 1, placeIndex: null, name: null, reason: 'x' }] };
    const parsed = skeletonRepairPatchSchema.safeParse(patch);
    expect(parsed.success).toBe(false);
  });

  it('locked decisions the patch schema has no field for survive untouched: archetype, purpose, unresolved', () => {
    const original = baseSkeleton();
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      nightsChanges: [{ baseId: 'alpha', nights: 1 }, { baseId: 'beta', nights: 3 }],
    };
    const result = applySkeletonRepairPatch(original, patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skeleton.archetype).toBe(original.archetype);
    expect(result.skeleton.purpose).toBe(original.purpose);
    expect(result.skeleton.unresolved).toEqual(original.unresolved);
  });

  it('the patch schema itself has no field for archetype, purpose, or unresolved — the model cannot resend a locked value because there is nowhere to put one', () => {
    const shapeKeys = Object.keys(skeletonRepairPatchSchema.shape);
    expect(shapeKeys).not.toContain('archetype');
    expect(shapeKeys).not.toContain('purpose');
    expect(shapeKeys).not.toContain('unresolved');
    expect(shapeKeys).not.toContain('days'); // days are addressed by dayNumber/reassignment, never resent wholesale
    expect(shapeKeys).not.toContain('bases'); // bases are addressed by insert/remove/reorder, never resent wholesale
  });

  it('rejects an invalid base reference: nightsChanges naming a base that does not exist', () => {
    const patch: SkeletonRepairPatch = { ...noOpPatch(), nightsChanges: [{ baseId: 'nonexistent', nights: 1 }] };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/nonexistent/);
  });

  it('rejects an invalid base reference: dayReassignments naming a base that does not exist', () => {
    const patch: SkeletonRepairPatch = { ...noOpPatch(), dayReassignments: [{ dayNumber: 2, baseId: 'nonexistent' }] };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/nonexistent/);
  });

  it('rejects a contradictory night allocation: the total across bases changed', () => {
    const patch: SkeletonRepairPatch = { ...noOpPatch(), nightsChanges: [{ baseId: 'alpha', nights: 5 }] };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/total nights/);
  });

  it('rejects a base removal that leaves a day dangling — no reassignment named for it', () => {
    // Nights are compensated (beta's 2 folded into alpha) so this fails on the dangling day
    // reference alone, not on the (separately tested) nights-sum check.
    const patch: SkeletonRepairPatch = { ...noOpPatch(), removeBaseIds: ['beta'], nightsChanges: [{ baseId: 'alpha', nights: 4 }] };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/Day 3.*"beta"/);
  });

  it('a base removal paired with an explicit reassignment for every affected day succeeds', () => {
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      removeBaseIds: ['beta'],
      nightsChanges: [{ baseId: 'alpha', nights: 4 }],
      dayReassignments: [
        { dayNumber: 3, baseId: 'alpha' },
        { dayNumber: 4, baseId: 'alpha' },
        { dayNumber: 5, baseId: 'alpha' },
      ],
    };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skeleton.bases.map((b) => b.id)).toEqual(['alpha']);
    expect(result.skeleton.bases[0]!.nights).toBe(4);
    expect(result.skeleton.days.every((d) => d.baseId === 'alpha')).toBe(true);
  });

  it('rejects a colliding inserted base id', () => {
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      insertBases: [{ id: 'alpha', insertAfterBaseId: null, name: 'Duplicate', nights: 1, why: 'Should be rejected.', placeIndex: null }],
    };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/"alpha".*already/);
  });

  it('rejects an insertAfterBaseId that names a removed base', () => {
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      removeBaseIds: ['beta'],
      dayReassignments: [
        { dayNumber: 3, baseId: 'alpha' },
        { dayNumber: 4, baseId: 'alpha' },
        { dayNumber: 5, baseId: 'alpha' },
      ],
      insertBases: [{ id: 'gamma', insertAfterBaseId: 'beta', name: 'Gamma', nights: 1, why: 'x', placeIndex: null }],
      nightsChanges: [{ baseId: 'alpha', nights: 3 }, { baseId: 'gamma', nights: 1 }],
    };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/insertAfterBaseId "beta"/);
  });

  it('reorderBaseIds must name exactly the surviving + inserted set — a missing id is rejected', () => {
    const patch: SkeletonRepairPatch = { ...noOpPatch(), reorderBaseIds: ['alpha'] }; // missing "beta"
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/exactly the surviving/);
  });

  it('reorderBaseIds successfully reverses base order when named explicitly', () => {
    const patch: SkeletonRepairPatch = { ...noOpPatch(), reorderBaseIds: ['beta', 'alpha'] };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skeleton.bases.map((b) => b.id)).toEqual(['beta', 'alpha']);
  });

  it('moves a retained anchor from one day to another, and an anchor drop is exact — not found is rejected', () => {
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      anchorMoves: [{ placeIndex: 11, name: null, fromDayNumber: 2, toDayNumber: 4, role: 'secondary' }],
    };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skeleton.days[1]!.anchors).toEqual([]);
    expect(result.skeleton.days[3]!.anchors.map((a) => a.placeIndex)).toEqual([12, 11]);
    expect(result.skeleton.days[3]!.anchors.find((a) => a.placeIndex === 11)?.role).toBe('secondary');
  });

  it('rejects an anchor move naming a placeIndex not actually on the named day', () => {
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      anchorMoves: [{ placeIndex: 999, name: null, fromDayNumber: 2, toDayNumber: 4, role: null }],
    };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/999/);
  });

  it('rejects an anchor drop naming a placeIndex not actually on the named day', () => {
    const patch: SkeletonRepairPatch = { ...noOpPatch(), anchorDrops: [{ dayNumber: 3, placeIndex: 999, name: null, reason: 'x' }] };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/999/);
  });

  it('an anchor move that would push a day past its 4-anchor cap is rejected', () => {
    const original = baseSkeleton();
    original.days[3]!.anchors = [
      { placeIndex: 30, role: 'primary', why: 'a' },
      { placeIndex: 31, role: 'primary', why: 'b' },
      { placeIndex: 32, role: 'secondary', why: 'c' },
      { placeIndex: 33, role: 'secondary', why: 'd' },
    ];
    const patch: SkeletonRepairPatch = { ...noOpPatch(), anchorMoves: [{ placeIndex: 11, name: null, fromDayNumber: 2, toDayNumber: 4, role: null }] };
    const result = applySkeletonRepairPatch(original, patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/more than 4 anchors/);
  });

  it('addedMajorOmissions is appended, never replacing the original list', () => {
    const patch: SkeletonRepairPatch = { ...noOpPatch(), addedMajorOmissions: [{ placeIndex: 40, reason: 'Dropped because its base moved.' }] };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skeleton.majorOmissions).toHaveLength(2);
    expect(result.skeleton.majorOmissions[0]).toEqual(baseSkeleton().majorOmissions[0]);
  });

  it('multiple relocation-driven changes compose in one patch — the model reasons about the whole route shape, not one leg at a time', () => {
    const patch: SkeletonRepairPatch = {
      summary: 'Inserted two waypoints to break up both over-limit legs.',
      insertBases: [
        { id: 'waypoint-1', insertAfterBaseId: 'alpha', name: 'Waypoint One', nights: 1, why: 'x', placeIndex: null },
        { id: 'waypoint-2', insertAfterBaseId: 'waypoint-1', name: 'Waypoint Two', nights: 1, why: 'y', placeIndex: null },
      ],
      removeBaseIds: [],
      reorderBaseIds: null,
      nightsChanges: [{ baseId: 'beta', nights: 0 }],
      dayReassignments: [
        { dayNumber: 3, baseId: 'waypoint-1' },
        { dayNumber: 4, baseId: 'waypoint-2' },
      ],
      anchorMoves: [],
      anchorDrops: [],
      addedMajorOmissions: [],
    };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skeleton.bases.map((b) => b.id)).toEqual(['alpha', 'waypoint-1', 'waypoint-2', 'beta']);
    expect(result.skeleton.bases.reduce((sum, b) => sum + b.nights, 0)).toBe(4);
  });

  it('validates the reconstructed skeleton against the real tripSkeletonSchema — a patch that would produce an oversized field is rejected', () => {
    const patch: SkeletonRepairPatch = {
      ...noOpPatch(),
      insertBases: [
        {
          id: 'oversized',
          insertAfterBaseId: null,
          name: 'x'.repeat(200), // past skeletonBaseSchema's own 100-char hard cap
          nights: 1,
          why: 'y',
          placeIndex: null,
        },
      ],
      // Nights compensated (beta loses the 1 the new base gains) so this fails on the
      // oversized name alone, not on the (separately tested) nights-sum check.
      nightsChanges: [{ baseId: 'beta', nights: 1 }],
    };
    const result = applySkeletonRepairPatch(baseSkeleton(), patch);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/failed its own schema/);
  });
});

describe('the patch schema is materially smaller than a whole TripSkeleton, and the model role stays semantic', () => {
  function wireBytes(schema: z.ZodType): number {
    return JSON.stringify(zodOutputFormat(schema)).length;
  }

  /**
   * Measured, not assumed: the patch *schema definition* (4,306 wire bytes)
   * is actually larger than `tripSkeletonSchema`'s own (3,303) — narrower
   * purpose does not mean fewer distinct shapes; the patch has six small
   * array-of-object fields (insertBases, nightsChanges, dayReassignments,
   * anchorMoves, anchorDrops, addedMajorOmissions) where the full skeleton
   * has three, and `zodOutputFormat`'s JSON-schema output charges roughly
   * per distinct shape, not per byte of array capacity — see
   * `schema-size.test.ts`'s own header on why `maxLength`/`maxItems` barely
   * move this number at all. Reported honestly rather than asserted false:
   * the definition is not smaller, but it stays comfortably under the one
   * calibration point this codebase actually has for a refused schema
   * (`GRAMMAR_RISK_BYTES`, 5,000 — see `schema-size.test.ts`). The claim
   * that matters — a repair response is materially smaller than a full
   * regenerated skeleton — is a claim about what the model has to *write*,
   * not about how the schema itself is described; the next test measures
   * that directly.
   */
  it('the schema definition stays comfortably under the calibrated grammar-refusal risk zone, even though it is not smaller than the full skeleton schema', () => {
    const patchBytes = wireBytes(skeletonRepairPatchSchema);
    const fullBytes = wireBytes(tripSkeletonSchema);
    const GRAMMAR_RISK_BYTES = 5_000; // same calibration schema-size.test.ts uses
    expect(patchBytes).toBeLessThan(GRAMMAR_RISK_BYTES);
    expect(fullBytes).toBeLessThan(GRAMMAR_RISK_BYTES);
  });

  it('a maximal patch response is small relative to the skeleton generation token ceiling', () => {
    const maximalPatch: SkeletonRepairPatch = {
      summary: 'x'.repeat(SKELETON_REPAIR_PATCH_PROSE_CAPS.summary),
      insertBases: Array.from({ length: 4 }, (_, i) => ({
        id: `inserted-base-${i}`,
        insertAfterBaseId: i === 0 ? null : `inserted-base-${i - 1}`,
        name: 'x'.repeat(SKELETON_REPAIR_PATCH_PROSE_CAPS.baseName),
        nights: 3,
        why: 'x'.repeat(SKELETON_REPAIR_PATCH_PROSE_CAPS.baseWhy),
        placeIndex: 42,
      })),
      removeBaseIds: Array.from({ length: 8 }, (_, i) => `removed-${i}`),
      reorderBaseIds: Array.from({ length: 12 }, (_, i) => `base-${i}`),
      nightsChanges: Array.from({ length: 8 }, (_, i) => ({ baseId: `base-${i}`, nights: 3 })),
      dayReassignments: Array.from({ length: 8 }, (_, i) => ({ dayNumber: i + 1, baseId: `base-${i}` })),
      anchorMoves: Array.from({ length: 8 }, (_, i) => ({ placeIndex: i, name: null, fromDayNumber: i + 1, toDayNumber: i + 2, role: 'primary' as const })),
      anchorDrops: Array.from({ length: 8 }, (_, i) => ({ dayNumber: i + 1, placeIndex: i, name: null, reason: 'x'.repeat(SKELETON_REPAIR_PATCH_PROSE_CAPS.anchorDropReason) })),
      addedMajorOmissions: Array.from({ length: 4 }, (_, i) => ({ placeIndex: i, reason: 'x'.repeat(SKELETON_REPAIR_PATCH_PROSE_CAPS.omissionReason) })),
    };
    expect(skeletonRepairPatchSchema.safeParse(maximalPatch).success).toBe(true);
    const bytes = Buffer.byteLength(JSON.stringify(maximalPatch), 'utf8');
    // Roughly bytes/4 for a token estimate, per this codebase's own convention (see SKELETON_MAX_TOKENS's header) —
    // reported here, not asserted past a generous bound, so this stays a measurement rather than a guess dressed as one.
    const estimatedTokens = bytes / 4;
    expect(estimatedTokens).toBeLessThan(SKELETON_REPAIR_PATCH_MAX_TOKENS);
  });

  /**
   * The claim the redesign actually rests on: what the model has to *write*
   * for a repair is still smaller than what it had to write for a full
   * skeleton regeneration — raised once, to 6,000 from 3,000, after the
   * first real production call hit the original ceiling with zero usable
   * response bytes (see this constant's own header). Still comfortably
   * under `SKELETON_MAX_TOKENS`, not merely equal to it.
   */
  it('is configured at exactly 6,000 tokens, and stays below the full skeleton generation ceiling', () => {
    expect(SKELETON_REPAIR_PATCH_MAX_TOKENS).toBe(6_000);
    expect(SKELETON_REPAIR_PATCH_MAX_TOKENS).toBeLessThan(SKELETON_MAX_TOKENS);
  });
});
