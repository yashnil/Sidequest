import { describe, expect, it } from 'vitest';
import { buildTripQualityContract, evaluateTripQualityContract, type PlanForContract, type TripQualityContractInput } from './trip-quality-contract';

const base: TripQualityContractInput = {
  ownWords: '',
  tripDays: 9,
  pace: 'balanced',
  intensity: 'moderate',
  restfulWeight: 0,
  carAvailable: true,
  statedMode: null,
  maxDailyTravelMinutes: 240,
  preferredStartMinute: 8 * 60,
  namedParts: [],
  mustDos: [],
  avoidances: [],
  candidates: [],
};
const day = (dayNumber: number, stops: PlanForContract['days'][number]['stops'], travelMinutes = 60) => ({ dayNumber, firstStartMinute: stops[0]?.startMinute ?? null, stops, travelMinutes });

describe('the trip-quality contract — what the trip is for', () => {
  it('a trail trip requires walking the trail, and says where a missing walk was lost', () => {
    const contract = buildTripQualityContract({ ...base, ownWords: 'Kumano Kodo, Japan', semanticType: 'corridor', candidates: [{ id: 'p1', name: 'Hongu Taisha', kind: 'temple_or_shrine' }, { id: 'p2', name: 'Hosshinmon-oji to Hongu walk', kind: 'day_hike', defining: true }] });
    expect(contract.purpose).toBe('trail');
    expect(contract.structure).toBe('trail_stages');
    expect(contract.essentials.map((e) => e.id)).toEqual(['walk_the_trail', 'destination_defining']);
    const without = evaluateTripQualityContract(contract, { days: [day(1, [{ placeId: 'p1', name: 'Hongu Taisha', kind: 'temple_or_shrine', startMinute: 600 }])], board: [{ id: 'p1', name: 'Hongu Taisha', kind: 'temple_or_shrine' }, { id: 'p2', name: 'Hosshinmon-oji to Hongu walk', kind: 'day_hike' }], selfDriveRequested: false });
    expect(without.passed).toBe(false);
    expect(without.violations.find((v) => v.id === 'walk_the_trail')).toMatchObject({ severity: 'fail', stage: 'selection' });
    const withWalk = evaluateTripQualityContract(contract, { days: [day(1, [{ placeId: 'p2', name: 'Hosshinmon-oji to Hongu walk', kind: 'day_hike', startMinute: 600 }])], board: [], selfDriveRequested: false });
    expect(withWalk.passed).toBe(true);
  });

  it('a missing essential nobody proposed is a discovery failure', () => {
    const contract = buildTripQualityContract({ ...base, ownWords: 'Tanzania safari', carAvailable: false });
    expect(contract.purpose).toBe('wildlife');
    expect(contract.transport.mode).toBe('operator');
    const evaluation = evaluateTripQualityContract(contract, { days: [day(1, [{ name: 'Arusha town', kind: 'small_town', startMinute: 600 }])], board: [{ id: 'x', name: 'Arusha town', kind: 'small_town' }], selfDriveRequested: true });
    expect(evaluation.violations.find((v) => v.id === 'wildlife_viewing')).toMatchObject({ stage: 'discovery', severity: 'fail' });
    expect(evaluation.violations.find((v) => v.id === 'operator_ground')).toMatchObject({ stage: 'transport', severity: 'fail' });
  });

  it('"by train" is a requirement; a hire car breaks it', () => {
    const contract = buildTripQualityContract({ ...base, ownWords: 'Tokyo and Kyoto by train', statedMode: 'public_transport', carAvailable: false, semanticType: 'informal_region', namedParts: ['Tokyo', 'Kyoto'] });
    expect(contract.transport).toEqual({ mode: 'public_transport', stated: true });
    expect(contract.structure).toBe('multi_base');
    expect(evaluateTripQualityContract(contract, { days: [], board: [], selfDriveRequested: true }).violations[0]).toMatchObject({ id: 'no_self_drive', severity: 'fail' });
  });

  it('a restful trip refuses a 05:30 start it did not choose, and keeps one the traveller picked', () => {
    const contract = buildTripQualityContract({ ...base, ownWords: 'a nice retreat, life has been stressful', restfulWeight: 0.7 });
    expect(contract.purpose).toBe('rest');
    expect(contract.timing).toMatchObject({ earliestStartMinute: 480, dawnNeedsConsent: true });
    const plan = (picked: boolean) => ({ days: [day(2, [{ name: 'Sunrise viewpoint', kind: 'viewpoint' as const, startMinute: 330, pickedByTraveller: picked }])], board: [], selfDriveRequested: false });
    expect(evaluateTripQualityContract(contract, plan(false)).violations).toEqual([expect.objectContaining({ id: 'early:2', severity: 'fail', stage: 'pace' })]);
    expect(evaluateTripQualityContract(contract, plan(true)).violations).toEqual([]);
  });

  it('a beach retreat needs beach time; a city break wants its culture (a preference)', () => {
    const beach = buildTripQualityContract({ ...base, ownWords: 'Kauai, Hawaii', semanticType: 'island', tripDays: 8 });
    expect(beach.essentials.find((e) => e.id === 'beach_time')).toMatchObject({ requirement: 'requirement', minCount: 2 });
    const city = buildTripQualityContract({ ...base, ownWords: 'Lisbon, Portugal', semanticType: 'settlement', tripDays: 4 });
    expect(city.purpose).toBe('city_culture');
    expect(city.essentials[0]).toMatchObject({ id: 'city_culture', requirement: 'preference' });
  });

  it('mountain hiking needs real walks; a road trip is a route; a ski trip needs ski days', () => {
    expect(buildTripQualityContract({ ...base, ownWords: 'Dolomites hiking', semanticType: 'mountain_region', tripDays: 8 }).essentials[0]).toMatchObject({ id: 'mountain_walks', minCount: 2 });
    expect(buildTripQualityContract({ ...base, ownWords: 'Iceland Ring Road', routeKind: 'loop' }).structure).toBe('route');
    expect(buildTripQualityContract({ ...base, ownWords: 'ski trip to the Alps', semanticType: 'mountain_region' }).essentials[0]).toMatchObject({ id: 'ski_days' });
  });

  it('a candidate the traveller cannot use is never made essential', () => {
    const contract = buildTripQualityContract({ ...base, candidates: [{ id: 'a', name: 'Glacier hike', kind: 'day_hike', defining: true, blocked: true }] });
    expect(contract.essentials.some((e) => e.id === 'destination_defining')).toBe(false);
  });
});
