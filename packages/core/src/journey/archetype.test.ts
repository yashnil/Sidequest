import { describe, expect, it } from 'vitest';
import { buildTripQualityContract, type TripQualityContractInput } from '../quality/trip-quality-contract';
import { chooseJourneyArchetype } from './archetype';

const base: TripQualityContractInput = { ownWords: '', tripDays: 9, pace: 'balanced', intensity: 'moderate', restfulWeight: 0, carAvailable: true, statedMode: null, maxDailyTravelMinutes: 240, preferredStartMinute: null, namedParts: [], mustDos: [], avoidances: [], candidates: [] };
const archetypeOf = (input: Partial<TripQualityContractInput>, extra: { semanticType?: string; scale?: string } = {}) => {
  const contract = buildTripQualityContract({ ...base, ...input });
  return chooseJourneyArchetype({ contract, tripDays: input.tripDays ?? base.tripDays, carAvailable: input.carAvailable ?? true, ...extra }).archetype;
};

describe('journey archetypes — a planning strategy chosen before the beds', () => {
  it('reads the trip, not the place', () => {
    expect(archetypeOf({ ownWords: 'Kumano Kodo, Japan', carAvailable: false }, { semanticType: 'corridor' })).toBe('point_to_point_trek');
    expect(archetypeOf({ ownWords: 'Tanzania safari', carAvailable: false })).toBe('operator_safari');
    expect(archetypeOf({ ownWords: 'Iceland Ring Road', routeKind: 'loop' })).toBe('road_trip_loop');
    expect(archetypeOf({ ownWords: 'Tokyo and Kyoto by train', statedMode: 'public_transport', carAvailable: false, namedParts: ['Tokyo', 'Kyoto'] })).toBe('rail_journey');
    expect(archetypeOf({ ownWords: 'Lisbon, Portugal' }, { semanticType: 'settlement', scale: 'city' })).toBe('urban_single_base');
    expect(archetypeOf({ ownWords: 'Kauai, Hawaii' }, { semanticType: 'island' })).toBe('island_exploration');
    expect(archetypeOf({ ownWords: 'a nice retreat, life has been stressful', restfulWeight: 0.7 })).toBe('wellness_retreat');
    expect(archetypeOf({ ownWords: 'Kyrgyzstan' }, { semanticType: 'country', scale: 'country' })).toBe('regional_multi_base');
  });

  it('the same place supports different strategies by intent', () => {
    expect(archetypeOf({ ownWords: 'Scottish Highlands road trip' })).toBe('road_trip_loop');
    expect(archetypeOf({ ownWords: 'Scottish Highlands hiking holiday, a walk along a trail', semanticType: 'corridor' } as Partial<TripQualityContractInput>, { semanticType: 'corridor' })).toBe('point_to_point_trek');
  });

  it('strategies carry the stay and ground rules', () => {
    const contract = buildTripQualityContract({ ...base, ownWords: 'Tanzania safari', carAvailable: true });
    const safari = chooseJourneyArchetype({ contract, tripDays: 9, carAvailable: true });
    expect(safari.strategy.ground).toBe('operator');
    expect(safari.strategy.maxBaseChanges).toBeGreaterThanOrEqual(3);
    const trek = chooseJourneyArchetype({ contract: buildTripQualityContract({ ...base, ownWords: 'Tour du Mont Blanc trek', semanticType: 'corridor' }), tripDays: 10, carAvailable: false, semanticType: 'corridor' });
    expect(trek.strategy.moveTolerance).toBe('move_freely');
    const city = chooseJourneyArchetype({ contract: buildTripQualityContract({ ...base, ownWords: 'Lisbon, Portugal', semanticType: 'settlement' }), tripDays: 4, carAvailable: false, scale: 'city' });
    expect(city.strategy.maxBaseChanges).toBe(0);
  });
});
