import { z } from 'zod';
import { BASELINE_HONESTY_RULES } from './prompts';
import { prose, slug, tripSkeletonSchema, type TripSkeleton } from './skeleton';

/**
 * WHY A REPAIR NO LONGER RETURNS A WHOLE `TripSkeleton`.
 *
 * `tripSkeletonSchema` itself carries zero `.refine()`/`.superRefine()` — every
 * check on it is a per-field one (enum, regex, numeric bound, array length),
 * exactly what grammar-mode Structured Outputs can and does enforce. But the
 * decisions a skeleton actually has to get right are mostly *cross-field*, and
 * none of the following is checked by that schema at all:
 *
 * - day count matching the requested trip length — nothing compares
 *   `days.length` to `packet.tripLength.days`; `hydrate.ts` derives its own
 *   `totalDays` from `skeleton.days.length`, so a wrong count silently
 *   produces a differently-sized itinerary instead of an error;
 * - day numbers forming a complete, non-duplicated `1..N` run — `hydrate.ts`
 *   only sorts by `dayNumber`; a duplicate silently double-books a calendar
 *   slot, a gap silently skips one;
 * - `days[].baseId` referencing a real `bases[].id` — the two are
 *   independently-patterned strings with no shared enum; only `hydrate.ts`,
 *   downstream of the whole call, catches a bad reference
 *   (`inconsistent_base_reference`);
 * - `bases[].id` uniqueness — a duplicate is silently dropped, last one wins,
 *   by the `Map` `hydrate.ts` builds from the array;
 * - nights summing to the trip's total duration — `skeleton-adapter.ts`'s
 *   `buildBasePortfolioDates` sums `nights` into a running cumulative index
 *   and *clamps* it against the real calendar (`Math.min(cumulativeNights,
 *   lastIndex)`) rather than rejecting a sum that is wrong;
 * - anchor `placeIndex` referencing a real evidence-packet entry — caught
 *   only downstream (`unresolvable_anchor`), never by the schema;
 * - arrival/departure closure — a real-routing question `hydrate.ts`'s
 *   `verifyDepartureClosure` answers after the fact; no schema could ever
 *   check it.
 *
 * None of this is a defect in `tripSkeletonSchema` — a schema cannot express
 * "the sum of these fields equals that other number" as constrained decoding.
 * The defect was asking full-object *regeneration* to hold all of it at once:
 * every one of these facts has to survive being reproduced correctly across
 * up to 40 day objects and 8 base objects in a single answer, with nothing
 * checking most of them until code far downstream of the model call runs. A
 * narrow relocation repair — insert one overnight, move a couple of days to
 * it — should not require re-proving all seven invariants above over a
 * 13-day skeleton it did not need to touch.
 *
 * `SkeletonRepairPatch` is the fix: the model states only the operations that
 * change something, addressed by stable id/dayNumber/placeIndex-or-name reference,
 * and `applySkeletonRepairPatch` — not the model — owns reconstructing the
 * full skeleton and enforcing exactly the invariants above that are within
 * its power to enforce deterministically (id collisions, day/base reference
 * integrity, the nights sum). What it cannot check locally (packet
 * membership, routing) stays `hydrate.ts`'s job afterward, unchanged.
 */

/** Same discipline as `SKELETON_SOFT_PROSE_CAPS` — one numeric source the schema and any future normalizer share. */
export const SKELETON_REPAIR_PATCH_PROSE_CAPS = {
  summary: 200,
  baseName: 100,
  baseWhy: 140,
  anchorDropReason: 140,
  omissionReason: 120,
} as const;

const patchBaseSchema = z.object({
  /** A new id, chosen by the model. Must not collide with an existing base id or another inserted one — `applySkeletonRepairPatch` rejects a collision. */
  id: slug(),
  /** Insert immediately after this existing-or-already-inserted base id; `null` inserts as the new first base. */
  insertAfterBaseId: slug().nullable(),
  name: prose(SKELETON_REPAIR_PATCH_PROSE_CAPS.baseName),
  nights: z.number().int().min(0).max(60),
  why: prose(SKELETON_REPAIR_PATCH_PROSE_CAPS.baseWhy),
  /** Null when this is a genuine hypothesis with no evidence-packet record — mirrors `skeletonBaseSchema.placeIndex` exactly. */
  placeIndex: z.number().int().min(0).nullable(),
});

const patchNightsChangeSchema = z.object({
  /** An existing (surviving) or newly inserted base id. */
  baseId: slug(),
  nights: z.number().int().min(0).max(60),
});

const patchDayReassignmentSchema = z.object({
  /** Must be a day number that exists in the original skeleton — the patch can never add or remove a day. */
  dayNumber: z.number().int().min(1).max(40),
  /** An existing (surviving) or newly inserted base id, or `null` for a day the trip no longer covers. */
  baseId: slug().nullable(),
});

/**
 * HOW A PATCH NAMES ONE EXISTING ANCHOR — `placeIndex` WHEN IT HAS ONE, ITS
 * OWN `name` WHEN IT DOES NOT.
 *
 * `skeletonAnchorSchema.placeIndex` became nullable in the Phase 17
 * baseline-first pass, so an anchor addressed only by `placeIndex` can no
 * longer be every anchor a skeleton might carry — a model-composed anchor
 * beyond the evidence packet has none. Both fields exist on this reference
 * rather than a discriminated union so the schema stays a plain object
 * (no `oneOf`/`anyOf` for constrained decoding to refuse); exactly one must
 * be non-null, enforced below and by `findAnchorIndex`'s own matching rule.
 */
const patchAnchorReferenceSchema = z
  .object({
    /** Set when the anchor being addressed cites a packet place. */
    placeIndex: z.number().int().min(0).nullable(),
    /** Set when the anchor being addressed does not — matched by exact name, since that is all such an anchor has. */
    name: prose(60).nullable(),
  })
  .refine((ref) => ref.placeIndex !== null || ref.name !== null, {
    message: 'An anchor reference must give a placeIndex or a name — it cannot address nothing.',
    path: ['placeIndex'],
  });

const patchAnchorMoveSchema = patchAnchorReferenceSchema.and(
  z.object({
    fromDayNumber: z.number().int().min(1).max(40),
    toDayNumber: z.number().int().min(1).max(40),
    /** `null` keeps the anchor's original role. */
    role: z.enum(['primary', 'secondary']).nullable(),
  }),
);

const patchAnchorDropSchema = patchAnchorReferenceSchema.and(
  z.object({
    dayNumber: z.number().int().min(1).max(40),
    reason: prose(SKELETON_REPAIR_PATCH_PROSE_CAPS.anchorDropReason),
  }),
);

/**
 * The one matching rule both `anchorMoves` and `anchorDrops` use: a
 * `placeIndex` reference matches only a packet-cited anchor with that exact
 * index; a `name` reference matches only a non-packet anchor (`placeIndex
 * === null`) with that exact name — never a packet anchor that merely
 * happens to carry the same display name, which stays addressable only by
 * its own `placeIndex`.
 */
function findAnchorIndex(
  anchors: readonly TripSkeleton['days'][number]['anchors'][number][],
  ref: { placeIndex: number | null; name: string | null },
): number {
  if (ref.placeIndex !== null) return anchors.findIndex((a) => a.placeIndex === ref.placeIndex);
  if (ref.name !== null) return anchors.findIndex((a) => a.placeIndex === null && a.name === ref.name);
  return -1;
}

/** For an error message: whichever half of the reference was actually given. */
function describeAnchorReference(ref: { placeIndex: number | null; name: string | null }): string {
  return ref.placeIndex !== null ? `placeIndex ${ref.placeIndex}` : `name "${ref.name}"`;
}

const patchOmissionSchema = z.object({
  placeIndex: z.number().int().min(0),
  reason: prose(SKELETON_REPAIR_PATCH_PROSE_CAPS.omissionReason),
});

/**
 * THE SMALLEST TYPED PATCH THAT CAN EXPRESS EVERY REPAIR-ELIGIBLE CHANGE.
 *
 * Deliberately has no field for `archetype`, `purpose`, `unresolved`, or any
 * base/day/anchor the repair does not touch — the model cannot resend a
 * locked decision because the schema gives it nowhere to put one. Everything
 * named here is addressed by stable id, `dayNumber`, or a `placeIndex`-or-
 * `name` anchor reference (see `patchAnchorReferenceSchema`) — never by
 * position in an array.
 */
export const skeletonRepairPatchSchema = z.object({
  /** One line on what changed and why, for the traveller-facing summary. The model's only free narration. */
  summary: prose(SKELETON_REPAIR_PATCH_PROSE_CAPS.summary),
  insertBases: z.array(patchBaseSchema).max(4),
  removeBaseIds: z.array(slug()).max(8),
  /** The full final left-to-right order of every surviving + inserted base id. `null` keeps the original relative order, with insertions placed via `insertAfterBaseId`. */
  reorderBaseIds: z.array(slug()).max(12).nullable(),
  nightsChanges: z.array(patchNightsChangeSchema).max(8),
  dayReassignments: z.array(patchDayReassignmentSchema).max(8),
  anchorMoves: z.array(patchAnchorMoveSchema).max(8),
  anchorDrops: z.array(patchAnchorDropSchema).max(8),
  /** Appended to the original skeleton's `majorOmissions` — never removes an existing one. */
  addedMajorOmissions: z.array(patchOmissionSchema).max(4),
});
export type SkeletonRepairPatch = z.infer<typeof skeletonRepairPatchSchema>;

/**
 * Originally set to 3,000 from the synthetic maximal-fixture measurement in
 * `skeleton-repair-patch.test.ts` (every array at its cap, every prose field
 * at its cap). Raised to 6,000 after the first real production call:
 * `claude-sonnet-5`, effort medium, hit `stop_reason: 'max_tokens'` at
 * exactly 3,000 output tokens with zero usable response bytes — the
 * synthetic fixture's byte/4 estimate under-counted real generation
 * overhead, the same gap `SKELETON_MAX_TOKENS`'s own header already notes
 * for full-skeleton generation. Still well under `SKELETON_MAX_TOKENS`
 * (9,000) — a narrow, measured correction to one real miss, not a
 * re-derivation of the ceiling's methodology.
 */
export const SKELETON_REPAIR_PATCH_MAX_TOKENS = 6_000;

export const SKELETON_REPAIR_PATCH_INSTRUCTION = [
  'You are correcting specific trip-shape decisions you already made. Deterministic hydration found specific,',
  'measured problems building the actual itinerary from them.',
  '',
  'You are not rewriting the trip. Answer only: how should the route concept change to solve the measured',
  'problems named below? A separate, deterministic system applies your answer to the full skeleton and',
  'verifies the result — it needs the smallest patch that fixes what is broken, not a full replacement.',
  '',
  'Return only the operations that actually change something: bases to insert, bases to remove, nights to',
  'move between bases (the total across every base must stay exactly what it already is — the system will',
  'reject a patch that changes it), days to reassign to a different base, anchors to move or drop, and any',
  'new major omission the repaired route requires. Do not restate anything you are not changing — an unnamed',
  'base, day, or anchor stays exactly as it was.',
  '',
  'Where a verified alternative is offered for a problem, prefer it — it is drawn from the same evidence and',
  'known to be usable. Where a decision is named locked, it cannot be changed even if you would prefer to.',
  '',
  'Name the anchor you are moving or dropping by its placeIndex when it has one, or by its own name when it',
  'does not — an anchor beyond the evidence packet has no placeIndex at all, and its name is the only way to',
  'address it.',
  '',
  'A newly proposed base may be a real place you are confident exists, named plainly, given a new id of your',
  'own choosing. You do not need a place index for it, and you must not invent coordinates, travel times,',
  'opening hours, or claim it is routable — Sidequest verifies all of that deterministically afterward; a',
  'newly named base is a hypothesis, not a fact. This is the only correction; there is no second pass.',
  '',
  BASELINE_HONESTY_RULES,
].join('\n');

export type SkeletonRepairApplyResult = { ok: true; skeleton: TripSkeleton } | { ok: false; detail: string };

function fail(detail: string): { ok: false; detail: string } {
  return { ok: false, detail };
}

/**
 * DETERMINISTIC PATCH APPLICATION — SIDEQUEST, NOT THE MODEL, RECONSTRUCTS
 * THE FULL REPAIRED SKELETON.
 *
 * Starts from the already-valid `original`, applies only what `patch`
 * explicitly names, and preserves every unspecified field exactly (by
 * construction — most of it is simply never touched, not merely left alone
 * by convention). Rejects anything ambiguous or contradictory before
 * touching hydration: an unknown id reference, a colliding new id, a nights
 * total that moved, a day left pointing at a base that no longer exists. The
 * final reconstructed object is run through `tripSkeletonSchema` itself, so
 * a repaired skeleton is validated exactly as strictly as a freshly
 * generated one — never accepted on the applier's word alone.
 */
export function applySkeletonRepairPatch(original: TripSkeleton, patch: SkeletonRepairPatch): SkeletonRepairApplyResult {
  const originalBaseIds = new Set(original.bases.map((b) => b.id));
  const insertedIds = new Set<string>();
  for (const insert of patch.insertBases) {
    if (originalBaseIds.has(insert.id)) return fail(`insertBases proposes id "${insert.id}", which already names an existing base.`);
    if (insertedIds.has(insert.id)) return fail(`insertBases proposes id "${insert.id}" more than once.`);
    insertedIds.add(insert.id);
  }

  for (const id of patch.removeBaseIds) {
    if (!originalBaseIds.has(id)) return fail(`removeBaseIds names "${id}", which is not one of the original skeleton's bases.`);
  }
  const removed = new Set(patch.removeBaseIds);
  const survivingBases = original.bases.filter((b) => !removed.has(b.id));

  const baseById = new Map<string, TripSkeleton['bases'][number]>();
  for (const base of survivingBases) baseById.set(base.id, { ...base });
  for (const insert of patch.insertBases) {
    baseById.set(insert.id, { id: insert.id, placeIndex: insert.placeIndex, name: insert.name, nights: insert.nights, why: insert.why });
  }
  if (baseById.size === 0) return fail('The patch would remove every base, leaving the trip nowhere to sleep.');

  let finalOrder: string[];
  if (patch.reorderBaseIds !== null) {
    const want = patch.reorderBaseIds;
    const wantSet = new Set(want);
    const have = new Set(baseById.keys());
    if (wantSet.size !== want.length) return fail('reorderBaseIds lists the same base id more than once.');
    if (wantSet.size !== have.size || [...wantSet].some((id) => !have.has(id))) {
      return fail(
        'reorderBaseIds must name exactly the surviving and newly inserted bases, once each — nothing missing, nothing extra.',
      );
    }
    finalOrder = [...want];
  } else {
    finalOrder = survivingBases.map((b) => b.id);
    // Applied in patch array order — an insert that targets another
    // newly-inserted base as its anchor must appear after it in the array,
    // since only already-placed ids can be found in the growing list.
    for (const insert of patch.insertBases) {
      if (insert.insertAfterBaseId === null) {
        finalOrder.unshift(insert.id);
        continue;
      }
      const anchorIndex = finalOrder.indexOf(insert.insertAfterBaseId);
      if (anchorIndex === -1) {
        return fail(
          `insertBases entry "${insert.id}" names insertAfterBaseId "${insert.insertAfterBaseId}", which is not present (removed, or not yet inserted) at the point it is placed.`,
        );
      }
      finalOrder.splice(anchorIndex + 1, 0, insert.id);
    }
  }

  for (const change of patch.nightsChanges) {
    const base = baseById.get(change.baseId);
    if (!base) return fail(`nightsChanges names "${change.baseId}", which is not a surviving or newly inserted base.`);
    baseById.set(change.baseId, { ...base, nights: change.nights });
  }

  const finalBases = finalOrder.map((id) => baseById.get(id)!);
  if (finalBases.length > 8) return fail(`The patch would leave ${finalBases.length} bases, past the schema's 8-base cap.`);

  const originalNights = original.bases.reduce((sum, b) => sum + b.nights, 0);
  const finalNights = finalBases.reduce((sum, b) => sum + b.nights, 0);
  if (finalNights !== originalNights) {
    return fail(
      `The patch changes total nights from ${originalNights} to ${finalNights} — total nights is a locked decision; a repair must reallocate nights between bases, not change the sum.`,
    );
  }

  const finalBaseIds = new Set(finalOrder);
  // Day count and day numbers are never touched by construction: this map
  // is seeded from, and only ever mutates entries already present in,
  // `original.days` — a patch cannot add or remove a day.
  const dayByNumber = new Map(original.days.map((d) => [d.dayNumber, { ...d, anchors: d.anchors.map((a) => ({ ...a })) }]));

  for (const reassignment of patch.dayReassignments) {
    const day = dayByNumber.get(reassignment.dayNumber);
    if (!day) return fail(`dayReassignments names day ${reassignment.dayNumber}, which does not exist in the original skeleton.`);
    if (reassignment.baseId !== null && !finalBaseIds.has(reassignment.baseId)) {
      return fail(
        `dayReassignments moves day ${reassignment.dayNumber} to base "${reassignment.baseId}", which is not one of the surviving or newly inserted bases.`,
      );
    }
    day.baseId = reassignment.baseId;
  }

  for (const day of dayByNumber.values()) {
    if (day.baseId !== null && !finalBaseIds.has(day.baseId)) {
      return fail(
        `Day ${day.dayNumber} still names base "${day.baseId}", which the patch removed without reassigning this day to another base.`,
      );
    }
  }

  for (const drop of patch.anchorDrops) {
    const day = dayByNumber.get(drop.dayNumber);
    if (!day) return fail(`anchorDrops names day ${drop.dayNumber}, which does not exist.`);
    const index = findAnchorIndex(day.anchors, drop);
    if (index === -1) return fail(`anchorDrops names ${describeAnchorReference(drop)} on day ${drop.dayNumber}, which is not one of that day's anchors.`);
    day.anchors.splice(index, 1);
  }

  for (const move of patch.anchorMoves) {
    const fromDay = dayByNumber.get(move.fromDayNumber);
    const toDay = dayByNumber.get(move.toDayNumber);
    if (!fromDay) return fail(`anchorMoves names fromDayNumber ${move.fromDayNumber}, which does not exist.`);
    if (!toDay) return fail(`anchorMoves names toDayNumber ${move.toDayNumber}, which does not exist.`);
    const index = findAnchorIndex(fromDay.anchors, move);
    if (index === -1) {
      return fail(`anchorMoves names ${describeAnchorReference(move)} on day ${move.fromDayNumber}, which is not one of that day's anchors.`);
    }
    if (toDay.anchors.length >= 4) return fail(`anchorMoves would give day ${move.toDayNumber} more than 4 anchors, past the schema's cap.`);
    const anchor = fromDay.anchors.splice(index, 1)[0]!;
    toDay.anchors.push(move.role !== null ? { ...anchor, role: move.role } : anchor);
  }

  const finalDays = [...dayByNumber.values()].sort((a, b) => a.dayNumber - b.dayNumber);

  const finalOmissions = [...original.majorOmissions, ...patch.addedMajorOmissions];
  if (finalOmissions.length > 10) return fail(`The patch would leave ${finalOmissions.length} major omissions, past the schema's 10-entry cap.`);

  const reconstructed: TripSkeleton = {
    archetype: original.archetype,
    purpose: original.purpose,
    bases: finalBases,
    days: finalDays,
    majorOmissions: finalOmissions,
    unresolved: original.unresolved,
  };

  const validated = tripSkeletonSchema.safeParse(reconstructed);
  if (!validated.success) {
    const issues = validated.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return fail(`The reconstructed skeleton failed its own schema after the patch was applied — ${issues}`);
  }
  return { ok: true, skeleton: validated.data };
}
