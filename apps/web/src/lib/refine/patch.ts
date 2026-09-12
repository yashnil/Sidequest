import { z } from 'zod';
import { patchInvariantViolations, type BookingDependency } from './invariants';
import { ANCHOR_CATEGORIES, ANCHOR_ROLES, DRAFT_DRIVING_ARRANGEMENTS, DRAFT_TRANSPORTS, OVERNIGHT_KINDS, WIRE_TIME_OF_DAY, draftAnchorId, tripDraftSchema, type TripDraft } from '../planning/trip-draft';

/**
 * THE COMPACT TRIP PATCH — WHAT A REFINEMENT ASKS THE MODEL TO WRITE.
 *
 * PRODUCTION LOCK V5 §40. The alternative was to regenerate the whole
 * `TripDraft` for every refinement, and it is worse in three separate ways:
 *
 * 1. **Cost and latency.** A full draft is ~8,500 bytes of output and up to 110
 *    seconds. "Move dinner to the other side of town" does not need either.
 * 2. **Silent loss.** A regenerated draft is a *new* draft. Everything the
 *    traveller was happy with has to survive a rewrite it never asked for, and
 *    the model has no way of knowing which sentences it must reproduce exactly.
 * 3. **Unverifiable preservation.** With a patch, "the hike is still there" is a
 *    property of the operation list and can be checked before anything is
 *    applied. With a regeneration it can only be checked afterwards, by
 *    comparing two documents and hoping the comparison is right.
 *
 * So the model returns operations against ids, application is deterministic
 * (`applyTripPatch`), and **unchanged content survives byte for byte** because
 * nothing rewrites it. `patch.test.ts` asserts that as an identity property.
 *
 * Anchor ids are `draftAnchorId(dayNumber, index, name)` — stable within one
 * draft and independent of any provider, which is what makes them safe to put in
 * front of a model.
 */

export const TRIP_PATCH_VERSION = 'sidequest-trip-patch/1' as const;

const shortProse = (max: number) => z.string().max(max);

/** A new or replacement activity. The same shape the compact wire uses, so the model writes one thing. */
export const patchActivitySchema = z.object({
  name: shortProse(60),
  near: shortProse(40).optional(),
  kind: z.enum(ANCHOR_CATEGORIES),
  role: z.enum(ANCHOR_ROLES).optional(),
  mins: z.number().int().min(10).max(600).optional(),
  how: z.enum(DRAFT_TRANSPORTS).optional(),
  when: z.enum(WIRE_TIME_OF_DAY as [string, ...string[]]).optional(),
  why: shortProse(140),
});

export const TRIP_PATCH_OPS = [
  'add_activity',
  'replace_activity',
  'remove_activity',
  'move_activity',
  'update_day',
  'update_base',
  'replace_base',
  'update_transport',
  'update_timing',
  'update_trip_thesis',
  'update_preference',
  /** V9.1 — one structural decision (nights per stay) that Sidequest expands into the operations above. */
  'restructure',
] as const;
export type TripPatchOp = (typeof TRIP_PATCH_OPS)[number];

export const tripPatchOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_activity'), day: z.number().int().min(1).max(40), at: z.number().int().min(0).max(10).optional(), activity: patchActivitySchema }),
  z.object({ op: z.literal('replace_activity'), id: z.string().max(120), activity: patchActivitySchema }),
  z.object({ op: z.literal('remove_activity'), id: z.string().max(120), reason: shortProse(160) }),
  z.object({ op: z.literal('move_activity'), id: z.string().max(120), toDay: z.number().int().min(1).max(40), at: z.number().int().min(0).max(10).optional() }),
  z.object({
    op: z.literal('update_day'),
    day: z.number().int().min(1).max(40),
    theme: shortProse(100).optional(),
    intensity: z.enum(['light', 'moderate', 'intense']).optional(),
    why: shortProse(160).optional(),
    meals: z.object({ breakfast: shortProse(100).optional(), lunch: shortProse(100).optional(), dinner: shortProse(100).optional(), area: shortProse(80).optional() }).optional(),
    partOf: shortProse(60).optional(),
  }),
  z.object({ op: z.literal('update_base'), id: z.string().max(120), nights: z.number().int().min(0).max(60).optional(), why: shortProse(140).optional(), lodgingArea: shortProse(80).optional(), lodgingStyle: shortProse(60).optional(), overnight: z.enum(OVERNIGHT_KINDS).optional() }),
  z.object({ op: z.literal('replace_base'), id: z.string().max(120), name: shortProse(100), nights: z.number().int().min(0).max(60), why: shortProse(140), lodgingArea: shortProse(80).optional(), lodgingStyle: shortProse(60).optional(), overnight: z.enum(OVERNIGHT_KINDS).optional() }),
  z.object({ op: z.literal('update_transport'), summary: shortProse(200).optional(), driving: z.enum(DRAFT_DRIVING_ARRANGEMENTS).optional(), notes: z.array(shortProse(140)).max(6).optional() }),
  z.object({ op: z.literal('update_timing'), startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), rationale: shortProse(240).optional() }),
  z.object({ op: z.literal('update_trip_thesis'), purpose: shortProse(240).optional(), routeRationale: shortProse(240).optional(), signatures: z.array(shortProse(60)).max(3).optional() }),
  z.object({ op: z.literal('update_preference'), field: z.string().max(60), value: z.string().max(200), note: shortProse(200).optional() }),
  /**
   * V9.1 — RESTRUCTURE: THE STRUCTURAL DECISION, NOT ITS CONSEQUENCES.
   *
   * "Fewer hotel changes" is a new nights figure per stay; everything else —
   * which days sleep where, which stays leave, what to tell the traveller —
   * Sidequest derives. So the wire carries only the decision: the stays whose
   * nights change (0 drops a stay; an existing stay may be renamed when it
   * becomes somewhere else), optionally anchors to drop or move by id, and one
   * reason. `expandRestructure` turns it into the typed operations above before
   * anything is applied, so locks, invariants, the blast radius, the delta and
   * undo all see ordinary operations. The nights must still add up to the
   * trip's nights; a sum that does not is refused, never silently corrected.
   */
  z.object({
    op: z.literal('restructure'),
    stays: z.array(z.object({ id: z.string().max(120), nights: z.number().int().min(0).max(60), name: shortProse(100).optional(), why: shortProse(140).optional(), lodgingArea: shortProse(80).optional(), overnight: z.enum(OVERNIGHT_KINDS).optional() })).min(1).max(12),
    drop: z.array(z.object({ id: z.string().max(120), reason: shortProse(160) })).max(12).optional(),
    move: z.array(z.object({ id: z.string().max(120), toDay: z.number().int().min(1).max(40) })).max(12).optional(),
    why: shortProse(200),
  }),
]);
export type TripPatchOperation = z.infer<typeof tripPatchOperationSchema>;

export const tripPatchSchema = z.object({
  version: z.literal(TRIP_PATCH_VERSION).default(TRIP_PATCH_VERSION),
  /**
   * What the model would tell the traveller it changed and kept. Optional since
   * V9.1: the proposal and the version record show the deterministic dry-run's
   * own lines (V6), never these, so a model that spends output on them spends
   * it on text nobody reads.
   */
  changed: z.array(shortProse(200)).max(10).default([]),
  kept: z.array(shortProse(200)).max(10).default([]),
  operations: z.array(tripPatchOperationSchema).max(40),
});
export type TripPatch = z.infer<typeof tripPatchSchema>;

/**
 * V9.1 — expand every `restructure` into the typed operations it stands for.
 *
 * Pure. A stay named that the draft does not have, or nights that no longer add
 * up to the trip's nights, comes back as a refusal line rather than an
 * operation, so `applyTripPatch` records it the same way it records a locked
 * stay. Order is preserved: the expansion sits where the restructure was.
 */
export function expandRestructure(patch: TripPatch, draft: TripDraft): { patch: TripPatch; refused: { op: TripPatchOp; ref: string; reason: string }[] } {
  const refused: { op: TripPatchOp; ref: string; reason: string }[] = [];
  const operations: TripPatchOperation[] = [];
  const totalNights = draft.bases.reduce((n, base) => n + base.nights, 0);
  for (const operation of patch.operations) {
    if (operation.op !== 'restructure') {
      operations.push(operation);
      continue;
    }
    const nights = new Map(draft.bases.map((base) => [base.id, base.nights]));
    let valid = true;
    for (const stay of operation.stays) {
      if (!nights.has(stay.id)) {
        refused.push({ op: 'restructure', ref: stay.id, reason: 'no such stay in this draft' });
        valid = false;
      }
    }
    if (!valid) continue;
    for (const stay of operation.stays) nights.set(stay.id, stay.nights);
    if ([...nights.values()].every((v) => v === 0)) {
      refused.push({ op: 'restructure', ref: 'nights', reason: 'every stay would be dropped' });
      continue;
    }
    const sum = [...nights.values()].reduce((n, v) => n + v, 0);
    if (sum !== totalNights) {
      refused.push({ op: 'restructure', ref: 'nights', reason: `the nights would add up to ${sum}, and the trip has ${totalNights}` });
      continue;
    }
    for (const stay of operation.stays) {
      const base = draft.bases.find((entry) => entry.id === stay.id)!;
      const why = stay.why ?? operation.why;
      if (stay.name && stay.name !== base.name) {
        operations.push({ op: 'replace_base', id: stay.id, name: stay.name, nights: stay.nights, why, ...(stay.lodgingArea ? { lodgingArea: stay.lodgingArea } : {}), ...(stay.overnight ? { overnight: stay.overnight } : {}) });
      } else if (stay.nights !== base.nights || stay.lodgingArea || stay.overnight) {
        operations.push({ op: 'update_base', id: stay.id, nights: stay.nights, ...(stay.nights !== base.nights ? { why } : {}), ...(stay.lodgingArea ? { lodgingArea: stay.lodgingArea } : {}), ...(stay.overnight ? { overnight: stay.overnight } : {}) });
      }
    }
    for (const entry of operation.drop ?? []) operations.push({ op: 'remove_activity', id: entry.id, reason: entry.reason });
    for (const entry of operation.move ?? []) operations.push({ op: 'move_activity', id: entry.id, toDay: entry.toDay });
  }
  return { patch: { ...patch, operations: operations.slice(0, 40) }, refused };
}

/* ------------------------------------------------------------------ *
 * Application
 * ------------------------------------------------------------------ */

export interface PatchApplication {
  ok: boolean;
  draft: TripDraft;
  /** One line per operation applied, in order. */
  applied: string[];
  /** Operations refused, with the reason. A refusal is never silent. */
  refused: { op: TripPatchOp; ref: string; reason: string }[];
}

/** Every anchor in a draft, with the stable id a patch refers to it by. */
export function anchorIndex(draft: TripDraft): Map<string, { dayNumber: number; index: number }> {
  const index = new Map<string, { dayNumber: number; index: number }>();
  for (const day of draft.days) {
    day.anchors.forEach((anchor, position) => {
      index.set(draftAnchorId(day.dayNumber, position, anchor.name), { dayNumber: day.dayNumber, index: position });
    });
  }
  return index;
}

/**
 * V6 — WHAT A PATCH REACHES, BEFORE ANY LOCK IS CONSULTED.
 *
 * The days its operations address, the stays it edits, and — when a stay's
 * nights change — every day that would sleep somewhere else as a result. The
 * blast radius is bounded to this (`radiusForPatch`), so the traveller is
 * told "change days 7 and 8, and where you sleep in Akan-ko and Obihiro"
 * rather than a list of every day the request happened to mention. A live
 * Hokkaido refinement named days 1 and 2 as *kept* and had them shown under
 * "Change days 1, 2, 7, 8?", while the two stays it actually changed were
 * outside the radius and refused.
 */
export function patchReach(input: TripPatch, draft: TripDraft): { days: number[]; bases: string[] } {
  /* V9.1 — a restructure reaches what its expansion reaches. */
  const patch = expandRestructure(input, draft).patch;
  const ids = anchorIndex(draft);
  const days = new Set<number>();
  const bases = new Set<string>();
  const nights = new Map(draft.bases.map((base) => [base.id, base.nights]));
  for (const operation of patch.operations) {
    switch (operation.op) {
      case 'add_activity':
      case 'update_day':
        days.add(operation.day);
        break;
      case 'replace_activity':
      case 'remove_activity': {
        const address = ids.get(operation.id);
        if (address) days.add(address.dayNumber);
        break;
      }
      case 'move_activity': {
        const address = ids.get(operation.id);
        if (address) days.add(address.dayNumber);
        days.add(operation.toDay);
        break;
      }
      case 'update_base':
      case 'replace_base':
        if (nights.has(operation.id)) {
          bases.add(operation.id);
          if (operation.nights !== undefined) nights.set(operation.id, operation.nights);
        }
        break;
      default:
        break;
    }
  }
  const before = dayBaseMap(draft.bases, draft.days.length);
  const after = dayBaseMap(draft.bases.map((base) => ({ id: base.id, nights: nights.get(base.id) ?? base.nights })), draft.days.length);
  before.forEach((id, index) => {
    if (after[index] !== id) days.add(index + 1);
  });
  return { days: [...days].filter((day) => day >= 1 && day <= draft.days.length).sort((a, b) => a - b), bases: [...bases] };
}

/**
 * Day → stay, from the base sequence: day d sleeps at the stay covering night
 * d, and the last day (a departure, no night) keeps the last stay. A stay with
 * no nights covers nothing.
 */
export function dayBaseMap(bases: readonly { id: string; nights: number }[], dayCount: number): string[] {
  const sequence = bases.filter((base) => base.nights > 0);
  const out: string[] = [];
  let cursor = 0;
  let covered = 0;
  for (let day = 1; day <= dayCount; day += 1) {
    while (cursor < sequence.length - 1 && day > covered + sequence[cursor]!.nights) {
      covered += sequence[cursor]!.nights;
      cursor += 1;
    }
    out.push(sequence[cursor]?.id ?? bases[bases.length - 1]?.id ?? '');
  }
  return out;
}

function listOfDays(days: readonly number[]): string {
  if (days.length <= 1) return String(days[0] ?? '');
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}

/**
 * Apply a patch to a draft, deterministically.
 *
 * ## The two properties that matter
 *
 * **Nothing outside the patch changes.** The draft is cloned once and only the
 * addressed paths are written, so a day the patch never names is the same object
 * graph it was. `patch.test.ts` asserts this by deep-comparing untouched days.
 *
 * **A locked thing cannot be changed.** `locked` is checked before every
 * operation, and a refusal is recorded rather than swallowed, so the traveller
 * can be told that their "keep this no matter what" is why something did not
 * happen (§45). The one exception the spec allows — an explicit user change that
 * makes the lock impossible — is resolved by an interrupt upstream, never by
 * quietly overriding it here.
 */
export function applyTripPatch(input: { draft: TripDraft; patch: TripPatch; locked?: readonly string[]; travellerLocked?: readonly string[]; booked?: readonly BookingDependency[]; today?: Date }): PatchApplication {
  /* V9.1 — a structural decision becomes ordinary operations first; its refusals are recorded like any other. */
  const expansion = expandRestructure(input.patch, input.draft);
  if (expansion.refused.length > 0 || expansion.patch !== input.patch) {
    return applyExpandedPatch({ ...input, patch: expansion.patch }, expansion.refused);
  }
  return applyExpandedPatch(input, []);
}

function applyExpandedPatch(input: { draft: TripDraft; patch: TripPatch; locked?: readonly string[]; travellerLocked?: readonly string[]; booked?: readonly BookingDependency[]; today?: Date }, priorRefusals: PatchApplication['refused']): PatchApplication {
  const draft: TripDraft = structuredClone(input.draft);
  const locked = new Set(input.locked ?? []);
  /*
   * V6 — a refusal says who is refusing. `locked` is the contract's whole
   * preserve list (everything outside the radius, plus the traveller's own
   * locks). A stay outside the scope is not "locked by the traveller", and the
   * first live proposal told them it was.
   */
  const travellerLocked = input.travellerLocked ? new Set(input.travellerLocked) : null;
  const because = (keys: readonly string[], what: string): string => (travellerLocked === null || keys.some((key) => travellerLocked.has(key)) ? `the traveller locked this ${what}` : `this ${what} is outside the scope of this change`);
  const applied: string[] = [];
  const refused: PatchApplication['refused'] = [...priorRefusals];
  const dayOf = (dayNumber: number) => draft.days.find((day) => day.dayNumber === dayNumber);

  /* Ids are resolved against the ORIGINAL draft: an operation list must not be sensitive to its own order. */
  const ids = anchorIndex(input.draft);
  /** Locate an anchor by the id it had before this patch started. */
  const locate = (id: string): { day: TripDraft['days'][number]; index: number } | null => {
    const address = ids.get(id);
    if (!address) return null;
    const day = dayOf(address.dayNumber);
    if (!day) return null;
    /*
     * Matched by name rather than by position. Earlier operations in the same
     * patch may have inserted or removed anchors on this day, which moves the
     * index but not the identity.
     */
    const original = input.draft.days.find((d) => d.dayNumber === address.dayNumber)?.anchors[address.index];
    if (!original) return null;
    const index = day.anchors.findIndex((anchor) => anchor.name === original.name);
    return index === -1 ? null : { day, index };
  };

  for (const operation of input.patch.operations) {
    switch (operation.op) {
      case 'add_activity': {
        const day = dayOf(operation.day);
        if (!day) {
          refused.push({ op: operation.op, ref: `day ${operation.day}`, reason: 'the trip has no such day' });
          break;
        }
        if (locked.has(`day:${operation.day}`)) {
          refused.push({ op: operation.op, ref: `day ${operation.day}`, reason: because([`day:${operation.day}`], 'day') });
          break;
        }
        if (day.anchors.length >= 5) {
          refused.push({ op: operation.op, ref: `day ${operation.day}`, reason: 'a day holds at most five experiences' });
          break;
        }
        const anchor = anchorFrom(operation.activity, day.anchors.length);
        day.anchors.splice(Math.min(operation.at ?? day.anchors.length, day.anchors.length), 0, anchor);
        applied.push(`added ${anchor.name} to day ${operation.day}`);
        break;
      }
      case 'replace_activity': {
        const found = locate(operation.id);
        if (!found) {
          refused.push({ op: operation.op, ref: operation.id, reason: 'no such activity in this draft' });
          break;
        }
        if (locked.has(`activity:${operation.id}`) || locked.has(`day:${found.day.dayNumber}`)) {
          refused.push({ op: operation.op, ref: operation.id, reason: because([`activity:${operation.id}`, `day:${found.day.dayNumber}`], 'experience') });
          break;
        }
        const previous = found.day.anchors[found.index]!;
        found.day.anchors[found.index] = anchorFrom(operation.activity, found.index, previous.role);
        applied.push(`replaced ${previous.name} with ${operation.activity.name} on day ${found.day.dayNumber}`);
        break;
      }
      case 'remove_activity': {
        const found = locate(operation.id);
        if (!found) {
          refused.push({ op: operation.op, ref: operation.id, reason: 'no such activity in this draft' });
          break;
        }
        if (locked.has(`activity:${operation.id}`) || locked.has(`day:${found.day.dayNumber}`)) {
          refused.push({ op: operation.op, ref: operation.id, reason: because([`activity:${operation.id}`, `day:${found.day.dayNumber}`], 'experience') });
          break;
        }
        const [removed] = found.day.anchors.splice(found.index, 1);
        applied.push(`removed ${removed?.name ?? operation.id} from day ${found.day.dayNumber}: ${operation.reason}`);
        break;
      }
      case 'move_activity': {
        const found = locate(operation.id);
        const target = dayOf(operation.toDay);
        if (!found || !target) {
          refused.push({ op: operation.op, ref: operation.id, reason: found ? 'the trip has no such day' : 'no such activity in this draft' });
          break;
        }
        if (locked.has(`activity:${operation.id}`) || locked.has(`day:${found.day.dayNumber}`) || locked.has(`day:${operation.toDay}`)) {
          refused.push({ op: operation.op, ref: operation.id, reason: because([`activity:${operation.id}`, `day:${found.day.dayNumber}`, `day:${operation.toDay}`], 'experience') });
          break;
        }
        if (target.anchors.length >= 5) {
          refused.push({ op: operation.op, ref: operation.id, reason: `day ${operation.toDay} already holds five experiences` });
          break;
        }
        const [moved] = found.day.anchors.splice(found.index, 1);
        if (!moved) break;
        target.anchors.splice(Math.min(operation.at ?? target.anchors.length, target.anchors.length), 0, moved);
        applied.push(`moved ${moved.name} from day ${found.day.dayNumber} to day ${operation.toDay}`);
        break;
      }
      case 'update_day': {
        const day = dayOf(operation.day);
        if (!day) {
          refused.push({ op: operation.op, ref: `day ${operation.day}`, reason: 'the trip has no such day' });
          break;
        }
        if (locked.has(`day:${operation.day}`)) {
          refused.push({ op: operation.op, ref: `day ${operation.day}`, reason: because([`day:${operation.day}`], 'day') });
          break;
        }
        if (operation.theme !== undefined) day.theme = operation.theme;
        if (operation.intensity !== undefined) day.intensity = operation.intensity;
        if (operation.why !== undefined) day.whyItFits = operation.why;
        if (operation.partOf !== undefined) day.partOf = operation.partOf;
        if (operation.meals) day.meals = { ...(day.meals ?? {}), ...operation.meals };
        applied.push(`updated day ${operation.day}`);
        break;
      }
      case 'update_base':
      case 'replace_base': {
        const base = draft.bases.find((entry) => entry.id === operation.id);
        if (!base) {
          refused.push({ op: operation.op, ref: operation.id, reason: 'no such stay in this draft' });
          break;
        }
        if (locked.has(`base:${operation.id}`) || locked.has(`lodging:${operation.id}`)) {
          refused.push({ op: operation.op, ref: operation.id, reason: because([`base:${operation.id}`, `lodging:${operation.id}`], 'stay') });
          break;
        }
        const wasName = base.name;
        const wasNights = base.nights;
        if (operation.op === 'replace_base') base.name = operation.name;
        if (operation.nights !== undefined) base.nights = operation.nights;
        if (operation.why !== undefined) base.why = operation.why;
        if (operation.lodgingArea !== undefined) base.lodgingArea = operation.lodgingArea;
        if (operation.lodgingStyle !== undefined) base.lodgingStyle = operation.lodgingStyle;
        if (operation.overnight !== undefined) base.overnight = operation.overnight;
        if (operation.op === 'replace_base') applied.push(`replaced the stay in ${wasName} with ${base.name} (${base.nights} night${base.nights === 1 ? '' : 's'})`);
        else if (operation.nights !== undefined && operation.nights !== wasNights) applied.push(operation.nights === 0 ? `dropped the night${wasNights === 1 ? '' : 's'} in ${base.name}` : `${base.name}: ${wasNights} → ${operation.nights} night${operation.nights === 1 ? '' : 's'}`);
        else applied.push(`updated the stay in ${base.name}`);
        break;
      }
      case 'update_transport': {
        if (locked.has('trip_fact:transport')) {
          refused.push({ op: operation.op, ref: 'transport', reason: 'the traveller locked the transport plan' });
          break;
        }
        if (operation.summary !== undefined) draft.package.transport.summary = operation.summary;
        if (operation.notes !== undefined) draft.package.transport.notes = [...operation.notes];
        if (operation.driving !== undefined) draft.driving = operation.driving;
        applied.push('updated the transport plan');
        break;
      }
      case 'update_timing': {
        if (locked.has('timing:trip')) {
          refused.push({ op: operation.op, ref: 'timing', reason: 'the traveller locked the dates' });
          break;
        }
        if (operation.startDate && operation.endDate) draft.window = { startDate: operation.startDate, endDate: operation.endDate };
        if (operation.rationale !== undefined) draft.timingRationale = operation.rationale;
        applied.push('updated the timing');
        break;
      }
      case 'update_trip_thesis': {
        if (operation.purpose !== undefined) draft.purpose = operation.purpose;
        if (operation.routeRationale !== undefined) draft.routeRationale = operation.routeRationale;
        if (operation.signatures !== undefined) draft.signatures = [...operation.signatures];
        applied.push('updated the trip thesis');
        break;
      }
      case 'update_preference': {
        /*
         * A preference is a fact about the traveller, not about the trip, so it
         * is recorded here as a note and applied to the profile by the caller.
         * Writing a profile from inside a draft patcher would put two owners on
         * the same value.
         */
        applied.push(`noted preference ${operation.field} = ${operation.value}`);
        break;
      }
    }
  }

  /* Day numbers and base references are re-derived, never trusted from the patch. */
  draft.days.forEach((day, position) => {
    day.dayNumber = position + 1;
  });
  /*
   * V6 — A NIGHT MOVED IS A BED MOVED.
   *
   * "A third night at Akan-ko instead of Obihiro" is two nights figures and,
   * downstream of them, the days that now sleep somewhere else. The model
   * writes the figures; the day-to-stay assignment is re-derived here from
   * the sequence, and only for the days whose stay actually moves, so a day
   * the nights do not reach keeps the assignment the composition gave it. A
   * stay left with no nights leaves the draft.
   */
  const nightsChanged = draft.bases.some((base) => input.draft.bases.find((original) => original.id === base.id)?.nights !== base.nights);
  if (nightsChanged) {
    /*
     * V9.1 — THE SEQUENCE IS THE TRUTH ABOUT WHERE A NIGHT IS SPENT.
     *
     * Every day is re-derived from the nights sequence once the nights move.
     * The V6 rule kept a day the nights "did not reach" on the id the
     * composition gave it, and the live Iceland draft showed why that cannot
     * hold: two stays named Reykjavík, and days 1–2 carrying the *return*
     * stay's id, so the first stay was "a stay no day uses" and every patch
     * was refused. A day is told it moved only when the *name* of its stay
     * changes — the same town under a different id is not a move.
     */
    const after = dayBaseMap(draft.bases, draft.days.length);
    const surviving = new Set(draft.bases.filter((base) => base.nights > 0).map((base) => base.id));
    const nameOf = (id: string) => draft.bases.find((base) => base.id === id)?.name ?? input.draft.bases.find((base) => base.id === id)?.name ?? id;
    const moved = new Map<string, number[]>();
    draft.days.forEach((day, index) => {
      const target = after[index];
      if (!target || !surviving.has(target) || day.baseId === target) return;
      const renamed = nameOf(day.baseId) !== nameOf(target);
      day.baseId = target;
      if (renamed) moved.set(target, [...(moved.get(target) ?? []), day.dayNumber]);
    });
    draft.bases = draft.bases.filter((base) => base.nights > 0);
    for (const [baseId, days] of moved) {
      const name = draft.bases.find((base) => base.id === baseId)?.name ?? baseId;
      applied.push(`day${days.length === 1 ? '' : 's'} ${listOfDays(days)} now sleep${days.length === 1 ? 's' : ''} in ${name}`);
    }
  }
  const parsed = tripDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return { ok: false, draft: input.draft, applied, refused: [...refused, { op: 'update_day', ref: 'draft', reason: `the change would leave the trip not valid: ${parsed.error.issues[0]?.message ?? 'unknown'}` }] };
  }

  /*
   * §9 — STRUCTURAL VALIDITY, AND ATOMICITY.
   *
   * The schema proves the shape; `invariants.ts` proves the trip. A violation
   * here throws the WHOLE patch away and returns the draft that came in, because
   * these are the failures a traveller cannot see and cannot recover from: a day
   * with no bed, two days numbered the same, the same experience twice, a booking
   * whose stay the patch deleted. Everything applied so far is discarded with it
   * — a half-applied structural change is the one state nothing downstream can
   * reason about.
   */
  const windowMutated = input.patch.operations.some((operation) => operation.op === 'update_timing' && operation.startDate !== undefined && operation.endDate !== undefined);
  const violations = patchInvariantViolations({ draft: parsed.data, booked: input.booked, windowMutated, today: input.today });
  if (violations.length > 0) {
    return { ok: false, draft: input.draft, applied: [], refused: [...refused, ...violations.map((violation) => ({ op: 'update_day' as const, ref: 'trip', reason: `the change would leave the trip not valid: ${violation}` }))] };
  }
  return { ok: refused.length === 0, draft: parsed.data, applied, refused };
}

function anchorFrom(activity: z.infer<typeof patchActivitySchema>, position: number, fallbackRole?: TripDraft['days'][number]['anchors'][number]['role']): TripDraft['days'][number]['anchors'][number] {
  return {
    name: activity.name,
    ...(activity.near ? { locality: activity.near } : {}),
    category: activity.kind,
    role: activity.role ?? fallbackRole ?? (position === 0 ? 'core' : position <= 2 ? 'secondary' : 'optional'),
    ...(activity.mins !== undefined ? { estimatedDurationMinutes: activity.mins } : {}),
    ...(activity.how ? { transport: activity.how } : {}),
    ...(activity.when && activity.when !== 'any' ? { timeOfDay: activity.when as TripDraft['days'][number]['anchors'][number]['timeOfDay'] } : {}),
    why: activity.why,
  };
}
