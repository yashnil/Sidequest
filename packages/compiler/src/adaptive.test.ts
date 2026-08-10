import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_QUESTION_IDS,
  deriveAdaptiveQuestions,
  MAX_ADAPTIVE_QUESTIONS,
  withAdaptiveQuestions,
} from './adaptive';
import { deriveScope } from './scope';
import {
  CLARIFICATION_SET_VERSION,
  TRIP_PREFLIGHT_VERSION,
  type ClarificationSet,
  type TripPreflight,
} from '@sidequest/core';

/**
 * ADAPTIVE MEANS "ONLY THIS TRIP WOULD HAVE BEEN ASKED THIS".
 *
 * The bar these tests hold is not that questions appear. It is that a trip
 * whose evidence does not warrant a question **is not asked it** — because a
 * generator that always fires is a longer form, and a longer form is what
 * section 6 exists to remove. So most of what follows asserts silence.
 *
 * No destination is named anywhere. Every fixture is a shape: a compact region,
 * a spread-out one, one with something just outside the line.
 */

function cluster(id: string, name: string, transferMinutes: number) {
  return {
    id,
    name,
    center: { lat: 0, lng: transferMinutes / 60 },
    memberCount: 3,
    memberNames: [],
    distanceFromGatewayKm: transferMinutes,
    transferMinutesFromGateway: transferMinutes,
  };
}

function preflight(over: {
  route?: { id: string; name: string; transferMinutes: number }[];
  baseReasons?: { clusterId: string; reason: string; nights: number; transferMinutes: number }[];
  satellites?: { id: string; name: string; transferMinutes: number }[];
  excluded?: { id: string; name: string; transferMinutes: number; reason: string }[];
  basesProposed?: number;
} = {}): TripPreflight {
  const route = (over.route ?? [{ id: 'a', name: 'Core', transferMinutes: 0 }]).map((entry) =>
    cluster(entry.id, entry.name, entry.transferMinutes),
  );
  return {
    schemaVersion: TRIP_PREFLIGHT_VERSION,
    destinationKey: 'test:1',
    portfolio: {
      gateway: { name: 'Core', center: { lat: 0, lng: 0 } },
      route,
      baseReasons:
        over.baseReasons ??
        route.map((entry, index) => ({
          clusterId: entry.id,
          reason: 'because',
          nights: 3,
          transferMinutes: index === 0 ? 0 : 30,
        })),
      satellites: (over.satellites ?? []).map((entry) => ({
        cluster: cluster(entry.id, entry.name, entry.transferMinutes),
        baseId: 'a',
        transferMinutes: entry.transferMinutes,
      })),
      excluded: (over.excluded ?? []).map((entry) => ({
        cluster: cluster(entry.id, entry.name, entry.transferMinutes),
        reason: entry.reason,
      })),
      basesProposed: over.basesProposed ?? route.length,
      transferDays: 0.5,
      mode: 'drive',
      reachRadiusKm: 70,
      rationale: 'test',
      estimated: true,
    },
    strategies: [],
    dates: null,
    duration: null,
    supply: null,
    builtAt: '2026-08-09T00:00:00.000Z',
    elapsedMs: 10,
  };
}

describe('a compact trip is asked nothing extra', () => {
  it('asks nothing when there is one base, nothing excluded and no season evidence', () => {
    const questions = deriveAdaptiveQuestions({
      preflight: preflight(),
      nights: 5,
      known: { transport: 'drive' },
    });
    expect(questions).toEqual([]);
  });

  it('asks nothing at all when the preliminary scan has not run', () => {
    expect(deriveAdaptiveQuestions({ preflight: null, nights: 5 })).toEqual([]);
  });
});

describe('a spread-out region earns the hotel-move question', () => {
  const spread = preflight({
    route: [
      { id: 'a', name: 'Core', transferMinutes: 0 },
      { id: 'b', name: 'Second', transferMinutes: 200 },
    ],
    baseReasons: [
      { clusterId: 'a', reason: 'densest', nights: 3, transferMinutes: 0 },
      { clusterId: 'b', reason: 'too far to day-trip', nights: 3, transferMinutes: 200 },
    ],
  });

  it('asks it, and carries the evidence that triggered it', () => {
    const [question, ...rest] = deriveAdaptiveQuestions({ preflight: spread, nights: 8 });
    expect(rest).toEqual([]);
    expect(question?.id).toBe(ADAPTIVE_QUESTION_IDS.hotelSwitchTolerance);
    expect(question?.decisionAffected).toBe('base_structure');
    /*
     * The evidence is the whole difference between this and a static question.
     * It has to name a number the traveller can check against the screen they
     * are looking at.
     */
    expect(question?.evidenceThatTriggeredIt?.[0]?.detail).toContain('3.3 hours');
    expect(question?.allowIndifference).toBe(true);
  });

  it('gives every answer a different consequence, so the question is worth asking', () => {
    const [question] = deriveAdaptiveQuestions({ preflight: spread, nights: 8 });
    const changes = Object.values(question?.planChangeByAnswer ?? {});
    expect(changes.length).toBe(question?.options.length);
    expect(new Set(changes).size).toBe(changes.length);
  });

  it('does not ask it when the traveller already chose a shape', () => {
    expect(
      deriveAdaptiveQuestions({ preflight: spread, nights: 8, known: { shape: 'two_bases' } }),
    ).toEqual([]);
  });

  it('does not ask it when a strategy was already picked on the preflight screen', () => {
    expect(
      deriveAdaptiveQuestions({ preflight: spread, nights: 8, known: { scopeStrategy: true } }),
    ).toEqual([]);
  });

  it('does not ask it on a trip too short to hold two bases anyway', () => {
    expect(deriveAdaptiveQuestions({ preflight: spread, nights: 3 })).toEqual([]);
  });

  it('does not ask it when the two bases are a short hop apart', () => {
    const close = preflight({
      route: [
        { id: 'a', name: 'Core', transferMinutes: 0 },
        { id: 'b', name: 'Second', transferMinutes: 40 },
      ],
      baseReasons: [
        { clusterId: 'a', reason: 'densest', nights: 3, transferMinutes: 0 },
        { clusterId: 'b', reason: 'near', nights: 3, transferMinutes: 40 },
      ],
    });
    expect(deriveAdaptiveQuestions({ preflight: close, nights: 8 })).toEqual([]);
  });
});

describe('long day trips are only asked about without a car', () => {
  const withFarSatellite = preflight({
    satellites: [{ id: 's', name: 'Far Valley', transferMinutes: 95 }],
  });

  it('asks a car-free traveller where they draw the line', () => {
    const questions = deriveAdaptiveQuestions({
      preflight: withFarSatellite,
      nights: 5,
      known: { transport: 'public_transport' },
    });
    const question = questions.find((entry) => entry.id === ADAPTIVE_QUESTION_IDS.longHaulDayTrips);
    expect(question).toBeDefined();
    expect(question?.decisionAffected).toBe('region_extent');
    expect(question?.evidenceThatTriggeredIt?.some((entry) => entry.detail.includes('Far Valley'))).toBe(
      true,
    );
  });

  it('does not ask a driver, for whom the answer changes much less', () => {
    const questions = deriveAdaptiveQuestions({
      preflight: withFarSatellite,
      nights: 5,
      known: { transport: 'drive' },
    });
    expect(questions.some((entry) => entry.id === ADAPTIVE_QUESTION_IDS.longHaulDayTrips)).toBe(false);
  });

  it('does not ask when nothing is more than an hour out', () => {
    const compact = preflight({ satellites: [{ id: 's', name: 'Near', transferMinutes: 25 }] });
    expect(
      deriveAdaptiveQuestions({
        preflight: compact,
        nights: 5,
        known: { transport: 'public_transport' },
      }),
    ).toEqual([]);
  });
});

describe('something just outside the line', () => {
  it('offers to make room, naming the area and the reason it was dropped', () => {
    const nearMiss = preflight({
      excluded: [
        {
          id: 'x',
          name: 'Edge Town',
          transferMinutes: 150,
          reason: 'Moving there costs about 4 hours and would save about 2 — not worth the change of hotel.',
        },
      ],
    });
    const questions = deriveAdaptiveQuestions({ preflight: nearMiss, nights: 6 });
    const question = questions.find((entry) => entry.id === ADAPTIVE_QUESTION_IDS.extendReach);
    expect(question).toBeDefined();
    expect(question?.question).toContain('Edge Town');
    expect(question?.evidenceThatTriggeredIt?.[0]?.detail).toContain('not worth the change of hotel');
  });

  it('stays quiet about something excluded for a reason a traveller cannot change', () => {
    const wrongReason = preflight({
      excluded: [
        {
          id: 'x',
          name: 'Thin Village',
          transferMinutes: 150,
          reason: 'Not enough there to justify 2 nights.',
        },
      ],
    });
    expect(deriveAdaptiveQuestions({ preflight: wrongReason, nights: 6 })).toEqual([]);
  });
});

describe('the ceiling', () => {
  it('never asks more than the cap, however much evidence there is', () => {
    const busy = preflight({
      route: [
        { id: 'a', name: 'Core', transferMinutes: 0 },
        { id: 'b', name: 'Second', transferMinutes: 200 },
      ],
      baseReasons: [
        { clusterId: 'a', reason: 'densest', nights: 3, transferMinutes: 0 },
        { clusterId: 'b', reason: 'far', nights: 3, transferMinutes: 200 },
      ],
      satellites: [{ id: 's', name: 'Far Valley', transferMinutes: 95 }],
      excluded: [
        { id: 'x', name: 'Edge One', transferMinutes: 150, reason: 'too far to fold in' },
        { id: 'y', name: 'Edge Two', transferMinutes: 180, reason: 'does not fit in 6 nights' },
      ],
    });
    const questions = deriveAdaptiveQuestions({
      preflight: busy,
      nights: 8,
      known: { transport: 'public_transport' },
    });
    expect(questions.length).toBeLessThanOrEqual(MAX_ADAPTIVE_QUESTIONS);
    /* And the most important one survives the cap rather than the first written. */
    expect(questions[0]?.importance).toBe('high');
  });

  it('never asks the same question twice', () => {
    const spread = preflight({
      route: [
        { id: 'a', name: 'Core', transferMinutes: 0 },
        { id: 'b', name: 'Second', transferMinutes: 200 },
      ],
      baseReasons: [
        { clusterId: 'a', reason: 'densest', nights: 3, transferMinutes: 0 },
        { clusterId: 'b', reason: 'far', nights: 3, transferMinutes: 200 },
      ],
    });
    expect(
      deriveAdaptiveQuestions({
        preflight: spread,
        nights: 8,
        existingIds: [ADAPTIVE_QUESTION_IDS.hotelSwitchTolerance],
      }),
    ).toEqual([]);
  });
});

describe('folding adaptive questions into a set', () => {
  const set: ClarificationSet = {
    schemaVersion: CLARIFICATION_SET_VERSION,
    questions: [
      {
        id: 'transport.car-available',
        reason: 'car_availability_unknown',
        question: 'Will you have a car?',
        whyItMatters: 'It decides what is reachable.',
        answerType: 'single_choice',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
        required: true,
        source: 'rule',
      },
    ],
    answers: [{ questionId: 'transport.car-available', values: ['no'], answeredAt: 'x' }],
  };

  it('adds without disturbing an answer already given', () => {
    const spread = preflight({
      route: [
        { id: 'a', name: 'Core', transferMinutes: 0 },
        { id: 'b', name: 'Second', transferMinutes: 200 },
      ],
      baseReasons: [
        { clusterId: 'a', reason: 'densest', nights: 3, transferMinutes: 0 },
        { clusterId: 'b', reason: 'far', nights: 3, transferMinutes: 200 },
      ],
    });
    const merged = withAdaptiveQuestions(
      set,
      deriveAdaptiveQuestions({ preflight: spread, nights: 8 }),
    );
    expect(merged.questions).toHaveLength(2);
    expect(merged.answers).toEqual(set.answers);
  });

  it('is a no-op when there is nothing to add', () => {
    expect(withAdaptiveQuestions(set, [])).toBe(set);
  });
});

/**
 * THE ANSWER HAS TO CHANGE SOMETHING.
 *
 * The worst defect an adaptive question can have is not being irrelevant — it
 * is being *consumed by nothing*. A question that costs a traveller a decision,
 * states a consequence in `planChangeByAnswer`, and then leaves the plan
 * identical is worse than not asking, because it teaches them their answers do
 * not matter.
 *
 * So these assert the wiring rather than the wording: the same trip, answered
 * two different ways, produces two different scopes.
 */
describe('answering an adaptive question changes the plan', () => {
  const candidate = {
    id: 'test-region',
    displayName: 'Testland',
    qualifiedName: 'Testland',
    entityType: 'state_or_province' as const,
    breadth: 'region' as const,
    center: { lat: 45, lng: 9 },
    aliases: [],
    administrativeAreas: ['Testland'],
    timeZones: ['Europe/Rome'],
    providerRefs: [{ provider: 'test', externalId: 'test-region' }],
    confidence: { level: 'high' as const, signals: [] as never[], note: 'test' },
  };

  function scopeAnswering(questionId: string, value: string, nights = 8) {
    return deriveScope({
      candidate,
      clarifications: {
        schemaVersion: CLARIFICATION_SET_VERSION,
        questions: [],
        answers: [{ questionId, values: [value], answeredAt: '2026-08-10T00:00:00.000Z' }],
      },
      nights,
      revision: 1,
      composerTransport: 'drive',
    });
  }

  it('“move once” and “stay put” produce different base allowances', () => {
    const move = scopeAnswering(ADAPTIVE_QUESTION_IDS.hotelSwitchTolerance, 'move');
    const stay = scopeAnswering(ADAPTIVE_QUESTION_IDS.hotelSwitchTolerance, 'stay');
    expect(move.maxBaseChanges).toBeGreaterThan(0);
    expect(stay.maxBaseChanges).toBe(0);
  });

  it('“decide for me” leaves the derived answer alone rather than forcing one', () => {
    const either = scopeAnswering(ADAPTIVE_QUESTION_IDS.hotelSwitchTolerance, 'either');
    const unanswered = deriveScope({
      candidate,
      clarifications: { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] },
      nights: 8,
      revision: 1,
      composerTransport: 'drive',
    });
    /*
     * Indifference has to be a distinct value rather than a midpoint. A
     * midpoint still breaks ties; this frees the structure to decide on travel
     * logic, which is what "whichever suits the region" promised.
     */
    expect(either.maxBaseChanges).toBe(unanswered.maxBaseChanges);
  });

  it('“make room for it” widens the ground the build covers', () => {
    /*
     * Three nights, so the derived reach sits below the mode's own cap. At
     * eight nights a driving trip is already at the 220 km ceiling and there is
     * nothing left to widen — which is correct behaviour and would have made
     * this assertion pass or fail on the trip length rather than on the answer.
     */
    const include = scopeAnswering(ADAPTIVE_QUESTION_IDS.extendReach, 'include', 3);
    const leaveOut = scopeAnswering(ADAPTIVE_QUESTION_IDS.extendReach, 'leave_out', 3);
    expect(include.reachRadiusKm!).toBeGreaterThan(leaveOut.reachRadiusKm!);
  });

  it('never widens past the ceiling the mode already imposes', () => {
    /*
     * The other half: agreeing to one longer travel day is not agreeing to a
     * different trip, and a traveller already at the cap stays there.
     */
    const atCap = scopeAnswering(ADAPTIVE_QUESTION_IDS.extendReach, 'include', 12);
    expect(atCap.reachRadiusKm!).toBeLessThanOrEqual(220);
  });

  it('every option a rule offers is one the consumer recognises', () => {
    /*
     * The structural version of the same claim, and the one that survives a
     * later edit: an option value the scope layer does not branch on is an
     * answer that silently does nothing.
     */
    const spread = {
      schemaVersion: 1 as const,
      destinationKey: 'wiring',
      portfolio: {
        gateway: { name: 'Core', center: { lat: 0, lng: 0 } },
        route: [
          { id: 'a', name: 'Core', center: { lat: 0, lng: 0 }, memberCount: 3, memberNames: [], distanceFromGatewayKm: 0, transferMinutesFromGateway: 0 },
          { id: 'b', name: 'Second', center: { lat: 2, lng: 0 }, memberCount: 3, memberNames: [], distanceFromGatewayKm: 200, transferMinutesFromGateway: 200 },
        ],
        baseReasons: [
          { clusterId: 'a', reason: 'densest', nights: 3, transferMinutes: 0 },
          { clusterId: 'b', reason: 'far', nights: 3, transferMinutes: 200 },
        ],
        satellites: [],
        excluded: [],
        basesProposed: 2,
        transferDays: 1,
        mode: 'drive' as const,
        reachRadiusKm: 200,
        rationale: 'test',
        estimated: true as const,
      },
      strategies: [],
      dates: null,
      duration: null,
      supply: null,
      builtAt: '2026-08-10T00:00:00.000Z',
      elapsedMs: 1,
    };
    const [question] = deriveAdaptiveQuestions({ preflight: spread, nights: 8 });
    expect(question?.id).toBe(ADAPTIVE_QUESTION_IDS.hotelSwitchTolerance);

    const outcomes = question!.options.map(
      (option) => scopeAnswering(question!.id, option.value).maxBaseChanges,
    );
    /* At least two of the options lead somewhere different. */
    expect(new Set(outcomes).size).toBeGreaterThan(1);
  });
});
