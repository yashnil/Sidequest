import {
  autoSelect,
  buildDiscoveryBoard,
  countTripDays,
  EASTERN_SIERRA,
  EASTERN_SIERRA_BASE_ID,
  EASTERN_SIERRA_ACCESS,
  EASTERN_SIERRA_PLACES,
  easternSierraTravelMatrix,
  tripDates,
  tripMonths,
  type DiscoverySelection,
  type QuestionnaireAnswers,
  type TripBasics,
} from '@sidequest/core';
import { buildTravelerProfile, defaultAnswers } from '@sidequest/core';
import type { AccessDataset, QuestionnaireContext, TravelerNeed } from '@sidequest/core';
import type { PlannerInput } from '../types';

/**
 * Builds a complete, realistic planner input the same way the web app does:
 * questionnaire answers → profile → discovery board → auto-selection → matrix.
 * Going through the real pipeline rather than hand-building candidates is what
 * makes the golden scenarios meaningful.
 */

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
  /** Swap the access data to exercise an out-of-season or weekday-gapped service. */
  access?: AccessDataset;
}

export function buildScenario(options: ScenarioOptions = {}): PlannerInput {
  const basics: TripBasics = { ...AUGUST_BASICS, ...options.basics };
  const travelerNeeds = options.travelerNeeds ?? [];
  const tripDays = countTripDays(basics.startDate, basics.endDate);
  const context: QuestionnaireContext = { travelerNeeds, tripDays };

  const base = defaultAnswers(context);
  const merged: QuestionnaireAnswers = {
    ...base,
    ...MAMMOTH_HIKER,
    ...options.answers,
    interests: {
      ...base.interests,
      ...MAMMOTH_HIKER.interests,
      ...options.answers?.interests,
    },
  };
  const profile = buildTravelerProfile(merged, context);

  const board = buildDiscoveryBoard({
    region: EASTERN_SIERRA,
    places: EASTERN_SIERRA_PLACES,
    profile,
    months: tripMonths(basics.startDate, basics.endDate),
    dates: tripDates(basics.startDate, basics.endDate),
    access: options.access ?? EASTERN_SIERRA_ACCESS,
    travelerNeeds,
  });

  let selections: DiscoverySelection[];
  if (options.selections) {
    selections = options.selections;
  } else {
    const auto = autoSelect({ candidates: board.candidates, profile, tripDays });
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

  return {
    tripId: 'trip-fixture',
    basics,
    profile,
    region: EASTERN_SIERRA,
    candidates: board.candidates,
    selections,
    matrix: easternSierraTravelMatrix(),
    access: options.access ?? EASTERN_SIERRA_ACCESS,
    baseId: EASTERN_SIERRA_BASE_ID,
    generatedAt: '2026-07-30T12:00:00.000Z',
  };
}
