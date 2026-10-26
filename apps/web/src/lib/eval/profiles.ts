import { BENCHMARK_REQUEST_VERSION, INTERESTS, benchmarkTripRequestSchema, type BenchmarkInterest, type BenchmarkTripRequest } from '@sidequest/bench';

/**
 * THE EVALUATION TRAVELLERS.
 *
 * Thirty-plus trips a real person could plausibly ask Sidequest for, written as
 * the shared benchmark request (`@sidequest/bench`) so the product's own
 * adapters (`benchmark/sidequest/request-adapter.ts`) translate them into the
 * composer and the questionnaire exactly as the benchmark arm does — no second
 * mapping layer lives here.
 *
 * The set is chosen for coverage, not for flattery: every season of 2027,
 * solo/couple/friends/family/seniors/mobility-limited parties, car and
 * car-free, short (2–3 days) and long (14–16 days), late arrivals and early
 * departures, cities, transit-heavy trips, broad countries, multi-country
 * phrases and remote regions. Destination text is what a traveller would type;
 * nothing downstream is told what the place "really" is.
 */

export type EvalCategory = 'urban' | 'transit_heavy' | 'country' | 'multi_country' | 'rural_remote' | 'road_trip' | 'park' | 'island';

export interface EvalProfile {
  id: string;
  title: string;
  categories: EvalCategory[];
  /** ISO country codes a correct plan's stops should lie in (geographic correctness). */
  expectedCountries: string[];
  request: BenchmarkTripRequest;
}

type Level = 'avoid' | 'low' | 'occasional' | 'frequent' | 'core';

interface Spec {
  id: string;
  title: string;
  categories: EvalCategory[];
  expectedCountries: string[];
  destination: string;
  start: string;
  end: string;
  arrival?: { precision: 'exact' | 'morning' | 'afternoon' | 'evening' | 'unknown'; time?: string };
  departure?: { precision: 'exact' | 'morning' | 'afternoon' | 'evening' | 'unknown'; time?: string };
  party?: Partial<BenchmarkTripRequest['party']> & { adults: number };
  car: boolean;
  transport?: BenchmarkTripRequest['movement']['preference'];
  maxDrive?: number;
  maxTravel?: number;
  bases?: number;
  pace: 'slow' | 'balanced' | 'fast';
  intensity?: 'light' | 'moderate' | 'intense';
  budget: 'budget' | 'midrange' | 'premium' | 'luxury';
  interests: Partial<Record<BenchmarkInterest, Level>>;
  mustDo?: string[];
  dislikes?: string[];
  hardAvoidances?: BenchmarkTripRequest['taste']['hardAvoidances'];
  crowd?: 'avoid_crowds' | 'mild' | 'dont_mind';
  discovery?: 'mostly_classics' | 'balanced' | 'mostly_hidden' | 'deep_cuts';
  food?: 'not_at_all' | 'a_little' | 'matters' | 'central';
  freeText?: string;
}

function nightsBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}

function levels(stated: Spec['interests']): Record<BenchmarkInterest, Level> {
  const out = {} as Record<BenchmarkInterest, Level>;
  for (const interest of INTERESTS) out[interest] = stated[interest] ?? 'low';
  return out;
}

function profile(spec: Spec): EvalProfile {
  const nights = nightsBetween(spec.start, spec.end);
  const bases = spec.bases ?? 1;
  const request = benchmarkTripRequestSchema.parse({
    schemaVersion: BENCHMARK_REQUEST_VERSION,
    requestId: `eval-${spec.id}`,
    destination: { mode: 'known', text: spec.destination, identity: null },
    dates: { mode: 'exact', startDate: spec.start, endDate: spec.end, nights },
    arrival: { precision: spec.arrival?.precision ?? 'afternoon', time: spec.arrival?.time ?? null },
    departure: { precision: spec.departure?.precision ?? 'afternoon', time: spec.departure?.time ?? null },
    origin: '',
    party: { children: 0, ...spec.party },
    movement: {
      preference: spec.transport ?? (spec.car ? 'drive' : 'public_transport'),
      publicTransit: spec.car ? 'accept' : 'prefer',
      carAvailable: spec.car,
      comfortableMountainRoads: spec.car,
      comfortableUnpavedRoads: false,
      willUseShuttlesAndFerries: true,
      maxDailyDriveMinutes: spec.car ? (spec.maxDrive ?? 180) : 0,
      maxDailyTravelMinutes: spec.maxTravel ?? (spec.car ? Math.max(240, spec.maxDrive ?? 180) : 150),
      maxAccessWalkMinutes: 30,
      desiredBaseCount: bases,
      maxBaseChanges: Math.max(0, bases - 1),
    },
    rhythm: { pace: spec.pace, activityIntensity: spec.intensity ?? 'moderate', freeTime: spec.pace === 'fast' ? 'packed' : spec.pace === 'slow' ? 'lots' : 'balanced', earlyMornings: 'sometimes' },
    taste: {
      interests: levels(spec.interests),
      crowdTolerance: spec.crowd ?? 'mild',
      discoveryMix: spec.discovery ?? 'balanced',
      foodImportance: spec.food ?? 'matters',
      nightlifeImportance: spec.interests.nightlife === 'core' || spec.interests.nightlife === 'frequent' ? 'matters' : 'a_little',
      indoorOutdoorBalance: 'balanced',
      mustDo: spec.mustDo ?? [],
      dislikes: spec.dislikes ?? [],
      hardAvoidances: spec.hardAvoidances ?? [],
    },
    conditions: { climate: 'no_preference', heat: 'fine', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: { budget: spec.budget, accommodation: 'no_preference', reservations: 'a_few_is_fine', guidedTours: 'sometimes' },
    freeText: spec.freeText ?? '',
  });
  return { id: spec.id, title: spec.title, categories: spec.categories, expectedCountries: spec.expectedCountries, request };
}

const COUPLE = { adults: 2 };
const SOLO = { adults: 1 };
const FRIENDS = { adults: 4 };
const FAMILY = { adults: 2, children: 2, childAges: [6, 9] };
const SENIORS = { adults: 2, seniorsInGroup: true };

export const EVAL_PROFILES: readonly EvalProfile[] = [
  profile({ id: 'switzerland-rail', title: 'Switzerland by train, 10 days, couple, July', categories: ['country', 'transit_heavy'], expectedCountries: ['CH'], destination: 'Switzerland', start: '2027-07-05', end: '2027-07-15', party: COUPLE, car: false, bases: 3, pace: 'balanced', budget: 'premium', interests: { hiking: 'frequent', scenic_viewpoints: 'core', trains: 'core', lakes_and_rivers: 'frequent', food_and_towns: 'occasional' } }),
  profile({ id: 'zurich-carfree-short', title: 'Zurich weekend, car-free, solo, late arrival', categories: ['urban', 'transit_heavy'], expectedCountries: ['CH'], destination: 'Zurich', start: '2027-03-12', end: '2027-03-14', arrival: { precision: 'exact', time: '22:30' }, party: SOLO, car: false, pace: 'fast', budget: 'midrange', interests: { museums_and_galleries: 'core', architecture: 'frequent', cafes: 'frequent', local_neighbourhoods: 'occasional' } }),
  profile({ id: 'zermatt-winter', title: 'Zermatt in January, car-free, friends, winter sports', categories: ['rural_remote', 'transit_heavy'], expectedCountries: ['CH'], destination: 'Zermatt', start: '2027-01-16', end: '2027-01-20', party: FRIENDS, car: false, pace: 'balanced', intensity: 'intense', budget: 'luxury', interests: { winter_sports: 'core', scenic_viewpoints: 'frequent', fine_dining: 'occasional', wellness_and_spa: 'occasional' } }),
  profile({ id: 'iceland-ring', title: 'Iceland ring road, 12 days, friends, September, car', categories: ['country', 'road_trip'], expectedCountries: ['IS'], destination: 'Iceland', start: '2027-09-03', end: '2027-09-15', party: FRIENDS, car: true, maxDrive: 240, bases: 4, pace: 'balanced', intensity: 'moderate', budget: 'midrange', interests: { geology_and_geothermal: 'core', hot_springs: 'frequent', scenic_drives: 'core', hiking: 'frequent', wildlife: 'occasional' } }),
  profile({ id: 'reykjavik-winter', title: 'Reykjavik in February, 4 days, couple, car-free', categories: ['urban', 'transit_heavy'], expectedCountries: ['IS'], destination: 'Reykjavik', start: '2027-02-10', end: '2027-02-14', party: COUPLE, car: false, pace: 'slow', budget: 'premium', interests: { hot_springs: 'core', stargazing: 'frequent', museums_and_galleries: 'occasional', food_and_towns: 'frequent' } }),
  profile({ id: 'japan-family', title: 'Japan, 14 days, family with two kids, April, rail', categories: ['country', 'transit_heavy'], expectedCountries: ['JP'], destination: 'Japan', start: '2027-04-01', end: '2027-04-15', party: FAMILY, car: false, bases: 3, pace: 'balanced', intensity: 'light', budget: 'midrange', interests: { history_and_culture: 'core', theme_parks: 'frequent', food_and_towns: 'frequent', trains: 'frequent', easy_nature_walks: 'occasional' } }),
  profile({ id: 'tokyo-carfree', title: 'Tokyo, 5 days, solo, car-free, food and neighbourhoods', categories: ['urban', 'transit_heavy'], expectedCountries: ['JP'], destination: 'Tokyo', start: '2027-11-08', end: '2027-11-13', party: SOLO, car: false, pace: 'fast', budget: 'midrange', interests: { markets_and_street_food: 'core', local_neighbourhoods: 'core', cafes: 'frequent', architecture: 'occasional', nightlife: 'occasional' } }),
  profile({ id: 'kyoto-temples', title: 'Kyoto, 4 days, seniors, car-free, temples, November', categories: ['urban', 'transit_heavy'], expectedCountries: ['JP'], destination: 'Kyoto', start: '2027-11-20', end: '2027-11-24', party: SENIORS, car: false, pace: 'slow', intensity: 'light', budget: 'premium', interests: { history_and_culture: 'core', architecture: 'frequent', easy_nature_walks: 'occasional', cafes: 'occasional' } }),
  profile({ id: 'kyrgyzstan-trek', title: 'Kyrgyzstan, 12 days, friends, August, hiking, car', categories: ['country', 'rural_remote'], expectedCountries: ['KG'], destination: 'Kyrgyzstan', start: '2027-08-02', end: '2027-08-14', party: FRIENDS, car: true, maxDrive: 300, bases: 3, pace: 'balanced', intensity: 'intense', budget: 'budget', interests: { hiking: 'core', lakes_and_rivers: 'frequent', scenic_viewpoints: 'frequent', history_and_culture: 'occasional' } }),
  profile({ id: 'kenya-tanzania', title: 'Kenya and Tanzania safari, 14 days, couple, July', categories: ['multi_country', 'rural_remote'], expectedCountries: ['KE', 'TZ'], destination: 'Kenya and Tanzania', start: '2027-07-10', end: '2027-07-24', party: COUPLE, car: false, transport: 'guided_or_transfers', maxTravel: 300, bases: 4, pace: 'balanced', budget: 'luxury', interests: { wildlife: 'core', beaches_and_swimming: 'occasional', photography_golden_hour: 'frequent', history_and_culture: 'occasional' } }),
  profile({ id: 'california-roadtrip', title: 'California road trip, 14 days, couple, May', categories: ['road_trip', 'park'], expectedCountries: ['US'], destination: 'California', start: '2027-05-08', end: '2027-05-22', party: COUPLE, car: true, maxDrive: 300, bases: 4, pace: 'balanced', budget: 'midrange', interests: { scenic_drives: 'core', hiking: 'frequent', beaches_and_swimming: 'occasional', food_and_towns: 'frequent', wildlife: 'occasional' } }),
  profile({ id: 'mammoth-lakes', title: 'Mammoth Lakes, 4 days, couple, August, car', categories: ['park', 'rural_remote'], expectedCountries: ['US'], destination: 'Mammoth Lakes', start: '2027-08-19', end: '2027-08-23', party: COUPLE, car: true, pace: 'balanced', intensity: 'intense', budget: 'midrange', interests: { hiking: 'core', lakes_and_rivers: 'core', scenic_viewpoints: 'frequent', hot_springs: 'occasional' } }),
  profile({ id: 'paris-seniors', title: 'Paris, 5 days, seniors with limited walking, October', categories: ['urban', 'transit_heavy'], expectedCountries: ['FR'], destination: 'Paris', start: '2027-10-04', end: '2027-10-09', party: { ...SENIORS, mobility: ['limited_walking'] }, car: false, pace: 'slow', intensity: 'light', budget: 'premium', interests: { museums_and_galleries: 'core', architecture: 'frequent', fine_dining: 'occasional', cafes: 'frequent' } }),
  profile({ id: 'nyc-family', title: 'New York City, 5 days, family with kids, December', categories: ['urban', 'transit_heavy'], expectedCountries: ['US'], destination: 'New York City', start: '2027-12-18', end: '2027-12-23', party: FAMILY, car: false, pace: 'balanced', budget: 'midrange', interests: { museums_and_galleries: 'frequent', architecture: 'frequent', local_neighbourhoods: 'occasional', shopping: 'occasional', theme_parks: 'occasional' } }),
  profile({ id: 'mexico-city-food', title: 'Mexico City, 6 days, solo foodie, March', categories: ['urban'], expectedCountries: ['MX'], destination: 'Mexico City', start: '2027-03-01', end: '2027-03-07', party: SOLO, car: false, pace: 'balanced', budget: 'budget', food: 'central', interests: { markets_and_street_food: 'core', history_and_culture: 'frequent', museums_and_galleries: 'frequent', local_neighbourhoods: 'frequent' } }),
  profile({ id: 'seoul-friends', title: 'Seoul, 5 days, friends, October, nightlife', categories: ['urban', 'transit_heavy'], expectedCountries: ['KR'], destination: 'Seoul', start: '2027-10-14', end: '2027-10-19', party: FRIENDS, car: false, pace: 'fast', budget: 'midrange', interests: { nightlife: 'core', markets_and_street_food: 'frequent', shopping: 'frequent', history_and_culture: 'occasional' } }),
  profile({ id: 'istanbul-early-dep', title: 'Istanbul, 4 days, couple, April, 07:00 departure', categories: ['urban'], expectedCountries: ['TR'], destination: 'Istanbul', start: '2027-04-20', end: '2027-04-24', departure: { precision: 'exact', time: '07:00' }, party: COUPLE, car: false, pace: 'balanced', budget: 'midrange', interests: { history_and_culture: 'core', architecture: 'core', markets_and_street_food: 'frequent', boats_and_ferries: 'occasional' } }),
  profile({ id: 'patagonia-long', title: 'Patagonia, 16 days, couple, January, hiking, car', categories: ['multi_country', 'rural_remote', 'park'], expectedCountries: ['AR', 'CL'], destination: 'Patagonia', start: '2027-01-05', end: '2027-01-21', party: COUPLE, car: true, maxDrive: 300, bases: 4, pace: 'balanced', intensity: 'intense', budget: 'midrange', interests: { hiking: 'core', scenic_viewpoints: 'core', lakes_and_rivers: 'frequent', wildlife: 'occasional' } }),
  profile({ id: 'scottish-highlands', title: 'Scottish Highlands, 8 days, couple, June, car', categories: ['rural_remote', 'road_trip'], expectedCountries: ['GB'], destination: 'Scottish Highlands', start: '2027-06-12', end: '2027-06-20', party: COUPLE, car: true, maxDrive: 200, bases: 2, pace: 'balanced', budget: 'midrange', interests: { history_and_culture: 'frequent', scenic_drives: 'core', hiking: 'occasional', lakes_and_rivers: 'frequent' } }),
  profile({ id: 'faroe-islands', title: 'Faroe Islands, 5 days, friends, July, hiking, car', categories: ['island', 'rural_remote'], expectedCountries: ['FO'], destination: 'Faroe Islands', start: '2027-07-20', end: '2027-07-25', party: FRIENDS, car: true, pace: 'balanced', intensity: 'intense', budget: 'premium', interests: { hiking: 'core', scenic_viewpoints: 'core', wildlife: 'frequent', boats_and_ferries: 'occasional' } }),
  profile({ id: 'atacama', title: 'Atacama Desert, 6 days, couple, November, stargazing, car', categories: ['rural_remote'], expectedCountries: ['CL'], destination: 'Atacama Desert', start: '2027-11-02', end: '2027-11-08', party: COUPLE, car: true, pace: 'balanced', budget: 'premium', interests: { stargazing: 'core', geology_and_geothermal: 'core', hot_springs: 'frequent', scenic_viewpoints: 'frequent' } }),
  profile({ id: 'vienna-wheelchair', title: 'Vienna, 4 days, wheelchair user, car-free, May', categories: ['urban', 'transit_heavy'], expectedCountries: ['AT'], destination: 'Vienna', start: '2027-05-13', end: '2027-05-17', party: { adults: 2, mobility: ['wheelchair_user'], mobilityNotes: 'One of us uses a wheelchair; step-free access matters.' }, car: false, pace: 'slow', intensity: 'light', budget: 'premium', interests: { museums_and_galleries: 'core', architecture: 'frequent', cafes: 'frequent', history_and_culture: 'occasional' } }),
  profile({ id: 'alaska', title: 'Alaska, 10 days, couple, August, wildlife, car', categories: ['rural_remote', 'road_trip', 'park'], expectedCountries: ['US'], destination: 'Alaska', start: '2027-08-06', end: '2027-08-16', party: COUPLE, car: true, maxDrive: 300, bases: 3, pace: 'balanced', budget: 'premium', interests: { wildlife: 'core', hiking: 'frequent', scenic_drives: 'frequent', boats_and_ferries: 'occasional' } }),
  profile({ id: 'canadian-rockies', title: 'Canadian Rockies, 7 days, family, September, car', categories: ['park', 'road_trip'], expectedCountries: ['CA'], destination: 'the Canadian Rockies', start: '2027-09-10', end: '2027-09-17', party: FAMILY, car: true, bases: 2, pace: 'balanced', intensity: 'light', budget: 'midrange', interests: { lakes_and_rivers: 'core', scenic_viewpoints: 'core', easy_nature_walks: 'frequent', wildlife: 'occasional' } }),
  profile({ id: 'rome-48h', title: 'Rome, 2 days, late arrival and early departure', categories: ['urban'], expectedCountries: ['IT'], destination: 'Rome', start: '2027-06-04', end: '2027-06-06', arrival: { precision: 'exact', time: '21:30' }, departure: { precision: 'exact', time: '09:00' }, party: COUPLE, car: false, pace: 'fast', budget: 'midrange', interests: { history_and_culture: 'core', architecture: 'core', food_and_towns: 'frequent' } }),
  profile({ id: 'nz-south-island', title: 'South Island New Zealand, 15 days, friends, February, car', categories: ['island', 'road_trip'], expectedCountries: ['NZ'], destination: 'South Island, New Zealand', start: '2027-02-06', end: '2027-02-21', party: FRIENDS, car: true, maxDrive: 300, bases: 4, pace: 'balanced', intensity: 'intense', budget: 'midrange', interests: { hiking: 'core', scenic_drives: 'core', lakes_and_rivers: 'frequent', wildlife: 'occasional' } }),
  profile({ id: 'costa-rica-family', title: 'Costa Rica, 9 days, family with kids, December, car', categories: ['country', 'rural_remote'], expectedCountries: ['CR'], destination: 'Costa Rica', start: '2027-12-27', end: '2028-01-05', party: FAMILY, car: true, bases: 3, pace: 'balanced', intensity: 'light', budget: 'midrange', interests: { wildlife: 'core', beaches_and_swimming: 'frequent', easy_nature_walks: 'frequent', hot_springs: 'occasional' } }),
  profile({ id: 'marrakech', title: 'Marrakech, 4 days, couple, March, markets', categories: ['urban'], expectedCountries: ['MA'], destination: 'Marrakech', start: '2027-03-18', end: '2027-03-22', party: COUPLE, car: false, pace: 'balanced', budget: 'midrange', interests: { markets_and_street_food: 'core', architecture: 'frequent', history_and_culture: 'frequent', wellness_and_spa: 'occasional' } }),
  profile({ id: 'norway-fjords', title: 'Norwegian fjords, 8 days, couple, June, car', categories: ['rural_remote', 'road_trip'], expectedCountries: ['NO'], destination: 'Norwegian fjords', start: '2027-06-20', end: '2027-06-28', party: COUPLE, car: true, maxDrive: 240, bases: 3, pace: 'balanced', budget: 'premium', interests: { scenic_drives: 'core', boats_and_ferries: 'frequent', hiking: 'frequent', scenic_viewpoints: 'core' } }),
  profile({ id: 'lake-district-seniors', title: 'Lake District, 5 days, seniors, May, gentle walks, car', categories: ['rural_remote', 'park'], expectedCountries: ['GB'], destination: 'Lake District', start: '2027-05-03', end: '2027-05-08', party: SENIORS, car: true, maxDrive: 120, pace: 'slow', intensity: 'light', budget: 'premium', interests: { easy_nature_walks: 'core', lakes_and_rivers: 'core', food_and_towns: 'frequent', history_and_culture: 'occasional' } }),
  profile({ id: 'amalfi-carfree', title: 'Amalfi Coast, 5 days, couple, September, car-free', categories: ['rural_remote', 'transit_heavy'], expectedCountries: ['IT'], destination: 'Amalfi Coast', start: '2027-09-14', end: '2027-09-19', party: COUPLE, car: false, pace: 'slow', budget: 'luxury', interests: { beaches_and_swimming: 'core', boats_and_ferries: 'frequent', food_and_towns: 'core', scenic_viewpoints: 'frequent' } }),
  profile({ id: 'bali-friends', title: 'Bali, 8 days, friends, July, beaches, no car', categories: ['island'], expectedCountries: ['ID'], destination: 'Bali', start: '2027-07-01', end: '2027-07-09', party: FRIENDS, car: false, transport: 'mixed', maxTravel: 180, bases: 2, pace: 'balanced', budget: 'budget', interests: { beaches_and_swimming: 'core', diving_and_snorkelling: 'frequent', history_and_culture: 'occasional', nightlife: 'frequent' } }),
  profile({ id: 'lisbon-short-solo', title: 'Lisbon, 3 days, solo, December, car-free', categories: ['urban', 'transit_heavy'], expectedCountries: ['PT'], destination: 'Lisbon', start: '2027-12-03', end: '2027-12-06', party: SOLO, car: false, pace: 'fast', budget: 'budget', interests: { local_neighbourhoods: 'core', scenic_viewpoints: 'frequent', history_and_culture: 'frequent', cafes: 'occasional' } }),
];

export function profileById(id: string): EvalProfile | undefined {
  return EVAL_PROFILES.find((p) => p.id === id);
}
