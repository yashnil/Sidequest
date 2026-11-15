import type { Itinerary } from '@sidequest/core';
import { buildFeasibilityReport } from '@sidequest/core';
import { reconcileTripDraft } from '../reconcile';
import { draftOf, fictionalWorld } from './harness';

/**
 * 2026-11 — A RECONCILED PLAN WITH ONE DAY OVER A HARD DAILY TRAVEL LIMIT.
 *
 * Day 2 carries the traveller's own far pick ("Far Lookout"); the record is
 * the shape `structure-repair.ts#travelLimitRecord` writes: keep the day, drop
 * the pick (by board id), and a stay change Sidequest cannot apply in place.
 * Shared by the option/apply unit tests and the server-action version tests.
 */
export const LIMITLAND_DATES = { startDate: '2026-08-01', endDate: '2026-08-03' } as const;

const PLACES = [
  { name: 'Base Town', lat: 50, lng: 10, entityType: 'city' as const },
  { name: 'Old Fort', lat: 50.05, lng: 10.02 },
  { name: 'River Walk', lat: 50.02, lng: 10.08 },
  { name: 'Far Lookout', lat: 50.3, lng: 10.05 },
  { name: 'Market Hall', lat: 50.01, lng: 9.95 },
];

async function plan(): Promise<Itinerary> {
  const world = fictionalWorld({ name: 'Limitland', center: { lat: 50, lng: 10 }, places: PLACES, basics: { ...LIMITLAND_DATES }, roadKmh: 60 });
  const draft = draftOf({
    bases: [{ id: 'b1', name: 'Base Town', nights: 2 }],
    days: [
      { base: 'b1', anchors: [{ name: 'Old Fort', minutes: 90 }, { name: 'Market Hall', minutes: 60 }] },
      { base: 'b1', anchors: [{ name: 'River Walk', minutes: 60 }, { name: 'Far Lookout', minutes: 90 }] },
      { base: 'b1', anchors: [{ name: 'Old Fort', minutes: 45 }] },
    ],
  });
  return (await reconcileTripDraft({ draft, context: world.context })).itinerary;
}

export const activities = (it: Itinerary, day: number) => it.days.find((d) => d.dayNumber === day)!.items.filter((i) => i.kind === 'activity');

/** The plan as the planner would leave it: day 2 over a 90-minute limit the traveller set, because of a pick of theirs. */
export async function overLimitItinerary(options: { hard?: boolean } = {}): Promise<{ itinerary: Itinerary; farId: string }> {
  const base = await plan();
  const far = activities(base, 2).find((i) => i.title === 'Far Lookout')!;
  const farId = far.placeId ?? far.id;
  /* The board id the planner would have written; a reconciled stop carries one where it was resolved. */
  const withId: Itinerary = far.placeId ? base : { ...base, days: base.days.map((d) => (d.dayNumber === 2 ? { ...d, items: d.items.map((i) => (i.id === far.id ? { ...i, placeId: farId } : i)) } : d)) };
  const hard = options.hard !== false;
  const travelLimit = {
    version: 1 as const,
    limitMinutes: 90,
    hard,
    daysOver: 1,
    days: [{ dayNumber: 2, travelMinutes: 200, cause: 'traveller_pick' as const }],
    choices: hard
      ? [
          { dayNumber: 2, kind: 'accept_long_day' as const, label: 'Accept about 3 h 20 of travel on day 2', detail: 'Keep day 2 as planned.', travelMinutes: 200 },
          { dayNumber: 2, kind: 'drop_stop' as const, label: 'Drop Far Lookout from day 2', detail: 'Without it day 2 has about 40 minutes of travel, inside your limit.', subject: 'Far Lookout', placeId: farId, travelMinutes: 40 },
          { dayNumber: 2, kind: 'stay_on' as const, label: 'Stay on in Base Town and skip the move', detail: 'No move on day 2.', subject: 'Base Town' },
        ]
      : [],
  };
  const pkg = withId.package!;
  const planned: Itinerary = {
    ...withId,
    package: {
      ...pkg,
      planning: { ...(pkg.planning ?? { mode: 'planner' as const, weatherMoves: [], mustConflicts: [] }), travelLimit, dayNotes: [{ dayNumber: 2, code: 'travel_over_limit', note: 'About 3 h 20 of travel today, over the 1 h 30 a day you set. Far Lookout is on your list, so it stays.' }] } as NonNullable<typeof pkg.planning>,
    },
  };
  const feasibility = buildFeasibilityReport({ itinerary: planned });
  return { itinerary: { ...planned, package: { ...planned.package!, feasibility } }, farId };
}

