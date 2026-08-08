import { defineCase, interestLevels } from './builder';

/**
 * OUTDOORS.
 *
 * Where the world stops answering questions. A national park publishes a great
 * deal; a high mountain region in Central Asia publishes almost nothing; a
 * tropical island publishes plenty about the busy half and little about the
 * rest. All three are planned against the same schema, so the difference between
 * a system that says "the pass may be shut and I could not find out" and one
 * that quietly asserts a road is open shows up as a difference in the plans
 * rather than as a difference in the fixtures.
 */

export const NATIONAL_PARK = defineCase({
  caseId: 'park-yosemite',
  title: 'Five nights in Yosemite National Park with a car and a permit problem',
  traits: { kind: 'park', transit: false, dataStrength: 'strong', length: 'medium' },
  request: {
    destination: {
      mode: 'known',
      text: 'Yosemite National Park',
      identity: {
        id: 'bench-yosemite',
        displayName: 'Yosemite National Park',
        countryCode: 'US',
        latitude: 37.8651,
        longitude: -119.5383,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2027-06-19',
      endDate: '2027-06-24',
      nights: 5,
    },
    arrival: { precision: 'afternoon', time: null },
    departure: { precision: 'exact', time: '09:00' },
    origin: 'San Francisco',
    party: { adults: 2, children: 0 },
    movement: {
      preference: 'drive',
      publicTransit: 'accept',
      carAvailable: true,
      comfortableMountainRoads: true,
      comfortableUnpavedRoads: false,
      willUseShuttlesAndFerries: true,
      maxDailyDriveMinutes: 150,
      maxDailyTravelMinutes: 240,
      maxAccessWalkMinutes: 60,
      desiredBaseCount: 2,
      maxBaseChanges: 1,
    },
    rhythm: {
      pace: 'balanced',
      activityIntensity: 'intense',
      freeTime: 'balanced',
      earlyMornings: 'happily',
    },
    taste: {
      interests: interestLevels({
        hiking: 'core',
        scenic_viewpoints: 'core',
        photography_golden_hour: 'frequent',
        lakes_and_rivers: 'occasional',
        wildlife: 'occasional',
        stargazing: 'occasional',
        easy_nature_walks: 'occasional',
        scenic_drives: 'occasional',
        geology_and_geothermal: 'occasional',
      }),
      crowdTolerance: 'avoid_crowds',
      discoveryMix: 'balanced',
      foodImportance: 'a_little',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'mostly_outdoor',
      mustDo: ['One long day hike with real elevation', 'A sunrise somewhere high'],
      dislikes: ['Roadside viewpoints with a car park queue'],
      hardAvoidances: ['crowds_and_tourist_traps'],
    },
    conditions: { climate: 'mild', heat: 'prefer_not', cold: 'fine', rain: 'prefer_not', snow: 'fine' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'basic_hotel',
      reservations: 'happy_to_book_ahead',
      guidedTours: 'avoid',
    },
    freeText:
      'We know some things here need booking months out and we would rather be told plainly what we have probably already missed than be given a plan that quietly assumes we got a permit.',
  },
});

export const REMOTE_OUTDOOR = defineCase({
  caseId: 'outdoor-remote-kyrgyzstan',
  title: 'Ten nights in the Kyrgyz mountains, driver hired, thin data everywhere',
  traits: { kind: 'outdoor', transit: false, dataStrength: 'weak', length: 'long' },
  request: {
    destination: {
      mode: 'known',
      text: 'Kyrgyzstan',
      identity: {
        id: 'bench-kyrgyzstan',
        displayName: 'Kyrgyzstan',
        countryCode: 'KG',
        latitude: 41.2044,
        longitude: 74.7661,
      },
    },
    // A month rather than a span. The traveller has not booked flights, and a
    // plan that pretends to know the arrival date would be asserting something
    // nobody said — which is precisely the behaviour under test.
    dates: {
      mode: 'month',
      startDate: null,
      endDate: null,
      month: 7,
      year: 2027,
      nights: 10,
    },
    arrival: { precision: 'unknown', time: null },
    departure: { precision: 'unknown', time: null },
    origin: 'Istanbul',
    party: { adults: 2, children: 0, mobility: ['altitude_sensitive'] },
    movement: {
      preference: 'guided_or_transfers',
      publicTransit: 'accept',
      carAvailable: false,
      comfortableMountainRoads: true,
      comfortableUnpavedRoads: true,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 330,
      maxAccessWalkMinutes: 120,
      desiredBaseCount: 4,
      maxBaseChanges: 4,
    },
    rhythm: {
      pace: 'balanced',
      activityIntensity: 'moderate',
      freeTime: 'balanced',
      earlyMornings: 'happily',
    },
    taste: {
      interests: interestLevels({
        hiking: 'core',
        scenic_viewpoints: 'frequent',
        lakes_and_rivers: 'frequent',
        wildlife: 'occasional',
        stargazing: 'occasional',
        history_and_culture: 'occasional',
        markets_and_street_food: 'occasional',
        hot_springs: 'occasional',
        scenic_drives: 'occasional',
      }),
      crowdTolerance: 'avoid_crowds',
      discoveryMix: 'deep_cuts',
      foodImportance: 'a_little',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'mostly_outdoor',
      mustDo: ['A night somewhere with no road to it'],
      dislikes: ['Being driven past things without stopping'],
      hardAvoidances: ['high_altitude_exertion'],
    },
    conditions: { climate: 'cool', heat: 'prefer_not', cold: 'fine', rain: 'fine', snow: 'prefer_not' },
    practicalities: {
      budget: 'budget',
      accommodation: 'no_preference',
      reservations: 'keep_it_spontaneous',
      guidedTours: 'prefer',
    },
    freeText:
      'One of us gets headaches above about three thousand metres, so please build in time to acclimatise rather than assuming we will be fine. We will hire a driver rather than drive ourselves.',
  },
});

export const TROPICAL_ISLAND = defineCase({
  caseId: 'island-bali',
  title: 'Seven nights in Bali, two bases, hired driver rather than self-drive',
  traits: { kind: 'island', transit: false, dataStrength: 'strong', length: 'medium' },
  request: {
    destination: {
      mode: 'known',
      text: 'Bali',
      identity: {
        id: 'bench-bali',
        displayName: 'Bali',
        countryCode: 'ID',
        latitude: -8.4095,
        longitude: 115.1889,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2027-04-10',
      endDate: '2027-04-17',
      nights: 7,
    },
    arrival: { precision: 'exact', time: '23:55' },
    departure: { precision: 'exact', time: '01:30' },
    origin: 'Perth',
    party: { adults: 2, children: 0, dietary: ['nut_allergy'], dietaryStrict: true },
    movement: {
      preference: 'guided_or_transfers',
      publicTransit: 'avoid',
      carAvailable: false,
      comfortableMountainRoads: true,
      comfortableUnpavedRoads: false,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 180,
      maxAccessWalkMinutes: 30,
      desiredBaseCount: 2,
      maxBaseChanges: 1,
    },
    rhythm: {
      pace: 'slow',
      activityIntensity: 'light',
      freeTime: 'lots',
      earlyMornings: 'sometimes',
    },
    taste: {
      interests: interestLevels({
        beaches_and_swimming: 'core',
        wellness_and_spa: 'frequent',
        food_and_towns: 'frequent',
        easy_nature_walks: 'occasional',
        scenic_viewpoints: 'occasional',
        history_and_culture: 'occasional',
        markets_and_street_food: 'occasional',
        diving_and_snorkelling: 'occasional',
      }),
      crowdTolerance: 'mild',
      discoveryMix: 'balanced',
      foodImportance: 'matters',
      nightlifeImportance: 'a_little',
      indoorOutdoorBalance: 'mostly_outdoor',
      mustDo: ['A morning in the water somewhere clear'],
      dislikes: ['Sunrise volcano queues'],
      hardAvoidances: ['early_mornings'],
    },
    conditions: { climate: 'warm', heat: 'fine', cold: 'fine', rain: 'prefer_not', snow: 'fine' },
    practicalities: {
      budget: 'premium',
      accommodation: 'resort',
      reservations: 'happy_to_book_ahead',
      guidedTours: 'sometimes',
    },
    freeText:
      'The nut allergy is severe and not a preference — please do not send us anywhere that cannot say plainly whether a dish is safe. We land near midnight and leave in the small hours, so the first and last days are mostly gone.',
  },
});

export const OUTDOOR_CASES = [NATIONAL_PARK, REMOTE_OUTDOOR, TROPICAL_ISLAND] as const;
