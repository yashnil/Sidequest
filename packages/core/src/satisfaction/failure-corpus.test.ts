import { describe, expect, it } from 'vitest';
import { answers, context } from '../testing/fixtures';
import { buildTravelerProfile } from '../questionnaire/transform';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { deriveTravelerIntent } from '../intent/traveler-intent';
import type { Interest } from '../schemas/common';
import { buildIntentSatisfaction, intentBlocksReady, type ItineraryEvidence } from './intent-satisfaction';

/**
 * V12 §53 — THE INTENT-SATISFACTION CORPUS.
 *
 * Seven deliberately bad trips, one per failure the brief names. The test is not
 * that they fail — a strict enough rule fails everything — but that the compiler
 * can say **why** each one fails, in the traveller's terms, and that a trip which
 * is merely *different* from what was asked is not confused with one that is wrong.
 */

const intentOf = (overrides: Partial<QuestionnaireAnswers>) => {
  const raw = answers(overrides);
  return deriveTravelerIntent({ profile: buildTravelerProfile(raw, context()), ...(raw.interestRoles ? { interestRoles: raw.interestRoles } : {}) });
};

const days = (spec: { interests: Interest[]; minutes?: number }[]): ItineraryEvidence['days'] =>
  spec.map((entry, index) => ({ dayNumber: index + 1, interests: entry.interests, activityMinutes: entry.minutes ?? 240 }));

describe('V12 §53 — each intentional failure is identified, and identified correctly', () => {
  it('a culture trip that is only landmarks: the goal is present but never the point', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { neighbourhoods_and_local_life: 'core', architecture_and_landmarks: 'frequent' }, interestRoles: { neighbourhoods_and_local_life: 'build_around' } }),
      /* Landmarks every day; the local life they came for on one afternoon. */
      itinerary: { days: days([{ interests: ['architecture_and_landmarks'] }, { interests: ['architecture_and_landmarks'] }, { interests: ['architecture_and_landmarks'] }, { interests: ['neighbourhoods_and_local_life'], minutes: 90 }, { interests: ['architecture_and_landmarks'] }]) },
      shape: { hotelChanges: 0, scheduledShare: 0.5, freeDays: 0 },
    });
    const core = report.goals.find((goal) => goal.interest === 'neighbourhoods_and_local_life');
    expect(core?.verdict).toBe('token');
    expect(intentBlocksReady(report)).toBe(true);
    expect(report.unmetPrimaryGoals[0]).toMatch(/where 2 would make it real/);
  });

  it('a hiking trip with one trivial walk', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { hiking: 'core' }, interestRoles: { hiking: 'build_around' } }),
      itinerary: { days: days([{ interests: ['hiking'], minutes: 90 }, { interests: [] }, { interests: [] }, { interests: [] }]) },
      shape: { hotelChanges: 0, scheduledShare: 0.5, freeDays: 0 },
    });
    expect(report.goals[0]?.verdict).toBe('token');
    expect(intentBlocksReady(report)).toBe(true);
  });

  it('a relaxation trip that has been over-scheduled', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { beaches_and_swimming: 'core' }, interestRoles: { beaches_and_swimming: 'build_around' }, pace: 'slow', dailyIntensity: 'light', freeTime: 'lots' }),
      itinerary: {
        days: days([
          { interests: ['beaches_and_swimming', 'history_and_culture', 'food_and_towns', 'markets_and_street_food'] },
          { interests: ['beaches_and_swimming', 'history_and_culture', 'food_and_towns', 'markets_and_street_food'] },
          { interests: ['beaches_and_swimming', 'history_and_culture', 'food_and_towns', 'markets_and_street_food'] },
          { interests: ['beaches_and_swimming', 'history_and_culture', 'food_and_towns', 'markets_and_street_food'] },
          { interests: ['beaches_and_swimming', 'history_and_culture', 'food_and_towns', 'markets_and_street_food'] },
          { interests: ['beaches_and_swimming', 'history_and_culture', 'food_and_towns', 'markets_and_street_food'] },
        ]),
        chapterInterests: { c: ['beaches_and_swimming'] },
      },
      shape: { hotelChanges: 5, scheduledShare: 0.95, freeDays: 0 },
    });
    /*
     * The goal itself is delivered — they are at the beach every day — and the
     * trip is still wrong, which is exactly why a goal count cannot be the whole
     * measure. The feeling is what catches it.
     */
    expect(report.goals[0]?.verdict).toBe('strong');
    const restful = report.feelings.find((entry) => entry.feeling === 'restful');
    expect(restful?.verdict).toBe('contradicted');
    expect(restful?.signals.length).toBeGreaterThanOrEqual(2);
  });

  it('a wildlife trip with no serious wildlife component', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { wildlife: 'core' }, interestRoles: { wildlife: 'build_around' } }),
      itinerary: { days: days([{ interests: ['scenic_viewpoints'] }, { interests: ['scenic_viewpoints'] }, { interests: ['scenic_viewpoints'] }]) },
      shape: { hotelChanges: 1, scheduledShare: 0.5, freeDays: 0 },
    });
    expect(report.goals[0]?.verdict).toBe('missing');
    expect(report.goals[0]?.reads).toMatch(/Nothing on this trip delivers it/);
    expect(intentBlocksReady(report)).toBe(true);
  });

  it('a backpacking traveller handed a trip that contradicts a hard constraint', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { neighbourhoods_and_local_life: 'core' }, interestRoles: { neighbourhoods_and_local_life: 'build_around' }, budgetStyle: 'budget', willDrive: false }),
      itinerary: {
        days: days([{ interests: ['neighbourhoods_and_local_life'] }, { interests: ['neighbourhoods_and_local_life'] }, { interests: ['neighbourhoods_and_local_life'] }]),
        chapterInterests: { c: ['neighbourhoods_and_local_life'] },
        brokenHardConstraints: ['The plan puts you in a hire car, and you told us you are not driving.'],
      },
      shape: { hotelChanges: 2, scheduledShare: 0.4, freeDays: 1 },
    });
    /* The goal is fully delivered, and the trip is still not shippable. */
    expect(report.goals[0]?.verdict).toBe('strong');
    expect(report.unmetPrimaryGoals).toHaveLength(0);
    expect(intentBlocksReady(report)).toBe(true);
    expect(report.hardConstraintFailures[0]).toMatch(/not driving/);
  });

  it('a food-focused city trip with generic meal slots', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { food_and_towns: 'core' }, interestRoles: { food_and_towns: 'build_around' } }),
      /* Meals happen; none of them is what the trip is about. */
      itinerary: { days: days([{ interests: [], minutes: 300 }, { interests: [], minutes: 300 }, { interests: ['food_and_towns'], minutes: 45 }, { interests: [], minutes: 300 }]) },
      shape: { hotelChanges: 0, scheduledShare: 0.6, freeDays: 0 },
    });
    expect(report.goals[0]?.verdict).toBe('token');
    expect(intentBlocksReady(report)).toBe(true);
  });

  it('and a trip that omits something deliberately still passes', () => {
    /*
     * §34 — the gate must not reward stuffing. Seven days cannot hold everything,
     * and a plan that says what it left out and why is a better plan, not a
     * failing one.
     */
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { hiking: 'core', wildlife: 'frequent' }, interestRoles: { hiking: 'build_around', wildlife: 'couple' } }),
      itinerary: {
        days: days([{ interests: ['hiking'] }, { interests: ['hiking'] }, { interests: ['hiking'] }]),
        chapterInterests: { c: ['hiking'] },
        statedOmissions: [{ interest: 'wildlife', reason: 'The reserve is nine hours away and would cost two of your seven days.' }],
      },
      shape: { hotelChanges: 1, scheduledShare: 0.5, freeDays: 1 },
    });
    expect(report.goals.find((goal) => goal.interest === 'wildlife')?.verdict).toBe('omitted');
    expect(intentBlocksReady(report)).toBe(false);
    expect(report.deliberateOmissions[0]?.reason).toMatch(/nine hours away/);
  });
});
