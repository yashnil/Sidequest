import { describe, expect, it } from 'vitest';
import type { Itinerary } from '@sidequest/core';
import { baseRouteOf, dayCardModel, overviewCardModel, readinessFromFeasibility } from './trip-cards';

/**
 * V9 §11 — A PICTURE OF A TRIP CARRIES NO PRIVATE FACT.
 *
 * The models are the whole of what the PNG routes draw, so what is asserted
 * here is what can appear on a share preview: destination, dates, the bases
 * in order, a readiness word from the feasibility report — and nothing about
 * bookings, prices, references or the party.
 */
const trip = { basics: { destinationInput: 'Iceland' } } as never;

const item = (id: string, kind: 'activity' | 'meal' | 'free_time', start: number, title: string) => ({ id, kind, title, startMinute: start, endMinute: start + 60, durationMinutes: 60, reason: 'x', weatherSensitive: false });

const itinerary = {
  tripId: 't',
  startDate: '2026-09-20',
  endDate: '2026-09-23',
  baseId: 'rvk',
  baseName: 'Reykjavík',
  days: [
    { dayNumber: 1, date: '2026-09-20', baseId: 'rvk', baseName: 'Reykjavík', theme: 'Arrival and the harbour', items: [item('a', 'activity', 600, 'Harpa'), item('b', 'meal', 780, 'Lunch at the harbour')] },
    { dayNumber: 2, date: '2026-09-21', baseId: 'rvk', baseName: 'Reykjavík', theme: 'Golden Circle', items: [item('c', 'activity', 540, 'Þingvellir'), item('d', 'activity', 720, 'Geysir'), item('e', 'activity', 840, 'Gullfoss'), item('f', 'activity', 960, 'Kerið'), item('g', 'activity', 1020, 'Secret Lagoon'), item('h', 'activity', 1080, 'Friðheimar')] },
    { dayNumber: 3, date: '2026-09-22', baseId: 'vik', baseName: 'Vík', theme: 'South coast', items: [item('i', 'activity', 600, 'Seljalandsfoss')] },
    { dayNumber: 4, date: '2026-09-23', baseId: 'vik', baseName: 'Vík', theme: 'Departure', items: [item('j', 'free_time', 600, 'Free time')] },
  ],
  package: {
    bases: [
      { id: 'rvk', name: 'Reykjavik', displayName: 'Reykjavík', nights: 2 },
      { id: 'vik', name: 'Vik', displayName: 'Vík', nights: 1 },
    ],
    anchors: [],
    feasibility: { version: 1, verdict: 'feasible_with_cautions', items: [], summary: 'ok' },
  },
} as unknown as Itinerary;

describe('overviewCardModel', () => {
  const model = overviewCardModel(trip, itinerary);

  it('names the destination, the dates, the day and stop counts, and the bases in order with nights', () => {
    expect(model.destination).toBe('Iceland');
    expect(model.dayCount).toBe(4);
    expect(model.stopCount).toBe(8);
    expect(model.dates).toContain('20');
    expect(model.route).toEqual([
      { name: 'Reykjavík', nights: 2 },
      { name: 'Vík', nights: 1 },
    ]);
  });

  it('takes its readiness word from the feasibility report alone', () => {
    expect(model.readiness).toEqual({ label: 'Nearly ready', tone: 'nearly' });
    expect(readinessFromFeasibility('feasible')).toEqual({ label: 'Ready', tone: 'ready' });
    expect(readinessFromFeasibility(undefined)).toBeNull();
    expect(overviewCardModel(trip, { ...itinerary, package: undefined } as Itinerary).readiness).toBeNull();
  });

  it('carries no field for bookings, prices, references or the party', () => {
    const keys = Object.keys(model).sort();
    expect(keys).toEqual(['dates', 'dayCount', 'destination', 'readiness', 'route', 'stopCount']);
  });

  it('uses the day base name when the plan has no package', () => {
    expect(baseRouteOf({ ...itinerary, package: undefined } as Itinerary).map((b) => b.name)).toEqual(['Reykjavík', 'Vík']);
  });
});

describe('dayCardModel', () => {
  it('shows up to five stops with times and counts the rest', () => {
    const model = dayCardModel(trip, itinerary, itinerary.days[1]!);
    expect(model.dayNumber).toBe(2);
    expect(model.dayCount).toBe(4);
    expect(model.theme).toBe('Golden Circle');
    expect(model.base).toBe('Reykjavík');
    expect(model.stops).toHaveLength(5);
    expect(model.stops[0]).toEqual({ time: '09:00', title: 'Þingvellir' });
    expect(model.more).toBe(1);
  });

  it('lets meals fill a quiet day, and says when nothing is timed', () => {
    expect(dayCardModel(trip, itinerary, itinerary.days[0]!).stops.map((s) => s.title)).toEqual(['Harpa', 'Lunch at the harbour']);
    const quiet = dayCardModel(trip, itinerary, itinerary.days[3]!);
    expect(quiet.stops).toEqual([]);
    expect(quiet.more).toBe(0);
  });
});
