import 'server-only';
import {
  benchmarkTripRequestSchema,
  BENCHMARK_REQUEST_VERSION,
  type BenchmarkInterest,
  type BenchmarkTripRequest,
} from '@sidequest/bench';
import { nightsFrom, type Trip, type TravelerProfile, type TripComposerAnswers } from '@sidequest/core';

/**
 * BENCHMARK ONLY — TRIP + WHATEVER PREFERENCES EXIST, COMPRESSED INTO ONE
 * COMPACT BENCHMARK REQUEST.
 *
 * PRODUCTION LOCK V5 §2 moved this file out of `planning/`. It was the only
 * input assembler on the canonical build path, and a benchmark schema's
 * vocabularies therefore bounded the whole product — including the diet
 * vocabulary, whose narrowing crashed a real trip on Build. Production now
 * builds `CanonicalTripBuildInput` (`planning/canonical-input.ts`) from real
 * product state only, and `benchmark-isolation.test.ts` keeps it that way.
 * This adapter remains for the benchmark harness, acceptance replays and
 * regression fixtures.
 *
 * The composer answers are captured on trip creation, before anything paid
 * runs (see `packages/core/src/schemas/composer.ts`), and are already almost
 * everything §7 of the Phase 17 spec asks the "minimal-first" path to have:
 * destination, dates, travellers, transport, a handful of themes, free text.
 * A completed nine-step questionnaire (`TravelerProfile`) is optional
 * enrichment layered on top when it exists — never required to get a first
 * plan.
 *
 * This function is deliberately total: every `BenchmarkTripRequest` field is
 * either read from what the traveller actually said or given the same
 * documented default every field in this file names beside it. Nothing here
 * is invented as a fact about the world; these are all preferences, exactly
 * as `composer.ts` describes its own inputs.
 */

const THEME_INTERESTS: Record<string, BenchmarkInterest[]> = {
  outdoors: ['hiking', 'easy_nature_walks', 'scenic_viewpoints'],
  mountains: ['hiking', 'scenic_drives', 'scenic_viewpoints'],
  water: ['beaches_and_swimming', 'lakes_and_rivers', 'boats_and_ferries'],
  wildlife: ['wildlife'],
  food: ['food_and_towns', 'markets_and_street_food', 'cafes'],
  culture: ['history_and_culture', 'museums_and_galleries', 'architecture'],
  cities: ['local_neighbourhoods', 'shopping', 'architecture'],
  quiet: ['scenic_viewpoints', 'easy_nature_walks'],
};

const AVOIDANCE_MAP: Record<string, BenchmarkTripRequest['taste']['hardAvoidances'][number]> = {
  crowds_and_tourist_traps: 'crowds_and_tourist_traps',
  long_hikes: 'long_hikes',
  strenuous_activity: 'strenuous_activity',
  long_drives: 'long_drives',
  rough_or_gravel_roads: 'rough_or_unpaved_roads',
  high_altitude_exertion: 'high_altitude_exertion',
  early_mornings: 'early_mornings',
  remote_areas_without_services: 'remote_areas_without_services',
  expensive_activities: 'expensive_activities',
  cold_water: 'cold_water',
  extreme_heat: 'extreme_heat',
  extreme_cold: 'extreme_cold',
};

/** Every interest the request must carry, defaulted to `low` unless stated. */
function baseInterests(): Record<BenchmarkInterest, 'avoid' | 'low' | 'occasional' | 'frequent' | 'core'> {
  const record: Partial<Record<BenchmarkInterest, 'avoid' | 'low' | 'occasional' | 'frequent' | 'core'>> = {};
  for (const interest of BENCHMARK_INTERESTS) record[interest] = 'low';
  return record as Record<BenchmarkInterest, 'avoid' | 'low' | 'occasional' | 'frequent' | 'core'>;
}

// Re-declared rather than imported to avoid a runtime dependency cycle risk;
// kept in the same order as `@sidequest/bench`'s own list so a coverage test
// can assert the two never drift silently.
const BENCHMARK_INTERESTS: BenchmarkInterest[] = [
  'hiking',
  'easy_nature_walks',
  'scenic_viewpoints',
  'lakes_and_rivers',
  'beaches_and_swimming',
  'scenic_drives',
  'wildlife',
  'geology_and_geothermal',
  'hot_springs',
  'history_and_culture',
  'museums_and_galleries',
  'architecture',
  'food_and_towns',
  'markets_and_street_food',
  'fine_dining',
  'cafes',
  'nightlife',
  'shopping',
  'local_neighbourhoods',
  'festivals_and_events',
  'photography_golden_hour',
  'stargazing',
  'wellness_and_spa',
  'boats_and_ferries',
  'trains',
  'winter_sports',
  'diving_and_snorkelling',
  'theme_parks',
];

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function buildHybridTripRequest(input: {
  trip: Trip;
  composer: TripComposerAnswers | null;
  profile: TravelerProfile | null;
  now: Date;
}): BenchmarkTripRequest {
  const { trip, composer, profile } = input;

  const nights = Math.max(
    1,
    (composer ? nightsFrom(composer) : null) ??
      countNightsFromBasics(trip) ??
      1,
  );

  const interests = baseInterests();
  for (const theme of composer?.themes ?? []) {
    for (const interest of THEME_INTERESTS[theme] ?? []) {
      interests[interest] = 'frequent';
    }
  }
  if (composer?.nightlife === 'important') interests.nightlife = 'frequent';
  else if (composer?.nightlife === 'some') interests.nightlife = 'occasional';

  // A completed questionnaire narrows the "low" defaults left over from the
  // composer's eight coarse themes into the thirty-interest ladder it was
  // always going to replace, wherever the two vocabularies name the same
  // thing.
  if (profile) {
    for (const [key, level] of Object.entries(profile.interests)) {
      if (isBenchmarkInterest(key)) {
        interests[key] = mapInterestLevel(level);
      }
    }
  }

  /*
   * A truly minimal request — "plan what you think is right for me", no
   * themes, no completed questionnaire — must still satisfy the schema's own
   * rule that a request naming nothing above "only if it is right there"
   * cannot personalise anything. Two broad, generically appealing interests
   * cover that case without pretending a preference was stated.
   */
  if (!BENCHMARK_INTERESTS.some((interest) => ['occasional', 'frequent', 'core'].includes(interests[interest]))) {
    interests.scenic_viewpoints = 'occasional';
    interests.history_and_culture = 'occasional';
    interests.food_and_towns = 'occasional';
  }

  const hardAvoidances = new Set<BenchmarkTripRequest['taste']['hardAvoidances'][number]>();
  for (const avoidance of profile?.avoidances ?? []) {
    const mapped = AVOIDANCE_MAP[avoidance];
    if (mapped) hardAvoidances.add(mapped);
  }
  /*
   * The interview's typed hard constraints, where the benchmark vocabulary
   * has a word for them. `profile.hard` is the one list that holds everything
   * hard, whichever screen it was said on.
   */
  const interview = profile?.interview;
  for (const constraint of profile?.hard ?? []) {
    if (constraint.code === 'no_boats') hardAvoidances.add('boats_and_ferries');
    if (constraint.code === 'no_small_aircraft') hardAvoidances.add('small_aircraft');
    if (constraint.code === 'no_late_nights') hardAvoidances.add('nightlife');
    if (constraint.code === 'no_remote_areas') hardAvoidances.add('remote_areas_without_services');
    if (constraint.code === 'no_high_altitude') hardAvoidances.add('high_altitude_exertion');
    if (constraint.code === 'no_strenuous_hiking') {
      hardAvoidances.add('strenuous_activity');
      hardAvoidances.add('long_hikes');
    }
    if (constraint.code === 'no_early_starts') hardAvoidances.add('early_mornings');
    if (constraint.code === 'max_daily_drive_minutes' && (constraint.value ?? 480) <= 120) hardAvoidances.add('long_drives');
  }

  const mustDo = composer?.mustDo ? splitFreeText(composer.mustDo) : [];
  const dislikes = composer?.avoid ? splitFreeText(composer.avoid) : [];

  const willDrive =
    profile?.transport.willDrive ??
    (composer?.transport ? composer.transport !== 'public_transport' : true);
  const maxDailyDriveMinutes =
    profile?.transport.maxDailyDriveMinutes ??
    composer?.maxDailyDriveMinutes ??
    (willDrive ? 240 : 0);
  const maxDailyTravelMinutes =
    profile?.transport.maxDailyTransportMinutes ?? Math.max(maxDailyDriveMinutes, 60) + 60;

  const desiredBaseCount = interview ? baseCountFromInterview(interview, composer?.shape, nights) : baseCountFor(composer?.shape, nights);
  const maxBaseChanges =
    interview?.baseMoveTolerance === 'stay_put'
      ? 0
      : interview?.baseMoveTolerance === 'move_once'
        ? 1
        : Math.max(desiredBaseCount - 1, desiredBaseCount);

  const budget = mapBudget(profile?.budgetStyle ?? composer?.budget);
  const pace = mapPace(profile?.pace ?? composer?.pace);
  const activityIntensity = mapIntensity(profile?.dailyIntensity ?? composer?.outdoorIntensity);
  const freeTime = profile?.freeTime ?? composer?.freeTime ?? 'balanced';
  const crowdTolerance = mapCrowdTolerance(profile?.crowdTolerance ?? composer?.crowdTolerance);
  const foodImportance = mapImportance(composer?.foodImportance, profile ? 'matters' : 'a_little');
  const nightlifeImportance = mapImportance(
    composer?.nightlife === 'important' ? 'central' : composer?.nightlife === 'some' ? 'matters' : undefined,
    'not_at_all',
  );

  const mobility: BenchmarkTripRequest['party']['mobility'] = [];
  if (
    trip.basics.travelerNeeds.includes('mobility_limited') ||
    profile?.accessibility.mobilityLimited
  ) {
    mobility.push('limited_walking');
  }
  if (trip.basics.travelerNeeds.includes('altitude_sensitive')) {
    mobility.push('altitude_sensitive');
  }

  const request: BenchmarkTripRequest = {
    schemaVersion: BENCHMARK_REQUEST_VERSION,
    requestId: `trip:${trip.id}`,
    destination: {
      mode: 'known',
      text: trip.basics.destinationInput,
      identity: null,
    },
    dates: {
      mode: composer?.dates.mode === 'flexible' ? 'flexible' : 'exact',
      startDate: trip.basics.startDate,
      endDate: trip.basics.endDate,
      flexDays: composer?.dates.flexDays ?? 0,
      month: null,
      year: null,
      nights,
    },
    arrival: {
      precision: mapArrivalPrecision(composer?.arrival?.precision),
      time: composer?.arrival?.precision === 'exact' ? composer.arrival.time ?? trip.basics.arrivalTime : null,
    },
    departure: {
      precision: mapArrivalPrecision(composer?.departure?.precision),
      time:
        composer?.departure?.precision === 'exact'
          ? composer.departure.time ?? trip.basics.departureTime
          : null,
    },
    origin: composer?.origin ?? '',
    party: {
      adults: trip.basics.adults,
      children: trip.basics.children,
      childAges: [],
      seniorsInGroup: trip.basics.travelerNeeds.includes('seniors_in_group'),
      mobility,
      mobilityNotes: profile?.accessibility.notes ?? '',
      /*
       * PRODUCTION LOCK V5 §4 — strictness cannot outlive the requirement it
       * belongs to. Core's dietary vocabulary is composable and much wider than
       * the benchmark's; narrowing the list here while carrying `dietaryStrict`
       * through unchanged left strictness with nothing to be strict about, which
       * the request schema (correctly) refuses — and that Zod throw was the
       * full-questionnaire Build crash. The production path no longer comes
       * through this file at all, and this adapter no longer produces the orphan.
       */
      ...(() => {
        const dietary = (profile?.food.dietaryNeeds ?? []).filter(isBenchmarkDietary);
        return { dietary, dietaryStrict: dietary.length > 0 && (profile?.food.dietaryStrict ?? false) };
      })(),
    },
    movement: {
      preference:
        interview && !willDrive && interview.guideWillingness === 'prefer'
          ? 'guided_or_transfers'
          : interview && willDrive && profile?.provenance.transport_mode
            ? 'drive'
            : interview && !willDrive && profile?.provenance.transport_mode
              ? 'public_transport'
              : mapTransportPreference(composer?.transport),
      publicTransit: willDrive ? 'accept' : profile?.transport.priority === 'least_stressful' ? 'accept' : 'prefer',
      carAvailable: willDrive,
      comfortableMountainRoads: profile?.transport.comfortableMountainRoads ?? true,
      comfortableUnpavedRoads: profile?.transport.comfortableGravelRoads ?? true,
      willUseShuttlesAndFerries: interview ? interview.boatsAndFerries !== 'cannot' && (profile?.transport.willUseShuttles ?? true) : (profile?.transport.willUseShuttles ?? true),
      maxDailyDriveMinutes,
      maxDailyTravelMinutes: clampInt(maxDailyTravelMinutes, 30, 720),
      maxAccessWalkMinutes: profile?.transport.maxAccessWalkMinutes ?? 30,
      desiredBaseCount,
      maxBaseChanges,
    },
    rhythm: {
      pace,
      activityIntensity,
      freeTime,
      earlyMornings: profile?.dayStart === 'early' ? 'happily' : profile?.dayStart === 'relaxed' ? 'never' : 'sometimes',
    },
    taste: {
      interests,
      crowdTolerance,
      discoveryMix: profile?.discoveryMix ?? 'balanced',
      foodImportance,
      nightlifeImportance,
      indoorOutdoorBalance: 'balanced',
      mustDo: mustDo.slice(0, 10),
      dislikes: dislikes.slice(0, 10),
      hardAvoidances: [...hardAvoidances],
    },
    conditions: {
      climate: 'no_preference',
      heat: profile?.avoidances.includes('extreme_heat') ? 'cannot' : 'fine',
      cold: profile?.avoidances.includes('extreme_cold') ? 'cannot' : 'fine',
      rain: 'fine',
      snow: 'fine',
    },
    practicalities: {
      budget,
      accommodation: mapAccommodation(interview?.lodgingStyle, interview?.rusticLodgingOk),
      reservations:
        interview?.convenienceSpend === 'pay_to_reduce_hassle'
          ? 'happy_to_book_ahead'
          : interview?.convenienceSpend === 'save_money'
            ? 'keep_it_spontaneous'
            : 'a_few_is_fine',
      guidedTours: interview?.guideWillingness ?? 'sometimes',
    },
    freeText: [composer?.mustDo, composer?.avoid].filter(Boolean).join('\n').slice(0, 2000),
  };

  return benchmarkTripRequestSchema.parse(request);
}

const BENCHMARK_DIETARY = ['vegetarian', 'vegan', 'gluten_free', 'dairy_free', 'nut_allergy', 'halal', 'kosher'] as const;
function isBenchmarkDietary(value: string): value is (typeof BENCHMARK_DIETARY)[number] {
  return (BENCHMARK_DIETARY as readonly string[]).includes(value);
}

function mapAccommodation(
  style: TravelerProfile['interview']['lodgingStyle'] | undefined,
  rusticOk: boolean | undefined,
): BenchmarkTripRequest['practicalities']['accommodation'] {
  switch (style) {
    case 'hostel':
      return 'hostel';
    case 'basic_hotel':
      return 'basic_hotel';
    case 'boutique_hotel':
      return 'boutique_hotel';
    case 'apartment':
      return 'apartment';
    case 'resort':
      return 'resort';
    case 'luxury_hotel':
      return 'luxury_hotel';
    case 'nature_lodge':
      return 'nature_lodge';
    default:
      return rusticOk === false ? 'basic_hotel' : 'no_preference';
  }
}

/**
 * How many bases the interview implies. The base-move tolerance is the
 * traveller's own statement about hotel changes; the coverage strategy says
 * whether a broad destination is seen deep or wide; the composer's shape is
 * the fallback for both.
 */
function baseCountFromInterview(
  interview: TravelerProfile['interview'],
  shape: string | undefined,
  nights: number,
): number {
  if (interview.baseMoveTolerance === 'stay_put') return 1;
  if (interview.baseMoveTolerance === 'move_once') return Math.min(2, Math.max(1, nights));
  if (interview.scopeStrategy === 'depth') return clampInt(nights / 4, 1, 2);
  if (interview.scopeStrategy === 'breadth' || interview.baseMoveTolerance === 'move_freely') return clampInt(nights / 2.5, 2, 8);
  return baseCountFor(shape, nights);
}

function isBenchmarkInterest(key: string): key is BenchmarkInterest {
  return (BENCHMARK_INTERESTS as string[]).includes(key);
}

function mapInterestLevel(
  level: string,
): 'avoid' | 'low' | 'occasional' | 'frequent' | 'core' {
  if (level === 'avoid' || level === 'low' || level === 'occasional' || level === 'frequent' || level === 'core') {
    return level;
  }
  return 'low';
}

function splitFreeText(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 10);
}

function countNightsFromBasics(trip: Trip): number | null {
  const start = Date.parse(`${trip.basics.startDate}T00:00:00Z`);
  const end = Date.parse(`${trip.basics.endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.max(1, Math.round((end - start) / 86_400_000));
}

function baseCountFor(shape: string | undefined, nights: number): number {
  if (shape === 'one_base') return 1;
  if (shape === 'two_bases') return 2;
  if (shape === 'circuit') return clampInt(nights / 2.5, 3, 8);
  // Undecided or unstated: let the model propose a structure, bounded to
  // something a trip this length could plausibly support.
  return clampInt(nights / 3, 1, 6);
}

function mapBudget(value: string | undefined): BenchmarkTripRequest['practicalities']['budget'] {
  switch (value) {
    case 'budget':
      return 'budget';
    case 'midrange':
    case 'mid_range':
      return 'midrange';
    case 'premium':
      return 'premium';
    case 'luxury':
      return 'luxury';
    default:
      return 'midrange';
  }
}

function mapPace(value: string | undefined): BenchmarkTripRequest['rhythm']['pace'] {
  if (value === 'slow') return 'slow';
  if (value === 'fast' || value === 'packed') return 'fast';
  return 'balanced';
}

function mapIntensity(value: string | undefined): BenchmarkTripRequest['rhythm']['activityIntensity'] {
  if (value === 'light' || value === 'gentle') return 'light';
  if (value === 'intense' || value === 'strenuous') return 'intense';
  return 'moderate';
}

function mapCrowdTolerance(value: string | undefined): BenchmarkTripRequest['taste']['crowdTolerance'] {
  if (value === 'avoid_crowds' || value === 'avoid') return 'avoid_crowds';
  if (value === 'dont_mind' || value === 'unbothered') return 'dont_mind';
  return 'mild';
}

function mapImportance(
  value: string | undefined,
  fallback: BenchmarkTripRequest['taste']['foodImportance'],
): BenchmarkTripRequest['taste']['foodImportance'] {
  switch (value) {
    case 'fuel':
      return 'a_little';
    case 'matters':
      return 'matters';
    case 'central':
      return 'central';
    case 'not_at_all':
    case 'a_little':
      return value;
    default:
      return fallback;
  }
}

function mapTransportPreference(
  value: string | undefined,
): BenchmarkTripRequest['movement']['preference'] {
  switch (value) {
    case 'drive':
      return 'drive';
    case 'public_transport':
      return 'public_transport';
    case 'mixed':
      return 'mixed';
    default:
      return 'no_preference';
  }
}

function mapArrivalPrecision(
  value: string | undefined,
): BenchmarkTripRequest['arrival']['precision'] {
  switch (value) {
    case 'exact':
    case 'morning':
    case 'afternoon':
    case 'evening':
      return value;
    default:
      return 'unknown';
  }
}
