import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { draftDelta } from '@sidequest/core';
import { tripDraftSchema, type TripDraft } from '../planning/trip-draft';
import { applyTripPatch, dayBaseMap, expandRestructure, patchReach, tripPatchSchema } from './patch';

/**
 * V9.1 CLOSURE §3 — TOPOLOGY FROM THE MODEL, ARITHMETIC FROM SIDEQUEST.
 *
 * A live call returned a schema-valid restructure under a legal intent whose
 * stays totalled eleven nights on a nine-night trip. The night counts were
 * never the model's to know: the trip's dates fix them and `dayBaseMap`
 * already derives which day sleeps where. The operation now carries only which
 * stays become one, and every number below is computed here rather than
 * accepted.
 *
 * The invariant these tests exist for: **derived stay nights equal the trip's
 * nights, for every accepted patch, without the model having added anything
 * up.** It holds by construction — a merge moves nights between two stays that
 * already exist — so the tests check the construction rather than a checksum.
 */
const FIXTURE = join(__dirname, '..', 'planning', 'acceptance', 'fixtures', 'iceland', 'live-v9-draft.json');
const draft: TripDraft = tripDraftSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
const PRISTINE = JSON.stringify(draft);
const TRIP_NIGHTS = draft.bases.reduce((n, b) => n + b.nights, 0);

/** Reykjavík 2 · Vík 2 · Höfn area 2 · Selfoss 2 · Reykjavík 1 = 9 nights over 10 days. */
const merge = (...steps: { from: string; into: string }[]) =>
  tripPatchSchema.parse({ operations: [{ op: 'restructure', merge: steps, why: 'Fewer hotel changes.' }] });

const nightsOf = (d: TripDraft) => d.bases.filter((b) => b.nights > 0).map((b) => `${b.name}:${b.nights}`);
const staysIn = (d: TripDraft) => d.bases.filter((b) => b.nights > 0).length;
const hotelChanges = (d: TripDraft) => Math.max(0, staysIn(d) - 1);

/**
 * A four-stay shape over the same ten days, so the matrix is not proved on one
 * topology alone: Reykjavík 2 · Vík 3 · Höfn area 2 · Selfoss 2 = 9 nights.
 * (The days are the fixture's own; inventing an eleventh would mean repeating
 * a day's stops, which a different invariant rightly refuses.)
 */
function fourStayDraft(): TripDraft {
  const bases = [
    { ...draft.bases[0]!, nights: 2 },
    { ...draft.bases[1]!, nights: 3 },
    { ...draft.bases[2]!, nights: 2 },
    { ...draft.bases[3]!, nights: 2 },
  ];
  const map = dayBaseMap(bases, draft.days.length);
  return tripDraftSchema.parse({
    ...draft,
    bases,
    days: draft.days.map((day, index) => ({ ...day, baseId: map[index]! })),
  });
}

describe('valid topologies', () => {
  it('9 nights, 5 stays → 3 stays, and the nights are derived rather than supplied', () => {
    const patch = merge({ from: 'hofn-area', into: 'vik' }, { from: 'selfoss', into: 'vik' });
    const expanded = expandRestructure(patch, draft);
    expect(expanded.refused).toEqual([]);
    /* Every operation the model never wrote: each night count here was computed by the fold. */
    expect(expanded.patch.operations.every((op) => op.op === 'update_base' || op.op === 'replace_base')).toBe(true);

    const applied = applyTripPatch({ draft, patch });
    expect(applied.ok).toBe(true);
    expect(staysIn(applied.draft)).toBe(3);
    expect(hotelChanges(applied.draft)).toBeLessThan(hotelChanges(draft));
    expect(nightsOf(applied.draft)).toEqual(['Reykjavík:2', 'Vík:6', 'Reykjavík:1']);
    /* The invariant. */
    expect(applied.draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(TRIP_NIGHTS);
    /* And the trip is still ten days long, every one of them sleeping somewhere. */
    expect(applied.draft.days).toHaveLength(draft.days.length);
    expect(applied.draft.days.every((day) => applied.draft.bases.some((b) => b.id === day.baseId && b.nights > 0))).toBe(true);
  });

  it('a four-stay trip collapses to two, on a different shape from the one above', () => {
    const four = fourStayDraft();
    const total = four.bases.reduce((n, b) => n + b.nights, 0);
    expect(total).toBe(9);
    expect(staysIn(four)).toBe(4);
    const patch = merge({ from: 'vik', into: 'reykjavik' }, { from: 'selfoss', into: 'hofn-area' });
    const applied = applyTripPatch({ draft: four, patch });
    expect(applied.ok, JSON.stringify(applied.refused)).toBe(true);
    expect(staysIn(applied.draft)).toBe(2);
    expect(applied.draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(total);
    expect(nightsOf(applied.draft)).toEqual(['Reykjavík:5', 'Höfn area:4']);
  });

  it('merging two adjacent bases moves exactly that stay’s nights and nothing else', () => {
    const applied = applyTripPatch({ draft, patch: merge({ from: 'hofn-area', into: 'vik' }) });
    expect(applied.ok).toBe(true);
    /* Vík gains Höfn's two; Reykjavík and Selfoss are untouched. */
    expect(nightsOf(applied.draft)).toEqual(['Reykjavík:2', 'Vík:4', 'Selfoss:2', 'Reykjavík:1']);
  });

  it('removes an overnight base while keeping its major experience as a day from the stay that absorbed it', () => {
    const before = draft.days.flatMap((d) => d.anchors.map((a) => a.name));
    const applied = applyTripPatch({ draft, patch: merge({ from: 'hofn-area', into: 'vik' }) });
    expect(applied.ok).toBe(true);
    /* Nothing is lost: the glacier lagoon day is still in the plan, now reached from Vík. */
    const after = applied.draft.days.flatMap((d) => d.anchors.map((a) => a.name));
    expect(after).toEqual(before);
    expect(applied.draft.signatures).toEqual(draft.signatures);
    /* Every day that used to sleep at Höfn now sleeps at the stay that took it on. */
    expect(applied.draft.days.some((d) => d.baseId === 'hofn-area')).toBe(false);
  });

  it('keeps a booked or locked stay exactly as it was, and refuses the merge that would move it', () => {
    const locked = applyTripPatch({ draft, patch: merge({ from: 'hofn-area', into: 'vik' }), locked: ['base:hofn-area'], travellerLocked: ['base:hofn-area'] });
    expect(locked.refused.some((r) => r.ref === 'hofn-area' && /locked/.test(r.reason))).toBe(true);
    expect(locked.draft.bases.find((b) => b.id === 'hofn-area')!.nights).toBe(2);
    expect(locked.draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(TRIP_NIGHTS);
  });
});

describe('invalid topologies, each refused for what is actually wrong', () => {
  const cases: [string, ReturnType<typeof merge>, RegExp][] = [
    ['a stay that does not exist', merge({ from: 'akureyri', into: 'vik' }), /no such stay/],
    ['a stay merged into one that does not exist', merge({ from: 'vik', into: 'akureyri' }), /no such stay/],
    ['a stay merged into itself', merge({ from: 'vik', into: 'vik' }), /merged into itself/],
    ['two stays that are not neighbours', merge({ from: 'reykjavik', into: 'selfoss' }), /not next to each other/],
    ['a stay already folded away earlier in the same patch', merge({ from: 'hofn-area', into: 'vik' }, { from: 'hofn-area', into: 'selfoss' }), /no nights left/],
  ];
  it.each(cases)('refuses %s', (_label, patch, reason) => {
    const expanded = expandRestructure(patch, draft);
    expect(expanded.refused[0]?.reason).toMatch(reason);
    const applied = applyTripPatch({ draft, patch });
    expect(applied.applied).toEqual([]);
    /* Nothing is clamped or invented: the draft is exactly as it arrived. */
    expect(JSON.stringify(draft)).toBe(PRISTINE);
  });

  it('a single-base trip is a legal topology, and still holds every night', () => {
    /*
     * Folding every stay into the first is legal one merge at a time — each
     * becomes the neighbour of the first once the ones between it are gone —
     * and a one-base trip is a real trip. What matters is that the nights
     * survive the collapse, which they do because each merge only moves them.
     */
    const everyStay = tripPatchSchema.parse({
      operations: [{ op: 'restructure', merge: draft.bases.slice(1).map((b) => ({ from: b.id, into: draft.bases[0]!.id })), why: 'One base for the whole trip.' }],
    });
    expect(expandRestructure(everyStay, draft).refused).toEqual([]);
    const applied = applyTripPatch({ draft, patch: everyStay });
    expect(applied.ok, JSON.stringify(applied.refused)).toBe(true);
    expect(staysIn(applied.draft)).toBe(1);
    expect(hotelChanges(applied.draft)).toBe(0);
    expect(applied.draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(TRIP_NIGHTS);
  });

  it('a missing or duplicated trip night is not expressible at all', () => {
    /* There is no field for a night count, so the schema itself rejects the shape that carried one. */
    const withNights = { operations: [{ op: 'restructure', stays: [{ id: 'vik', nights: 7 }], why: 'x' }] };
    expect(tripPatchSchema.safeParse(withNights).success).toBe(false);
    const withoutMerge = { operations: [{ op: 'restructure', why: 'x' }] };
    expect(tripPatchSchema.safeParse(withoutMerge).success).toBe(false);
  });
});

describe('the live Call 2 answer, as a regression', () => {
  /**
   * Call 2 returned a schema-valid patch under the legal intent `change_stay`
   * whose stays totalled eleven nights on a nine-night trip, and which left a
   * stay no day used. The response body itself was not persisted, so this is
   * its recorded *effect* rather than its bytes: the shape it must have had
   * under the old wire, and what happens to that shape now.
   *
   * Its structural intent — fold Höfn into a neighbour to lose a hotel change
   * — is sound. Only the arithmetic was wrong, and the arithmetic is no longer
   * the model's to supply.
   */
  it('cannot be expressed any more: the wire has no field for the number it got wrong', () => {
    const asCall2Sent = {
      operations: [
        {
          op: 'restructure',
          stays: [
            { id: 'hofn-area', nights: 0 },
            { id: 'vik', nights: 4 },
            { id: 'selfoss', nights: 4 },
            { id: 'reykjavik', nights: 3 },
          ],
          why: 'Fewer hotel changes.',
        },
      ],
    };
    /* 0 + 4 + 4 + 3 = 11 on a 9-night trip: the old wire accepted the shape and the invariant caught it. */
    expect(asCall2Sent.operations[0]!.stays.reduce((n, s) => n + s.nights, 0)).toBe(11);
    expect(tripPatchSchema.safeParse(asCall2Sent).success).toBe(false);
  });

  it('its structural intent, expressed as topology, now applies cleanly to exactly nine nights', () => {
    const applied = applyTripPatch({ draft, patch: merge({ from: 'hofn-area', into: 'vik' }) });
    expect(applied.ok).toBe(true);
    expect(applied.refused).toEqual([]);
    expect(applied.draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(9);
    expect(hotelChanges(applied.draft)).toBe(hotelChanges(draft) - 1);
    /* Every signature experience survives, which is the half of the request the numbers never touched. */
    expect(applied.draft.signatures).toEqual(draft.signatures);
    expect(applied.draft.days.reduce((n, d) => n + d.anchors.length, 0)).toBe(draft.days.reduce((n, d) => n + d.anchors.length, 0));
  });

  it('the deterministic delta reads the change the traveller asked for', () => {
    const applied = applyTripPatch({ draft, patch: merge({ from: 'hofn-area', into: 'vik' }) });
    const shape = (d: TripDraft) => ({
      bases: d.bases.map((b) => ({ id: b.id, name: b.name, nights: b.nights })),
      days: d.days.map((day) => ({ dayNumber: day.dayNumber, baseId: day.baseId, anchors: day.anchors.map((a) => ({ name: a.name, role: a.role, transport: a.transport })) })),
    });
    const delta = draftDelta(shape(draft), shape(applied.draft));
    expect(delta.lines.find((l) => l.label === 'Hotel changes')?.after).toBe('3');
    expect(delta.signatureKept.kept).toBe(delta.signatureKept.total);
  });

  it('reaches only the stays it touched', () => {
    const reach = patchReach(merge({ from: 'hofn-area', into: 'vik' }), draft);
    expect([...reach.bases].sort()).toEqual(['hofn-area', 'vik']);
    expect(reach.days.length).toBeGreaterThan(0);
    expect(reach.days.length).toBeLessThan(draft.days.length);
  });
});
