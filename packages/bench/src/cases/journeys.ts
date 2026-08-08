import { defineCase, interestLevels } from './builder';

/**
 * TRIPS THAT MOVE.
 *
 * Every case here has more geography than one base can reach, so the planning
 * problem is not "which places" but "how many nights where, in what order, and
 * what does the traveller give up by moving". That is the decision the two
 * systems make most differently, and the one a single-base city case cannot
 * expose at all.
 */

export const BROAD_COUNTRY = defineCase({
  caseId: 'country-broad-slovenia',
  title: 'Eleven nights across Slovenia by car, dates flexible either way',
  traits: { kind: 'country', transit: false, dataStrength: 'strong', length: 'long' },
  request: {
    destination: {
      mode: 'known',
      text: 'Slovenia',
      identity: {
        id: 'bench-slovenia',
        displayName: 'Slovenia',
        countryCode: 'SI',
        latitude: 46.1512,
        longitude: 14.9955,
      },
    },
    // Flexible rather than exact, because a broad trip is where a shifted start
    // genuinely changes the answer — and a library in which every request is
    // pinned to the day would never exercise that.
    dates: {
      mode: 'flexible',
      startDate: '2027-06-05',
      endDate: '2027-06-16',
      flexDays: 3,
      nights: 11,
    },
    arrival: { precision: 'exact', time: '13:05' },
    departure: { precision: 'exact', time: '16:30' },
    origin: 'Manchester',
    party: { adults: 2, children: 0 },
    movement: {
      preference: 'drive',
      publicTransit: 'accept',
      carAvailable: true,
      comfortableMountainRoads: true,
      comfortableUnpavedRoads: false,
      maxDailyDriveMinutes: 210,
      maxDailyTravelMinutes: 300,
      maxAccessWalkMinutes: 60,
      desiredBaseCount: 4,
      maxBaseChanges: 3,
    },
    rhythm: {
      pace: 'balanced',
      activityIntensity: 'moderate',
      freeTime: 'balanced',
      earlyMornings: 'sometimes',
    },
    taste: {
      interests: interestLevels({
        lakes_and_rivers: 'core',
        hiking: 'frequent',
        scenic_drives: 'frequent',
        scenic_viewpoints: 'frequent',
        food_and_towns: 'occasional',
        history_and_culture: 'occasional',
        architecture: 'occasional',
        easy_nature_walks: 'occasional',
        wellness_and_spa: 'occasional',
        geology_and_geothermal: 'occasional',
      }),
      crowdTolerance: 'avoid_crowds',
      discoveryMix: 'balanced',
      foodImportance: 'matters',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'mostly_outdoor',
      mustDo: ['A day in the mountains that is not a via ferrata', 'One coastal night'],
      dislikes: ['Coach parties'],
      hardAvoidances: ['crowds_and_tourist_traps'],
    },
    conditions: { climate: 'mild', heat: 'prefer_not', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'boutique_hotel',
      reservations: 'a_few_is_fine',
      guidedTours: 'sometimes',
    },
    freeText:
      'We can shift the whole thing a few days either way if that avoids a busy weekend. We would rather sleep in four places than in seven.',
  },
});

export const MULTI_BASE_ROAD_TRIP = defineCase({
  caseId: 'road-trip-multi-base-iceland',
  title: 'Nine nights driving a loop of Iceland, moving base most days',
  traits: { kind: 'road_trip', transit: false, dataStrength: 'strong', length: 'long' },
  request: {
    destination: {
      mode: 'known',
      text: 'Iceland',
      identity: {
        id: 'bench-iceland',
        displayName: 'Iceland',
        countryCode: 'IS',
        latitude: 64.9631,
        longitude: -19.0208,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2027-07-03',
      endDate: '2027-07-12',
      nights: 9,
    },
    arrival: { precision: 'exact', time: '06:35' },
    departure: { precision: 'exact', time: '07:50' },
    origin: 'Boston',
    party: { adults: 2, children: 0 },
    movement: {
      preference: 'drive',
      publicTransit: 'avoid',
      carAvailable: true,
      comfortableMountainRoads: true,
      comfortableUnpavedRoads: true,
      willUseShuttlesAndFerries: true,
      maxDailyDriveMinutes: 300,
      maxDailyTravelMinutes: 420,
      maxAccessWalkMinutes: 90,
      desiredBaseCount: 6,
      maxBaseChanges: 6,
    },
    rhythm: {
      pace: 'fast',
      activityIntensity: 'intense',
      freeTime: 'packed',
      earlyMornings: 'happily',
    },
    taste: {
      interests: interestLevels({
        geology_and_geothermal: 'core',
        scenic_drives: 'core',
        scenic_viewpoints: 'frequent',
        hiking: 'frequent',
        photography_golden_hour: 'frequent',
        hot_springs: 'occasional',
        wildlife: 'occasional',
        lakes_and_rivers: 'occasional',
        boats_and_ferries: 'occasional',
      }),
      crowdTolerance: 'mild',
      discoveryMix: 'mostly_hidden',
      foodImportance: 'a_little',
      nightlifeImportance: 'not_at_all',
      indoorOutdoorBalance: 'mostly_outdoor',
      mustDo: ['A glacier lagoon', 'At least one hot spring with nobody else in it'],
      dislikes: ['Buffet restaurants attached to hotels'],
      hardAvoidances: [],
    },
    conditions: { climate: 'cool', heat: 'fine', cold: 'fine', rain: 'fine', snow: 'fine' },
    practicalities: {
      budget: 'premium',
      accommodation: 'nature_lodge',
      reservations: 'happy_to_book_ahead',
      guidedTours: 'sometimes',
    },
    freeText:
      'We have driven long distances before and we are not nervous about gravel. We would rather cover ground than sit still, and we do not mind packing the car every morning.',
  },
});

export const ARCHIPELAGO_FERRY = defineCase({
  caseId: 'island-archipelago-cyclades',
  title: 'Seven nights hopping three Cycladic islands by ferry',
  traits: { kind: 'island', transit: true, dataStrength: 'strong', length: 'medium' },
  request: {
    destination: {
      mode: 'known',
      text: 'the Cyclades',
      identity: {
        id: 'bench-cyclades',
        displayName: 'Cyclades',
        countryCode: 'GR',
        latitude: 37.0,
        longitude: 25.15,
      },
    },
    dates: {
      mode: 'exact',
      startDate: '2027-05-22',
      endDate: '2027-05-29',
      nights: 7,
    },
    arrival: { precision: 'exact', time: '10:10' },
    departure: { precision: 'exact', time: '19:45' },
    origin: 'Athens',
    party: { adults: 2, children: 0 },
    movement: {
      preference: 'mixed',
      publicTransit: 'prefer',
      carAvailable: false,
      // Ferries are the spine of this trip, so refusing them would not be a
      // preference — it would be a different trip.
      willUseShuttlesAndFerries: true,
      maxDailyDriveMinutes: 0,
      maxDailyTravelMinutes: 360,
      maxAccessWalkMinutes: 45,
      desiredBaseCount: 3,
      maxBaseChanges: 2,
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
        boats_and_ferries: 'frequent',
        food_and_towns: 'frequent',
        scenic_viewpoints: 'occasional',
        easy_nature_walks: 'occasional',
        history_and_culture: 'occasional',
        photography_golden_hour: 'occasional',
        diving_and_snorkelling: 'occasional',
      }),
      crowdTolerance: 'avoid_crowds',
      discoveryMix: 'mostly_hidden',
      foodImportance: 'matters',
      nightlifeImportance: 'a_little',
      indoorOutdoorBalance: 'mostly_outdoor',
      mustDo: ['One island that is quiet in the evening'],
      dislikes: ['Cruise ship days'],
      hardAvoidances: ['crowds_and_tourist_traps'],
    },
    conditions: { climate: 'warm', heat: 'fine', cold: 'prefer_not', rain: 'prefer_not', snow: 'fine' },
    practicalities: {
      budget: 'midrange',
      accommodation: 'apartment',
      reservations: 'happy_to_book_ahead',
      guidedTours: 'avoid',
    },
    freeText:
      'We are happy to build the days around the boat timetable rather than the other way round, but we do not want to spend a whole holiday on deck.',
  },
});

export const JOURNEY_CASES = [BROAD_COUNTRY, MULTI_BASE_ROAD_TRIP, ARCHIPELAGO_FERRY] as const;
