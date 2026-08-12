import { describe, expect, it } from 'vitest';
import { buildDiscoveryBoard, BOARD_GROUPS, type DiscoveryCandidate } from '@sidequest/core';
import {
  AUGUST_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
} from '@sidequest/core/testing';
import {
  BOARD_GROUP_HEADINGS,
  MAX_CARD_CHIPS,
  alsoLikeThis,
  chipsFor,
  evidenceDisclosureLabel,
  sharedBoardFacts,
  timeThere,
  whyThisFits,
} from './BoardCopy';

/**
 * THE COPY RULES THE LIVE BOARD BROKE.
 *
 * Every assertion here corresponds to something observed on a real compiled
 * Tokyo board: twenty-four cards with six identical chips each, the same three
 * warnings repeated on all of them, and "Why we trust this (0 of 6 checked)"
 * under every one. None of it was catchable by a test, because all of it lived
 * inline in a component the unit suite cannot render.
 */

const BOARD = (() => {
  const built = profile(MAMMOTH_HIKER_ANSWERS, context({ tripDays: 4 }));
  return buildDiscoveryBoard({ ...boardContext(AUGUST_DATES), profile: built, travelerNeeds: [] });
})();

/** A candidate with one field forced, so a rule can be exercised in isolation. */
function forced(patch: (candidate: DiscoveryCandidate) => DiscoveryCandidate): DiscoveryCandidate {
  return patch(BOARD.candidates[0]!);
}

/** The reach of a journey nobody could time — the whole-board case in Tokyo. */
function unmeasured(candidate: DiscoveryCandidate): DiscoveryCandidate['reach'] {
  return {
    baseId: candidate.reach.baseId,
    candidateId: candidate.reach.candidateId,
    status: 'unmeasured',
    reachable: null,
    conflict: false,
    reason: 'no_route_found',
    detail: 'nothing timed this journey',
  };
}

describe('board group headings', () => {
  it('names every group a traveller could land in', () => {
    for (const group of BOARD_GROUPS) {
      expect(BOARD_GROUP_HEADINGS[group].title.length).toBeGreaterThan(0);
      expect(BOARD_GROUP_HEADINGS[group].blurb.length).toBeGreaterThan(0);
    }
  });

  it('uses no compiler vocabulary in a heading or its blurb', () => {
    // §26's list, restricted to the words that could plausibly land in a heading.
    const banned = /\b(candidate|evidence pack|role|membership|containment|readiness|provider|matrix|inventory|coverage|unmeasured|diagnostics|personalised)\b/i;
    for (const group of BOARD_GROUPS) {
      const copy = `${BOARD_GROUP_HEADINGS[group].title} ${BOARD_GROUP_HEADINGS[group].blurb}`;
      expect(copy, `${group} heading`).not.toMatch(banned);
    }
  });
});

describe('facts that belong to the board rather than a card', () => {
  it('hoists a statement true of every card and tells the cards to stay quiet', () => {
    /*
     * The observed shape: nothing could time any journey, so every single card
     * carried "We could not check the journey". Twenty-four copies of one
     * sentence is not information, it is wallpaper.
     */
    const all = BOARD.candidates.map(
      (candidate): DiscoveryCandidate => ({
        ...candidate,
        detourClass: 'in_tolerance',
        reach: unmeasured(candidate),
      }),
    );

    const facts = sharedBoardFacts(all);
    expect(facts.suppressed.has('journey')).toBe(true);
    expect(facts.notes.join(' ')).toMatch(/could not time the journeys/i);
  });

  it('names how many cards are unverified rather than repeating the sentence on each', () => {
    /*
     * Observed on the live board: eleven of twenty-three cards carried the same
     * thirty-word "this looks promising, but nobody publishes enough about it".
     * Under the share threshold, so it would not hoist; far too many to leave
     * repeating. Naming the count is what makes the sentence honest below a
     * majority.
     */
    const board = BOARD.candidates.map(
      (candidate, index): DiscoveryCandidate =>
        index < 4
          ? { ...candidate, fit: { ...candidate.fit, evidenceLimited: true, blockers: [] } }
          : candidate,
    );

    const facts = sharedBoardFacts(board);
    expect(facts.suppressed.has('unverified')).toBe(true);
    expect(facts.notes.join(' ')).toMatch(/\b4 of these\b/);
    // And the card then wears a chip instead of the paragraph, so a reader can
    // still tell which four.
    expect(chipsFor(board[0]!, facts.suppressed).some((chip) => chip.key === 'unverified')).toBe(
      true,
    );
    expect(whyThisFits(board[0]!, facts.suppressed)).not.toMatch(/looks promising/);
  });

  it('hoists the reason most cards would share and gives those cards something of their own', () => {
    /*
     * The second layer of the same defect, and the one that appeared the moment
     * the first was fixed: with the evidence sentence hoisted, fifteen cards fell
     * through to the identical quality verdict and the wall of prose came back
     * one rung down.
     */
    const verdict = 'We could not confirm when this is open, so we would not build a day around it.';
    const board = BOARD.candidates.map(
      (candidate): DiscoveryCandidate => ({
        ...candidate,
        fit: { ...candidate.fit, reasons: [], blockers: [], evidenceLimited: false },
        quality: { ...candidate.quality, reason: verdict },
      }),
    );

    const facts = sharedBoardFacts(board);
    expect(facts.commonWhy).toBe(verdict);
    expect(facts.notes).toContain(verdict);
    for (const candidate of board) {
      expect(whyThisFits(candidate, facts.suppressed, facts.commonWhy)).not.toBe(verdict);
    }
  });

  it('never hoists a blocker, which is a verdict on one place', () => {
    const board = BOARD.candidates.map(
      (candidate): DiscoveryCandidate => ({
        ...candidate,
        fit: {
          ...candidate.fit,
          blockers: [{ code: 'needs_car', message: 'There is no way in without a vehicle.' }],
        },
      }),
    );
    expect(sharedBoardFacts(board).commonWhy).toBeNull();
  });

  it('does not hoist a statement true of a minority', () => {
    const mostly = BOARD.candidates.map(
      (candidate, index): DiscoveryCandidate =>
        index === 0
          ? { ...candidate, detourClass: 'in_tolerance', reach: unmeasured(candidate) }
          : candidate,
    );
    expect(sharedBoardFacts(mostly).suppressed.has('journey')).toBe(false);
  });
});

describe('card chips', () => {
  it('never exceeds the cap, whatever a candidate qualifies for', () => {
    /*
     * The live cards wore six: worth-detour, hidden gem, two access badges and
     * two hours badges. This forces a candidate that qualifies for more than
     * that and checks the cap holds rather than the ordering happening to.
     */
    const loaded = forced((candidate) => ({
      ...candidate,
      season: { ...candidate.season, status: 'partially_open' as const },
      operating: {
        ...candidate.operating,
        badges: ['reservation_required', 'timed_entry', 'limited_hours'] as const as never,
      },
      access: {
        ...candidate.access,
        badges: ['car_required', 'permit_required', 'verify_conditions'] as const as never,
      },
      weather: {
        ...candidate.weather,
        badges: ['poor_in_the_forecast', 'visibility_dependent'] as const as never,
      },
      place: { ...candidate.place, hiddenGemScore: 0.9 },
    }));

    expect(chipsFor(loaded).length).toBeLessThanOrEqual(MAX_CARD_CHIPS);
  });

  it('leads with the fact that would stop the visit', () => {
    const shut = forced((candidate) => ({
      ...candidate,
      season: { ...candidate.season, status: 'closed' as const },
      place: { ...candidate.place, hiddenGemScore: 0.9 },
    }));
    expect(chipsFor(shut)[0]?.label).toBe('Closed on your dates');
  });

  it('drops a weather chip the board has already stated for every card', () => {
    const wet = forced((candidate) => ({
      ...candidate,
      season: { ...candidate.season, status: 'open' as const },
      operating: { ...candidate.operating, status: 'always_open' as const, badges: [] as never },
      access: { ...candidate.access, badges: [] as never },
      weather: { ...candidate.weather, badges: ['poor_in_the_forecast'] as const as never },
      place: { ...candidate.place, hiddenGemScore: 0.1 },
    }));
    expect(chipsFor(wet).some((chip) => chip.key === 'poor_in_the_forecast')).toBe(true);
    expect(
      chipsFor(wet, new Set(['weather'])).some((chip) => chip.key === 'poor_in_the_forecast'),
    ).toBe(false);
  });
});

describe('the argument on a card', () => {
  it('says the practical details are unchecked rather than recommending', () => {
    /*
     * §26's own worked example: a card with no verified evidence must not read
     * as a recommendation, whatever it scored.
     */
    const unverified = forced((candidate) => ({
      ...candidate,
      fit: { ...candidate.fit, evidenceLimited: true, blockers: [] },
    }));
    expect(whyThisFits(unverified)).toMatch(/not.*checked|have.?n.t.*checked|nobody publishes/i);
  });

  it('says something real or says nothing — never a stub description', () => {
    /*
     * §8.7's banned primary copy. The regression this guards is a subtle one:
     * suppressing a repeated sentence left a hole, the hole was filled from
     * `shortDescription`, and on a weak artifact that field is literally "A
     * viewpoint." — filler in the one slot where the product makes its case.
     */
    for (const candidate of BOARD.candidates) {
      const why = whyThisFits(candidate);
      if (why === null) continue;
      expect(why.length).toBeGreaterThan(10);
      expect(why, candidate.place.id).not.toMatch(/^an?\s+[a-z\s]+\.\s*$/i);
    }
  });

  it('leaves the reason blank rather than promoting a stub description into it', () => {
    const stub = forced((candidate) => ({
      ...candidate,
      fit: { ...candidate.fit, reasons: [], blockers: [], evidenceLimited: false },
      quality: { ...candidate.quality, reason: 'shared verdict' },
      place: { ...candidate.place, shortDescription: 'A viewpoint.' },
    }));
    expect(whyThisFits(stub, new Set(), 'shared verdict')).toBeNull();
  });

  it('does not label the evidence disclosure with a fraction', () => {
    for (const answered of [0, 3, 6]) {
      expect(evidenceDisclosureLabel(answered)).not.toMatch(/\d+\s*(of|\/)\s*\d+/);
      expect(evidenceDisclosureLabel(answered)).not.toMatch(/trust/i);
    }
  });

  /**
   * The archetype's constant, said as one.
   *
   * A compiled river arrives with `typicalDurationMinutes: 90` because that is
   * what the *kind* is worth, and the card printed it flat: "Time there:
   * 1 hr 30 min", on a stretch of water nobody has ever timed. The compiler
   * already marks the figure `category_estimate` for exactly this; the card is
   * the half that has to say it.
   */
  it('hedges a duration derived from the kind of place, and only that one', () => {
    const compiled = forced((candidate) => ({
      ...candidate,
      place: {
        ...candidate.place,
        typicalDurationMinutes: 90,
        durationBasis: 'category_estimate' as const,
      },
    }));
    expect(timeThere(compiled.place)).toBe('about 1 hr 30 min');

    const stated = forced((candidate) => ({
      ...candidate,
      place: {
        ...candidate.place,
        typicalDurationMinutes: 90,
        durationBasis: 'source_stated' as const,
      },
    }));
    expect(timeThere(stated.place)).toBe('1 hr 30 min');
  });
});

describe('passing on something, with a reason', () => {
  it('offers only places at least as far out as the one that was rejected', () => {
    const withDistances = BOARD.candidates.filter(
      (candidate) => candidate.travelMinutesFromBase !== null,
    );
    const sorted = [...withDistances].sort(
      (a, b) => (a.travelMinutesFromBase ?? 0) - (b.travelMinutesFromBase ?? 0),
    );
    const middle = sorted[Math.floor(sorted.length / 2)]!;

    const similar = alsoLikeThis({
      candidates: BOARD.candidates,
      passed: middle,
      reason: 'too_far',
      decided: new Set(),
    });

    expect(similar.length).toBeGreaterThan(0);
    for (const candidate of similar) {
      expect(candidate.travelMinutesFromBase).not.toBeNull();
      expect(candidate.travelMinutesFromBase!).toBeGreaterThanOrEqual(
        middle.travelMinutesFromBase!,
      );
    }
  });

  it('never re-asks about a place the traveller has already decided on', () => {
    const sorted = [...BOARD.candidates]
      .filter((candidate) => candidate.travelMinutesFromBase !== null)
      .sort((a, b) => (a.travelMinutesFromBase ?? 0) - (b.travelMinutesFromBase ?? 0));
    const nearest = sorted[0]!;
    const decided = new Set(sorted.slice(1).map((candidate) => candidate.place.id));

    expect(
      alsoLikeThis({ candidates: BOARD.candidates, passed: nearest, reason: 'too_far', decided }),
    ).toEqual([]);
  });

  it('offers nothing when the reason cannot discriminate', () => {
    // Nothing is cheaper than free, so "too expensive" about a free stop is not
    // a judgement that could be applied to anything else.
    const free = forced((candidate) => ({
      ...candidate,
      place: { ...candidate.place, costLevel: 0 as const },
    }));
    expect(
      alsoLikeThis({
        candidates: BOARD.candidates,
        passed: free,
        reason: 'too_expensive',
        decided: new Set(),
      }),
    ).toEqual([]);
  });
});
