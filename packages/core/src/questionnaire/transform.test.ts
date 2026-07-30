import { describe, expect, it } from 'vitest';
import {
  availableRegionalExpansions,
  isQuestionVisible,
  type QuestionnaireContext,
} from './definition';
import { buildTravelerProfile, defaultAnswers, normalizeAnswers } from './transform';
import { validatedQuestionnaireAnswersSchema } from '../schemas/profile';
import { answers, context, interests, MAMMOTH_HIKER_ANSWERS } from '../testing/fixtures';

const ctx = (overrides: Partial<QuestionnaireContext> = {}) => context(overrides);

describe('adaptive questionnaire', () => {
  it('does not ask about daily effort when the group has limited mobility', () => {
    const base = answers();
    expect(
      isQuestionVisible('dailyIntensity', { answers: base, context: ctx() }),
    ).toBe(true);
    expect(
      isQuestionVisible('dailyIntensity', {
        answers: base,
        context: ctx({ travelerNeeds: ['mobility_limited'] }),
      }),
    ).toBe(false);
  });

  it('only asks about tourist traps when crowds already bother the traveller', () => {
    expect(
      isQuestionVisible('avoidTouristTraps', {
        answers: answers({ crowdTolerance: 'avoid_crowds' }),
        context: ctx(),
      }),
    ).toBe(true);
    expect(
      isQuestionVisible('avoidTouristTraps', {
        answers: answers({ crowdTolerance: 'dont_mind' }),
        context: ctx(),
      }),
    ).toBe(false);
  });

  it('hides driving questions when there is no car', () => {
    const noCar = { answers: answers({ willDrive: false }), context: ctx() };
    expect(isQuestionVisible('roadComfort', noCar)).toBe(false);
    expect(isQuestionVisible('maxDailyTravelMinutes', noCar)).toBe(false);
    expect(isQuestionVisible('roadComfort', { answers: answers(), context: ctx() })).toBe(true);
  });

  it('skips detour tolerance when the traveller wants to stay in town', () => {
    expect(
      isQuestionVisible('detourToleranceMinutes', {
        answers: answers({ regionalExpansion: 'destination_only' }),
        context: ctx(),
      }),
    ).toBe(false);
  });

  it('does not offer a regional radius a car-less traveller cannot reach', () => {
    expect(availableRegionalExpansions(true)).toHaveLength(5);
    expect(availableRegionalExpansions(false)).toEqual(['destination_only', 'nearby_30']);
  });
});

describe('answer normalisation', () => {
  it('forces hidden answers to the value their hiding rule implies', () => {
    const normalized = normalizeAnswers(
      answers({
        crowdTolerance: 'dont_mind',
        avoidTouristTraps: true,
        willDrive: false,
        comfortableMountainRoads: true,
        comfortableGravelRoads: true,
      }),
      ctx(),
    );
    expect(normalized.avoidTouristTraps).toBe(false);
    expect(normalized.comfortableMountainRoads).toBe(false);
    expect(normalized.comfortableGravelRoads).toBe(false);
  });

  it('clamps a regional radius that a later answer invalidated', () => {
    const normalized = normalizeAnswers(
      answers({ regionalExpansion: 'best_regional', willDrive: false }),
      ctx(),
    );
    expect(normalized.regionalExpansion).toBe('nearby_30');
  });

  it('zeroes detour tolerance when the traveller stays in town', () => {
    const normalized = normalizeAnswers(
      answers({ regionalExpansion: 'destination_only', detourToleranceMinutes: 90 }),
      ctx(),
    );
    expect(normalized.detourToleranceMinutes).toBe(0);
  });

  it('carries a mobility need from the basics screen into the answers', () => {
    const normalized = normalizeAnswers(
      answers({ mobilityLimited: false, avoidances: [] }),
      ctx({ travelerNeeds: ['mobility_limited'] }),
    );
    expect(normalized.mobilityLimited).toBe(true);
    expect(normalized.avoidances).toContain('strenuous_activity');
  });

  it('does not mutate the answers it was given', () => {
    const original = answers({ regionalExpansion: 'best_regional', willDrive: false });
    const snapshot = JSON.stringify(original);
    normalizeAnswers(original, ctx());
    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('questionnaire validation', () => {
  it('rejects a profile with nothing the traveller actually wants', () => {
    const result = validatedQuestionnaireAnswersSchema.safeParse(defaultAnswers(ctx()));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['interests']);
  });

  it('accepts once at least one interest is worth building a day around', () => {
    const result = validatedQuestionnaireAnswersSchema.safeParse(
      answers({ interests: interests({ hiking: 'frequent' }) }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an out-of-range travel tolerance', () => {
    expect(
      validatedQuestionnaireAnswersSchema.safeParse(
        answers({ interests: interests({ hiking: 'core' }), maxDailyTravelMinutes: 900 }),
      ).success,
    ).toBe(false);
  });
});

describe('profile transformation', () => {
  it('produces a schema-valid, versioned profile', () => {
    const built = buildTravelerProfile(answers(MAMMOTH_HIKER_ANSWERS), ctx());
    expect(built.version).toBe(1);
    expect(built.interests.scenic_viewpoints).toBe('core');
    expect(built.transport.willDrive).toBe(true);
  });

  it('turns interest levels into frequency ceilings scaled to trip length', () => {
    const short = buildTravelerProfile(answers(MAMMOTH_HIKER_ANSWERS), ctx({ tripDays: 4 }));
    expect(short.derived.frequencyCaps.hiking).toBe(3);
    expect(short.derived.frequencyCaps.scenic_viewpoints).toBe(4);
    expect(short.derived.frequencyCaps.history_and_culture).toBe(1);

    const long = buildTravelerProfile(answers(MAMMOTH_HIKER_ANSWERS), ctx({ tripDays: 10 }));
    expect(long.derived.frequencyCaps.hiking).toBe(6);
    expect(long.derived.frequencyCaps.scenic_viewpoints).toBe(10);
  });

  it('gives an avoided interest a ceiling of zero', () => {
    const built = buildTravelerProfile(
      answers({ interests: interests({ hiking: 'core', hot_springs: 'avoid' }) }),
      ctx(),
    );
    expect(built.derived.frequencyCaps.hot_springs).toBe(0);
  });

  it('caps physical intensity from avoidances and mobility needs', () => {
    expect(buildTravelerProfile(answers(MAMMOTH_HIKER_ANSWERS), ctx()).derived.maxPhysicalIntensity)
      .toBe('strenuous');

    expect(
      buildTravelerProfile(
        answers({ ...MAMMOTH_HIKER_ANSWERS, avoidances: ['strenuous_activity'] }),
        ctx(),
      ).derived.maxPhysicalIntensity,
    ).toBe('moderate');

    expect(
      buildTravelerProfile(
        answers(MAMMOTH_HIKER_ANSWERS, ctx({ travelerNeeds: ['mobility_limited'] })),
        ctx({ travelerNeeds: ['mobility_limited'] }),
      ).derived.maxPhysicalIntensity,
    ).toBe('easy');
  });

  it('takes the tightest of the radius, the stated tolerance and the daily drive budget', () => {
    // Stated tolerance is the binding constraint.
    expect(
      buildTravelerProfile(
        answers({ ...MAMMOTH_HIKER_ANSWERS, regionalExpansion: 'nearby_120', detourToleranceMinutes: 45 }),
        ctx(),
      ).derived.effectiveDetourMinutes,
    ).toBe(45);

    // A round trip has to fit inside the day, so half the daily budget wins.
    expect(
      buildTravelerProfile(
        answers({
          ...MAMMOTH_HIKER_ANSWERS,
          regionalExpansion: 'best_regional',
          detourToleranceMinutes: 180,
          maxDailyTravelMinutes: 120,
        }),
        ctx(),
      ).derived.effectiveDetourMinutes,
    ).toBe(60);

    // No car collapses the region to the town itself.
    expect(
      buildTravelerProfile(
        answers({ ...MAMMOTH_HIKER_ANSWERS, willDrive: false }),
        ctx(),
      ).derived.effectiveDetourMinutes,
    ).toBe(20);
  });

  it('sets the famous/hidden target from the discovery mix', () => {
    expect(
      buildTravelerProfile(answers({ ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'mostly_classics' }), ctx())
        .derived.hiddenGemTarget,
    ).toBeLessThan(0.3);
    expect(
      buildTravelerProfile(answers({ ...MAMMOTH_HIKER_ANSWERS, discoveryMix: 'deep_cuts' }), ctx())
        .derived.hiddenGemTarget,
    ).toBeGreaterThan(0.8);
  });

  it('thins the day when travelling with young children', () => {
    const withoutKids = buildTravelerProfile(answers(MAMMOTH_HIKER_ANSWERS), ctx());
    const withKids = buildTravelerProfile(
      answers(MAMMOTH_HIKER_ANSWERS, ctx({ travelerNeeds: ['kids_under_12'] })),
      ctx({ travelerNeeds: ['kids_under_12'] }),
    );
    expect(withKids.derived.activitySlotsPerDay).toBeLessThan(
      withoutKids.derived.activitySlotsPerDay,
    );
  });

  it('is deterministic', () => {
    const a = buildTravelerProfile(answers(MAMMOTH_HIKER_ANSWERS), ctx());
    const b = buildTravelerProfile(answers(MAMMOTH_HIKER_ANSWERS), ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
