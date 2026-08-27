import {
  autoSelect,
  buildDiscoveryBoard,
  countTripDays,
  tripDates,
  tripMonths,
  type DiscoverySelection,
  type QuestionnaireAnswers,
  type TripBasics,
} from '@sidequest/core';
import {
  buildTravelerProfile,
  defaultAnswers,
} from '@sidequest/core';
import type {
  AccessDataset,
  FoodDataset,
  FoodSelection,
  OperatingHoursDataset,
  Place,
  QuestionnaireContext,
  Region,
  ScheduledNetworkPresence,
  TransitEvidence,
  TravelerNeed,
  WeatherDataset,
} from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';
import type { PlannerInput } from '../types';
import {
  EASTERN_SIERRA,
  EASTERN_SIERRA_ACCESS,
  EASTERN_SIERRA_BASE_ID,
  EASTERN_SIERRA_FOOD,
  EASTERN_SIERRA_HOURS,
  EASTERN_SIERRA_PLACES,
  EASTERN_SIERRA_WEATHER_LOCATIONS,
  buildFixtureWeather,
  easternSierraTravelMatrix,
} from '@sidequest/core/data';

/**
 * Builds a complete, realistic planner input the same way the web app does:
 * questionnaire answers → profile → discovery board → auto-selection → matrix.
 * Going through the real pipeline rather than hand-building candidates is what
 * makes the golden scenarios meaningful.
 */

/**
 * The instant every scenario is planned "at", unless it says otherwise.
 *
 * Fixed so the forecast horizon is a property of the test rather than of the
 * afternoon somebody runs it: the August trip below sits thirteen days out from
 * here, which puts it inside the horizon and gives it a real forecast. Move this
 * and half the golden scenarios quietly become historical patterns.
 */
export const FIXED_NOW = new Date('2026-07-30T12:00:00.000Z');

export const AUGUST_BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'Mammoth Lakes',
  regionId: 'eastern-sierra',
  startDate: '2026-08-12',
  endDate: '2026-08-15',
  arrivalTime: '11:00',
  departureTime: '17:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

export const MAMMOTH_HIKER: Partial<QuestionnaireAnswers> = {
  interests: {
    hiking: 'frequent',
    lakes_and_rivers: 'frequent',
    scenic_viewpoints: 'core',
    food_and_towns: 'occasional',
    scenic_drives: 'occasional',
    photography_golden_hour: 'occasional',
    geology_and_geothermal: 'occasional',
    easy_nature_walks: 'occasional',
    history_and_culture: 'low',
    hot_springs: 'low',
    wildlife: 'low',
    stargazing: 'low',
  },
  pace: 'balanced',
  dayStart: 'early',
  dailyIntensity: 'moderate',
  budgetStyle: 'midrange',
  discoveryMix: 'balanced',
  crowdTolerance: 'avoid_crowds',
  avoidTouristTraps: true,
  willDrive: true,
  comfortableMountainRoads: true,
  comfortableGravelRoads: true,
  maxDailyTravelMinutes: 150,
  regionalExpansion: 'nearby_60',
  detourToleranceMinutes: 60,
  avoidances: [],
  mobilityLimited: false,
};

export interface ScenarioOptions {
  basics?: Partial<TripBasics>;
  answers?: Partial<QuestionnaireAnswers>;
  travelerNeeds?: TravelerNeed[];
  /** Explicit board decisions. Omit to use the deterministic auto-pick. */
  selections?: DiscoverySelection[];
  /** Extra manual includes layered on top of the auto-pick. */
  manualIncludes?: string[];
  manualExcludes?: string[];
  /**
   * Swap a place record to exercise a fact no fixture place actually has — a
   * source-backed dry-conditions closure, say. Ids are unchanged, so the travel
   * matrix, the access rules and the operating calendars all still apply.
   */
  places?: Place[];
  /** Swap the access data to exercise an out-of-season or weekday-gapped service. */
  access?: AccessDataset;
  /** Swap the opening hours to exercise a closed weekday, a last admission, a booking. */
  hours?: OperatingHoursDataset;
  /**
   * Swap the weather to exercise a clear day against a stormy one, a trip past
   * the forecast horizon, or a provider that did not answer. Left alone it is
   * the deterministic fixture, evaluated against `now` — so a scenario that
   * says nothing about weather still gets a real, reproducible forecast.
   */
  weather?: WeatherDataset;
  /**
   * "Now". Fixed by default so the forecast horizon — and therefore whether the
   * trip gets a forecast or a historical pattern — is a property of the test
   * rather than of the day it is run on.
   */
  now?: Date;
  /**
   * Swap the food data to exercise a closed venue, a strict dietary claim, or a
   * region with nothing in it at all. Pass `null` for "no food data reached the
   * planner", which is a different state from an empty dataset and reads
   * differently on screen.
   */
  food?: FoodDataset | null;
  /** Venues the traveller asked for, or asked not to be sent to, on the board. */
  foodSelections?: readonly FoodSelection[];
  /**
   * Measured public-transport journeys, for a scenario that has any.
   *
   * The Eastern Sierra buys none — a road region with no timetables is the
   * ordinary case and must stay tested — so this is absent by default and the
   * board and planner both see exactly the road matrix they always did.
   */
  transit?: TransitEvidence;
  /**
   * Whether the destination's own evidence records a scheduled network.
   *
   * Threaded to the board *and* to the planner from one place, because the two
   * deciding it differently is the exact drift this builder exists to catch:
   * the board's detour class and the planner's journey bound are the same
   * verdict about the same journey. Absent is "nobody said", which is what
   * every scenario written before the observation existed keeps.
   */
  scheduledNetwork?: ScheduledNetworkPresence | null;
  /**
   * WHICH FIXTURE WORLD THIS SCENARIO IS SET IN.
   *
   * Added because the shape that had to be tested could not be expressed:
   * every founder journey behind the walking-bound defects is car-free, in a
   * region whose evidence observes a scheduled network nobody could time, on a
   * pedestrian matrix — and this builder was welded to a road region with a car
   * and no timetables. A test that hand-builds its own board and its own
   * planner input to get there proves nothing about the wiring, which is the
   * failure the last wave shipped.
   *
   * Absent is the road region, unchanged in every particular.
   */
  world?: ScenarioWorld;
}

/**
 * Everything a scenario needs that is a property of the destination rather than
 * of the traveller.
 *
 * A world is swapped whole. Swapping half of one — new places against the old
 * matrix, say — is how a fixture comes to describe a region nobody could
 * travel, so the pieces that have to agree with each other are declared
 * together and handed over together.
 */
export interface ScenarioWorld {
  basics: TripBasics;
  region: Region;
  places: Place[];
  access: AccessDataset;
  hours: OperatingHoursDataset;
  baseId: string;
  /** Built per scenario, so the board's copy and the planner's cannot drift. */
  matrix: () => TravelTimeMatrix;
  weather: (dates: readonly string[], now: Date) => WeatherDataset;
  /** Null for a world that bought no food data, which reads differently. */
  food: FoodDataset | null;
  /** The answers this world's traveller gives, before any caller override. */
  answers: Partial<QuestionnaireAnswers>;
}

export const EASTERN_SIERRA_WORLD: ScenarioWorld = {
  basics: AUGUST_BASICS,
  region: EASTERN_SIERRA,
  places: EASTERN_SIERRA_PLACES,
  access: EASTERN_SIERRA_ACCESS,
  hours: EASTERN_SIERRA_HOURS,
  baseId: EASTERN_SIERRA_BASE_ID,
  matrix: easternSierraTravelMatrix,
  weather: (dates, now) =>
    buildFixtureWeather({
      regionId: EASTERN_SIERRA.id,
      locations: EASTERN_SIERRA_WEATHER_LOCATIONS,
      dates: [...dates],
      now,
    }),
  food: EASTERN_SIERRA_FOOD,
  answers: MAMMOTH_HIKER,
};

export function buildScenario(options: ScenarioOptions = {}): PlannerInput {
  const world = options.world ?? EASTERN_SIERRA_WORLD;
  const basics: TripBasics = { ...world.basics, ...options.basics };
  const travelerNeeds = options.travelerNeeds ?? [];
  const tripDays = countTripDays(basics.startDate, basics.endDate);
  const context: QuestionnaireContext = { travelerNeeds, tripDays };

  const base = defaultAnswers(context);
  const merged: QuestionnaireAnswers = {
    ...base,
    ...world.answers,
    ...options.answers,
    interests: {
      ...base.interests,
      ...world.answers.interests,
      ...options.answers?.interests,
    },
  };
  const profile = buildTravelerProfile(merged, context);

  const now = options.now ?? FIXED_NOW;
  const weather = options.weather ?? world.weather(tripDates(basics.startDate, basics.endDate), now);

  /*
   * One matrix, built once, handed to the board *and* to the planner below.
   * Two calls to `easternSierraTravelMatrix()` would be two equal objects and
   * the scenario would still pass — but a fixture whose two halves are wired
   * from one source cannot drift, and drift between the board's world and the
   * planner's is the whole class of defect this file exists to catch.
   */
  const matrix = world.matrix();

  const board = buildDiscoveryBoard({
    region: world.region,
    places: options.places ?? world.places,
    profile,
    months: tripMonths(basics.startDate, basics.endDate),
    dates: tripDates(basics.startDate, basics.endDate),
    access: options.access ?? world.access,
    hours: options.hours ?? world.hours,
    weather,
    travelerNeeds,
    travel: {
      matrix,
      ...(options.transit === undefined ? {} : { transit: options.transit }),
      baseId: world.baseId,
      ...(options.scheduledNetwork === undefined
        ? {}
        : { scheduledNetwork: options.scheduledNetwork }),
    },
  });

  let selections: DiscoverySelection[];
  if (options.selections) {
    selections = options.selections;
  } else {
    const auto = autoSelect({
      candidates: board.candidates,
      profile,
      tripDays,
      transitUnmeasured: board.transitUnmeasured,
    });
    selections = auto.selectedIds.map((placeId) => ({
      placeId,
      status: 'included' as const,
      source: 'auto' as const,
      updatedAt: '2026-07-30T00:00:00.000Z',
    }));
  }

  for (const placeId of options.manualIncludes ?? []) {
    const existing = selections.findIndex((entry) => entry.placeId === placeId);
    const row: DiscoverySelection = {
      placeId,
      status: 'included',
      source: 'user',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    if (existing >= 0) selections[existing] = row;
    else selections.push(row);
  }
  for (const placeId of options.manualExcludes ?? []) {
    const existing = selections.findIndex((entry) => entry.placeId === placeId);
    const row: DiscoverySelection = {
      placeId,
      status: 'excluded',
      source: 'user',
      updatedAt: '2026-07-30T00:00:00.000Z',
    };
    if (existing >= 0) selections[existing] = row;
    else selections.push(row);
  }

  const food = options.food === null ? null : (options.food ?? world.food);

  return {
    tripId: 'trip-fixture',
    basics,
    profile,
    region: world.region,
    candidates: board.candidates,
    selections,
    matrix,
    ...(options.transit === undefined ? {} : { transit: options.transit }),
    access: options.access ?? world.access,
    hours: options.hours ?? world.hours,
    weather,
    ...(food ? { food } : {}),
    ...(options.foodSelections ? { foodSelections: options.foodSelections } : {}),
    ...(options.scheduledNetwork === undefined
      ? {}
      : { scheduledNetwork: options.scheduledNetwork }),
    now,
    baseId: world.baseId,
    generatedAt: '2026-07-30T12:00:00.000Z',
  };
}
