import { describe, expect, it } from 'vitest';
import { planStructure, type PlannerCandidate, type StructurePlannerInput } from './structure-planner';
import { classifyDayDensity, densityNote, discoveryLossesOf, lossesAreMaterial, tripDensityLine, type DiscoveryLosses } from './day-density';

/*
 * A fictional valley with one base. Minutes are a function of straight-line
 * distance, so geography decides the days — the same harness shape as the
 * structure planner's own tests.
 */
const BASE = { id: 'base', coordinates: { lat: 46.0, lng: 7.0 } };
const DATES = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];
const NO_LOSSES: DiscoveryLosses = { bases: [], places: [] };

function c(id: string, overrides: Partial<PlannerCandidate> = {}): PlannerCandidate {
  return {
    id,
    name: id.replace(/-/g, ' '),
    locality: 'Valley',
    coordinates: { lat: 46.0, lng: 7.0 },
    durationMinutes: 90,
    intensity: 'easy',
    bestTime: 'any',
    exposure: 'outdoor',
    visibilityDependent: false,
    rainyDayOk: false,
    interests: ['scenic_viewpoints'],
    primaryInterest: 'scenic_viewpoints',
    category: 'viewpoint',
    kindLabel: 'Viewpoint',
    fit: 75,
    significance: 0.6,
    dayTrip: false,
    why: 'Fits.',
    booking: 'none',
    openOnTripDates: true,
    status: 'recommended',
    ...overrides,
  };
}

const at = (dLat: number, dLng: number) => ({ lat: 46.0 + dLat, lng: 7.0 + dLng });
const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot((a.lng - b.lng) * 77, (a.lat - b.lat) * 111);

function input(candidates: PlannerCandidate[], overrides: Partial<StructurePlannerInput> = {}): StructurePlannerInput {
  const coords = new Map<string, { lat: number; lng: number }>([[BASE.id, BASE.coordinates], ...candidates.map((x) => [x.id, x.coordinates] as const)]);
  return {
    destinationName: 'Test Valley',
    windows: DATES.map((date, i) => ({ date, startMinute: i === 0 ? 13 * 60 : 9 * 60, endMinute: i === DATES.length - 1 ? 12 * 60 : 19 * 60 })),
    bases: [{ id: BASE.id, name: 'Base Town', why: 'Central.', coordinates: BASE.coordinates, fromDate: DATES[0]!, toDate: DATES[DATES.length - 1]!, nights: DATES.length - 1, transferMinutesFromPrevious: 0 }],
    candidates,
    minutes: (a, b) => {
      const pa = coords.get(a);
      const pb = coords.get(b);
      if (!pa || !pb) return null;
      return a === b ? 0 : Math.round(8 + km(pa, pb) * 1.2);
    },
    pace: 'balanced',
    maxStopsPerDay: 3,
    carAvailable: true,
    maxDailyTravelMinutes: 240,
    maxPhysicalIntensity: 'strenuous',
    frequencyCaps: {},
    weather: [],
    foodAreas: [],
    improve: false,
    ...overrides,
  };
}

/** Twenty nearby places: far more than a slow week can hold. */
const plenty = Array.from({ length: 20 }, (_, i) => c(`place-${i + 1}`, { coordinates: at(((i % 5) - 2) * 0.02, (Math.floor(i / 5) - 2) * 0.02), interests: [(['scenic_viewpoints', 'history_and_culture', 'food_and_towns', 'lakes_and_rivers'] as const)[i % 4]!], primaryInterest: (['scenic_viewpoints', 'history_and_culture', 'food_and_towns', 'lakes_and_rivers'] as const)[i % 4]! }));

describe('a light day says why it is light', () => {
  it('a slow trip with plenty on the board stays light and reads as relaxed by pace, never as a gap', () => {
    const planner = input(plenty, { pace: 'slow', maxStopsPerDay: 2 });
    const plan = planStructure(planner);
    const middle = plan.days.slice(1, -1);
    /* It stays light: never more than the slow pace's two daytime stops, with real time left over. */
    for (const day of middle) expect(day.stops.filter((s) => s.slot === 'day').length).toBeLessThanOrEqual(2);
    const density = classifyDayDensity({ plan, planner, freeTimeHeavy: true, losses: NO_LOSSES });
    expect(density.complete).toBe(true);
    expect(density.class).toBe('relaxed_by_pace');
    for (const day of density.days.slice(1, -1)) expect(['relaxed_by_pace', 'full']).toContain(day.class);
    expect(density.days.some((d) => d.class === 'discovery_gap' || d.class === 'nothing_in_reach')).toBe(false);
    expect(tripDensityLine(density)).toBeNull();
  });

  it('a relaxed trip stays relaxed even when the scan lost a place to sleep: pace held the places back, not discovery', () => {
    const planner = input(plenty, { pace: 'slow', maxStopsPerDay: 2 });
    const plan = planStructure(planner);
    const density = classifyDayDensity({ plan, planner, freeTimeHeavy: true, losses: { bases: ['Far Lodge'], places: ['A', 'B', 'C'] } });
    expect(density.days.some((d) => d.class === 'discovery_gap')).toBe(false);
  });

  it('a board with too little on it: nothing in reach when discovery lost nothing material, a discovery gap when it lost a place to sleep', () => {
    const sparse = [c('only-one', { coordinates: at(0.01, 0.01) }), c('only-two', { coordinates: at(-0.01, 0.01) })];
    const planner = input(sparse);
    const plan = planStructure(planner);
    const quiet = classifyDayDensity({ plan, planner, losses: { bases: [], places: ['One vague viewpoint'], proposed: 30 } });
    expect(quiet.days.filter((d) => d.class === 'nothing_in_reach').length).toBeGreaterThan(0);
    expect(quiet.complete).toBe(true);

    const lost = classifyDayDensity({ plan, planner, losses: { bases: ['Karatu lodges'], places: [] } });
    expect(lost.complete).toBe(false);
    expect(lost.class).toBe('discovery_gap');
    const gapDay = lost.days.find((d) => d.class === 'discovery_gap')!;
    const note = densityNote(gapDay, lost, { baseName: 'Base Town', maxDailyTravelMinutes: 240, isEmpty: gapDay.stops === 0 })!;
    expect(note).toMatch(/not by design/);
    expect(note).toContain('Karatu lodges');
    expect(note).toMatch(/nothing for you to do/);
    expect(tripDensityLine(lost)).toMatch(/lighter than/);
  });

  it('one long experience is the day, not a thin day', () => {
    const drive = [c('crater-game-drive', { coordinates: at(0.05, 0.05), durationMinutes: 360, category: 'wildlife', kindLabel: 'Wildlife' })];
    const planner = input(drive);
    const plan = planStructure(planner);
    const density = classifyDayDensity({ plan, planner, losses: { bases: ['Somewhere'], places: [] } });
    const day = density.days.find((d) => d.stops === 1)!;
    expect(day.class).toBe('episode_day');
  });

  it('reads losses from stored scan diagnostics, and judges whether they are material', () => {
    const losses = discoveryLossesOf({ proposal: { returned: 40 }, placement: { unplaced: [{ name: 'Base A', isBase: true }, { name: 'Museum B', isBase: false }] }, assembly: [{ name: 'Viewpoint C', code: 'approximate_only' }, { name: 'Same D', code: 'duplicate' }] });
    expect(losses).toEqual({ bases: ['Base A'], places: ['Museum B', 'Viewpoint C'], proposed: 40 });
    expect(lossesAreMaterial(losses)).toBe(true);
    expect(lossesAreMaterial({ bases: [], places: ['x', 'y'], proposed: 40 })).toBe(false);
    expect(lossesAreMaterial({ bases: [], places: ['a', 'b', 'c', 'd', 'e', 'f'], proposed: 40 })).toBe(true);
    expect(discoveryLossesOf(null)).toEqual({ bases: [], places: [] });
  });
});
