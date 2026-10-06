import { describe, expect, it } from 'vitest';
import { transportStrategyFor } from './planner-composer';
import type { PlannerCandidate, StructurePlan } from './structure-planner';

function stop(id: string, lat: number, lng: number) {
  return { candidate: { id, coordinates: { lat, lng } } as PlannerCandidate, slot: 'day' as const };
}

function plan(days: { stops: ReturnType<typeof stop>[]; travel: number }[]): StructurePlan {
  return {
    days: days.map((d, i) => ({ dayNumber: i + 1, date: `2026-09-0${i + 1}`, baseId: 'base', relocation: false, stops: d.stops, travelMinutes: d.travel, eveningTravelMinutes: 0, activityMinutes: 200, capacityMinutes: 400, weather: null, lunchNear: null, lunchFoodArea: null, backup: null, intensity: 'moderate' })),
    dropped: [],
    weatherMoves: [],
    mustConflicts: [],
  };
}

const base = { id: 'base', name: 'Base', why: '', coordinates: { lat: 35.68, lng: 139.7 }, fromDate: '2026-09-01', toDate: '2026-09-03', nights: 2, transferMinutesFromPrevious: 0 };
const coords = (p: StructurePlan) => new Map([['base', base.coordinates], ...p.days.flatMap((d) => d.stops.map((s) => [s.candidate.id, s.candidate.coordinates] as const))]);

describe('transport strategy, read off the plan', () => {
  it('a dense car-free city is on foot and by public transport, never "timed" transit', () => {
    const p = plan([{ stops: [stop('a', 35.681, 139.701), stop('b', 35.682, 139.702), stop('c', 35.70, 139.75)], travel: 60 }]);
    const out = transportStrategyFor({ plan: p, bases: [base], carAvailable: false, maxDailyTravelMinutes: 180, minutes: () => 20, coordinates: coords(p) });
    expect(out.summary).toMatch(/^On foot and by public transport/);
    expect(out.summary).toMatch(/estimated rather than timed/);
  });

  it('a spread-out road trip recommends the car with the day\'s driving against the limit', () => {
    const p = plan([{ stops: [stop('a', 36.0, 140.0), stop('b', 36.3, 140.4)], travel: 150 }, { stops: [stop('c', 35.2, 139.2)], travel: 130 }]);
    const out = transportStrategyFor({ plan: p, bases: [base], carAvailable: true, maxDailyTravelMinutes: 240, minutes: () => 70, coordinates: coords(p) });
    expect(out.summary).toMatch(/^A car: stops sit up to 70 minutes/);
    expect(out.summary).toMatch(/240-minute limit/);
  });

  it('says a car is optional when everything is a walk from the base', () => {
    const p = plan([{ stops: [stop('a', 35.681, 139.701), stop('b', 35.682, 139.702), stop('c', 35.683, 139.703)], travel: 20 }]);
    const out = transportStrategyFor({ plan: p, bases: [base], carAvailable: true, maxDailyTravelMinutes: 240, minutes: () => 10, coordinates: coords(p) });
    expect(out.summary).toMatch(/^A car is optional here/);
  });
});
