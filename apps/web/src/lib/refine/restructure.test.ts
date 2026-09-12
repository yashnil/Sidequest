import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tripDraftSchema, type TripDraft } from '../planning/trip-draft';
import { applyTripPatch, expandRestructure, patchReach, tripPatchSchema } from './patch';
import { REFINEMENT_INSTRUCTION, buildRefinementTask, isStructuralRequest, refinementIndexOf, structuralIndexOf } from './interpreter';
import { REFINEMENT_INTENTS } from './state';
import { draftDelta } from '@sidequest/core';

/**
 * V9.1 — COMPACT STRUCTURAL PATCHING, ON THE DRAFT THAT TIMED OUT LIVE.
 *
 * The stored Iceland draft (10 days, 22 anchors, 5 stays) is the one whose
 * "fewer hotel changes" refinement ran past the 90 s deadline. These tests
 * prove the compact path on it: the structural index is a fraction of the
 * full one, one `restructure` operation expands into ordinary typed
 * operations, the nights invariant holds, locks still refuse, the delta
 * reads the change, and the model is never asked to restate unchanged days.
 */
const FIXTURE = join(__dirname, '..', 'planning', 'acceptance', 'fixtures', 'iceland', 'live-v9-draft.json');
const draft: TripDraft = tripDraftSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));
const REQUEST = 'Reduce the number of hotel changes without losing the defining experiences.';

describe('the structural index', () => {
  it('is a fraction of the full index and carries stays, moves, signatures, ids, roles and the two figures', () => {
    const full = JSON.stringify(refinementIndexOf({ draft, locks: [] }));
    const compact = JSON.stringify(structuralIndexOf({ draft, locks: [] }));
    expect(compact.length).toBeLessThan(full.length * 0.7);
    const index = structuralIndexOf({ draft, locks: [] }) as { figures: { nights: number; stays: number; hotelChanges: number }; days: { moves?: boolean; acts: { id: string; role: string }[] }[] };
    expect(index.figures).toEqual({ nights: 9, stays: 5, hotelChanges: 4 });
    expect(index.days.filter((d) => d.moves).length).toBeGreaterThanOrEqual(4);
    expect(index.days.every((d) => d.acts.every((a) => typeof a.id === 'string' && typeof a.role === 'string'))).toBe(true);
    expect(compact).not.toMatch(/meals|theme|intensity|"when"/);
  });

  it('a structural task is shorter and says so; the phrase table recognises structural requests and a chip hint wins', () => {
    const structural = buildRefinementTask({ draft, locks: [], request: REQUEST, structural: true });
    const full = buildRefinementTask({ draft, locks: [], request: REQUEST });
    expect(structural.length).toBeLessThan(full.length);
    expect(structural).toContain('<trip structural="true">');
    expect(structural).toContain('one restructure operation');
    /* V9.1 §4 — the nights total stated concretely, after a live answer totalled 11 on a 9-night trip. */
    expect(structural).toContain('must total exactly 9 nights');
    expect(full).not.toContain('must total exactly');
    expect(isStructuralRequest(REQUEST)).toBe(true);
    expect(isStructuralRequest('Less driving on the long days')).toBe(true);
    expect(isStructuralRequest('Make day 2 easier')).toBe(false);
    expect(isStructuralRequest('Make day 2 easier', true)).toBe(true);
    expect(REFINEMENT_INSTRUCTION).toContain('restructure');
  });
});

describe('the restructure operation', () => {
  const patch = tripPatchSchema.parse({
    operations: [{ op: 'restructure', stays: [{ id: 'hofn-area', nights: 0 }, { id: 'vik', nights: 4 }], why: 'One hotel change fewer: Höfn folds into Vík.' }],
  });

  it('expands into ordinary typed operations, keeps the nights total, and applies with the days re-derived', () => {
    const expanded = expandRestructure(patch, draft);
    expect(expanded.refused).toEqual([]);
    expect(expanded.patch.operations.map((o) => o.op)).toEqual(['update_base', 'update_base']);
    const applied = applyTripPatch({ draft, patch });
    expect(applied.ok).toBe(true);
    expect(applied.draft.bases.map((b) => [b.id, b.nights])).toEqual([['reykjavik', 2], ['vik', 4], ['selfoss', 2], ['reykjavik-2', 1]]);
    expect(applied.draft.bases.reduce((n, b) => n + b.nights, 0)).toBe(9);
    expect(applied.applied.some((line) => /now sleep/.test(line))).toBe(true);
    /* Every anchor survives: a restructure moves beds, never experiences. */
    expect(applied.draft.days.reduce((n, d) => n + d.anchors.length, 0)).toBe(22);
    const reach = patchReach(patch, draft);
    expect(reach.bases).toEqual(['hofn-area', 'vik']);
    expect(reach.days.length).toBeGreaterThan(0);
  });

  it('refuses nights that do not add up, an unknown stay, or dropping every stay — never silently corrected', () => {
    const short = tripPatchSchema.parse({ operations: [{ op: 'restructure', stays: [{ id: 'hofn-area', nights: 0 }], why: 'x' }] });
    expect(expandRestructure(short, draft).refused[0]?.reason).toMatch(/add up to 7, and the trip has 9/);
    expect(applyTripPatch({ draft, patch: short }).applied).toEqual([]);
    const unknown = tripPatchSchema.parse({ operations: [{ op: 'restructure', stays: [{ id: 'akureyri', nights: 2 }], why: 'x' }] });
    expect(expandRestructure(unknown, draft).refused[0]?.reason).toMatch(/no such stay/);
    const all = tripPatchSchema.parse({ operations: [{ op: 'restructure', stays: draft.bases.map((b) => ({ id: b.id, nights: 0 })), why: 'x' }] });
    expect(expandRestructure(all, draft).refused[0]?.reason).toMatch(/every stay/);
  });

  it('a locked stay still refuses, a rename becomes a replace_base, drops and moves become their operations', () => {
    const locked = applyTripPatch({ draft, patch, locked: ['base:hofn-area'], travellerLocked: ['base:hofn-area'] });
    expect(locked.refused.some((r) => r.ref === 'hofn-area' && /locked/.test(r.reason))).toBe(true);
    const renamed = tripPatchSchema.parse({ operations: [{ op: 'restructure', stays: [{ id: 'hofn-area', nights: 0 }, { id: 'vik', nights: 4, name: 'Kirkjubæjarklaustur' }], drop: [{ id: 'd3-a2-solheimajokull', reason: 'off the new route' }], why: 'x' }] });
    const ops = expandRestructure(renamed, draft).patch.operations.map((o) => o.op);
    expect(ops).toEqual(['update_base', 'replace_base', 'remove_activity']);
  });

  it('the delta preview reads the change from the drafts: one hotel change fewer, every signature kept', () => {
    const applied = applyTripPatch({ draft, patch });
    const shape = (d: TripDraft) => ({ bases: d.bases.map((b) => ({ id: b.id, name: b.name, nights: b.nights })), days: d.days.map((day) => ({ dayNumber: day.dayNumber, baseId: day.baseId, anchors: day.anchors.map((a) => ({ name: a.name, role: a.role, transport: a.transport })) })) });
    const delta = draftDelta(shape(draft), shape(applied.draft));
    expect(delta.lines.find((l) => l.label === 'Hotel changes')?.after).toBe('3');
    expect(delta.lines.find((l) => l.label === 'Bases')?.after).toBe('4');
    expect(delta.signatureKept.kept).toBe(delta.signatureKept.total);
  });

  it('changed and kept are optional on the wire', () => {
    expect(tripPatchSchema.parse({ operations: [] })).toMatchObject({ changed: [], kept: [] });
  });

  /*
   * V9.1 — the live structural call came back in twenty seconds and was refused
   * by the schema. `intent` is a closed enum of nineteen snake_case values and
   * the contract asked for it without ever saying what they are, while it
   * carefully enumerates activity kinds, transports and times of day. A model
   * that writes a sensible word of its own ("reduce_hotel_changes") is refused
   * for a reason nobody told it about.
   */
  it('names every intent it will accept, so the closed enum is never guessed at', () => {
    for (const intent of REFINEMENT_INTENTS) expect(REFINEMENT_INSTRUCTION).toContain(intent);
    expect(REFINEMENT_INSTRUCTION).toMatch(/intent, exactly one of:/);
  });
});
