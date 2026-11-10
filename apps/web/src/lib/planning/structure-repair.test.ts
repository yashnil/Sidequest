import { describe, expect, it } from 'vitest';
import { createPlannerKernel, detourMinutes, planStructure, type PlannerCandidate, type StructurePlannerInput } from './structure-planner';
import { describeDays, repairDays } from './structure-repair';

const stop = (id: string, extra: Partial<PlannerCandidate> = {}): PlannerCandidate => ({
  id, name: id, locality: 'Here', coordinates: { lat: 0, lng: 0 }, durationMinutes: 120, intensity: 'easy', bestTime: 'any', exposure: 'mixed', visibilityDependent: false, rainyDayOk: false, interests: [], primaryInterest: null, category: 'landmark', kindLabel: 'Landmark', fit: 70, significance: 0.5, dayTrip: false, why: 'x', booking: 'none', openOnTripDates: true, status: 'recommended', ...extra,
});

const DATES = ['2027-05-10', '2027-05-11', '2027-05-12', '2027-05-13'];

function input(extra: Partial<StructurePlannerInput> & Pick<StructurePlannerInput, 'candidates'>, table: Record<string, number> = {}): StructurePlannerInput {
  return {
    destinationName: 'Test',
    windows: DATES.map((date, i) => ({ date, startMinute: i === 0 ? 15 * 60 : 9 * 60, endMinute: i === DATES.length - 1 ? 12 * 60 : 18 * 60 })),
    bases: [{ id: 'b', name: 'Base', why: 'x', coordinates: { lat: 0, lng: 0 }, fromDate: DATES[0]!, toDate: DATES[3]!, nights: 3, transferMinutesFromPrevious: 0 }],
    minutes: (a, c) => (a === c ? 0 : table[`${a}|${c}`] ?? table[`${c}|${a}`] ?? 20),
    pace: 'balanced',
    maxStopsPerDay: 3,
    carAvailable: true,
    maxDailyTravelMinutes: 150,
    maxPhysicalIntensity: 'strenuous',
    frequencyCaps: {},
    weather: [],
    foodAreas: [],
    ...extra,
  };
}

const twoBases = (transfer: number): Pick<StructurePlannerInput, 'bases'> => ({
  bases: [
    { id: 'b', name: 'First', why: 'x', coordinates: { lat: 0, lng: 0 }, fromDate: DATES[0]!, toDate: DATES[2]!, nights: 2, transferMinutesFromPrevious: 0 },
    { id: 'c', name: 'Second', why: 'x', coordinates: { lat: 0, lng: 1 }, fromDate: DATES[2]!, toDate: DATES[3]!, nights: 1, transferMinutesFromPrevious: transfer },
  ],
});

describe('a moving day is a journey', () => {
  it('takes a stop on the way, however far it is from tonight\'s bed', () => {
    const onTheWay = stop('way', { fit: 80 });
    const kernel = createPlannerKernel(input({ ...twoBases(120), candidates: [onTheWay] }, { 'b|c': 120, 'b|way': 40, 'way|c': 100 }));
    expect(kernel.checkDay(2, [onTheWay], () => [], 'way')).toEqual({ ok: true });
  });

  it('still refuses a stop that takes the day off its road', () => {
    const offRoad = stop('off', { fit: 80 });
    const kernel = createPlannerKernel(input({ ...twoBases(120), candidates: [offRoad] }, { 'b|c': 120, 'b|off': 100, 'off|c': 100 }));
    expect(kernel.checkDay(2, [offRoad], () => [], 'off')).toMatchObject({ ok: false, reason: 'too_far' });
  });

  it('keeps a move inside the limit unless the transfer has already spent it', () => {
    const within = createPlannerKernel(input({ ...twoBases(120), candidates: [] })).days[2]!;
    expect(within.travelBudgetMinutes).toBe(30);
    const nearlyAll = createPlannerKernel(input({ ...twoBases(145), candidates: [] })).days[2]!;
    expect(nearlyAll.travelBudgetMinutes).toBe(15);
    const overLimit = createPlannerKernel(input({ ...twoBases(200), candidates: [] })).days[2]!;
    expect(overLimit.travelBudgetMinutes).toBe(45);
  });
});

describe('prevention: a transfer is travel', () => {
  it('a moving day gives what its transfer used back to the traveller’s limit', () => {
    const near = stop('near');
    const planner = input({ ...twoBases(120), candidates: [near] }, { 'b|c': 120, 'b|near': 90, 'near|c': 90 });
    const kernel = createPlannerKernel(planner);
    const day = kernel.days[2]!;
    expect(day.relocation).toBe(true);
    expect(day.travelBudgetMinutes).toBe(30);
    /* 90 + 90 − 120 = 60 of detour, past the 30 the day has left. */
    expect(kernel.checkDay(2, [near], () => [], 'near')).toMatchObject({ ok: false, reason: 'too_far' });
  });

  it('a place on the way costs its detour, not a round trip', () => {
    const table: Record<string, number> = { 'b|c': 120, 'b|way': 60, 'way|c': 65 };
    expect(detourMinutes('b', 'c', ['way'], (a, z) => (a === z ? 0 : table[`${a}|${z}`] ?? table[`${z}|${a}`] ?? null)).total).toBe(5);
    const way = stop('way');
    const kernel = createPlannerKernel(input({ ...twoBases(120), candidates: [way] }, table));
    expect(kernel.checkDay(2, [way], () => [], 'way')).toEqual({ ok: true });
  });

  it('sunrise drives count against the limit', () => {
    const rise = stop('rise', { bestTime: 'sunrise', durationMinutes: 45 });
    const kernel = createPlannerKernel(input({ candidates: [rise], maxDailyTravelMinutes: 100 }, { 'b|rise': 60 }));
    expect(kernel.checkDay(1, [rise], () => [], 'rise')).toMatchObject({ ok: false, reason: 'too_far' });
  });
});

describe('repair: an include parked where it does not fit', () => {
  it('moves off a short arrival afternoon to a day with room, giving up as little as it can', () => {
    const long = stop('long', { status: 'must', durationMinutes: 300 });
    const pick = stop('pick', { durationMinutes: 240 });
    const planner = input({ candidates: [long, pick] });
    const kernel = createPlannerKernel(planner);
    const { state, repairs } = repairDays(kernel, [[long], [pick], [], []]);
    expect(state[0]).toEqual([]);
    expect(state.flat().map((s) => s.id).sort()).toEqual(['long', 'pick']);
    expect(repairs).toEqual([expect.objectContaining({ dayNumber: 1, code: 'moved_own_pick' })]);
  });

  it('never removes an include, and states what it could not repair', () => {
    const a = stop('a', { status: 'must', durationMinutes: 500 });
    const planner = input({ candidates: [a], windows: [{ date: DATES[0]!, startMinute: 15 * 60, endMinute: 18 * 60 }, { date: DATES[3]!, startMinute: 9 * 60, endMinute: 12 * 60 }], bases: [{ id: 'b', name: 'Base', why: 'x', coordinates: { lat: 0, lng: 0 }, fromDate: DATES[0]!, toDate: DATES[3]!, nights: 1, transferMinutesFromPrevious: 0 }] });
    const kernel = createPlannerKernel(planner);
    const { state } = repairDays(kernel, [[a], []]);
    expect(state.flat().map((s) => s.id)).toEqual(['a']);
    const notes = describeDays(kernel, state);
    expect(notes.some((n) => n.code === 'day_overfull' && /on your list/.test(n.note))).toBe(true);
  });

  it('a transfer past the limit is said on the day, with its figures', () => {
    const kernel = createPlannerKernel(input({ ...twoBases(280), candidates: [] }, { 'b|c': 280 }));
    const notes = describeDays(kernel, [[], [], [], []]);
    expect(notes).toContainEqual(expect.objectContaining({ dayNumber: 3, code: 'transfer_over_limit', note: expect.stringContaining('4 h 40') }));
  });

  it('never leaves an empty day to explain itself', () => {
    const far = stop('far');
    const kernel = createPlannerKernel(input({ candidates: [far] }, { 'b|far': 400 }));
    const notes = describeDays(kernel, [[], [], [], []]);
    const interior = notes.filter((n) => n.code === 'open_day').map((n) => n.dayNumber);
    expect(interior).toEqual([2, 3]);
    expect(notes.find((n) => n.code === 'open_day')!.note).toMatch(/far.*6 h 40 each way/);
    /* An arrival or departure day says nothing: a short day there is the shape of the trip. */
    expect(notes.some((n) => n.dayNumber === 1 && n.code === 'open_day')).toBe(false);
  });

  it('says what can be done about a move over the limit', () => {
    const halfway = stop('halfway', { locality: 'Midtown' });
    const withStop = createPlannerKernel(input({ ...twoBases(280), candidates: [halfway] }, { 'b|c': 280, 'b|halfway': 140, 'halfway|c': 145 }));
    expect(describeDays(withStop, [[], [], [], []]).find((n) => n.code === 'transfer_over_limit')!.note).toContain('A night around Midtown');
    const bare = createPlannerKernel(input({ ...twoBases(280), candidates: [] }, { 'b|c': 280 }));
    expect(describeDays(bare, [[], [], [], []]).find((n) => n.code === 'transfer_over_limit')!.note).toMatch(/A train or a flight|Staying on in First/);
  });

  it('a locality half the board shares is a region, not somewhere to spend the night', () => {
    const shared = ['a', 'b2', 'c2', 'd', 'e', 'f'].map((id) => stop(id, { locality: 'The Highlands' }));
    const onWay = stop('way', { locality: 'The Highlands' });
    const kernel = createPlannerKernel(input({ ...twoBases(280), candidates: [...shared, onWay] }, { 'b|c': 280, 'b|way': 140, 'way|c': 145 }));
    expect(describeDays(kernel, [[], [], [], []]).find((n) => n.code === 'transfer_over_limit')!.note).not.toContain('A night around');
  });

  it('a repaired plan still passes the day validator for everything Sidequest chose', () => {
    const candidates = [stop('m', { status: 'must', durationMinutes: 300 }), ...['a', 'b2', 'c2', 'd'].map((id) => stop(id, { durationMinutes: 120 }))];
    const plan = planStructure(input({ candidates }));
    expect(plan.days.flatMap((d) => d.stops.map((s) => s.candidate.id))).toContain('m');
    expect(plan.dayNotes.filter((n) => n.code === 'day_overfull')).toEqual([]);
  });
});
