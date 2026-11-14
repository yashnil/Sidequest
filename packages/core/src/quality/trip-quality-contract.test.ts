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

describe('a trek named in the destination phrase', () => {
  it('is the walk itself, whatever the place resolved to; a wish for some trekking in the notes is not', () => {
    const named = buildTripQualityContract({ ...base, ownWords: 'Tour of the Long Ridge trek', destinationPhrase: 'Tour of the Long Ridge trek', semanticType: 'settlement' });
    expect(named.purpose).toBe('trail');
    expect(named.structure).toBe('trail_stages');
    const notes = buildTripQualityContract({ ...base, ownWords: 'Lake District · some trekking if the weather holds', destinationPhrase: 'Lake District', semanticType: 'mountain_region' });
    expect(notes.purpose).not.toBe('trail');
  });

  it('a gorilla or snow trek is not a stage walk', () => {
    expect(buildTripQualityContract({ ...base, ownWords: 'Volcano gorilla trek', destinationPhrase: 'Volcano gorilla trek' }).purpose).not.toBe('trail');
    expect(buildTripQualityContract({ ...base, ownWords: 'Ski trek in the north', destinationPhrase: 'Ski trek in the north' }).purpose).not.toBe('trail');
  });
});

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

describe('pillars — defining experiences as structured requirements with substitutes', () => {
  const candidates = [
    { id: 'plains', name: 'Great Plains game drive', kind: 'wildlife' as const },
    { id: 'crater', name: 'Crater floor game drive', kind: 'wildlife' as const },
    { id: 'baobab', name: 'Baobab park drive', kind: 'national_park' as const },
    { id: 'lake', name: 'Lake park drive', kind: 'national_park' as const },
  ];
  const pillars = [
    { name: 'The great plains', tier: 'essential' as const, why: 'July is the migration season there.', placeIds: ['plains'] },
    { name: 'The crater', tier: 'essential' as const, why: '', placeIds: ['crater'] },
    { name: 'A southern park', tier: 'recommended' as const, why: '', placeIds: ['baobab', 'lake'] },
    { name: 'A hot-air balloon', tier: 'optional' as const, why: '', placeIds: [] },
    { name: 'A remote reserve', tier: 'essential' as const, why: 'Its season is short.', placeIds: ['nowhere'] },
  ];
  const contract = buildTripQualityContract({ ...base, ownWords: 'safari', carAvailable: false, candidates, pillars });
  const plan = (ids: string[]) => ({ days: [day(2, ids.map((id, i) => ({ placeId: id, name: id, kind: 'wildlife' as const, startMinute: 480 + i * 120 })))], board: candidates, selfDriveRequested: false });

  it('one requirement per essential pillar, a preference per recommended one, nothing for optional', () => {
    const ids = contract.essentials.filter((e) => e.id.startsWith('pillar:')).map((e) => [e.label, e.requirement]);
    expect(ids).toEqual([['The great plains', 'requirement'], ['The crater', 'requirement'], ['A southern park', 'preference'], ['A remote reserve', 'requirement']]);
    expect(contract.essentials.some((e) => e.id === 'destination_defining')).toBe(false);
  });

  it('coverage is judged across the whole plan; substitutes count; a missing pillar says why and what to do', () => {
    const onlyCrater = evaluateTripQualityContract(contract, plan(['crater']));
    const plains = onlyCrater.violations.find((v) => v.id === 'pillar:0')!;
    expect(plains).toMatchObject({ severity: 'fail', stage: 'selection' });
    expect(plains.recovery).toMatch(/migration season/);
    expect(plains.recovery).toMatch(/Great Plains game drive/);
    const withSubstitute = evaluateTripQualityContract(contract, plan(['plains', 'crater', 'lake']));
    expect(withSubstitute.violations.find((v) => v.id === 'pillar:2')).toBeUndefined();
    /* A pillar nothing placeable offers is a discovery gap, stated. */
    expect(withSubstitute.violations.find((v) => v.id === 'pillar:4')).toMatchObject({ severity: 'fail', stage: 'discovery' });
  });
});
