import { defineCase, interestLevels } from './builder';

/**
 * CITIES.
 *
 * Four travellers who all typed the name of a city and want four unrelated
 * things from it. Grouped together because the shape of the planning problem is
 * the same — one base, dense candidates, everything walkable or one train ride
 * away — and because that shared shape is what makes the differences between
 * them a fair test of personalisation rather than of geography.
 */

export const DENSE_CITY = defineCase({
  caseId: 'city-dense-new-york',
  title: 'Five days in New York City, museums and neighbourhoods, no car',
  traits: { kind: 'city', transit: true, dataStrength: 'strong', length: 'medium' },
  request: {
    destination: {
      mode: 'known',
      text: 'New York City',
      identity: {
        id: 'bench-new-york-city',
        displayName: 'New York City',
        countryCode: 'US',
        latitude: 40.7128,
        longitude: -74.006,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2026-10-14',
      endDate: '2026-10-19',
      nights: 5,
    },
    arrival: { precision: 'exact', time: '15:40' },
    departure: { precision: 'exact', time: '11:20' },
    origin: 'London',
    party: { adults: 2, children: 0 },
    movement: {
      preference: 'public_transport',
      publicTransit: 'prefer',
      carAvailable: false,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 120,
      maxAccessWalkMinutes: 45,
      desiredBaseCount: 1,
      maxBaseChanges: 0,
    },
    rhythm: {
      pace: 'fast',
      activityIntensity: 'moderate',
      freeTime: 'packed',
      earlyMornings: 'sometimes',
    },
    taste: {
      interests: interestLevels({
        museums_and_galleries: 'core',
        architecture: 'frequent',
        local_neighbourhoods: 'frequent',
        history_and_culture: 'occasional',
        markets_and_street_food: 'occasional',
        food_and_towns: 'occasional',
        shopping: 'occasional',
        photography_golden_hour: 'occasional',
      }),
      crowdTolerance: 'dont_mind',
      discoveryMix: 'balanced',
      foodImportance: 'matters',
      nightlifeImportance: 'a_little',
      indoorOutdoorBalance: 'balanced',
      mustDo: ['A high view over the city at dusk', 'One long afternoon in a big art museum'],
      dislikes: ['Queueing for an hour for a photograph'],
      hardAvoidances: [],
    },
    conditions: { climate: 'mild', heat: 'prefer_not', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'boutique_hotel',
      reservations: 'happy_to_book_ahead',
      guidedTours: 'avoid',
    },
    freeText:
      'Second visit for one of us and a first for the other, so we do not need to tick every famous thing. We would rather spend a whole afternoon somewhere good than half an hour in six places.',
  },
});

export const TRANSIT_CITY = defineCase({
  caseId: 'city-transit-tokyo',
  title: 'Six days in Tokyo on trains alone, one base, day trips out',
  traits: { kind: 'city', transit: true, dataStrength: 'strong', length: 'medium' },
  request: {
    destination: {
      mode: 'known',
      text: 'Tokyo',
      identity: {
        id: 'bench-tokyo',
        displayName: 'Tokyo',
        countryCode: 'JP',
        latitude: 35.6762,
        longitude: 139.6503,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2026-11-07',
      endDate: '2026-11-13',
      nights: 6,
    },
    arrival: { precision: 'afternoon', time: null },
    departure: { precision: 'morning', time: null },
    origin: 'Vancouver',
    party: { adults: 2, children: 0, dietary: ['vegetarian'], dietaryStrict: false },
    movement: {
      preference: 'public_transport',
      publicTransit: 'prefer',
      carAvailable: false,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 180,
      maxAccessWalkMinutes: 40,
      desiredBaseCount: 1,
      maxBaseChanges: 0,
    },
    rhythm: {
      pace: 'balanced',
      activityIntensity: 'moderate',
      freeTime: 'balanced',
      earlyMornings: 'happily',
    },
    taste: {
      interests: interestLevels({
        food_and_towns: 'core',
        trains: 'frequent',
        local_neighbourhoods: 'frequent',
        markets_and_street_food: 'frequent',
        history_and_culture: 'occasional',
        architecture: 'occasional',
        cafes: 'occasional',
        easy_nature_walks: 'occasional',
        shopping: 'occasional',
      }),
      crowdTolerance: 'mild',
      discoveryMix: 'mostly_hidden',
      foodImportance: 'central',
      nightlifeImportance: 'a_little',
      indoorOutdoorBalance: 'balanced',
      mustDo: ['One day trip out of the city by train'],
      dislikes: ['Themed cafes'],
      hardAvoidances: [],
    },
    conditions: { climate: 'cool', heat: 'prefer_not', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'basic_hotel',
      reservations: 'a_few_is_fine',
      guidedTours: 'avoid',
    },
    freeText:
      'Neither of us drives and we would rather not start. One of us is vegetarian but eats fish stock without minding, so please do not make the whole trip about it.',
  },
});

export const FOOD_WEEKEND = defineCase({
  caseId: 'city-food-weekend-oaxaca',
  title: 'A three-night eating weekend in Oaxaca',
  traits: { kind: 'city', transit: true, dataStrength: 'strong', length: 'short' },
  request: {
    destination: {
      mode: 'known',
      text: 'Oaxaca de Juárez',
      identity: {
        id: 'bench-oaxaca',
        displayName: 'Oaxaca de Juárez',
        countryCode: 'MX',
        latitude: 17.0732,
        longitude: -96.7266,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2027-02-12',
      endDate: '2027-02-15',
      nights: 3,
    },
    arrival: { precision: 'exact', time: '12:15' },
    departure: { precision: 'evening', time: null },
    origin: 'Mexico City',
    party: { adults: 4, children: 0 },
    movement: {
      preference: 'mixed',
      publicTransit: 'accept',
      carAvailable: false,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 150,
      maxAccessWalkMinutes: 35,
      desiredBaseCount: 1,
      maxBaseChanges: 0,
    },
    rhythm: {
      pace: 'slow',
      activityIntensity: 'light',
      freeTime: 'lots',
      earlyMornings: 'sometimes',
    },
    taste: {
      interests: interestLevels({
        markets_and_street_food: 'core',
        food_and_towns: 'core',
        fine_dining: 'occasional',
        cafes: 'frequent',
        local_neighbourhoods: 'occasional',
        history_and_culture: 'occasional',
        shopping: 'occasional',
      }),
      crowdTolerance: 'mild',
      discoveryMix: 'balanced',
      foodImportance: 'central',
      nightlifeImportance: 'a_little',
      indoorOutdoorBalance: 'balanced',
      mustDo: ['A proper market breakfast', 'One long dinner worth dressing up for'],
      dislikes: ['Anything described as a food tour with a headset'],
      hardAvoidances: ['expensive_activities'],
    },
    conditions: { climate: 'warm', heat: 'fine', cold: 'fine', rain: 'prefer_not', snow: 'fine' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'apartment',
      reservations: 'happy_to_book_ahead',
      guidedTours: 'sometimes',
    },
    freeText:
      'Four friends who mainly want to eat. We are happy to walk between places and we do not want a packed sightseeing schedule around the meals.',
  },
});

export const NIGHTLIFE_SHORT = defineCase({
  caseId: 'city-nightlife-berlin',
  title: 'Two nights in Berlin built around the evenings',
  traits: { kind: 'city', transit: true, dataStrength: 'strong', length: 'short' },
  request: {
    destination: {
      mode: 'known',
      text: 'Berlin',
      identity: {
        id: 'bench-berlin',
        displayName: 'Berlin',
        countryCode: 'DE',
        latitude: 52.52,
        longitude: 13.405,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2026-09-18',
      endDate: '2026-09-20',
      nights: 2,
    },
    arrival: { precision: 'exact', time: '18:50' },
    departure: { precision: 'afternoon', time: null },
    origin: 'Copenhagen',
    party: { adults: 3, children: 0 },
    movement: {
      preference: 'public_transport',
      publicTransit: 'prefer',
      carAvailable: false,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 120,
      maxAccessWalkMinutes: 30,
      desiredBaseCount: 1,
      maxBaseChanges: 0,
    },
    rhythm: {
      pace: 'balanced',
      activityIntensity: 'light',
      freeTime: 'lots',
      earlyMornings: 'never',
    },
    taste: {
      interests: interestLevels({
        nightlife: 'core',
        local_neighbourhoods: 'frequent',
        markets_and_street_food: 'occasional',
        museums_and_galleries: 'occasional',
        cafes: 'occasional',
        history_and_culture: 'occasional',
      }),
      crowdTolerance: 'dont_mind',
      discoveryMix: 'mostly_hidden',
      foodImportance: 'matters',
      nightlifeImportance: 'central',
      indoorOutdoorBalance: 'mostly_indoor',
      mustDo: ['A late night that does not end at midnight'],
      dislikes: ['Anything that needs us up before ten'],
      hardAvoidances: ['early_mornings'],
    },
    conditions: { climate: 'cool', heat: 'prefer_not', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'budget',
      accommodation: 'hostel',
      reservations: 'keep_it_spontaneous',
      guidedTours: 'avoid',
    },
    freeText:
      'We land on Friday evening and fly out Sunday afternoon. The days are for recovering, the nights are the point. Please do not schedule anything before eleven in the morning.',
  },
});

export const CITY_CASES = [DENSE_CITY, TRANSIT_CITY, FOOD_WEEKEND, NIGHTLIFE_SHORT] as const;
