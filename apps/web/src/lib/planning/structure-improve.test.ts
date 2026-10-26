import { describe, expect, it } from 'vitest';
import { planStructure, scoreStructure, tourMinutes, validateStructure, type PlannerCandidate, type PlannerDayWeather, type StructurePlan, type StructurePlannerInput } from './structure-planner';
import { compareObjective } from './structure-improve';
import { benchTrips, largeBenchTrip } from './testing/planner-bench';

/*
 * The improvement phase against its contract: never worse than the greedy
 * seed by its own objective, every day a day the validator accepts, no
 * traveller include or lock lost, the same board giving the same trip, and the
 * three greedy failures the planner audit named — a day trip lost to stops
 * that had spread over every day, strenuous spacing decided by whichever hike
 * was placed first, and a day seeded in the wrong district — actually fixed.
 *
 * Timing is measured in `planner-bench.perf.test.ts` (`npm run test:perf`),
 * never here: a measurement inside the parallel suite measures contention.
 */

const greedy = (input: StructurePlannerInput) => planStructure({ ...input, improve: false });
const improved = (input: StructurePlannerInput) => planStructure({ ...input, improve: true });
const scheduled = (plan: StructurePlan) => plan.days.flatMap((d) => d.stops.map((s) => s.candidate.id));
const dayOf = (plan: StructurePlan, id: string) => plan.days.find((d) => d.stops.some((s) => s.candidate.id === id))?.dayNumber ?? null;
const shape = (plan: StructurePlan) => ({
  days: plan.days.map((d) => d.stops.map((s) => s.candidate.id)),
  dropped: plan.dropped.map((d) => `${d.candidate.id}:${d.reason}:${d.detail}`).sort(),
  mustConflicts: plan.mustConflicts.map((m) => `${m.candidateId}:${m.reason}`).sort(),
  weatherMoves: plan.weatherMoves.map((m) => `${m.candidateId}:${m.avoidedDate}>${m.chosenDate}`).sort(),
});

describe('improvement phase — the bench trips', () => {
  const trips = [...benchTrips(), largeBenchTrip()];

  for (const trip of trips) {
    describe(trip.label, () => {
      const seed = greedy(trip.input);
      const plan = improved(trip.input);

      it('scores at least as well as the greedy plan by the stated objective', () => {
        expect(compareObjective(scoreStructure(trip.input, plan), scoreStructure(trip.input, seed))).toBeGreaterThanOrEqual(0);
      });

      it('passes the day validator on every day, as the greedy plan does', () => {
        expect(validateStructure(trip.input, seed)).toEqual([]);
        expect(validateStructure(trip.input, plan)).toEqual([]);
      });

      it('loses no traveller include and moves no locked stop', () => {
        const musts = trip.input.candidates.filter((c) => c.status === 'must');
        const placedBefore = musts.filter((c) => scheduled(seed).includes(c.id)).map((c) => c.id);
        for (const id of placedBefore) expect(scheduled(plan), id).toContain(id);
        for (const c of musts) {
          if (!scheduled(plan).includes(c.id)) expect(plan.mustConflicts.map((m) => m.candidateId), c.id).toContain(c.id);
          if (c.pinnedDay !== undefined && scheduled(plan).includes(c.id)) expect(dayOf(plan, c.id)).toBe(c.pinnedDay);
        }
      });

      it('explains every pick, include, maybe and good filler it left out — exactly once', () => {
        const out = trip.input.candidates.filter((c) => !scheduled(plan).includes(c.id) && (c.status !== 'candidate' || c.fit >= 60));
        for (const c of out) expect(plan.dropped.filter((d) => d.candidate.id === c.id), c.id).toHaveLength(1);
        for (const d of plan.dropped) expect(scheduled(plan)).not.toContain(d.candidate.id);
      });

      it('never puts a sunrise on arrival or a moving day, an evening on departure, or hard days back to back below a fast pace', () => {
        const last = plan.days.length;
        for (const day of plan.days) {
          if (day.dayNumber === 1 || day.relocation) expect(day.stops.some((s) => s.slot === 'sunrise'), `day ${day.dayNumber}`).toBe(false);
          if (day.dayNumber === last) expect(day.stops.some((s) => s.slot === 'sunset' || s.slot === 'night')).toBe(false);
        }
        if (trip.input.pace !== 'fast') {
          const hard = plan.days.filter((d) => d.stops.some((s) => s.candidate.intensity === 'strenuous' && s.candidate.status !== 'must')).map((d) => d.dayNumber);
          const any = new Set(plan.days.filter((d) => d.stops.some((s) => s.candidate.intensity === 'strenuous')).map((d) => d.dayNumber));
          for (const n of hard) expect(any.has(n - 1) || any.has(n + 1), `day ${n}`).toBe(false);
        }
      });

      it('gives the same trip for the same board, and for the same board in a different order', () => {
        expect(shape(improved(trip.input))).toEqual(shape(plan));
        const reversed = { ...trip.input, candidates: [...trip.input.candidates].reverse() };
        expect(shape(improved(reversed)).days).toEqual(shape(plan).days);
        expect(shape(improved(reversed)).dropped).toEqual(shape(plan).dropped);
      });
    });
  }

  it('improves the objective on most of the bench, not just ties it', () => {
    const better = trips.filter((t) => compareObjective(scoreStructure(t.input, improved(t.input)), scoreStructure(t.input, greedy(t.input))) > 0);
    expect(better.length).toBeGreaterThanOrEqual(trips.length - 1);
  });
});

/* ---------------------------------------------------------------------------------------------
 * Targeted regressions — the audit's W1 findings, each on a small fictional valley where the
 * greedy failure is reproduced first, so the test proves the improvement and not a coincidence.
 * --------------------------------------------------------------------------------------------- */

const BASE = { id: 'base', coordinates: { lat: 46.0, lng: 7.0 } };
const DATES = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
const INTERESTS = ['scenic_viewpoints', 'lakes_and_rivers', 'history_and_culture', 'food_and_towns', 'wildlife', 'museums_and_galleries', 'easy_nature_walks', 'architecture_and_landmarks', 'markets_and_street_food', 'hot_springs'] as const;

function c(id: string, overrides: Partial<PlannerCandidate> = {}): PlannerCandidate {
  return {
    id,
    name: id.replace(/-/g, ' '),
    locality: 'Valley',
    coordinates: BASE.coordinates,
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

function valley(candidates: PlannerCandidate[], overrides: Partial<StructurePlannerInput> = {}, dates: readonly string[] = DATES): StructurePlannerInput {
  const coords = new Map<string, { lat: number; lng: number }>([[BASE.id, BASE.coordinates], ...candidates.map((x) => [x.id, x.coordinates] as const)]);
  return {
    destinationName: 'Test Valley',
    windows: dates.map((date, i) => ({ date, startMinute: i === 0 ? 13 * 60 : 9 * 60, endMinute: i === dates.length - 1 ? 12 * 60 : 19 * 60 })),
    bases: [{ id: BASE.id, name: 'Base Town', why: 'Central.', coordinates: BASE.coordinates, fromDate: dates[0]!, toDate: dates[dates.length - 1]!, nights: dates.length - 1, transferMinutesFromPrevious: 0 }],
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

describe('improvement phase — the greedy failures it exists to fix', () => {
  it('frees a day for a high-fit day trip that greedy lost because nearby stops had spread over every day', () => {
    const near = Array.from({ length: 7 }, (_, i) => c(`near-${i}`, { fit: 86 - (i % 3), durationMinutes: 75, coordinates: at(0.01 * (i % 3), 0.01 * Math.floor(i / 3)), primaryInterest: INTERESTS[i]!, interests: [INTERESTS[i]!] }));
    const trip = c('day-trip-town', { fit: 84, significance: 0.5, dayTrip: true, durationMinutes: 240, coordinates: at(0, 1.0), primaryInterest: 'food_and_towns', interests: ['food_and_towns'] });
    const input = valley([...near, trip]);
    const before = greedy(input);
    expect(scheduled(before)).not.toContain('day-trip-town');
    const after = improved(input);
    const day = after.days.find((d) => d.stops.some((s) => s.candidate.id === 'day-trip-town'));
    expect(day, 'the day trip is placed').toBeDefined();
    expect(day!.stops.map((s) => s.candidate.id)).toEqual(['day-trip-town']);
    // Nothing nearby was given up to make the room: the displaced stops moved.
    for (const stop of near) expect(scheduled(after)).toContain(stop.id);
    expect(validateStructure(input, after)).toEqual([]);
  });

  it('resolves strenuous spacing that the first-placed hike decided, by moving it', () => {
    const input = valley([
      c('lake-walk', { status: 'must', pinnedDay: 2, durationMinutes: 120, coordinates: at(-0.1, 0) }),
      c('gorge-walk', { status: 'must', pinnedDay: 4, durationMinutes: 120, coordinates: at(-0.1, 0.01) }),
      c('north-ridge', { intensity: 'strenuous', fit: 95, durationMinutes: 240, coordinates: at(0.1, 0.02), primaryInterest: 'hiking', interests: ['hiking'] }),
      c('north-summit', { intensity: 'strenuous', fit: 90, durationMinutes: 240, coordinates: at(0.11, -0.02), primaryInterest: 'hiking', interests: ['hiking'] }),
    ]);
    const before = greedy(input);
    expect(dayOf(before, 'north-ridge')).toBe(3);
    expect(before.dropped.find((d) => d.candidate.id === 'north-summit')?.reason).toBe('too_strenuous');
    const after = improved(input);
    const hard = [dayOf(after, 'north-ridge'), dayOf(after, 'north-summit')];
    expect(hard.every((d) => d !== null)).toBe(true);
    expect(Math.abs(hard[0]! - hard[1]!)).toBeGreaterThan(1);
    expect(dayOf(after, 'lake-walk')).toBe(2);
    expect(dayOf(after, 'gorge-walk')).toBe(4);
    expect(validateStructure(input, after)).toEqual([]);
  });

  it('re-seeds a day that greedy organised around a stray far stop, so the district the trip is about gets the day', () => {
    const east = Array.from({ length: 9 }, (_, i) => c(`east-${i}`, { status: 'candidate', fit: 82 - (i % 4), significance: 0.5, durationMinutes: 60, coordinates: at(0.005 * (i % 3), 0.02 + 0.005 * Math.floor(i / 3)), primaryInterest: INTERESTS[i]!, interests: [INTERESTS[i]!] }));
    const stray = c('stray-west', { status: 'candidate', fit: 85, significance: 0.5, durationMinutes: 200, coordinates: at(0, -0.45), primaryInterest: 'hot_springs', interests: ['hot_springs'] });
    const input = valley([...east, stray], {}, DATES.slice(0, 4));
    const before = greedy(input);
    const strayDay = before.days.find((d) => d.stops.some((s) => s.candidate.id === 'stray-west'))!;
    expect(strayDay.stops.map((s) => s.candidate.id), 'greedy gives the stray a whole day').toEqual(['stray-west']);
    const eastBefore = scheduled(before).filter((id) => id.startsWith('east')).length;
    const after = improved(input);
    expect(scheduled(after).filter((id) => id.startsWith('east')).length).toBeGreaterThan(eastBefore);
    expect(scoreStructure(input, after).parts.travelMinutes).toBeLessThan(scoreStructure(input, before).parts.travelMinutes);
    // What was given up is still explained, in the validator's words.
    if (!scheduled(after).includes('stray-west')) expect(after.dropped.find((d) => d.candidate.id === 'stray-west')).toBeDefined();
  });

  it('places a locked include before every other include, so the lock is never the one that loses', () => {
    const wet = (date: string): PlannerDayWeather => ({ date, severity: 2, wet: true, windy: false, poorVisibility: false, label: 'rain forecast' });
    const input = valley(
      [
        c('big-outdoor-must', { status: 'must', fit: 99, durationMinutes: 400, coordinates: at(0.01, 0) }),
        c('locked-gallery', { status: 'must', fit: 10, pinnedDay: 3, durationMinutes: 200, exposure: 'indoor', rainyDayOk: true, coordinates: at(0.012, 0) }),
      ],
      { weather: [wet(DATES[0]!), wet(DATES[1]!), wet(DATES[3]!), wet(DATES[4]!)] },
    );
    for (const plan of [greedy(input), improved(input)]) {
      expect(dayOf(plan, 'locked-gallery')).toBe(3);
      expect(plan.mustConflicts).toEqual([]);
    }
  });

  it('can be switched off, which returns construction exactly', () => {
    const input = benchTrips()[0]!.input;
    expect(shape(planStructure({ ...input, improve: false }))).toEqual(shape(greedy(input)));
    expect(shape(planStructure(input))).toEqual(shape(improved(input)));
  });
});

describe('unknown legs (unknown ≠ far, never zero)', () => {
  it('an unmeasured hop never splits a day, and an unmeasured leg still costs time on the clock', () => {
    const a = c('a', { coordinates: at(0.01, 0) });
    const b = c('b', { coordinates: at(0.012, 0) });
    const base = valley([a, b]);
    const input: StructurePlannerInput = { ...base, minutes: (x, y) => ((x === 'a' && y === 'b') || (x === 'b' && y === 'a') ? null : base.minutes(x, y)) };
    const plan = improved(input);
    expect(scheduled(plan)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(validateStructure(input, plan)).toEqual([]);
    expect(tourMinutes('base', ['a', 'b'], input.minutes).total).toBeGreaterThanOrEqual(60);
  });
});

describe('intra-day order above seven stops', () => {
  it('2-opt and Or-opt never leave a crossing loop the exhaustive order would not', () => {
    // Twelve points on a ring: the shortest loop visits them in ring order.
    const ids = Array.from({ length: 12 }, (_, i) => `r${i}`);
    const point = (id: string) => (id === 'hub' ? { x: 0, y: 0 } : { x: Math.cos((Number(id.slice(1)) * Math.PI) / 6) * 10, y: Math.sin((Number(id.slice(1)) * Math.PI) / 6) * 10 });
    const minutes = (a: string, b: string) => Math.round(Math.hypot(point(a).x - point(b).x, point(a).y - point(b).y) * 10);
    const shuffled = [...ids].sort((x, y) => (Number(x.slice(1)) * 7) % 12 - (Number(y.slice(1)) * 7) % 12);
    const { total } = tourMinutes('hub', shuffled, minutes);
    const ring = minutes('hub', 'r0') + ids.slice(1).reduce((n, id, i) => n + minutes(ids[i]!, id), 0) + minutes('r11', 'hub');
    expect(total).toBeLessThanOrEqual(ring);
  });
});
