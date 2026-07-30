import type { Interest, InterestLevel } from '../schemas/common';
import type { QuestionnaireAnswers, TravelerProfile } from '../schemas/profile';
import type { TravelerNeed } from '../schemas/trip';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';
import type { QuestionnaireContext } from '../questionnaire/definition';

export const AUGUST_MONTHS = [8];
export const JANUARY_MONTHS = [1];

export function context(overrides: Partial<QuestionnaireContext> = {}): QuestionnaireContext {
  return { travelerNeeds: [], tripDays: 4, ...overrides };
}

export function answers(
  overrides: Partial<QuestionnaireAnswers> = {},
  ctx: QuestionnaireContext = context(),
): QuestionnaireAnswers {
  const base = defaultAnswers(ctx);
  return {
    ...base,
    ...overrides,
    interests: { ...base.interests, ...(overrides.interests ?? {}) },
  };
}

export function profile(
  overrides: Partial<QuestionnaireAnswers> = {},
  ctx: QuestionnaireContext = context(),
): TravelerProfile {
  return buildTravelerProfile(answers(overrides, ctx), ctx);
}

export function interests(
  values: Partial<Record<Interest, InterestLevel>>,
): Record<Interest, InterestLevel> {
  return values as Record<Interest, InterestLevel>;
}

/**
 * The canonical scenario from the product brief: four days in Mammoth Lakes,
 * hiking and lakes and viewpoints and good food, mid-budget, happy to drive,
 * not too rushed, crowds are a turn-off.
 */
export const MAMMOTH_HIKER_ANSWERS: Partial<QuestionnaireAnswers> = {
  interests: interests({
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
  }),
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

export const NEEDS: Record<string, TravelerNeed[]> = {
  none: [],
  mobility: ['mobility_limited'],
  kids: ['kids_under_12'],
  altitude: ['altitude_sensitive'],
};
