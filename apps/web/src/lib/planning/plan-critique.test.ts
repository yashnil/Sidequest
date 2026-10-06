import { describe, expect, it } from 'vitest';
import { critiqueExistingPlan, existingPlanPlaceNames, parseExistingPlan } from './plan-critique';
import type { PlannerCandidate, StructurePlan, StructurePlannerInput } from './structure-planner';

function candidate(id: string, name: string, over: Partial<PlannerCandidate> = {}): PlannerCandidate {
  return {
    id, name, locality: 'Town', coordinates: { lat: 0, lng: 0 }, durationMinutes: 90, intensity: 'easy', bestTime: 'any' as PlannerCandidate['bestTime'],
    exposure: 'outdoor', visibilityDependent: false, rainyDayOk: false, interests: [], primaryInterest: null, category: 'landmark', kindLabel: 'Landmark',
    fit: 70, significance: 0.5, dayTrip: false, why: '', booking: 'none', openOnTripDates: true, status: 'candidate', ...over,
  };
}

/* Four places on a line: base — A (10) — B (20) — C (30) minutes out. */
const POS: Record<string, number> = { base: 0, a: 10, b: 20, c: 30, far: 200 };
const minutes = (x: string, y: string) => (POS[x] === undefined || POS[y] === undefined ? null : Math.abs(POS[x]! - POS[y]!));

function planner(over: Partial<StructurePlannerInput> = {}): StructurePlannerInput {
  return {
    destinationName: 'Somewhere',
    windows: [
      { date: '2026-11-01', startMinute: 540, endMinute: 1080 },
      { date: '2026-11-02', startMinute: 540, endMinute: 1080 },
      { date: '2026-11-03', startMinute: 540, endMinute: 1080 },
    ],
    bases: [{ id: 'base', name: 'Base Town', why: '', coordinates: { lat: 0, lng: 0 }, fromDate: '2026-11-01', toDate: '2026-11-03', nights: 2, transferMinutesFromPrevious: 0 }],
    candidates: [
      candidate('a', 'Alpha Gardens'),
      candidate('b', 'Bravo Museum', { exposure: 'indoor' }),
      candidate('c', 'Charlie Falls'),
      candidate('far', 'Far Canyon', { intensity: 'strenuous' }),
      candidate('classic', 'Grand Classic Gorge', { fit: 90, significance: 0.9 }),
    ],
    minutes,
    pace: 'balanced',
    maxStopsPerDay: 3,
    carAvailable: true,
    maxDailyTravelMinutes: 180,
    maxPhysicalIntensity: 'moderate',
    frequencyCaps: {},
    weather: [],
    foodAreas: [],
    ...over,
  };
}

const proposal = (ids: string[]): StructurePlan => ({
  days: [{ dayNumber: 1, date: '2026-11-01', baseId: 'base', relocation: false, stops: ids.map((id) => ({ candidate: candidate(id, id), slot: 'day' as const })), travelMinutes: 0, eveningTravelMinutes: 0, activityMinutes: 0, capacityMinutes: 0, weather: null, lunchNear: null, lunchFoodArea: null, backup: null, intensity: 'light' }],
  dropped: [], weatherMoves: [], mustConflicts: [],
});

describe('reading a plan as written', () => {
  it('reads numbered days, arrows and "then", and keeps the order', () => {
    const plan = parseExistingPlan('Day 1: Alpha Gardens, Bravo Museum then Charlie Falls\nDay 2 - Far Canyon → Grand Classic Gorge');
    expect(plan).toEqual({ hasDays: true, days: [{ dayNumber: 1, places: ['Alpha Gardens', 'Bravo Museum', 'Charlie Falls'] }, { dayNumber: 2, places: ['Far Canyon', 'Grand Classic Gorge'] }] });
  });

  it('a single line is a list without days, and names are deduplicated for the scan', () => {
    expect(parseExistingPlan('Alpha Gardens, Bravo Museum')!.hasDays).toBe(false);
    expect(existingPlanPlaceNames('Day 1: Alpha Gardens\nDay 2: alpha gardens, Bravo Museum')).toEqual(['Alpha Gardens', 'Bravo Museum']);
    expect(parseExistingPlan('   ')).toBeNull();
  });
});

describe('checking a plan against the planner', () => {
  it('a sensible plan works and says so', () => {
    const out = critiqueExistingPlan({ plan: parseExistingPlan('Day 1: Alpha Gardens, Bravo Museum\nDay 2: Grand Classic Gorge')!, planner: planner({ minutes: (x, y) => (x === 'classic' || y === 'classic' ? 15 : minutes(x, y)) }), proposal: proposal(['classic']), minutesEstimated: false });
    expect(out.verdict).toBe('works');
    expect(out.matched).toBe(3);
  });

  it('finds the doubling back and names the better order with the saving', () => {
    const out = critiqueExistingPlan({ plan: parseExistingPlan('Day 1: Charlie Falls, Alpha Gardens, Bravo Museum, Far Canyon')!, planner: planner({ maxStopsPerDay: 5, maxDailyTravelMinutes: 999, windows: [{ date: '2026-11-01', startMinute: 360, endMinute: 1380 }] }), proposal: proposal([]), minutesEstimated: false });
    const order = out.findings.find((f) => f.kind === 'order_wastes_time');
    // As written: 30+20+10+180+200 = 440; best: 10+10+10+170+200 = 400.
    expect(order?.sentence).toMatch(/^Day 1 doubles back: .* in that order saves about 40 min of travel\./);
  });

  it('a day over the travel limit, too many stops, too hard, and more days than the trip are each said', () => {
    const out = critiqueExistingPlan({ plan: parseExistingPlan('Day 1: Alpha Gardens, Bravo Museum, Charlie Falls, Far Canyon\nDay 2: Alpha Gardens\nDay 3: Bravo Museum\nDay 4: Charlie Falls')!, planner: planner(), proposal: proposal([]), minutesEstimated: false });
    const kinds = out.findings.map((f) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['travel_over_limit', 'rushed_day', 'too_strenuous', 'too_many_days']));
    expect(out.verdict).toBe('rethink');
    expect(out.findings[0]!.severity).toBe('major');
  });

  it('a closure on the planned date, a blocker and a wet day for an outdoor stop', () => {
    const p = planner({
      candidates: [candidate('a', 'Alpha Gardens', { closedDates: ['2026-11-01'] }), candidate('b', 'Bravo Museum', { blocked: 'Needs a car, and this trip has none.' }), candidate('c', 'Charlie Falls')],
      weather: [{ date: '2026-11-02', severity: 2, wet: true, windy: false, poorVisibility: false, label: 'Rain' }, { date: '2026-11-03', severity: 0, wet: false, windy: false, poorVisibility: false, label: 'Fine' }],
    });
    const out = critiqueExistingPlan({ plan: parseExistingPlan('Day 1: Alpha Gardens, Bravo Museum\nDay 2: Charlie Falls')!, planner: p, proposal: proposal([]), minutesEstimated: true });
    expect(out.findings.find((f) => f.kind === 'closed_that_day')?.sentence).toMatch(/Alpha Gardens is closed on Day 1/);
    expect(out.findings.find((f) => f.kind === 'blocked')?.sentence).toMatch(/Needs a car/);
    expect(out.findings.find((f) => f.kind === 'weather')?.sentence).toMatch(/Day 2 looks rain for Charlie Falls; day 3 looks better/);
  });

  it('an unknown place is "not checked", never wrong, and a strong classic left out is offered', () => {
    const out = critiqueExistingPlan({ plan: parseExistingPlan('Alpha Gardens, Mystery Spot')!, planner: planner(), proposal: proposal(['classic']), minutesEstimated: false });
    expect(out.findings.find((f) => f.kind === 'not_checked')?.sentence).toMatch(/"Mystery Spot".*nothing here says they are wrong/);
    expect(out.findings.find((f) => f.kind === 'missing_classic')?.sentence).toMatch(/Grand Classic Gorge/);
    expect(out.verdict).toBe('works');
  });

  it('an unmeasured leg never produces an order or travel verdict', () => {
    const out = critiqueExistingPlan({ plan: parseExistingPlan('Day 1: Alpha Gardens, Bravo Museum, Charlie Falls')!, planner: planner({ minutes: () => null }), proposal: proposal([]), minutesEstimated: true });
    expect(out.findings.some((f) => f.kind === 'order_wastes_time' || f.kind === 'travel_over_limit')).toBe(false);
  });
});
