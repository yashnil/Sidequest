import { defineCase, interestLevels } from './builder';

/**
 * TRAVELLERS RATHER THAN DESTINATIONS.
 *
 * Each of these is here because of who is going, not where. Between them they
 * cover the four constraints that most often turn a good-looking plan into an
 * unusable one — a six-year-old, an unwillingness to drive far, a refusal to be
 * rushed, and a wheelchair — and each is stated as a field rather than left in
 * prose, because a plan that honours a constraint only when a model happens to
 * read the free text is a plan that will drop it on the day it matters.
 */

export const FAMILY_TRIP = defineCase({
  caseId: 'family-costa-rica',
  title: 'A week in Costa Rica with a six-year-old and a nine-year-old',
  traits: { kind: 'road_trip', transit: false, dataStrength: 'strong', length: 'medium' },
  request: {
    destination: {
      mode: 'known',
      text: 'Costa Rica',
      identity: {
        id: 'bench-costa-rica',
        displayName: 'Costa Rica',
        countryCode: 'CR',
        latitude: 9.7489,
        longitude: -83.7534,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2026-12-19',
      endDate: '2026-12-26',
      nights: 7,
    },
    arrival: { precision: 'exact', time: '14:20' },
    departure: { precision: 'exact', time: '12:45' },
    origin: 'Toronto',
    party: {
      adults: 2,
      children: 2,
      childAges: [6, 9],
      seniorsInGroup: false,
      dietary: ['gluten_free'],
      dietaryStrict: true,
    },
    movement: {
      preference: 'drive',
      publicTransit: 'accept',
      carAvailable: true,
      comfortableMountainRoads: true,
      comfortableUnpavedRoads: false,
      willUseShuttlesAndFerries: true,
      maxDailyDriveMinutes: 150,
      maxDailyTravelMinutes: 210,
      maxAccessWalkMinutes: 25,
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
        wildlife: 'core',
        beaches_and_swimming: 'frequent',
        easy_nature_walks: 'frequent',
        scenic_viewpoints: 'occasional',
        lakes_and_rivers: 'occasional',
        hot_springs: 'occasional',
        food_and_towns: 'occasional',
      }),
      crowdTolerance: 'mild',
      discoveryMix: 'mostly_classics',
      foodImportance: 'matters',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'mostly_outdoor',
      mustDo: ['Sloths that the children can actually see', 'A pool or a beach every single day'],
      dislikes: ['Anything with a two-hour minimum where the children cannot leave'],
      hardAvoidances: ['long_drives', 'strenuous_activity', 'rough_or_unpaved_roads'],
    },
    conditions: { climate: 'warm', heat: 'prefer_not', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'apartment',
      reservations: 'happy_to_book_ahead',
      guidedTours: 'prefer',
    },
    freeText:
      'The coeliac diagnosis is real and we have had a holiday go badly wrong over it before. The younger one falls asleep in the car after about ninety minutes, so long transfers cost us the afternoon as well as the drive.',
  },
});

export const LOW_DRIVING = defineCase({
  caseId: 'low-driving-scottish-highlands',
  title: 'Six nights in the Highlands with a car but almost no appetite for driving',
  traits: { kind: 'outdoor', transit: true, dataStrength: 'strong', length: 'medium' },
  request: {
    destination: {
      mode: 'known',
      text: 'the Scottish Highlands',
      identity: {
        id: 'bench-scottish-highlands',
        displayName: 'Scottish Highlands',
        countryCode: 'GB',
        latitude: 57.12,
        longitude: -4.71,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2027-05-08',
      endDate: '2027-05-14',
      nights: 6,
    },
    arrival: { precision: 'exact', time: '17:15' },
    departure: { precision: 'morning', time: null },
    origin: 'Bristol',
    party: { adults: 2, children: 0, seniorsInGroup: true },
    movement: {
      preference: 'mixed',
      publicTransit: 'prefer',
      carAvailable: true,
      comfortableMountainRoads: false,
      comfortableUnpavedRoads: false,
      willUseShuttlesAndFerries: true,
      // A car exists and is barely used. That is a materially different request
      // from having no car at all, and the two must not collapse into each other
      // — a plan that puts a two-hour drive in front of somebody who said one
      // hour has broken a stated constraint, not merely chosen unwisely.
      maxDailyDriveMinutes: 60,
      maxDailyTravelMinutes: 150,
      maxAccessWalkMinutes: 60,
      desiredBaseCount: 2,
      maxBaseChanges: 1,
    },
    rhythm: {
      pace: 'slow',
      activityIntensity: 'moderate',
      freeTime: 'lots',
      earlyMornings: 'sometimes',
    },
    taste: {
      interests: interestLevels({
        easy_nature_walks: 'core',
        trains: 'frequent',
        scenic_viewpoints: 'frequent',
        lakes_and_rivers: 'occasional',
        history_and_culture: 'occasional',
        wildlife: 'occasional',
        food_and_towns: 'occasional',
        photography_golden_hour: 'occasional',
      }),
      crowdTolerance: 'avoid_crowds',
      discoveryMix: 'balanced',
      foodImportance: 'matters',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'balanced',
      mustDo: ['One proper railway journey'],
      dislikes: ['Single-track roads with passing places'],
      hardAvoidances: ['long_drives', 'rough_or_unpaved_roads'],
    },
    conditions: { climate: 'cool', heat: 'cannot', cold: 'fine', rain: 'fine', snow: 'prefer_not' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'basic_hotel',
      reservations: 'a_few_is_fine',
      guidedTours: 'sometimes',
    },
    freeText:
      'We have hired a car because there is no other way to reach the cottage, but one of us finds narrow roads genuinely stressful and we would like most days to start and end on foot or by train.',
  },
});

export const SLOW_PACED = defineCase({
  caseId: 'slow-paced-madeira',
  title: 'Eight nights on Madeira at a deliberately unhurried pace, one base',
  traits: { kind: 'island', transit: false, dataStrength: 'strong', length: 'long' },
  request: {
    destination: {
      mode: 'known',
      text: 'Madeira',
      identity: {
        id: 'bench-madeira',
        displayName: 'Madeira',
        countryCode: 'PT',
        latitude: 32.7607,
        longitude: -16.9595,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2027-03-06',
      endDate: '2027-03-14',
      nights: 8,
    },
    arrival: { precision: 'exact', time: '11:30' },
    departure: { precision: 'afternoon', time: null },
    origin: 'Dublin',
    party: { adults: 2, children: 0, seniorsInGroup: true },
    movement: {
      preference: 'no_preference',
      publicTransit: 'accept',
      carAvailable: true,
      comfortableMountainRoads: true,
      comfortableUnpavedRoads: false,
      maxDailyDriveMinutes: 90,
      maxDailyTravelMinutes: 150,
      maxAccessWalkMinutes: 45,
      desiredBaseCount: 1,
      maxBaseChanges: 0,
    },
    rhythm: {
      pace: 'slow',
      activityIntensity: 'light',
      freeTime: 'lots',
      earlyMornings: 'never',
    },
    taste: {
      interests: interestLevels({
        easy_nature_walks: 'core',
        scenic_viewpoints: 'frequent',
        cafes: 'frequent',
        food_and_towns: 'occasional',
        wellness_and_spa: 'occasional',
        markets_and_street_food: 'occasional',
        scenic_drives: 'occasional',
        photography_golden_hour: 'occasional',
      }),
      crowdTolerance: 'avoid_crowds',
      discoveryMix: 'mostly_classics',
      foodImportance: 'matters',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'balanced',
      mustDo: ['One levada walk that is flat the whole way'],
      dislikes: ['Days with more than two things in them'],
      hardAvoidances: ['early_mornings', 'strenuous_activity', 'heights_and_exposure'],
    },
    conditions: { climate: 'mild', heat: 'prefer_not', cold: 'prefer_not', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'premium',
      accommodation: 'boutique_hotel',
      reservations: 'a_few_is_fine',
      guidedTours: 'avoid',
    },
    freeText:
      'We are not trying to see the island. We are trying to have eight quiet days somewhere beautiful, with one outing a day and a long lunch afterwards. Please do not fill the gaps.',
  },
});

export const MOBILITY_CONSTRAINED = defineCase({
  caseId: 'mobility-constrained-amsterdam',
  title: 'Three nights in Amsterdam with a wheelchair user and no stairs anywhere',
  traits: { kind: 'city', transit: true, dataStrength: 'strong', length: 'short' },
  request: {
    destination: {
      mode: 'known',
      text: 'Amsterdam',
      identity: {
        id: 'bench-amsterdam',
        displayName: 'Amsterdam',
        countryCode: 'NL',
        latitude: 52.3676,
        longitude: 4.9041,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2026-09-25',
      endDate: '2026-09-28',
      nights: 3,
    },
    arrival: { precision: 'exact', time: '13:10' },
    departure: { precision: 'exact', time: '18:00' },
    origin: 'Hamburg',
    party: {
      adults: 2,
      children: 0,
      mobility: ['wheelchair_user', 'no_stairs'],
      mobilityNotes:
        'One of us uses a manual wheelchair full time and cannot manage steps at all, including a single one at a doorway. Lifts and step-free entrances need to be certain rather than likely.',
    },
    movement: {
      preference: 'public_transport',
      publicTransit: 'prefer',
      carAvailable: false,
      willUseShuttlesAndFerries: true,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 120,
      maxAccessWalkMinutes: 20,
      desiredBaseCount: 1,
      maxBaseChanges: 0,
    },
    rhythm: {
      pace: 'slow',
      activityIntensity: 'light',
      freeTime: 'balanced',
      earlyMornings: 'sometimes',
    },
    taste: {
      interests: interestLevels({
        museums_and_galleries: 'core',
        architecture: 'frequent',
        cafes: 'frequent',
        boats_and_ferries: 'occasional',
        history_and_culture: 'occasional',
        local_neighbourhoods: 'occasional',
        markets_and_street_food: 'occasional',
      }),
      crowdTolerance: 'mild',
      discoveryMix: 'mostly_classics',
      foodImportance: 'matters',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'mostly_indoor',
      mustDo: ['One of the big museums, properly'],
      dislikes: ['Cobbles for more than a few metres'],
      hardAvoidances: ['strenuous_activity', 'crowds_and_tourist_traps'],
    },
    conditions: { climate: 'mild', heat: 'prefer_not', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'premium',
      accommodation: 'boutique_hotel',
      reservations: 'happy_to_book_ahead',
      guidedTours: 'sometimes',
    },
    freeText:
      'We would much rather be told that a place could not be confirmed as step-free than be sent there and find out at the door. A shorter plan we can trust beats a fuller one we cannot.',
  },
});

export const TRAVELLER_CASES = [
  FAMILY_TRIP,
  LOW_DRIVING,
  SLOW_PACED,
  MOBILITY_CONSTRAINED,
] as const;
