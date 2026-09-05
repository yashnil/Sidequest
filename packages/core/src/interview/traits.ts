import type { DestinationEntityType, ScopeBreadth } from '../schemas/geography';
import type { TransportMode } from '../schemas/access';
import type { TravelerNeed } from '../schemas/trip';

/**
 * DESTINATION SCREENING — GENERIC TRAITS, EACH WITH THE EVIDENCE THAT EARNED IT.
 *
 * The questionnaire adapts to *what kind of place* the trip is, never to the
 * place's name. This module turns the cheap signals Sidequest already holds
 * before any research runs — the resolved destination's entity type, breadth
 * and extent, the geographic scope's transport assumptions, the preflight's
 * climate normals, a compiled region when one exists, the seeded region's own
 * class, the dates and the party — into a small set of traits. Every trait
 * carries a `basis` sentence; a trait the signals cannot justify is not
 * emitted, and a destination nobody could screen yields no traits at all,
 * which the selector reads as "ask the generic high-information questions".
 *
 * Nothing here calls a model or a provider. It is a pure function of stored
 * facts and it must stay one: the screening runs on every questionnaire
 * render and must never block it.
 */

export const DESTINATION_TRAITS = [
  'dense_urban',
  'transit_rich',
  'walk_heavy',
  'road_trip_region',
  'multi_base_likely',
  'broad_geography',
  'compact_country',
  'island',
  'archipelago',
  'mountain',
  'high_altitude',
  'winter_access',
  'remote',
  'wilderness',
  'water_transfer',
  'internal_flight_likely',
  'guide_transfer_likely',
  'beach',
  'food_dense',
  'nightlife_dense',
  'heat_sensitive',
  'cold_sensitive',
  'weather_exposed',
  'family_logistics_sensitive',
] as const;
export type DestinationTrait = (typeof DESTINATION_TRAITS)[number];

export const DESTINATION_TRAIT_LABELS: Record<DestinationTrait, string> = {
  dense_urban: 'Dense city',
  transit_rich: 'Good public transport',
  walk_heavy: 'Best explored on foot',
  road_trip_region: 'A region you drive',
  multi_base_likely: 'Probably more than one base',
  broad_geography: 'Too big to see all of it',
  compact_country: 'Compact enough to cross',
  island: 'An island',
  archipelago: 'A group of islands',
  mountain: 'Mountain country',
  high_altitude: 'High altitude',
  winter_access: 'Winter access',
  remote: 'Remote',
  wilderness: 'Wilderness',
  water_transfer: 'Boats are part of getting around',
  internal_flight_likely: 'Internal flights likely',
  guide_transfer_likely: 'Guides or transfers likely',
  beach: 'Coast and beaches',
  food_dense: 'A serious food destination',
  nightlife_dense: 'Late nights are an option',
  heat_sensitive: 'Hot in your dates',
  cold_sensitive: 'Cold in your dates',
  weather_exposed: 'Days depend on the weather',
  family_logistics_sensitive: 'Group logistics matter',
};

export type DestinationClassSignal = 'urban' | 'coastal' | 'mountain' | 'countryside';

export interface ScreeningSignals {
  name: string;
  /** How the destination reads mid-sentence, when a source has authored one. */
  proseName?: string;
  entityType?: DestinationEntityType;
  breadth?: ScopeBreadth;
  featureType?: string;
  countryCode?: string;
  center?: { lat: number; lng: number };
  bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } };
  population?: number;
  tripDays: number;
  startDate?: string;
  months?: readonly number[];
  climate?: { high?: number; low?: number };
  /** The geographic scope's transport assumptions, when a scope exists. */
  scopeTransport?: {
    primaryMode?: TransportMode;
    allowedModes?: readonly TransportMode[];
    carAvailable?: boolean | null;
    acceptsWaterOrAirTransfers?: boolean | null;
    basis?: string;
  };
  gatewayKinds?: readonly string[];
  maxBaseChanges?: number;
  composerShape?: string;
  composerTransport?: string;
  /** What a compiled region measured, when one exists. */
  compiled?: {
    placeCount: number;
    carOnlyShare?: number;
    ferryPlaces?: number;
    transitMeasured?: number;
    hasScheduledNetwork?: boolean;
    matrixMode?: string;
    classes?: readonly DestinationClassSignal[];
    subregionCount?: number;
    baseCount?: number;
    foodVenueCount?: number;
    maxElevationMetres?: number;
    furthestSatelliteMinutes?: number;
  };
  /** The seeded region's own class, for authored regions. */
  seededClass?: DestinationClassSignal;
  /** Interest classes the offer derived, when nothing else names a class. */
  offerClasses?: readonly DestinationClassSignal[];
  travelerNeeds?: readonly TravelerNeed[];
  adults?: number;
  children?: number;
}

export type ScreeningEvidence = 'screened' | 'partial' | 'none';

export interface DestinationAssumption {
  bases: 'one' | 'few' | 'many';
  movement: 'car' | 'transit_walk' | 'guided' | 'boat' | 'mixed';
  sentence: string;
}

export interface DestinationQuestionContext {
  name: string;
  proseName: string;
  entityType?: DestinationEntityType;
  breadth?: ScopeBreadth;
  scaleLabel?: string;
  traits: DestinationTrait[];
  basis: Partial<Record<DestinationTrait, string>>;
  evidence: ScreeningEvidence;
  tripDays: number;
  nights: number;
  season?: 'winter' | 'spring' | 'summer' | 'autumn';
  extentKm?: number;
  /** Lines for the understanding screen, only ones the screening can stand behind. */
  understanding: string[];
  /** The route/transport shape Sidequest would assume, stated so it can be checked. */
  assumption?: DestinationAssumption;
}

const BREADTH_RANK: Record<ScopeBreadth, number> = {
  local: 0,
  city: 1,
  subregion: 2,
  region: 3,
  country: 4,
  multi_country: 5,
};

const SCALE_LABEL: Record<DestinationEntityType, string> = {
  point_of_interest: 'A specific place',
  neighbourhood: 'A neighbourhood',
  city: 'A city',
  metro_area: 'A city and its surroundings',
  island: 'An island',
  archipelago: 'A group of islands',
  protected_area: 'A park or protected area',
  subregion: 'A region',
  state_or_province: 'A state or province',
  country: 'A whole country',
  multi_country: 'Several countries',
  route_or_corridor: 'A route',
  unknown: '',
};

function diagonalKm(bounds: NonNullable<ScreeningSignals['bounds']>): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bounds.northEast.lat - bounds.southWest.lat);
  const dLng = toRad(bounds.northEast.lng - bounds.southWest.lng);
  const midLat = toRad((bounds.northEast.lat + bounds.southWest.lat) / 2);
  const x = dLng * Math.cos(midLat);
  return Math.round(R * Math.sqrt(dLat * dLat + x * x));
}

export function seasonFor(isoDate: string | undefined, lat: number | undefined): DestinationQuestionContext['season'] | undefined {
  if (!isoDate) return undefined;
  const month = Number(isoDate.slice(5, 7));
  if (!Number.isFinite(month) || month < 1) return undefined;
  const northern = lat === undefined || lat >= 0;
  const index = Math.floor(((month % 12) + (northern ? 0 : 6)) / 3) % 4;
  return (['winter', 'spring', 'summer', 'autumn'] as const)[index];
}

/**
 * The screening itself. Deterministic, order-independent, and every branch
 * writes the sentence that justified it.
 */
export function screenDestination(signals: ScreeningSignals): DestinationQuestionContext {
  const traits = new Map<DestinationTrait, string>();
  const add = (trait: DestinationTrait, basis: string) => {
    if (!traits.has(trait)) traits.set(trait, basis);
  };

  const breadth = signals.breadth;
  const rank = breadth ? BREADTH_RANK[breadth] : undefined;
  const entity = signals.entityType;
  const extentKm = signals.bounds ? diagonalKm(signals.bounds) : undefined;
  const nights = Math.max(0, signals.tripDays - 1);
  const classes = new Set<DestinationClassSignal>([
    ...(signals.compiled?.classes ?? []),
    ...(signals.offerClasses ?? []),
    ...(signals.seededClass ? [signals.seededClass] : []),
  ]);
  const compiled = signals.compiled;
  const transport = signals.scopeTransport;
  const allowed = new Set(transport?.allowedModes ?? []);
  const featureType = signals.featureType;

  let signalCount = 0;
  for (const value of [entity, breadth, signals.bounds, signals.population, signals.climate, transport, compiled, signals.seededClass, signals.offerClasses]) {
    if (value !== undefined && value !== null) signalCount += 1;
  }

  // --- urban ------------------------------------------------------------------
  const urbanEntity = entity === 'city' || entity === 'metro_area' || entity === 'neighbourhood';
  if (urbanEntity) add('dense_urban', `You named ${SCALE_LABEL[entity!].toLowerCase()}.`);
  else if (classes.has('urban') && !classes.has('mountain') && (rank === undefined || rank <= 1)) {
    add('dense_urban', 'What is known about this place is mostly built and inhabited.');
  }
  if (signals.population !== undefined && signals.population >= 500_000 && (rank === undefined || rank <= 1)) {
    add('dense_urban', `About ${Math.round(signals.population / 100_000) / 10} million people live here.`);
  }
  if (traits.has('dense_urban')) {
    if ((compiled?.transitMeasured ?? 0) > 0 || compiled?.hasScheduledNetwork) {
      add('transit_rich', 'Public transport journeys were measured here.');
    } else if (transport?.primaryMode === 'rail' || transport?.primaryMode === 'public_bus' || allowed.has('rail')) {
      add('transit_rich', 'The trip scope assumes public transport as the way around.');
    } else if (signals.population !== undefined && signals.population >= 1_000_000) {
      add('transit_rich', 'A city this size usually runs usable public transport (a prior, checked during research).');
    }
    add('walk_heavy', 'Cities are best covered on foot between rides.');
    if ((compiled?.foodVenueCount ?? 0) >= 10) add('food_dense', `${compiled!.foodVenueCount} eating places were found here.`);
    else add('food_dense', 'Cities carry the widest choice of places to eat (a prior).');
    if (signals.population !== undefined && signals.population >= 1_000_000) {
      add('nightlife_dense', 'A city this size keeps late hours (a prior).');
    }
  } else if (transport?.primaryMode === 'walk' && rank !== undefined && rank <= 1) {
    add('walk_heavy', 'The trip scope assumes walking as the way around.');
  }

  // --- islands and water --------------------------------------------------------
  if (entity === 'island' || featureType === 'island') add('island', 'You named an island.');
  if (entity === 'archipelago') {
    add('archipelago', 'You named a group of islands.');
    add('water_transfer', 'Moving between islands means boats or short flights.');
  }
  if ((compiled?.ferryPlaces ?? 0) > 0) add('water_transfer', `${compiled!.ferryPlaces} place${compiled!.ferryPlaces === 1 ? '' : 's'} here can only be reached by ferry.`);
  if (signals.gatewayKinds?.includes('ferry_port')) add('water_transfer', 'A ferry port is one of the ways in.');
  if (allowed.has('ferry')) add('water_transfer', 'The trip scope allows ferries.');
  if (classes.has('coastal')) add('beach', 'The coast is part of what this place is known for.');

  // --- mountains, altitude, wilderness ------------------------------------------
  if (classes.has('mountain')) add('mountain', 'Trails, peaks and high ground are part of what was found here.');
  if (entity === 'protected_area' || featureType === 'national_park' || featureType === 'protected_area') {
    add('wilderness', 'You named a park or protected area.');
    add('weather_exposed', 'Days in a protected area happen outdoors.');
  }
  if ((compiled?.maxElevationMetres ?? 0) >= 2500) {
    add('high_altitude', `Places here sit as high as ${compiled!.maxElevationMetres} m.`);
  }

  // --- road trips, breadth, bases ----------------------------------------------------
  const roadEntity = entity === 'subregion' || entity === 'state_or_province' || entity === 'route_or_corridor';
  if (roadEntity) add('road_trip_region', `${SCALE_LABEL[entity!]} is usually covered by road.`);
  if (transport?.primaryMode === 'drive' && rank !== undefined && rank >= 2) add('road_trip_region', 'The trip scope assumes driving.');
  if ((compiled?.carOnlyShare ?? 0) >= 0.5) add('road_trip_region', `${Math.round(compiled!.carOnlyShare! * 100)}% of what was found here has no way in but a drive.`);
  if (signals.seededClass === 'mountain' && !urbanEntity) add('road_trip_region', 'The best of this region is spread along its roads.');
  if (compiled?.matrixMode === 'car' && rank !== undefined && rank >= 2) add('road_trip_region', 'Travel times here were measured by road.');

  if (breadth === 'country' || breadth === 'multi_country') {
    if (extentKm !== undefined && extentKm <= 600) add('compact_country', `About ${extentKm} km corner to corner — crossable in a day.`);
    else add('broad_geography', extentKm ? `About ${extentKm} km corner to corner — more than one trip's worth.` : 'A whole country is more than one trip covers.');
  } else if (extentKm !== undefined && extentKm >= 400) {
    add('broad_geography', `About ${extentKm} km corner to corner.`);
  }
  if (nights >= 5) {
    if (traits.has('broad_geography')) add('multi_base_likely', `${nights} nights across a place this size usually means more than one base.`);
    else if ((compiled?.baseCount ?? 0) >= 2) add('multi_base_likely', `${compiled!.baseCount} sensible bases were found here.`);
    else if ((signals.maxBaseChanges ?? 0) >= 1 || signals.composerShape === 'two_bases' || signals.composerShape === 'circuit') add('multi_base_likely', 'You said you would consider moving between bases.');
    else if (extentKm !== undefined && extentKm >= 150 && !traits.has('dense_urban')) add('multi_base_likely', `About ${extentKm} km across, which is a lot to cover from one bed.`);
    else if (traits.has('archipelago')) add('multi_base_likely', 'Island groups are usually seen from more than one island.');
  }

  // --- remoteness -------------------------------------------------------------------
  const smallPopulation = signals.population !== undefined && signals.population < 50_000;
  if (traits.has('wilderness')) add('remote', 'Protected areas are thin on services by design.');
  if (transport?.primaryMode === 'private_transfer' || transport?.primaryMode === 'shuttle' || signals.composerTransport === 'guided_or_transfers') {
    add('guide_transfer_likely', 'The way around here is assumed to be transfers rather than self-drive or transit.');
    add('remote', 'Places that need transfers are usually away from services.');
  }
  if (transport?.acceptsWaterOrAirTransfers) add('internal_flight_likely', 'The trip scope allows water or air transfers.');
  if (rank !== undefined && rank >= 2 && smallPopulation && !traits.has('dense_urban')) add('remote', 'Few people live across a large area here.');
  if ((compiled?.carOnlyShare ?? 0) >= 0.7 && (compiled?.furthestSatelliteMinutes ?? 0) >= 150) add('remote', `The furthest worthwhile place found is about ${compiled!.furthestSatelliteMinutes} minutes out by road.`);
  if (traits.has('wilderness') || (traits.has('remote') && traits.has('water_transfer'))) add('guide_transfer_likely', 'Wilderness and water access are usually guided or transferred.');
  if (traits.has('archipelago') && (extentKm ?? 0) >= 300) add('internal_flight_likely', `Islands about ${extentKm} km apart are usually linked by short flights.`);
  if (traits.has('broad_geography') && (extentKm ?? 0) >= 900) add('internal_flight_likely', `About ${extentKm} km across — internal flights save whole days.`);

  // --- climate, dates ----------------------------------------------------------------
  const lat = signals.center?.lat;
  const season = seasonFor(signals.startDate, lat);
  if (signals.climate?.high !== undefined && signals.climate.high >= 30) add('heat_sensitive', `Typical daytime highs around ${Math.round(signals.climate.high)}°C in your dates.`);
  if (signals.climate?.low !== undefined && signals.climate.low <= 0) add('cold_sensitive', `Typical lows around ${Math.round(signals.climate.low)}°C in your dates.`);
  // Only outside the tropics: an equatorial basin has wet and dry seasons, not a winter that closes roads.
  if (season === 'winter' && lat !== undefined && Math.abs(lat) >= 35 && (traits.has('mountain') || traits.has('road_trip_region') || Math.abs(lat) >= 50)) {
    add('winter_access', 'Your dates fall in the winter season here, when roads and trails can close.');
  }
  if (traits.has('mountain') || traits.has('island') || traits.has('archipelago') || traits.has('road_trip_region') || traits.has('beach')) {
    add('weather_exposed', 'Most of what makes this place worth visiting is outdoors.');
  }

  // --- the party --------------------------------------------------------------------
  const needs = signals.travelerNeeds ?? [];
  if ((signals.children ?? 0) > 0) add('family_logistics_sensitive', 'Children are travelling.');
  if (needs.includes('mobility_limited') || needs.includes('seniors_in_group') || needs.includes('kids_under_12')) {
    add('family_logistics_sensitive', 'Somebody in the group changes what a day can hold.');
  }

  // --- the understanding lines and the assumption to check --------------------------
  const evidence: ScreeningEvidence = signalCount === 0 ? 'none' : signalCount >= 3 ? 'screened' : 'partial';
  const understanding: string[] = [];
  const scaleLabel = entity && entity !== 'unknown' ? SCALE_LABEL[entity] : undefined;
  if (scaleLabel) understanding.push(scaleLabel);
  const headlineTraits = (['dense_urban', 'mountain', 'island', 'archipelago', 'wilderness', 'broad_geography', 'compact_country', 'road_trip_region', 'beach'] as DestinationTrait[]).filter((t) => traits.has(t));
  if (headlineTraits.length > 0) understanding.push(headlineTraits.map((t) => DESTINATION_TRAIT_LABELS[t]).slice(0, 3).join(' · '));
  if (traits.has('heat_sensitive')) understanding.push(traits.get('heat_sensitive')!);
  if (traits.has('cold_sensitive')) understanding.push(traits.get('cold_sensitive')!);
  if (traits.has('winter_access')) understanding.push(traits.get('winter_access')!);

  const assumption = assumptionFor(traits, nights);
  const proseName = signals.proseName ?? signals.name;

  return {
    name: signals.name,
    proseName,
    ...(entity ? { entityType: entity } : {}),
    ...(breadth ? { breadth } : {}),
    ...(scaleLabel ? { scaleLabel } : {}),
    traits: DESTINATION_TRAITS.filter((t) => traits.has(t)),
    basis: Object.fromEntries(traits) as Partial<Record<DestinationTrait, string>>,
    evidence,
    tripDays: signals.tripDays,
    nights,
    ...(season ? { season } : {}),
    ...(extentKm !== undefined ? { extentKm } : {}),
    understanding,
    ...(assumption ? { assumption } : {}),
  };
}

function assumptionFor(traits: Map<DestinationTrait, string>, nights: number): DestinationAssumption | undefined {
  if (traits.size === 0) return undefined;
  const bases: DestinationAssumption['bases'] = traits.has('broad_geography')
    ? 'many'
    : traits.has('multi_base_likely')
      ? 'few'
      : 'one';
  const movement: DestinationAssumption['movement'] = traits.has('guide_transfer_likely')
    ? 'guided'
    : traits.has('archipelago') && !traits.has('road_trip_region')
      ? 'boat'
      : traits.has('transit_rich') || (traits.has('dense_urban') && !traits.has('road_trip_region'))
        ? 'transit_walk'
        : traits.has('road_trip_region') || traits.has('mountain') || traits.has('compact_country')
          ? 'car'
          : 'mixed';
  const basesPhrase =
    bases === 'one' ? 'keep one main base' : bases === 'few' ? 'move between a couple of bases' : 'choose a coherent subset and move between a few bases';
  const movementPhrase =
    movement === 'car'
      ? 'use a car to reach the region'
      : movement === 'transit_walk'
        ? 'get around on foot and by public transport'
        : movement === 'guided'
          ? 'rely on guides or arranged transfers for the remote parts'
          : movement === 'boat'
            ? 'move by boat between islands'
            : 'mix a car with local transport';
  const sentence = `Sidequest would probably ${basesPhrase} and ${movementPhrase}${nights > 0 ? '' : ''}. We'll check that assumption with you.`;
  return { bases, movement, sentence };
}

export function hasTrait(context: DestinationQuestionContext, trait: DestinationTrait): boolean {
  return context.traits.includes(trait);
}

/** A screening for a destination nobody could classify: no traits, generic questions. */
export function unscreenedDestination(name: string, tripDays: number): DestinationQuestionContext {
  return {
    name,
    proseName: name,
    traits: [],
    basis: {},
    evidence: 'none',
    tripDays,
    nights: Math.max(0, tripDays - 1),
    understanding: [],
  };
}
