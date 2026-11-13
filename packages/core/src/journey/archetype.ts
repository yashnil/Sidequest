import type { TripQualityContract } from '../quality/trip-quality-contract';

/**
 * THE JOURNEY ARCHETYPE — HOW THIS TRIP IS STRUCTURED, CHOSEN BEFORE THE BEDS.
 *
 * A planning strategy, not a destination label: the same place supports
 * several ("Kyoto" as a city stay, or one stop of a rail journey). It is read
 * from the trip-quality contract (what the trip is for, how it moves) and the
 * destination's shape, and it decides the stay strategy the scan's stay
 * objective works within and the ground arrangement the plan is written in —
 * so a trek is not planned as day hikes by car, a safari not as a self-drive,
 * a city break not as a tour of satellite towns. Never a place-name rule.
 */
export const JOURNEY_ARCHETYPES = [
  'urban_single_base',
  'regional_multi_base',
  'road_trip_loop',
  'rail_journey',
  'island_exploration',
  'operator_safari',
  'point_to_point_trek',
  'wellness_retreat',
] as const;
export type JourneyArchetype = (typeof JOURNEY_ARCHETYPES)[number];

export const JOURNEY_ARCHETYPE_LABELS: Record<JourneyArchetype, string> = {
  urban_single_base: 'A city stay from one base',
  regional_multi_base: 'A regional trip with a few bases',
  road_trip_loop: 'A road trip',
  rail_journey: 'A journey by train and public transport',
  island_exploration: 'An island trip',
  operator_safari: 'An operator-guided safari',
  point_to_point_trek: 'A walk from stage to stage',
  wellness_retreat: 'A restful stay from one base',
};

export interface StayStrategy {
  /** The most hotel changes the strategy allows (the traveller's own cap still applies when lower). */
  maxBaseChanges: number;
  /** The least the strategy expects; a trek follows its stages, a safari its parks. */
  minBaseChanges: number;
  /** How moving feels to this kind of trip: a trek's moves are its walks, a city stay's are pure cost. */
  moveTolerance: 'stay_put' | 'move_once' | 'move_if_it_saves_time' | 'move_freely';
  /** The ground arrangement the plan is written in. */
  ground: 'operator' | 'self_drive' | 'public_transport' | 'undecided';
}

export interface JourneyChoice {
  archetype: JourneyArchetype;
  reason: string;
  strategy: StayStrategy;
}

export interface JourneyInput {
  contract: Pick<TripQualityContract, 'purpose' | 'secondary' | 'transport' | 'structure' | 'namedParts'>;
  semanticType?: string | null;
  /** The destination's scale (`city`, `region`, `country` …). */
  scale?: string | null;
  tripDays: number;
  carAvailable: boolean;
}

export function chooseJourneyArchetype(input: JourneyInput): JourneyChoice {
  const { contract } = input;
  const purposes = [contract.purpose, ...contract.secondary];
  const days = Math.max(1, input.tripDays);
  const ground = contract.transport.mode;
  const choice = (archetype: JourneyArchetype, reason: string, strategy: Omit<StayStrategy, 'ground'> & { ground?: StayStrategy['ground'] }): JourneyChoice => ({ archetype, reason, strategy: { ground, ...strategy } });

  if (purposes.includes('trail') && days >= 3 && !(contract.transport.stated && contract.transport.mode === 'self_drive')) {
    return choice('point_to_point_trek', 'The trip is a walk along a trail: the beds follow its stages and the moves are the walks.', { maxBaseChanges: Math.max(2, days - 1), minBaseChanges: 1, moveTolerance: 'move_freely', ground: 'public_transport' });
  }
  if (purposes.includes('wildlife')) {
    return choice('operator_safari', 'A safari is run by an operator: a driver-guide and vehicle, with beds near each park.', { maxBaseChanges: Math.min(5, Math.max(1, Math.floor(days / 2))), minBaseChanges: days >= 5 ? 1 : 0, moveTolerance: 'move_if_it_saves_time', ground: 'operator' });
  }
  if (purposes.includes('route') || contract.structure === 'route') {
    return choice(ground === 'public_transport' ? 'rail_journey' : 'road_trip_loop', 'The trip is a route: the beds are spaced along it.', { maxBaseChanges: Math.max(1, days - 1), minBaseChanges: 1, moveTolerance: 'move_freely' });
  }
  if (ground === 'public_transport' && contract.transport.stated && contract.namedParts.length >= 2) {
    return choice('rail_journey', 'Several named places, by public transport: one bed in each.', { maxBaseChanges: Math.max(1, contract.namedParts.length - 1), minBaseChanges: contract.namedParts.length - 1, moveTolerance: 'move_if_it_saves_time' });
  }
  if (contract.purpose === 'rest' && !purposes.includes('beach')) {
    return choice('wellness_retreat', 'A restful trip: one comfortable base and short days.', { maxBaseChanges: contract.namedParts.length >= 2 ? 1 : 0, minBaseChanges: 0, moveTolerance: 'stay_put' });
  }
  if ((input.scale === 'city' || input.scale === 'local' || input.semanticType === 'settlement') && contract.namedParts.length < 2) {
    return choice('urban_single_base', 'A city stay: one base in the city.', { maxBaseChanges: 0, minBaseChanges: 0, moveTolerance: 'stay_put' });
  }
  if (input.semanticType === 'island' || input.semanticType === 'island_group' || purposes.includes('beach')) {
    return choice('island_exploration', 'An island trip: one base, or one strategic move where the island is long.', { maxBaseChanges: input.semanticType === 'island_group' ? Math.max(1, Math.floor(days / 3)) : 1, minBaseChanges: 0, moveTolerance: 'move_if_it_saves_time' });
  }
  return choice('regional_multi_base', 'A regional trip: a few bases where they save travel.', { maxBaseChanges: Math.max(1, Math.floor(days / 3)), minBaseChanges: 0, moveTolerance: 'move_if_it_saves_time' });
}
