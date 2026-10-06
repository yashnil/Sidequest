import { describe, expect, it } from 'vitest';
import type { DiscoverySelection, Itinerary } from '@sidequest/core';
import { reconcileTripDraft } from '@/lib/planning/reconcile';
import { addCustomStop, moveStopToDay, removeStopFromReconciledItinerary, setStopDuration, setStopKeep } from '@/lib/planning/reconciled-edits';
import { draftOf, fictionalWorld } from '@/lib/planning/acceptance/harness';
import { keepsToCarry, regenerationCopy, regenerationPreview } from './regenerate-summary';

/**
 * V1 CONVERGENCE — the Regenerate confirmation says only what is true.
 *
 * Driven by the real edit verbs (`reconciled-edits.ts`), so a reworded revision
 * sentence or a new kind of edit shows up here rather than as a confirmation
 * that promises to keep something the rebuild throws away.
 */
const PLACES = [
  { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' as const },
  { name: 'Old Fort', lat: 50.05, lng: 10.02 },
  { name: 'River Walk', lat: 50.02, lng: 10.08 },
  { name: 'Hill Chapel', lat: 50.09, lng: 10.11 },
  { name: 'Market Hall', lat: 50.01, lng: 9.95 },
];

async function plan(): Promise<Itinerary> {
  const world = fictionalWorld({ name: 'Editland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-03' }, roadKmh: 40 });
  const draft = draftOf({
    bases: [{ id: 'b1', name: 'Base Town', nights: 2 }],
    days: [
      { base: 'b1', anchors: [{ name: 'Old Fort', minutes: 90 }, { name: 'River Walk', role: 'optional', minutes: 60 }, { name: 'Market Hall', role: 'secondary', minutes: 60 }] },
      { base: 'b1', anchors: [{ name: 'Hill Chapel', minutes: 60 }] },
      { base: 'b1', anchors: [{ name: 'Old Fort', minutes: 45 }] },
    ],
  });
  return (await reconcileTripDraft({ draft, context: world.context })).itinerary;
}

const activity = (it: Itinerary, day: number, name: RegExp) => it.days.find((d) => d.dayNumber === day)!.items.find((i) => i.kind === 'activity' && name.test(i.title))!;
const row = (placeId: string, status: DiscoverySelection['status'], source: DiscoverySelection['source'] = 'user'): DiscoverySelection => ({ placeId, status, source, updatedAt: '2026-01-01T00:00:00Z' });

describe('Regenerate — what it keeps and what it replaces', () => {
  it('a fresh plan with no edits never says edits will be replaced', async () => {
    const it0 = await plan();
    const preview = regenerationPreview({ itinerary: it0, locks: [], selections: [row('x', 'included'), row('y', 'excluded'), row('z', 'included', 'auto')], bookings: 0 });
    expect(preview.manualEdits).toEqual([]);
    const copy = regenerationCopy(preview);
    expect(copy.replaced).toEqual([]);
    expect(copy.kept).toMatch(/your 2 Discovery Board decisions/);
    expect(copy.kept).toMatch(/who is travelling/);
    expect(copy.kept).not.toMatch(/booking/);
  });

  it('moves, custom stops and duration changes are counted as replaced; removals and must-keep marks are not', async () => {
    let it1 = await plan();
    const river = activity(it1, 1, /River Walk/);
    const moved = moveStopToDay(it1, 1, river.placeId ?? river.id, 3);
    if (!moved.ok) throw new Error('move failed');
    it1 = moved.itinerary;
    const custom = addCustomStop(it1, 2, { title: 'Picnic by the bridge', minutes: 45 });
    if (!custom.ok) throw new Error('custom failed');
    it1 = custom.itinerary;
    const chapel = activity(it1, 2, /Hill Chapel/);
    const longer = setStopDuration(it1, 2, chapel.placeId ?? chapel.id, 120);
    if (!longer.ok) throw new Error('duration failed');
    it1 = longer.itinerary;
    const fort = activity(it1, 1, /Old Fort/);
    const kept = setStopKeep(it1, 1, fort.placeId ?? fort.id, 'must_keep');
    if (!kept.ok) throw new Error('keep failed');
    it1 = kept.itinerary;
    const market = activity(it1, 1, /Market Hall/);
    const removed = removeStopFromReconciledItinerary(it1, 1, market.placeId ?? market.id);
    if (!removed.ok) throw new Error('remove failed');
    it1 = removed.itinerary;

    const preview = regenerationPreview({ itinerary: it1, locks: [], selections: [], bookings: 2 });
    expect(preview.manualEdits).toHaveLength(3);
    const copy = regenerationCopy(preview);
    expect(copy.replaced[0]).toMatch(/^Replaced: the 3 changes you made on this itinerary/);
    expect(copy.kept).toMatch(/your 2 bookings/);
  });

  it('a must-keep or locked board place is carried as the traveller’s own include; one off the board is named as not carried', async () => {
    let it2 = await plan();
    const fort = activity(it2, 1, /Old Fort/);
    const chapel = activity(it2, 2, /Hill Chapel/);
    const kept = setStopKeep(it2, 1, fort.placeId ?? fort.id, 'must_keep');
    if (!kept.ok) throw new Error('keep failed');
    it2 = kept.itinerary;
    const fortId = it2.package!.anchors.find((a) => a.name === 'Old Fort' && a.note)!.placeId!;
    expect(fortId).toBeTruthy();
    const chapelId = chapel.placeId!;
    const selections = [row(fortId, 'included', 'auto')];
    const preview = regenerationPreview({ itinerary: it2, locks: [{ placeId: chapelId, dayNumber: 2 }], selections, bookings: 0 });
    expect(preview.carriedKeeps.map((k) => k.name)).toEqual(['Old Fort']);
    expect(preview.uncarriedKeeps.map((k) => k.name)).toEqual(['Hill Chapel']);
    expect(keepsToCarry(preview, selections)).toEqual([fortId]);
    /* Already the traveller's own include: nothing to write. */
    expect(keepsToCarry(preview, [row(fortId, 'included', 'user')])).toEqual([]);
    const copy = regenerationCopy(preview);
    expect(copy.kept).toMatch(/Old Fort, which you marked must-keep or locked — it stays in, and a locked stop keeps its day/);
    expect(copy.replaced.join(' ')).toMatch(/Hill Chapel is not on your Discovery Board, so the new plan may leave it out/);
  });

  it('a skipped board place marked must-keep is not carried back in behind the traveller’s back', async () => {
    let it3 = await plan();
    const fort = activity(it3, 1, /Old Fort/);
    const kept = setStopKeep(it3, 1, fort.placeId ?? fort.id, 'must_keep');
    if (!kept.ok) throw new Error('keep failed');
    it3 = kept.itinerary;
    const fortId = it3.package!.anchors.find((a) => a.name === 'Old Fort' && a.note)!.placeId!;
    const preview = regenerationPreview({ itinerary: it3, locks: [], selections: [row(fortId, 'excluded')], bookings: 0 });
    expect(preview.carriedKeeps).toEqual([]);
    expect(keepsToCarry(preview, [row(fortId, 'excluded')])).toEqual([]);
  });
});
