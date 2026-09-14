import { describe, expect, it } from 'vitest';
import { answers, context } from '../testing/fixtures';
import { buildTravelerProfile } from '../questionnaire/transform';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { deriveTravelerIntent } from '../intent/traveler-intent';
import type { Interest } from '../schemas/common';
import { buildIntentSatisfaction, intentBlocksReady, satisfactionHighlights, type ItineraryEvidence } from './intent-satisfaction';

const intentOf = (overrides: Partial<QuestionnaireAnswers>) => {
  const raw = answers(overrides);
  return deriveTravelerIntent({ profile: buildTravelerProfile(raw, context()), ...(raw.interestRoles ? { interestRoles: raw.interestRoles } : {}) });
};

const days = (spec: { interests: Interest[]; minutes?: number }[]): ItineraryEvidence['days'] =>
  spec.map((entry, index) => ({ dayNumber: index + 1, interests: entry.interests, activityMinutes: entry.minutes ?? 240 }));

const shape = (overrides: Partial<{ hotelChanges: number; scheduledShare: number; freeDays: number }> = {}) => ({ hotelChanges: 1, scheduledShare: 0.5, freeDays: 1, ...overrides });

const HIKER = { interests: { hiking: 'core' as const }, interestRoles: { hiking: 'build_around' as const } };

describe('V12 §31 — coverage is depth, not a checkbox', () => {
  it('calls one short inclusion of a core goal token, not satisfied', () => {
    /* §31's own example: a hiking trip cannot be satisfied by one two-hour walk. */
    const report = buildIntentSatisfaction({
      intent: intentOf(HIKER),
      itinerary: { days: days([{ interests: ['hiking'], minutes: 120 }, { interests: [] }, { interests: [] }, { interests: [] }, { interests: [] }]) },
      shape: shape(),
    });
    const hiking = report.goals.find((goal) => goal.interest === 'hiking');
    expect(hiking?.verdict).toBe('token');
    expect(hiking?.reads).toMatch(/where 2 would make it real/);
    expect(report.unmetPrimaryGoals).toHaveLength(1);
    expect(intentBlocksReady(report)).toBe(true);
  });

  it('refuses to call a core goal strong on day count alone', () => {
    /*
     * Three days mention it, but it shaped nothing and holds a small share of
     * the trip's time. That is present — it happened — and not what the trip is
     * built around, which is what `build_around` asked for.
     */
    const report = buildIntentSatisfaction({
      intent: intentOf(HIKER),
      itinerary: { days: days([{ interests: ['hiking'], minutes: 60 }, { interests: ['hiking'], minutes: 60 }, { interests: ['hiking'], minutes: 60 }, { interests: [], minutes: 600 }, { interests: [], minutes: 600 }]) },
      shape: shape(),
    });
    expect(report.goals.find((goal) => goal.interest === 'hiking')?.verdict).toBe('present');
  });

  it('calls it strong when a chapter exists for it', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf(HIKER),
      itinerary: {
        days: days([{ interests: ['hiking'] }, { interests: [] }, { interests: ['hiking'] }, { interests: [] }, { interests: ['hiking'] }]),
        chapterInterests: { 'chapter-2': ['hiking'] },
      },
      shape: shape(),
    });
    const hiking = report.goals.find((goal) => goal.interest === 'hiking');
    expect(hiking?.verdict).toBe('strong');
    expect(hiking?.structural).toBe(true);
    expect(intentBlocksReady(report)).toBe(false);
  });

  it('says where, so the explanation can point at days rather than assert', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf(HIKER),
      itinerary: { days: days([{ interests: ['hiking'] }, { interests: [] }, { interests: ['hiking'] }, { interests: [] }, { interests: ['hiking'] }]), chapterInterests: { c: ['hiking'] } },
      shape: shape(),
    });
    expect(report.goals[0]?.dayNumbers).toEqual([1, 3, 5]);
  });
});

describe('V12 §34 — a deliberate omission is not a failure', () => {
  it('records an explained omission as an omission, and does not block', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf(HIKER),
      itinerary: {
        days: days([{ interests: [] }, { interests: [] }, { interests: [] }]),
        statedOmissions: [{ interest: 'hiking', reason: 'Seven days will not reach the range and the culture days are stronger.' }],
      },
      shape: shape(),
    });
    expect(report.goals[0]?.verdict).toBe('omitted');
    expect(report.unmetPrimaryGoals).toHaveLength(0);
    expect(intentBlocksReady(report)).toBe(false);
    expect(report.deliberateOmissions).toHaveLength(1);
  });

  it('but silence is still a failure — dropping a goal without saying so blocks', () => {
    const report = buildIntentSatisfaction({ intent: intentOf(HIKER), itinerary: { days: days([{ interests: [] }, { interests: [] }, { interests: [] }]) }, shape: shape() });
    expect(report.goals[0]?.verdict).toBe('missing');
    expect(intentBlocksReady(report)).toBe(true);
  });
});

describe('V12 §32 — a feeling is checked against the shape of the trip', () => {
  const RESTFUL = { interests: { beaches_and_swimming: 'core' as const }, interestRoles: { beaches_and_swimming: 'build_around' as const }, pace: 'slow' as const, dailyIntensity: 'light' as const, freeTime: 'lots' as const };

  it('contradicts "restful" when the trip changes hotel every night', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf(RESTFUL),
      itinerary: { days: days([{ interests: ['beaches_and_swimming'] }, { interests: ['beaches_and_swimming'] }, { interests: ['beaches_and_swimming'] }, { interests: ['beaches_and_swimming'] }, { interests: ['beaches_and_swimming'] }, { interests: ['beaches_and_swimming'] }]) },
      shape: shape({ hotelChanges: 5, freeDays: 0 }),
    });
    const restful = report.feelings.find((entry) => entry.feeling === 'restful');
    expect(restful?.verdict).toBe('contradicted');
    expect(restful?.signals.join(' ')).toMatch(/changes where you sleep/);
  });

  it('honours it when the shape agrees', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf(RESTFUL),
      itinerary: { days: days([{ interests: ['beaches_and_swimming'] }, { interests: [] }, { interests: ['beaches_and_swimming'] }, { interests: [] }, { interests: ['beaches_and_swimming'] }]) },
      shape: shape({ hotelChanges: 0, freeDays: 2 }),
    });
    expect(report.feelings.find((entry) => entry.feeling === 'restful')?.verdict).toBe('honoured');
  });

  it('measures "challenging" by how hard the days are, not by how many items they hold', () => {
    /*
     * A trek day carries one anchor — the pass — and is the hardest day of the
     * trip. The first live backpacking run reported `challenging` as
     * contradicted for exactly that shape.
     */
    const intent = intentOf({ interests: { hiking: 'core' }, interestRoles: { hiking: 'build_around' }, dailyIntensity: 'intense' });
    const trek = { days: days([{ interests: ['hiking'] }, { interests: ['hiking'] }, { interests: ['hiking'] }, { interests: ['hiking'] }, { interests: ['hiking'] }]), chapterInterests: { c: ['hiking'] as Interest[] } };
    const hard = buildIntentSatisfaction({ intent, itinerary: trek, shape: { ...shape(), strenuousDays: 4 } });
    expect(hard.feelings.find((entry) => entry.feeling === 'challenging')?.verdict).toBe('honoured');
    const soft = buildIntentSatisfaction({ intent, itinerary: trek, shape: { ...shape(), strenuousDays: 0 } });
    expect(soft.feelings.find((entry) => entry.feeling === 'challenging')?.verdict).toBe('contradicted');
  });

  it('says "unmeasured" rather than inventing a test for a feeling it cannot check', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { history_and_culture: 'core' }, interestRoles: { history_and_culture: 'build_around' } }),
      itinerary: { days: days([{ interests: ['history_and_culture'] }, { interests: ['history_and_culture'] }]), chapterInterests: { c: ['history_and_culture'] } },
      shape: shape(),
    });
    const cultural = report.feelings.find((entry) => entry.feeling === 'culturally_rich');
    expect(cultural?.verdict).toBe('unmeasured');
    expect(cultural?.signals).toHaveLength(0);
  });

  it('does not let a contradicted feeling block readiness on its own', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf(RESTFUL),
      itinerary: { days: days([{ interests: ['beaches_and_swimming'] }, { interests: ['beaches_and_swimming'] }, { interests: ['beaches_and_swimming'] }, { interests: ['beaches_and_swimming'] }]), chapterInterests: { c: ['beaches_and_swimming'] } },
      shape: shape({ hotelChanges: 4, freeDays: 0 }),
    });
    expect(report.feelings.some((entry) => entry.verdict === 'contradicted')).toBe(true);
    expect(intentBlocksReady(report)).toBe(false);
  });
});

describe('V12 §33 §36 — hard constraints block, and the traveller sees reassurance rather than a rubric', () => {
  it('treats a broken hard constraint as a blocker, not as low satisfaction', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf(HIKER),
      itinerary: { days: days([{ interests: ['hiking'] }, { interests: ['hiking'] }]), chapterInterests: { c: ['hiking'] }, brokenHardConstraints: ['The plan puts you in a hire car, and you said you will not drive.'] },
      shape: shape(),
    });
    expect(report.unmetPrimaryGoals).toHaveLength(0);
    expect(intentBlocksReady(report)).toBe(true);
  });

  it('never claims a goal it did not deliver', () => {
    const report = buildIntentSatisfaction({
      intent: intentOf({ interests: { hiking: 'core', wildlife: 'frequent' }, interestRoles: { hiking: 'build_around', wildlife: 'couple' } }),
      itinerary: { days: days([{ interests: ['hiking'] }, { interests: ['hiking'] }, { interests: ['hiking'] }]), chapterInterests: { c: ['hiking'] } },
      shape: shape(),
    });
    const claimed = satisfactionHighlights(report).map((entry) => entry.label);
    expect(claimed).toContain('Hiking');
    expect(claimed).not.toContain('Wildlife');
  });
});
