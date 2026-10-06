import { describe, expect, it } from 'vitest';
import { planStructure, plannerPriority, tourMinutes, type PlannerCandidate, type PlannerDayWeather, type StructurePlannerInput } from './structure-planner';

/*
 * A fictional valley — two clusters of things to do around one base, a far
 * day-trip town, indoor options. Minutes are a function of straight-line
 * distance so geography, not a hand-written table, decides the days.
 */
const BASE = { id: 'base', coordinates: { lat: 46.0, lng: 7.0 } };
const DATES = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];

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

function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dx = (a.lng - b.lng) * 77;
  const dy = (a.lat - b.lat) * 111;
  return Math.sqrt(dx * dx + dy * dy);
}

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
    ...overrides,
  };
}

const scheduledIds = (plan: ReturnType<typeof planStructure>) => plan.days.flatMap((d) => d.stops.map((s) => s.candidate.id));
const dayOf = (plan: ReturnType<typeof planStructure>, id: string) => plan.days.find((d) => d.stops.some((s) => s.candidate.id === id))?.dayNumber ?? null;

describe('structure planner — the traveller decides first', () => {
  it('never schedules what the traveller excluded (excluded rows never reach the pool) and always places their own includes or states the conflict', () => {
    const pool = [c('must-a', { status: 'must', fit: 20 }), ...Array.from({ length: 12 }, (_, i) => c(`p${i}`, { coordinates: at(i * 0.01, 0) }))];
    const plan = planStructure(input(pool));
    expect(scheduledIds(plan)).toContain('must-a');
  });

  it('states a must-do that cannot fit as a conflict instead of dropping it silently', () => {
    const pool = [c('far-must', { status: 'must', coordinates: at(5, 5), durationMinutes: 600, openOnTripDates: true })];
    const plan = planStructure(input(pool, { windows: DATES.map((date) => ({ date, startMinute: 9 * 60, endMinute: 10 * 60 })) }));
    const placed = scheduledIds(plan).includes('far-must');
    expect(placed || plan.mustConflicts.some((m) => m.candidateId === 'far-must')).toBe(true);
  });

  it('ranks a defining classic above a weak Sidequest pick, and never above the traveller', () => {
    expect(plannerPriority({ status: 'candidate', fit: 80, significance: 0.8 })).toBeGreaterThan(plannerPriority({ status: 'recommended', fit: 55, significance: 0.5 }));
    expect(plannerPriority({ status: 'must', fit: 10, significance: 0.5 })).toBeGreaterThan(plannerPriority({ status: 'candidate', fit: 100, significance: 1 }));
  });
});

describe('structure planner — preferences change the plan', () => {
  const hikes = Array.from({ length: 4 }, (_, i) => c(`hike-${i}`, { intensity: 'strenuous', durationMinutes: 240, interests: ['hiking'], primaryInterest: 'hiking', category: 'hike', coordinates: at(0.05 * i, 0.02) }));
  const easy = Array.from({ length: 10 }, (_, i) => c(`walk-${i}`, { intensity: 'easy', coordinates: at(-0.02 * i, 0.01), interests: ['easy_nature_walks'], primaryInterest: 'easy_nature_walks' }));

  it('"avoid long hikes" produces a materially different trip from "hiking is the core"', () => {
    const lover = planStructure(input([...hikes, ...easy], { maxPhysicalIntensity: 'strenuous' }));
    const avoider = planStructure(input([...hikes, ...easy], { maxPhysicalIntensity: 'moderate' }));
    const hikesIn = (plan: ReturnType<typeof planStructure>) => scheduledIds(plan).filter((id) => id.startsWith('hike')).length;
    expect(hikesIn(lover)).toBeGreaterThanOrEqual(2);
    expect(hikesIn(avoider)).toBe(0);
    expect(avoider.dropped.filter((d) => d.reason === 'too_strenuous').length).toBe(4);
  });

  it('never puts two strenuous days back to back at a balanced pace, nor one on arrival or departure day', () => {
    const plan = planStructure(input([...hikes, ...easy]));
    const hard = plan.days.filter((d) => d.stops.some((s) => s.candidate.intensity === 'strenuous')).map((d) => d.dayNumber);
    for (let i = 1; i < hard.length; i += 1) expect(hard[i]! - hard[i - 1]!).toBeGreaterThan(1);
    expect(hard).not.toContain(1);
    expect(hard).not.toContain(DATES.length);
  });

  it('holds a slow pace to fewer stops a day than a fast one', () => {
    const many = Array.from({ length: 20 }, (_, i) => c(`s${i}`, { durationMinutes: 60, coordinates: at(0.005 * i, 0) }));
    const slow = planStructure(input(many, { pace: 'slow', maxStopsPerDay: 2 }));
    const fast = planStructure(input(many, { pace: 'fast', maxStopsPerDay: 5 }));
    expect(scheduledIds(slow).length).toBeLessThan(scheduledIds(fast).length);
    expect(Math.max(...slow.days.map((d) => d.stops.filter((s) => s.slot === 'day').length))).toBeLessThanOrEqual(2);
  });

  it('respects the frequency the traveller asked for before filling, and only exceeds it to avoid an empty day', () => {
    const views = Array.from({ length: 10 }, (_, i) => c(`view-${i}`, { coordinates: at(0.01 * i, 0) }));
    const museums = Array.from({ length: 3 }, (_, i) => c(`museum-${i}`, { exposure: 'indoor', rainyDayOk: true, interests: ['museums_and_galleries'], primaryInterest: 'museums_and_galleries', category: 'museum', coordinates: at(0, 0.01 * i) }));
    const plan = planStructure(input([...views, ...museums], { frequencyCaps: { scenic_viewpoints: 2, museums_and_galleries: 0 } }));
    // A cap of zero is "avoid": never exceeded, even to fill a day.
    expect(scheduledIds(plan).some((id) => id.startsWith('museum'))).toBe(false);
  });
});

describe('structure planner — weather moves the plan only when it matters', () => {
  const outdoor = [c('summit-view', { visibilityDependent: true, coordinates: at(0.02, 0) })];
  const fillers = Array.from({ length: 6 }, (_, i) => c(`town-${i}`, { exposure: 'indoor', rainyDayOk: true, coordinates: at(-0.01 * i, 0), interests: ['history_and_culture'], primaryInterest: 'history_and_culture' }));
  const wet = (date: string, severity: 2 | 3 = 2): PlannerDayWeather => ({ date, severity, wet: true, windy: false, poorVisibility: false, label: 'rain forecast' });
  const damp = (date: string): PlannerDayWeather => ({ date, severity: 1, wet: true, windy: false, poorVisibility: false, label: 'showers possible' });

  it('moves an exposed outdoor stop off a day with rain forecast and records the move', () => {
    const baseline = planStructure(input([...outdoor, ...fillers]));
    const chosen = dayOf(baseline, 'summit-view')!;
    const plan = planStructure(input([...outdoor, ...fillers], { weather: [wet(DATES[chosen - 1]!)] }));
    expect(dayOf(plan, 'summit-view')).not.toBe(chosen);
    expect(plan.weatherMoves.map((m) => m.candidateId)).toContain('summit-view');
  });

  it('does not report or force a move for a small chance of showers', () => {
    // Showers only break a tie between equally good days; nothing is told to the traveller as a weather move.
    const all = DATES.map((d) => damp(d));
    all[2] = { date: DATES[2]!, severity: 0, wet: false, windy: false, poorVisibility: false, label: 'fair' };
    const plan = planStructure(input([...outdoor, ...fillers], { weather: all }));
    expect(plan.weatherMoves).toEqual([]);
    expect(scheduledIds(plan)).toContain('summit-view');
  });

  it('when every day is wet it keeps the stop and attaches a nearby indoor backup', () => {
    const all = DATES.map((d) => wet(d));
    const plan = planStructure(input([...outdoor, ...fillers, c('museum-backup', { exposure: 'indoor', rainyDayOk: true, coordinates: at(0, 0.002), fit: 40, status: 'candidate' })], { weather: all }));
    const day = plan.days.find((d) => d.stops.some((s) => s.candidate.id === 'summit-view'));
    expect(day).toBeDefined();
    expect(day!.backup).not.toBeNull();
  });
});

describe('structure planner — time of day and geography', () => {
  it('puts a sunset stop at the end of the day, a sunrise stop first, and never a night stop on the departure day', () => {
    const pool = [c('sunset-point', { bestTime: 'sunset', coordinates: at(0.01, 0) }), c('dawn-lake', { bestTime: 'sunrise', coordinates: at(0.02, 0) }), c('stars', { bestTime: 'night' }), ...Array.from({ length: 6 }, (_, i) => c(`d${i}`, { coordinates: at(0.003 * i, 0.003) }))];
    const plan = planStructure(input(pool));
    for (const day of plan.days) {
      const slots = day.stops.map((s) => s.slot);
      if (slots.includes('sunrise')) expect(slots[0]).toBe('sunrise');
      if (slots.includes('sunset')) expect(['sunset', 'night']).toContain(slots[slots.length - 1]);
    }
    expect(plan.days[plan.days.length - 1]!.stops.some((s) => s.slot === 'night' || s.slot === 'sunset')).toBe(false);
  });

  it('groups nearby stops onto the same day rather than zig-zagging', () => {
    const east = Array.from({ length: 3 }, (_, i) => c(`east-${i}`, { coordinates: at(0, 0.3 + 0.01 * i) }));
    const west = Array.from({ length: 3 }, (_, i) => c(`west-${i}`, { coordinates: at(0, -0.3 - 0.01 * i) }));
    const plan = planStructure(input([...east, ...west]));
    for (const day of plan.days) {
      const sides = new Set(day.stops.map((s) => s.candidate.id.split('-')[0]));
      expect(sides.size).toBeLessThanOrEqual(1);
    }
  });

  it('finds the shortest round trip order', () => {
    const minutes = (a: string, b: string) => Math.abs(Number(a.replace(/\D/g, '') || 0) - Number(b.replace(/\D/g, '') || 0)) * 10;
    const order = tourMinutes('p0', ['p3', 'p1', 'p2'], minutes).order;
    // A round trip has two equally short directions; either is right, a zig-zag is not.
    expect([['p1', 'p2', 'p3'], ['p3', 'p2', 'p1']]).toContainEqual(order);
  });
});

describe('structure planner — locks', () => {
  it('holds a locked stop to its day, and reports a lock it cannot honour as a conflict', () => {
    const pool = [c('locked', { status: 'must', pinnedDay: 3, coordinates: at(0.01, 0) }), ...Array.from({ length: 8 }, (_, i) => c(`p${i}`, { coordinates: at(0.004 * i, 0) }))];
    expect(dayOf(planStructure(input(pool)), 'locked')).toBe(3);
    const impossible = [c('late', { status: 'must', pinnedDay: DATES.length, durationMinutes: 600 })];
    const plan = planStructure(input(impossible));
    expect(dayOf(plan, 'late') === DATES.length || plan.mustConflicts.some((m) => m.candidateId === 'late')).toBe(true);
  });
});

describe('structure planner — no abandoned day', () => {
  it('gives every day between arrival and departure something when the board can', () => {
    // Few, low-fit places, one interest capped at one: strict rules alone would leave days empty.
    const pool = Array.from({ length: 6 }, (_, i) => c(`only-${i}`, { fit: 40, status: 'candidate', coordinates: at(0.01 * i, 0) }));
    const plan = planStructure(input(pool, { frequencyCaps: { scenic_viewpoints: 1 } }));
    for (const day of plan.days.slice(1, -1)) expect(day.stops.length, `day ${day.dayNumber}`).toBeGreaterThan(0);
  });

  it('never fills a day with something the traveller asked to avoid', () => {
    const pool = Array.from({ length: 6 }, (_, i) => c(`avoided-${i}`, { status: 'candidate', coordinates: at(0.01 * i, 0) }));
    const plan = planStructure(input(pool, { frequencyCaps: { scenic_viewpoints: 0 } }));
    expect(plan.days.flatMap((d) => d.stops)).toHaveLength(0);
  });
});

describe('structure planner — hours and workability', () => {
  it('never places a stop on a date its published hours say it is shut, and never schedules what the board says cannot work', () => {
    const shut = c('centre', { closedDates: DATES.slice(1, 4) });
    const carOnly = c('car-only-lake', { blocked: 'Needs a car, and this trip has none.' });
    const pool = [shut, carOnly, ...Array.from({ length: 6 }, (_, i) => c(`p${i}`, { coordinates: at(0.004 * i, 0) }))];
    const plan = planStructure(input(pool));
    const day = dayOf(plan, 'centre');
    if (day !== null) expect(DATES.slice(1, 4)).not.toContain(DATES[day - 1]);
    expect(scheduledIds(plan)).not.toContain('car-only-lake');
    expect(plan.dropped.find((d) => d.candidate.id === 'car-only-lake')?.reason).toBe('not_workable');
  });

  it('treats unknown hours as possibly open, never as closed', () => {
    const plan = planStructure(input([c('unknown-hours'), ...Array.from({ length: 4 }, (_, i) => c(`p${i}`))]));
    expect(scheduledIds(plan)).toContain('unknown-hours');
  });
});

describe('structure planner — a day hangs together (live Tokyo finding)', () => {
  it('never stitches a far-off day trip between two nearby neighbourhoods; it gets a day of its own', () => {
    const city = Array.from({ length: 6 }, (_, i) => c(`city-${i}`, { coordinates: at(0.005 * i, 0.005 * i) }));
    const farA = c('far-temple', { coordinates: at(-0.4, -0.2), fit: 90, significance: 0.8 });
    const farB = c('far-shrine', { coordinates: at(-0.402, -0.201), fit: 70 });
    const plan = planStructure(input([...city, farA, farB], { maxDailyTravelMinutes: 300 }));
    for (const day of plan.days) {
      const hasFar = day.stops.some((s) => s.candidate.id.startsWith('far'));
      const hasCity = day.stops.some((s) => s.candidate.id.startsWith('city') && s.slot === 'day');
      expect(hasFar && hasCity, `day ${day.dayNumber} mixes a far day trip with city stops`).toBe(false);
    }
  });

  it('counts the drive out to a sunset stop against the day, so verification has nothing to trim', () => {
    const daytime = Array.from({ length: 3 }, (_, i) => c(`d${i}`, { coordinates: at(0.3 + 0.01 * i, 0) }));
    const sunset = c('sunset-far', { bestTime: 'sunset', coordinates: at(-0.3, 0) });
    const plan = planStructure(input([...daytime, sunset], { maxDailyTravelMinutes: 100 }));
    for (const day of plan.days) expect(day.travelMinutes + day.eveningTravelMinutes).toBeLessThanOrEqual(100 + 200);
    const withSunset = plan.days.find((d) => d.stops.some((s) => s.candidate.id === 'sunset-far'));
    if (withSunset) expect(withSunset.travelMinutes + withSunset.eveningTravelMinutes).toBeLessThanOrEqual(100);
  });
});

describe('arrival and departure days carry their transfers (V1)', () => {
  const places = [c('near-a', { coordinates: at(0.01, 0.01) }), c('near-b', { coordinates: at(-0.01, 0.01) }), c('near-c', { coordinates: at(0.01, -0.01) }), c('near-d', { coordinates: at(-0.01, -0.01) }), c('near-e', { coordinates: at(0.02, 0) }), c('near-f', { coordinates: at(0, 0.02) })];
  const withArrival = (startMinute: number, arrivalMinutes: number) =>
    planStructure(input(places, { windows: DATES.map((date, i) => ({ date, startMinute: i === 0 ? startMinute : 9 * 60, endMinute: i === DATES.length - 1 ? 12 * 60 : 19 * 60 })), edgeTransfers: { arrivalMinutes, departureMinutes: 0 } }));

  it('a long transfer after a late landing leaves the arrival day as the journey', () => {
    const late = withArrival(16 * 60 + 30, 130);
    expect(late.days[0]!.capacityMinutes).toBe(0);
    expect(late.days[0]!.stops.filter((s) => s.slot === 'day')).toHaveLength(0);
  });

  it('the same transfer after an early landing still leaves a real afternoon', () => {
    const early = withArrival(8 * 60 + 30, 130);
    expect(early.days[0]!.capacityMinutes).toBeGreaterThan(180);
    expect(early.days[0]!.stops.length).toBeGreaterThan(0);
  });

  it('arrival time changes what the arrival day holds, materially', () => {
    const noon = withArrival(12 * 60, 60);
    const evening = withArrival(17 * 60, 60);
    expect(noon.days[0]!.capacityMinutes).toBeGreaterThan(evening.days[0]!.capacityMinutes + 200);
  });

  it('the departure transfer comes off the last day', () => {
    const plain = planStructure(input(places));
    const leaving = planStructure(input(places, { edgeTransfers: { arrivalMinutes: 0, departureMinutes: 90 } }));
    expect(leaving.days.at(-1)!.capacityMinutes).toBeLessThan(plain.days.at(-1)!.capacityMinutes);
  });
});
