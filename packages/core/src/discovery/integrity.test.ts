import { describe, expect, it } from 'vitest';
import {
  BOARD_BLOCKER_CLAUSES,
  BOARD_INTEGRITY_FACTS,
  BOARD_INTEGRITY_FACT_LABELS,
  BOARD_INTEGRITY_STATES,
  BOARD_INTEGRITY_STATE_LABELS,
  BOARD_RECOVERY_ACTIONS,
  BOARD_RECOVERY_ACTION_LABELS,
  BOARD_RECOVERY_ACTION_TARGETS,
  bindingBoardConstraint,
  boardIntegrityState,
  buildDiscoveryBoard,
  readBoardIntegrity,
  type DiscoveryBoard,
} from './board';
import type { QuestionnaireAnswers, TravelerProfile } from '../schemas/profile';
import {
  AUGUST_DATES,
  JANUARY_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
} from '../testing/fixtures';

function setup(
  overrides: Partial<QuestionnaireAnswers> = MAMMOTH_HIKER_ANSWERS,
  dates = AUGUST_DATES,
  tripDays = 4,
): { board: DiscoveryBoard; profile: TravelerProfile; tripDays: number } {
  const built = profile(overrides, context({ travelerNeeds: [], tripDays }));
  return {
    board: buildDiscoveryBoard({ ...boardContext(dates), profile: built, travelerNeeds: [] }),
    profile: built,
    tripDays,
  };
}

describe('board integrity, as a traveller reads it', () => {
  it('reports the authored board as workable, with real counts', () => {
    const { board, profile: built, tripDays } = setup();
    const reading = readBoardIntegrity({ board, profile: built, tripDays });

    expect(BOARD_INTEGRITY_STATES).toContain(reading.state);
    expect(reading.state).not.toBe('blocked');

    const attractions = reading.facts.find((fact) => fact.id === 'attractions');
    expect(attractions?.value).toBeGreaterThan(0);
    const kinds = reading.facts.find((fact) => fact.id === 'categoryDiversity');
    expect(kinds?.value).toBeGreaterThan(1);

    // The sentence carries a number and never a destination name.
    expect(reading.summary).toMatch(/\d/);
  });

  /**
   * The rule that keeps the panel from shouting on the happiest path.
   *
   * `data/places.ts` writes no role tags at all, so every admitted card is
   * role-unknown — `roleUnknown === admitted`. That is the resting state of the
   * fixture the whole browser suite drives, and it is a fact about a convention
   * that arrived after the data, not about this board.
   */
  it('says nothing about roles when nothing on the board carries one', () => {
    const { board, profile: built, tripDays } = setup();
    expect(board.integrity.roleUnknown).toBe(board.integrity.admitted);
    expect(board.integrity.everyCardHasEligibleRole).toBe(false);

    const reading = readBoardIntegrity({ board, profile: built, tripDays });
    expect(reading.facts.map((fact) => fact.id)).not.toContain('roleUnclassified');
  });

  /**
   * The other half of the same rule: a *mixed* population is worth naming, and
   * only a mixed one.
   */
  it('names role-unclassified places only when some places are classified', () => {
    const { board, profile: built, tripDays } = setup();
    const mixed: DiscoveryBoard = {
      ...board,
      integrity: { ...board.integrity, roleUnknown: 2, admitted: 9 },
    };
    const reading = readBoardIntegrity({ board: mixed, profile: built, tripDays });
    expect(reading.facts.find((fact) => fact.id === 'roleUnclassified')?.value).toBe(2);
  });

  /**
   * The defect this whole layer exists to avoid. `refused['utility_role']` is
   * structurally ~0 on every artifact the live provider produces, and a panel
   * that renders "0 practical stops set aside" for ever looks broken.
   */
  it('never renders a count the artifact does not actually record', () => {
    const { board, profile: built, tripDays } = setup();
    const reading = readBoardIntegrity({ board, profile: built, tripDays });

    for (const id of [
      'supportKeptSeparately',
      'withheldUnplaceable',
      'removedOutOfScope',
      'removedUtilityRole',
      'gateways',
    ] as const) {
      expect(reading.facts.find((fact) => fact.id === id)).toBeUndefined();
    }
    expect(reading.facts.every((fact) => fact.value > 0 || fact.id === 'attractions')).toBe(true);
  });

  it('says the support figure the moment an artifact records one', () => {
    const { board, profile: built, tripDays } = setup();
    const reading = readBoardIntegrity({
      board,
      profile: built,
      tripDays,
      recorded: { supportKeptSeparately: 11, removedOutOfScope: 6, withheldUnplaceable: 0 },
    });
    expect(reading.facts.find((fact) => fact.id === 'supportKeptSeparately')?.value).toBe(11);
    expect(reading.facts.find((fact) => fact.id === 'removedOutOfScope')?.value).toBe(6);
    /*
     * A recorded zero is a fact and is kept. The rule is "never *fabricate* a
     * zero", not "never show one" — an artifact that counted and found none has
     * said something.
     */
    expect(reading.facts.find((fact) => fact.id === 'withheldUnplaceable')?.value).toBe(0);
  });

  it('does not claim an area count when the artifact names no areas', () => {
    const { board, profile: built, tripDays } = setup();
    const reading = readBoardIntegrity({ board, profile: built, tripDays });
    expect(reading.facts.find((fact) => fact.id === 'regionalDiversity')).toBeUndefined();
    expect(reading.missingAreas).toEqual([]);
  });

  it('counts the areas it is given and names the empty ones', () => {
    const { board, profile: built, tripDays } = setup();
    const ids = board.candidates.map((candidate) => candidate.place.id);
    const reading = readBoardIntegrity({
      board,
      profile: built,
      tripDays,
      areas: [
        { name: 'The valley', placeIds: ids.slice(0, 3) },
        { name: 'The far side', placeIds: ['nothing-on-this-board'] },
      ],
    });
    expect(reading.facts.find((fact) => fact.id === 'regionalDiversity')?.value).toBe(1);
    expect(reading.missingAreas).toEqual(['The far side']);
  });
});

describe('the binding constraint', () => {
  /**
   * The `/discover` empty state used to name season, radius and effort. On the
   * one world that reaches it every place is *inside* the radius and simply too
   * far to return from. This is the assertion that the panel names the
   * constraint that is actually binding rather than three plausible ones.
   */
  it('is the reason that is stopping the most places', () => {
    const constraint = bindingBoardConstraint([
      candidateWith(['exceeds_daily_travel']),
      candidateWith(['exceeds_daily_travel']),
      candidateWith(['closed_on_your_dates']),
    ]);
    expect(constraint).toEqual({ code: 'exceeds_daily_travel', count: 2 });
  });

  it('counts one vote per place, however many times a place trips the same rule', () => {
    const constraint = bindingBoardConstraint([
      candidateWith(['needs_car', 'needs_car', 'needs_car']),
      candidateWith(['too_expensive']),
      candidateWith(['too_expensive']),
    ]);
    expect(constraint).toEqual({ code: 'too_expensive', count: 2 });
  });

  it('ignores places that are workable', () => {
    expect(bindingBoardConstraint([candidateWith([], 'strong')])).toBeUndefined();
  });

  it('appears in the sentence, in words, never as an identifier', () => {
    const { board, profile: built, tripDays } = setup(MAMMOTH_HIKER_ANSWERS, JANUARY_DATES);
    const reading = readBoardIntegrity({ board, profile: built, tripDays });
    if (reading.bindingConstraint) {
      expect(reading.summary).toContain(BOARD_BLOCKER_CLAUSES[reading.bindingConstraint.code]);
      expect(reading.summary).not.toContain(reading.bindingConstraint.code);
    }
  });
});

describe('recovery actions', () => {
  const base = {
    state: 'blocked' as const,
    attractions: 0,
    tripDays: 4,
    regionalDiversity: undefined,
    missingAreas: 0,
    satellites: 0,
    removedOutOfScope: 0,
  };

  function actionsFor(overrides: Partial<typeof base> & { bindingConstraint?: never } = {}) {
    const { board, profile: built } = setup();
    return readBoardIntegrity({
      board: { ...board, candidates: [], groups: [] },
      profile: built,
      tripDays: overrides.tripDays ?? base.tripDays,
    }).actions;
  }

  it('offers nothing that could not change the answer', () => {
    // A board with no satellites offered is never told to allow one; a board
    // that lost nothing to scope is never told to widen it.
    const actions = actionsFor();
    expect(actions).not.toContain('allow_satellite');
    expect(actions).not.toContain('broaden_scope');
    expect(actions).not.toContain('narrow_scope');
  });

  it('answers a travel-distance constraint with travel, not with the season', () => {
    const { board, profile: built } = setup();
    const blocked: DiscoveryBoard = {
      ...board,
      candidates: [candidateWith(['exceeds_daily_travel']), candidateWith(['exceeds_daily_travel'])],
      groups: [],
    };
    const reading = readBoardIntegrity({ board: blocked, profile: built, tripDays: 4 });
    expect(reading.state).toBe('blocked');
    expect(reading.actions).toContain('adjust_travel_tolerance');
    expect(reading.actions).toContain('return_to_shaping');
    expect(reading.actions).not.toContain('change_transport');
  });

  it('answers a transport constraint with transport', () => {
    const { board, profile: built } = setup();
    const blocked: DiscoveryBoard = {
      ...board,
      candidates: [candidateWith(['needs_car'])],
      groups: [],
    };
    const reading = readBoardIntegrity({ board: blocked, profile: built, tripDays: 4 });
    expect(reading.actions).toContain('change_transport');
    expect(reading.actions).not.toContain('adjust_travel_tolerance');
  });

  it('offers nothing at all where nothing on this screen would help', () => {
    const { board, profile: built } = setup();
    const blocked: DiscoveryBoard = {
      ...board,
      candidates: [candidateWith(['too_expensive'])],
      groups: [],
    };
    const reading = readBoardIntegrity({ board: blocked, profile: built, tripDays: 4 });
    expect(reading.actions).toEqual(['return_to_shaping']);
  });

  it('offers a side trip only when one is on offer', () => {
    const { board, profile: built } = setup();
    const withSatellites: DiscoveryBoard = {
      ...board,
      integrity: { ...board.integrity, external: [{ reason: 'optional_satellite', count: 3 }] },
    };
    const reading = readBoardIntegrity({ board: withSatellites, profile: built, tripDays: 4 });
    expect(reading.actions).toContain('allow_satellite');
    expect(reading.facts.find((fact) => fact.id === 'satellites')?.value).toBe(3);
  });

  it('suggests covering less ground only when there is more ground than days', () => {
    const { board, profile: built } = setup();
    const ids = board.candidates.map((candidate) => candidate.place.id);
    const areas = ids.slice(0, 6).map((id, index) => ({ name: `Area ${index}`, placeIds: [id] }));
    const spread = readBoardIntegrity({ board, profile: built, tripDays: 2, areas });
    expect(spread.actions).toContain('narrow_scope');

    const roomy = readBoardIntegrity({ board, profile: built, tripDays: 12, areas });
    expect(roomy.actions).not.toContain('narrow_scope');
  });
});

describe('the state ladder', () => {
  const shape = {
    tripDays: 4,
    categoryDiversity: 5,
    regionalDiversity: 3,
    gaps: 0,
    withheld: 0,
  };

  it('is total over every input', () => {
    for (const attractions of [0, 1, 3, 4, 8, 12, 40]) {
      expect(BOARD_INTEGRITY_STATES).toContain(
        boardIntegrityState({ ...shape, attractions }),
      );
    }
  });

  it('reads the same board differently for a longer trip', () => {
    expect(boardIntegrityState({ ...shape, attractions: 12, tripDays: 4 })).toBe('strong');
    expect(boardIntegrityState({ ...shape, attractions: 12, tripDays: 14 })).toBe('thin');
  });

  it('never downgrades for an unknown area count', () => {
    expect(
      boardIntegrityState({ ...shape, attractions: 12, regionalDiversity: undefined }),
    ).toBe('strong');
    expect(boardIntegrityState({ ...shape, attractions: 12, regionalDiversity: 1 })).toBe('usable');
  });

  it('is blocked only when there is nothing at all', () => {
    expect(boardIntegrityState({ ...shape, attractions: 0 })).toBe('blocked');
    expect(boardIntegrityState({ ...shape, attractions: 1 })).not.toBe('blocked');
  });
});

/**
 * Every identifier a traveller could reach has a phrase, and no phrase is the
 * identifier with its underscores out. `hot spring, scenic drive` is the exact
 * shape of the previous defect.
 */
describe('nothing renders as an identifier', () => {
  it('labels every state, fact, action and blocker', () => {
    for (const state of BOARD_INTEGRITY_STATES) {
      expect(BOARD_INTEGRITY_STATE_LABELS[state]).toMatch(/^[A-Z]/);
      expect(BOARD_INTEGRITY_STATE_LABELS[state]).not.toContain('_');
    }
    for (const fact of BOARD_INTEGRITY_FACTS) {
      expect(BOARD_INTEGRITY_FACT_LABELS[fact]).toMatch(/^[A-Z]/);
      expect(BOARD_INTEGRITY_FACT_LABELS[fact]).not.toContain('_');
    }
    for (const action of BOARD_RECOVERY_ACTIONS) {
      expect(BOARD_RECOVERY_ACTION_LABELS[action]).toMatch(/^[A-Z]/);
      expect(BOARD_RECOVERY_ACTION_LABELS[action]).not.toContain('_');
      expect(BOARD_RECOVERY_ACTION_TARGETS[action]).toBeTruthy();
    }
    for (const clause of Object.values(BOARD_BLOCKER_CLAUSES)) {
      expect(clause).not.toContain('_');
      expect(clause.length).toBeGreaterThan(10);
    }
  });

  it('never puts a de-underscored identifier in a summary', () => {
    const { board, profile: built } = setup();
    const reading = readBoardIntegrity({ board, profile: built, tripDays: 4 });
    expect(reading.summary).not.toMatch(/[a-z]_[a-z]/);
  });
});

// ---------------------------------------------------------------------------

/** A candidate that carries nothing but a fit verdict. Enough for the gates. */
function candidateWith(
  codes: readonly string[],
  band: 'not_workable' | 'strong' = 'not_workable',
): DiscoveryCandidateStub {
  return {
    place: { id: `p-${codes.join('-')}-${band}`, category: 'viewpoint', interests: [] },
    fit: { band, blockers: codes.map((code) => ({ code, message: code })) },
  } as unknown as DiscoveryCandidateStub;
}

type DiscoveryCandidateStub = Parameters<typeof bindingBoardConstraint>[0][number];
