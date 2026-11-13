import { describe, expect, it, vi } from 'vitest';
import { buildTripQualityContract, evaluateTripQualityContract, type DiscoveryCandidate, type Trip } from '@sidequest/core';
import { fictionalTrailRegion, TRAIL_DATES, type FictionalTrailOptions } from '../../../../../packages/core/src/scan/trail-fixture.test-support';
import { composeWithPlanner } from './planner-composer';
import { defaultProfileFor } from './default-profile';
import type { RegionContext } from '../region';

/**
 * POINT-TO-POINT TREKKING, THROUGH THE PLANNER — a fictional four-stage trail
 * (`packages/core/src/scan/trail-fixture.test-support.ts`) assembled by the
 * scan, then planned: one stage per walking day as that day's move, the bags
 * sent ahead, no hire car, a stage too long for the party replaced by its
 * stated bus, the dusk-safe start on every stage day, and a trail trip whose
 * proposal gave no stages planned honestly with its gap said.
 */

vi.mock('server-only', () => ({}));

function plannedTrail(options: FictionalTrailOptions = {}) {
  const assembled = fictionalTrailRegion(options);
  const compiled = assembled.region;
  const dates = [...(options.dates ?? TRAIL_DATES)];
  const trip: Trip = {
    id: 'trail-trip',
    basics: { mode: 'known_destination', destinationInput: 'The Valley Trail pilgrimage', regionId: 'dynamic', startDate: dates[0]!, endDate: dates[dates.length - 1]!, arrivalTime: '10:00', departureTime: '17:00', arrivalPrecision: 'exact', departurePrecision: 'exact', adults: 2, children: 0, travelerNeeds: [] },
    status: 'draft',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  } as Trip;
  const profile = { ...defaultProfileFor(trip, null), dailyIntensity: 'moderate' as const };
  const region = {
    region: compiled.region,
    places: compiled.places,
    access: compiled.access,
    hours: compiled.operatingHours,
    weather: null,
    food: null,
    matrix: compiled.travelTimes,
    transit: undefined,
    scheduledNetwork: null,
    baseId: compiled.bases.find((b) => b.id === compiled.primaryBaseId)!.routingId,
    basePortfolio: compiled.basePortfolio,
    months: [10],
    dates,
    compiled,
  } as unknown as RegionContext;
  const candidates = compiled.places.map((place) => ({ place, fit: { score: 80, blockers: [] } }) as unknown as DiscoveryCandidate);
  const composed = composeWithPlanner({ trip, profile, region, candidates, selections: [], extras: null, destinationName: 'The Valley Trail', carAvailable: true, maxDailyTravelMinutes: 180 });
  return { composed, compiled };
}

const stagesOn = (composed: ReturnType<typeof plannedTrail>['composed'], dayNumber: number) => composed.plan.days.find((d) => d.dayNumber === dayNumber)!.stops.filter((s) => s.candidate.trailStage).map((s) => s.candidate.name);
const notesOn = (composed: ReturnType<typeof plannedTrail>['composed'], code: string) => composed.plan.dayNotes.filter((n) => n.code === code);

describe('a trail followed from inn to inn', () => {
  it('puts each stage on its own move day, alone, with the bags sent ahead and nothing else of Sidequest’s that day', () => {
    const { composed } = plannedTrail();
    expect(stagesOn(composed, 2)).toEqual(['Alder Gate to Brackenford']);
    expect(stagesOn(composed, 3)).toEqual(['Brackenford to Corrie Mill']);
    expect(stagesOn(composed, 4)).toEqual(['Corrie Mill to Dunmere']);
    expect(stagesOn(composed, 5)).toEqual([]);
    expect(stagesOn(composed, 6)).toEqual(['Dunmere to Eskwater']);
    for (const day of [2, 3, 4, 6]) {
      const plannedDay = composed.plan.days.find((d) => d.dayNumber === day)!;
      expect(plannedDay.relocation).toBe(true);
      expect(plannedDay.stops.filter((s) => s.slot === 'day')).toHaveLength(1);
    }
    expect(notesOn(composed, 'walk_luggage').map((n) => n.dayNumber)).toEqual([2, 3, 4, 6]);
    expect(notesOn(composed, 'walk_luggage')[0]!.note).toMatch(/send your bags ahead/);
    expect(notesOn(composed, 'walk_return')).toEqual([]);
    /* The walk is the move: no road transfer is charged on a walked move day. */
    expect(composed.plannerInput.bases.slice(1).map((b) => b.transferMinutesFromPrevious)).toEqual([0, 0, 0, 0]);
  });

  it('states each stage’s figures and the latest start that still reaches the next bed an hour before dusk', () => {
    const { composed } = plannedTrail();
    const stages = notesOn(composed, 'trail_stage');
    expect(stages.map((n) => n.dayNumber)).toEqual([2, 3, 4, 6]);
    expect(stages[0]!.note).toMatch(/^Stage 1 of 4: Alder Gate → Brackenford, 12 km and 500 m of climbing \(Sidequest's research, not measured\) — about 3 h 30 of walking; set off by \d\d:\d\d to reach Brackenford at least an hour before dusk \(about 17:\d\d\)\.$/);
    expect(notesOn(composed, 'trail_rest')).toEqual([{ dayNumber: 5, code: 'trail_rest', note: 'A rest day in Dunmere: no stage today, and a hot spring close by.' }]);
    expect(notesOn(composed, 'trail_return')[0]).toMatchObject({ dayNumber: 7 });
    expect(notesOn(composed, 'trail_return')[0]!.note).toMatch(/The trail ends in Eskwater: .*estimated/);
  });

  it('asks for no hire car, and puts the inns and the luggage transfer first in what to book', () => {
    const { composed } = plannedTrail();
    expect(composed.draft.driving).toBe('none');
    expect(composed.draft.package?.transport.summary ?? '').not.toMatch(/hire car|rental/i);
    expect(composed.draft.package?.beforeYouGo.join(' ')).toMatch(/luggage transfer for each walking day/);
    expect(composed.draft.package?.beforeYouGo.join(' ')).not.toMatch(/hire car/i);
  });

  it('a stage too long for the party, with nowhere to break it, is replaced by its stated bus on that day', () => {
    const { composed } = plannedTrail({ longThirdStage: true, busAlternative: true });
    expect(stagesOn(composed, 4)).toEqual([]);
    const alt = notesOn(composed, 'trail_alternative');
    expect(alt).toHaveLength(1);
    expect(alt[0]!.dayNumber).toBe(4);
    expect(alt[0]!.note).toMatch(/^Corrie Mill → Dunmere: About 9 h 20 of walking, .* so take the bus instead: The valley bus runs from Corrie Mill to Dunmere several times a day\.$/);
    expect(composed.plan.dropped.find((d) => d.candidate.name === 'Corrie Mill to Dunmere')?.reason).toBe('not_workable');
  });

  it('a trail trip whose proposal gave no stages is not dressed up as a trek: it says so, and the contract records the gap', () => {
    const { composed, compiled } = plannedTrail({ noStages: true });
    expect(composed.plan.days.flatMap((d) => d.stops).some((s) => s.candidate.trailStage)).toBe(false);
    expect(notesOn(composed, 'trail_gap')[0]).toMatchObject({ dayNumber: 1 });
    expect(notesOn(composed, 'trail_gap')[0]!.note).toMatch(/not a walk from inn to inn/);
    const contract = buildTripQualityContract({ ownWords: 'The Valley Trail pilgrimage', tripDays: 7, pace: 'balanced', intensity: 'moderate', restfulWeight: 0, carAvailable: true, statedMode: null, maxDailyTravelMinutes: null, preferredStartMinute: null, namedParts: [], mustDos: [], avoidances: [], candidates: [] });
    expect(contract.structure).toBe('trail_stages');
    const verdict = evaluateTripQualityContract(contract, { days: [], board: [], selfDriveRequested: false, trail: compiled.basePortfolio!.decision!.trail! });
    expect(verdict.violations.find((v) => v.id === 'trail_stages')).toMatchObject({ severity: 'warn', stage: 'discovery' });
    /* A followed trail raises no such gap. */
    const followed = plannedTrail().compiled.basePortfolio!.decision!.trail!;
    expect(evaluateTripQualityContract(contract, { days: [], board: [], selfDriveRequested: false, trail: followed }).violations.some((v) => v.id === 'trail_stages')).toBe(false);
  });
});
