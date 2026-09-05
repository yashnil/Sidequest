import { describe, expect, it } from 'vitest';
import { itinerarySchema } from '@sidequest/core';
import { reconcileTripDraft } from './reconcile';
import { addCustomStop, moveStopToDay, setStopDuration, setStopKeep, shiftStop } from './reconciled-edits';
import { repairReconciledDay } from './day-repair';
import { draftOf, fictionalWorld } from './acceptance/harness';

/**
 * LIVE WORLD V1 — day editing and deterministic repair, on a reconciled plan.
 * No model, no provider: every verb is local and every leg it touches is
 * honestly un-measured rather than carrying a figure for a drive nobody timed.
 */
const PLACES = [
  { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' as const },
  { name: 'Old Fort', lat: 50.05, lng: 10.02 },
  { name: 'River Walk', lat: 50.02, lng: 10.08 },
  { name: 'Hill Chapel', lat: 50.09, lng: 10.11 },
  { name: 'Market Hall', lat: 50.01, lng: 9.95 },
  { name: 'Lake Shore', lat: 50.12, lng: 10.2 },
];

async function plan() {
  const world = fictionalWorld({ name: 'Editland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { startDate: '2026-05-01', endDate: '2026-05-03' }, roadKmh: 40 });
  const draft = draftOf({
    bases: [{ id: 'b1', name: 'Base Town', nights: 2 }],
    days: [
      { base: 'b1', anchors: [{ name: 'Old Fort', minutes: 90 }, { name: 'River Walk', role: 'optional', minutes: 60 }, { name: 'Market Hall', role: 'secondary', minutes: 60 }] },
      { base: 'b1', anchors: [{ name: 'Hill Chapel', minutes: 60 }, { name: 'Lake Shore', role: 'optional', minutes: 120 }] },
      { base: 'b1', anchors: [{ name: 'Old Fort', minutes: 45 }] },
    ],
  });
  const result = await reconcileTripDraft({ draft, context: world.context });
  return result.itinerary;
}

const activities = (it: Awaited<ReturnType<typeof plan>>, day: number) => it.days.find((d) => d.dayNumber === day)!.items.filter((i) => i.kind === 'activity');
const legs = (it: Awaited<ReturnType<typeof plan>>, day: number) => it.days.find((d) => d.dayNumber === day)!.items.filter((i) => i.kind === 'travel');

describe('LIVE WORLD V1 — day edits', () => {
  it('moves a stop to another day: both days re-time, the moved leg is honestly unmeasured, the package records the new day, the result validates', async () => {
    const before = await plan();
    const stop = activities(before, 1).find((i) => /River Walk/.test(i.title))!;
    const result = moveStopToDay(before, 1, stop.placeId ?? stop.id, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(itinerarySchema.safeParse(result.itinerary).success).toBe(true);
    expect(activities(result.itinerary, 1).map((i) => i.title)).not.toContain(stop.title);
    expect(activities(result.itinerary, 3).map((i) => i.title)).toContain(stop.title);
    const movedLeg = legs(result.itinerary, 3).find((l) => l.travel?.toName === stop.title)!;
    expect(movedLeg.travel?.provenance).toBe('unmeasured');
    expect(movedLeg.travel?.unmeasuredReason).toBe('not_remeasured_after_edit');
    const anchor = result.itinerary.package!.anchors.find((a) => a.name === 'River Walk' && a.dayNumber === 1)!;
    expect(anchor.scheduledDayNumber).toBe(3);
    expect(result.itinerary.diagnostics.revisions.at(-1)?.code).toBe('traveller_edit');
    // Nothing on the untouched day changed.
    expect(result.itinerary.days[1]).toEqual(before.days[1]);
  });

  it('shifts a stop earlier, keeps every stop, and un-measures only the legs whose pair changed', async () => {
    const before = await plan();
    const [first, second] = activities(before, 1);
    const measuredBefore = legs(before, 1).filter((l) => l.travel?.provenance === 'measured').length;
    const result = shiftStop(before, 1, second!.placeId ?? second!.id, 'earlier');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(activities(result.itinerary, 1).map((i) => i.title).slice(0, 2)).toEqual([second!.title, first!.title]);
    expect(activities(result.itinerary, 1)).toHaveLength(3);
    const measuredAfter = legs(result.itinerary, 1).filter((l) => l.travel?.provenance === 'measured').length;
    expect(measuredAfter).toBeLessThan(measuredBefore);
    expect(legs(result.itinerary, 1).filter((l) => l.travel?.provenance === 'unmeasured').every((l) => l.travel?.unmeasuredReason === 'not_remeasured_after_edit')).toBe(true);
    expect(itinerarySchema.safeParse(result.itinerary).success).toBe(true);
    expect(shiftStop(before, 1, first!.placeId ?? first!.id, 'earlier').ok).toBe(false);
  });

  it('changes a stop’s duration and refuses silly values', async () => {
    const before = await plan();
    const stop = activities(before, 2)[0]!;
    const result = setStopDuration(before, 2, stop.placeId ?? stop.id, 150);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(activities(result.itinerary, 2)[0]!.durationMinutes).toBe(150);
    expect(setStopDuration(before, 2, stop.placeId ?? stop.id, 5).ok).toBe(false);
  });

  it('adds a custom stop as an unverified package anchor, at the end of the day, before any return leg', async () => {
    const before = await plan();
    const result = addCustomStop(before, 2, { title: 'Harbour swim', minutes: 45 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const day = result.itinerary.days[1]!;
    const stops = day.items.filter((i) => i.kind === 'activity');
    expect(stops.at(-1)?.title).toBe('Harbour swim');
    const returnIndex = day.items.findIndex((i) => i.kind === 'travel' && i.travel?.role === 'return');
    const stopIndex = day.items.findIndex((i) => i.title === 'Harbour swim');
    if (returnIndex >= 0) expect(stopIndex).toBeLessThan(returnIndex);
    const anchor = result.itinerary.package!.anchors.find((a) => a.name === 'Harbour swim')!;
    expect(anchor.verification).toBe('unverified');
    expect(anchor.role).toBe('optional');
    expect(result.itinerary.package!.anchors.length).toBe(before.package!.anchors.length + 1);
    expect(itinerarySchema.safeParse(result.itinerary).success).toBe(true);
    expect(addCustomStop(before, 2, { title: 'x' }).ok).toBe(false);
  });

  it('marks a stop must-keep or optional on the package', async () => {
    const before = await plan();
    const stop = activities(before, 1)[0]!;
    const optional = setStopKeep(before, 1, stop.placeId ?? stop.id, 'optional');
    expect(optional.ok && optional.itinerary.package!.anchors.find((a) => a.name === stop.title)?.role).toBe('optional');
    const core = setStopKeep(before, 1, stop.placeId ?? stop.id, 'must_keep');
    expect(core.ok && core.itinerary.package!.anchors.find((a) => a.name === stop.title)?.role).toBe('core');
  });
});

describe('LIVE WORLD V1 — fix this day', () => {
  it('trims an over-long day by its least-committed stops, never a must-keep one, and names each step', async () => {
    const before = await plan();
    // Make day 1 run long: give the core stop most of the day.
    const core = activities(before, 1)[0]!;
    const long = setStopDuration(before, 1, core.placeId ?? core.id, 540);
    expect(long.ok).toBe(true);
    if (!long.ok) return;
    const repaired = repairReconciledDay(long.itinerary, 1);
    expect(repaired.ok).toBe(true);
    expect(repaired.steps.length).toBeGreaterThan(0);
    expect(repaired.steps.join(' ')).toMatch(/River Walk|Market Hall/);
    expect(activities(repaired.itinerary!, 1).map((i) => i.title)).toContain(core.title);
    expect(itinerarySchema.safeParse(repaired.itinerary).success).toBe(true);
    // A day that already fits is left alone, and says so.
    const fine = repairReconciledDay(before, 3);
    expect(fine.ok).toBe(false);
    expect(fine.message).toMatch(/already fits/);
  });
});
