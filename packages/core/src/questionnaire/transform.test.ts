import { describe, expect, it } from 'vitest';
import { TRAVELER_PROFILE_VERSION } from '../schemas/profile';
import {
  availableRegionalExpansions,
  carFreeReachMinutes,
  EXPANSION_CEILING_MINUTES,
  isQuestionVisible,
  NO_CAR_DETOUR_MINUTES,
  type QuestionnaireContext,
} from './definition';
import { buildTravelerProfile, defaultAnswers, normalizeAnswers } from './transform';
import { validatedQuestionnaireAnswersSchema } from '../schemas/profile';
import { detourToleranceMinutesFor } from '../travel/reach';
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

  /**
   * The toggle is gone from the screen; the warning is derived from the graded
   * crowd control. "Crowds ruin it" turns it on, a written hard refusal of
   * crowds turns it on, and a shrug does not — the same formula the benchmark
   * request adapter writes, so its answers stay a fixed point of
   * `normalizeAnswers`. The visibility rule survives for that adapter's
   * representability maths.
   */
  it('derives the tourist-trap warning from the crowd answer instead of asking', () => {
    const derived = (overrides: Parameters<typeof answers>[0]) =>
      normalizeAnswers(answers(overrides), ctx()).avoidTouristTraps;
    expect(derived({ crowdTolerance: 'avoid_crowds', avoidTouristTraps: false })).toBe(true);
    expect(derived({ crowdTolerance: 'mild', avoidTouristTraps: true })).toBe(false);
    expect(
      derived({
        crowdTolerance: 'mild',
        avoidTouristTraps: false,
        avoidances: ['crowds_and_tourist_traps'],
      }),
    ).toBe(true);
    expect(derived({ crowdTolerance: 'dont_mind', avoidTouristTraps: true })).toBe(false);
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

  /**
   * The car-free offer is derived from the traveller's own ride budget, not
   * hard-capped at thirty minutes for every compiled destination. The review
   * card was printing "up to 75 min by public transport" while this function
   * refused to offer anything past half an hour — two derivations of one
   * answer, disagreeing on the screen where it decides what is reachable.
   */
  it('offers a car-free traveller every ring their ride budget covers', () => {
    expect(availableRegionalExpansions(true)).toHaveLength(5);
    const offered = availableRegionalExpansions(false);
    expect(offered).toEqual(['destination_only', 'nearby_30', 'nearby_60']);
    for (const ring of offered) {
      expect(EXPANSION_CEILING_MINUTES[ring]).toBeLessThanOrEqual(carFreeReachMinutes());
    }
  });

  /** A region that has authored its car-free reach is believed outright. */
  it('lets an authored region narrow the car-free offer below the derived one', () => {
    const authored = ctx({
      region: {
        baseName: 'Mammoth Lakes',
        copy: {
          proseName: 'the Eastern Sierra',
          destinationOnlyLabel: 'Mammoth Lakes itself',
          expansionExamples: {},
          carFreeExpansions: ['destination_only', 'nearby_30'],
          regionStepIntro: 'One valley, one trolley.',
          discoveryIntro: 'Both exist here.',
          transportIntro: 'The trolley runs in season.',
        },
      },
    });
    expect(availableRegionalExpansions(false, authored)).toEqual([
      'destination_only',
      'nearby_30',
    ]);
  });

  /**
   * The region step and the review card must be one derivation. The card reads
   * `detourToleranceMinutesFor(profile, 'rail')`; the step reads
   * `carFreeReachMinutes()`. This is the pin that stops them drifting apart —
   * it failed before the fix, when the step said 30 and the card said 75.
   */
  it('agrees with the reach function the review card prints', () => {
    const carFree = buildTravelerProfile(answers({ willDrive: false }), ctx());
    expect(carFreeReachMinutes()).toBe(detourToleranceMinutesFor(carFree, 'rail'));
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
    // The widest ring the ride budget still covers — an hour, not half of one.
    expect(normalized.regionalExpansion).toBe('nearby_60');
  });

  it('lands a hard early-mornings filter on the day-start window', () => {
    const normalized = normalizeAnswers(
      answers({ avoidances: ['early_mornings'], dayStart: 'early' }),
      ctx(),
    );
    expect(normalized.dayStart).toBe('relaxed');
    // Without the avoidance, the stated start survives untouched.
    expect(normalizeAnswers(answers({ dayStart: 'early' }), ctx()).dayStart).toBe('early');
  });

  it('keeps the handed-over step list canonical', () => {
    const normalized = normalizeAnswers(
      answers({ decideForMe: ['food', 'rhythm', 'food'] }),
      ctx(),
    );
    expect(normalized.decideForMe).toEqual(['rhythm', 'food']);
    // Absent stays absent: an old draft is not retroactively a statement.
    const legacy = answers();
    delete (legacy as Partial<typeof legacy>).decideForMe;
    expect(normalizeAnswers(legacy, ctx()).decideForMe).toBeUndefined();
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
    expect(built.version).toBe(TRAVELER_PROFILE_VERSION);
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

    /*
     * Altitude effort caps like the other two. It was offered as a hard filter
     * and consumed by nothing — the placebo class PR-QUES-10 exists to close.
     */
    expect(
      buildTravelerProfile(
        answers({ ...MAMMOTH_HIKER_ANSWERS, avoidances: ['high_altitude_exertion'] }),
        ctx(),
      ).derived.maxPhysicalIntensity,
    ).toBe('moderate');
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

    /*
     * The expectation here was 20 — the car-free constant, applied whatever the
     * traveller had answered. It moved because that constant is now the floor
     * under their answers rather than a replacement for them; the case below
     * pins the floor itself, which is the part of the old claim that was true.
     * Sixty is this fixture's own stated one-way tolerance, inside a
     * sixty-five-minute ring and inside the car-free reach.
     */
    expect(
      buildTravelerProfile(
        answers({ ...MAMMOTH_HIKER_ANSWERS, willDrive: false }),
        ctx(),
      ).derived.effectiveDetourMinutes,
    ).toBe(60);
  });

  /**
   * THE NON-DRIVER'S OWN TRAVEL ANSWER, WHICH THE PROFILE USED TO THROW AWAY.
   *
   * The questionnaire puts both questions to somebody with no car: the ring
   * ("how far from your base") on an offer that reaches `carFreeReachMinutes()`,
   * and the one-way slider ("furthest you would travel one way for one stop —
   * by train, bus or shuttle"). Both answers were discarded and replaced by
   * `NO_CAR_DETOUR_MINUTES`, so the region step offered an hour out by public
   * transport while the profile recorded twenty minutes, and every radius
   * derived from the profile held a car-free trip to a walk-out constant.
   *
   * The live evidence class this sits under is a car-free dense-metro board
   * whose every canonical seat was thirty-nine to seventy measured walking
   * minutes from base and was refused on a last-mile answer.
   */
  it('keeps a non-driver’s stated one-way travel answer, bounded by the car-free reach', () => {
    const carFree = (overrides: Parameters<typeof answers>[0] = {}) =>
      buildTravelerProfile(
        answers({ ...MAMMOTH_HIKER_ANSWERS, willDrive: false, ...overrides }),
        ctx(),
      ).derived.effectiveDetourMinutes;

    /* Their slider, honoured, where the ring they chose leaves room for it. */
    expect(carFree({ regionalExpansion: 'nearby_60', detourToleranceMinutes: 45 })).toBe(45);
    /* And their ring, which binds when it is the tighter of the two. */
    expect(carFree({ regionalExpansion: 'nearby_30', detourToleranceMinutes: 60 })).toBe(35);
    /*
     * Never past what a car-free day can actually reach and return from. The
     * ring is clamped to `nearby_60` for a non-driver by `normalizeAnswers`, so
     * this is the widest answer the questionnaire can produce; the bound is
     * asserted against the function the region step reads rather than a literal.
     */
    expect(carFree({ regionalExpansion: 'best_regional', detourToleranceMinutes: 180 })).toBe(
      Math.min(EXPANSION_CEILING_MINUTES.nearby_60, carFreeReachMinutes()),
    );
  });

  /** An untouched slider still yields the walk-out radius, and never less. */
  it('floors an unanswered non-driver at the car-free walk-out radius', () => {
    const stayInTown = buildTravelerProfile(
      answers({
        ...MAMMOTH_HIKER_ANSWERS,
        willDrive: false,
        regionalExpansion: 'destination_only',
        detourToleranceMinutes: 0,
      }),
      ctx(),
    );
    expect(EXPANSION_CEILING_MINUTES.destination_only).toBeLessThan(NO_CAR_DETOUR_MINUTES);
    expect(stayInTown.derived.effectiveDetourMinutes).toBe(NO_CAR_DETOUR_MINUTES);
  });

  /**
   * The control on the pair above: nothing about a driver's radius moved. Every
   * combination the driving branch can be handed — the ring binding, the slider
   * binding, the half-day cap binding, and a slider nobody touched — is the
   * same arithmetic it always was.
   */
  it('leaves a driver’s radius exactly where it was', () => {
    const driving = (overrides: Parameters<typeof answers>[0]) =>
      buildTravelerProfile(answers({ ...MAMMOTH_HIKER_ANSWERS, ...overrides }), ctx()).derived
        .effectiveDetourMinutes;

    expect(driving({ regionalExpansion: 'nearby_30', detourToleranceMinutes: 60 })).toBe(35);
    expect(driving({ regionalExpansion: 'nearby_120', detourToleranceMinutes: 45 })).toBe(45);
    expect(
      driving({
        regionalExpansion: 'best_regional',
        detourToleranceMinutes: 180,
        maxDailyTravelMinutes: 120,
      }),
    ).toBe(60);
    /* An untouched slider falls back to the ring, not to a floor. */
    expect(driving({ regionalExpansion: 'destination_only', detourToleranceMinutes: 0 })).toBe(
      EXPANSION_CEILING_MINUTES.destination_only,
    );
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
