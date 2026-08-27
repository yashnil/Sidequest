import { describe, expect, it } from 'vitest';
import {
  boardOrderingOf,
  buildDiscoveryBoard,
  compareBoardOrder,
  type DiscoveryCandidate,
  type DiscoverySelection,
} from '@sidequest/core';
import {
  AUGUST_DATES,
  MAMMOTH_HIKER_ANSWERS,
  boardContext,
  context,
  profile,
} from '@sidequest/core/testing';
import { pinnedPriority, resolveCandidates } from './candidates';

/**
 * THE PLAN HAS TO BE IN THE ORDER THE BOARD WAS.
 *
 * The board composes its order out of two terms — the band it prints on the
 * card, and then how much each place matters beside how well it suits this
 * traveller. The planning queue read one of them: `base + candidate.fit.score`.
 * So inside one selection band the two lists could disagree, and the case where
 * they disagree is not exotic — it is the ordinary one. Fit score is blunt at
 * the top of its range; most pairs on a real board are within a point of each
 * other, and it is precisely there that significance is the only thing left
 * saying which of the two is the better stop. The traveller then read one order
 * on the board and got another in the trip, with nothing anywhere saying why.
 *
 * The fixture is the authored region, whose places carry no significance at all,
 * with the field supplied on the two cards under test — the same lever
 * `discovery.test.ts` uses to hold everything personal identical while varying
 * standing alone.
 */

const BOARD = (() => {
  const built = profile(MAMMOTH_HIKER_ANSWERS, context({ tripDays: 4 }));
  return buildDiscoveryBoard({
    ...boardContext(AUGUST_DATES),
    profile: built,
    travelerNeeds: [],
  });
})();

/**
 * Two cards the fit scorer genuinely cannot separate, with the significance the
 * test needs written onto them and the ordering key rebuilt from the result.
 *
 * Rebuilt rather than inherited: a candidate whose `ordering` described an
 * earlier version of its own place is a fixture that lies about the type it
 * claims to be, and every assertion below would then be about the spread rather
 * than about the rule.
 */
function withSignificance(candidate: DiscoveryCandidate, value: number): DiscoveryCandidate {
  const place = { ...candidate.place, experienceSignificance: value };
  return { ...candidate, place, ordering: boardOrderingOf({ place, fit: candidate.fit }) };
}

function chosen(candidate: DiscoveryCandidate): DiscoverySelection {
  return {
    placeId: candidate.place.id,
    status: 'included',
    source: 'auto',
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
}

describe('the planning queue and the board it was built from', () => {
  it('orders two candidates the fit scorer cannot separate the way the board did', () => {
    /*
     * Ids chosen so that the alphabetical tiebreak — the only thing left once
     * fit score ties — contradicts the answer significance gives. Without that
     * the old ordering would agree by accident and the test would pass over the
     * defect.
     */
    const pair = ['convict-lake', 'mcgee-creek-canyon'].map(
      (id) => BOARD.candidates.find((candidate) => candidate.place.id === id)!,
    );
    expect(pair.every(Boolean), 'the authored region no longer holds this pair').toBe(true);
    expect(
      pair[0]!.fit.score,
      'the pair is no longer a tie, so this measures the gap rather than the rule',
    ).toBe(pair[1]!.fit.score);
    expect(pair[0]!.fit.band).toBe(pair[1]!.fit.band);
    expect(pair[0]!.place.id.localeCompare(pair[1]!.place.id)).toBeLessThan(0);

    // The one the region is known for is the one that sorts second by id.
    const candidates = [withSignificance(pair[0]!, 0.2), withSignificance(pair[1]!, 0.9)];

    const asBoarded = [...candidates]
      .sort(compareBoardOrder)
      .map((candidate) => candidate.place.id);
    expect(asBoarded).toEqual(['mcgee-creek-canyon', 'convict-lake']);

    const { eligible, rejected } = resolveCandidates(
      candidates,
      candidates.map(chosen),
      boardContext(AUGUST_DATES).travel.matrix,
    );
    expect(rejected, rejected.map((entry) => entry.reason).join(' / ')).toHaveLength(0);

    expect(
      eligible.map((candidate) => candidate.place.id),
      'the trip put these in a different order from the board the traveller read',
    ).toEqual(asBoarded);
  });

  it('does not let the last bit of a double decide which stop comes first', () => {
    /**
     * THE DIVERGENCE THAT SURVIVED THE FIRST FIX, MEASURED ON A LIVE ARTIFACT.
     *
     * A match of 81 with a standing worth three hundredths and a match of 84
     * with none are, in arithmetic, the same figure. In binary they are
     * `0.8400000000000001` and `0.84`. The comparator sorts on the raw
     * difference and duly put one above the other; `boardPriorityOf` normalises
     * the same figure onto a 0–100 scale, where one part in 10^16 does not
     * survive, so the planner saw a tie and fell to the id. Two orders again,
     * from a distinction neither the scorer nor the significance model could
     * express — and it was not hypothetical: on the stored Tokyo artifact
     * exactly this pair put the plan's fifth stop at the board's eighth.
     *
     * The rule, stated where it can be checked: two cards the two dimensions
     * cannot separate must be *equal*, and must then break the tie the same way
     * on both sides.
     */
    const pair = ['hot-creek-geologic-site', 'panorama-gondola'].map(
      (id) => BOARD.candidates.find((candidate) => candidate.place.id === id)!,
    );
    expect(pair.every(Boolean), 'the authored region no longer holds this pair').toBe(true);
    expect(
      { scores: pair.map((candidate) => candidate.fit.score), bands: pair.map((c) => c.fit.band) },
      'the pair no longer sits three points apart in one band, so the sum below is not a tie',
    ).toEqual({ scores: [84, 81], bands: ['strong', 'strong'] });

    // 0.84 + nothing against 0.81 + three hundredths: the same number twice.
    const candidates = [withSignificance(pair[0]!, 0.5), withSignificance(pair[1]!, 0.6)];
    expect(candidates[1]!.ordering.significanceLift).toBeCloseTo(0.03, 10);
    expect(
      candidates[0]!.ordering.withinBand,
      'the two dimensions come to different figures here, so this is not the case under test',
    ).toBe(candidates[1]!.ordering.withinBand);

    const { eligible } = resolveCandidates(
      candidates,
      candidates.map(chosen),
      boardContext(AUGUST_DATES).travel.matrix,
    );
    expect(eligible.map((candidate) => candidate.place.id)).toEqual(
      [...candidates].sort(compareBoardOrder).map((candidate) => candidate.place.id),
    );
  });

  it('keeps the whole queue in the board’s order, not only the pair under test', () => {
    /*
     * The property rather than a cell. Standing is written across the region in
     * four steps so that fit and significance genuinely disagree up and down the
     * list — on a board where nothing carries the field the two orders coincide
     * and a full-list assertion would pass over the defect it is here to catch.
     *
     * Measured on the stored Tokyo artifact before this held: the plan's fifth
     * stop was the board's eighth, and the four cards in between moved with it.
     */
    const ctx = boardContext(AUGUST_DATES);
    const steps = [0.1, 0.4, 0.6, 0.9];
    const board = buildDiscoveryBoard({
      ...ctx,
      places: ctx.places.map((place, index) => ({
        ...place,
        experienceSignificance: steps[index % steps.length]!,
      })),
      profile: profile(MAMMOTH_HIKER_ANSWERS, context({ tripDays: 4 })),
      travelerNeeds: [],
    });

    const { eligible } = resolveCandidates(
      board.candidates,
      board.candidates.map(chosen),
      ctx.travel.matrix,
    );
    expect(eligible.length).toBeGreaterThan(5);

    const planned = new Set(eligible.map((candidate) => candidate.place.id));
    const asBoarded = [...board.candidates]
      .sort(compareBoardOrder)
      .filter((candidate) => planned.has(candidate.place.id))
      .map((candidate) => candidate.place.id);

    expect(
      eligible.map((candidate) => candidate.place.id),
      'the trip and the board disagree about the order of the same stops',
    ).toEqual(asBoarded);
  });

  it('still refuses to let standing cross a band the scorer set', () => {
    /*
     * The guard on the fix. A priority that folded significance in without the
     * band above it would let a famous place that suits this traveller less
     * outrank one that suits them more — which is the failure the board's own
     * lexicographic key was built to make structurally impossible, and it has to
     * stay impossible on this side too.
     */
    const strong = BOARD.candidates.find((candidate) => candidate.fit.band === 'top_pick')!;
    const weaker = BOARD.candidates.find(
      (candidate) =>
        candidate.fit.band !== 'top_pick' &&
        candidate.fit.band !== 'not_workable' &&
        candidate.ordering.bandRank < strong.ordering.bandRank,
    )!;
    expect(strong && weaker, 'the fixture no longer offers two bands').toBeTruthy();

    const candidates = [withSignificance(strong, 0.05), withSignificance(weaker, 1)];
    const { eligible } = resolveCandidates(
      candidates,
      candidates.map(chosen),
      boardContext(AUGUST_DATES).travel.matrix,
    );

    expect(eligible[0]!.place.id).toBe(strong.place.id);
    expect(eligible.map((candidate) => candidate.place.id)).toEqual(
      [...candidates].sort(compareBoardOrder).map((candidate) => candidate.place.id),
    );
  });

  it('never lets the board’s order outrank a place the traveller pinned by hand', () => {
    /*
     * The other guard, and the reason the composed figure stays on `fit.score`'s
     * 0–100 scale: the selection bands are a thousand apart, and a within-band
     * term that grew past them would let an auto-pick the region is famous for
     * jump a stop somebody asked for by name.
     */
    const famous = BOARD.candidates.find((candidate) => candidate.fit.band === 'top_pick')!;
    const asked = BOARD.candidates.find(
      (candidate) =>
        candidate.place.id !== famous.place.id && candidate.fit.band !== 'not_workable',
    )!;

    const candidates = [withSignificance(famous, 1), withSignificance(asked, 0)];
    // Left to itself the board ranks the famous one first, or the pin below
    // proves nothing.
    expect([...candidates].sort(compareBoardOrder)[0]!.place.id).toBe(famous.place.id);

    const { eligible } = resolveCandidates(
      candidates,
      [chosen(candidates[0]!), { ...chosen(candidates[1]!), source: 'user' as const }],
      boardContext(AUGUST_DATES).travel.matrix,
    );

    expect(eligible[0]!.place.id).toBe(asked.place.id);
    expect(eligible[0]!.manual).toBe(true);
  });

  /**
   * PINNING A STOP MUST NOT REVERT IT TO THE ORDER THE BOARD STOPPED USING.
   *
   * Every rule above is about the queue `resolveCandidates` hands back. It is
   * not the last word on priority: a lock lifts a place into the manual band,
   * and that lift was written out by hand at three call sites as
   * `10_000 + fitScore` — the board's *old* key, from before significance
   * entered it. So the composition this whole file exists to protect survived
   * exactly as far as the traveller's first pin. Two stops the board had ranked
   * one way came back ranked the other, and only the pinned ones moved, which is
   * the hardest version of the §10 complaint to explain to the person reading it:
   * the list disagreed with itself about the places they had insisted on.
   */
  it('keeps two pinned stops in the board’s order rather than reverting them to fit alone', () => {
    const pair = ['hot-creek-geologic-site', 'panorama-gondola'].map(
      (id) => BOARD.candidates.find((candidate) => candidate.place.id === id)!,
    );
    expect(pair.every(Boolean), 'the authored region no longer holds this pair').toBe(true);

    /*
     * The case that separates the two keys: 84 with middling standing against 81
     * with high. Fit alone says the first; the board says the second. A pair the
     * two agree on would pass whatever the promotion did.
     */
    const candidates = [withSignificance(pair[0]!, 0.5), withSignificance(pair[1]!, 0.9)];
    expect(candidates.map((candidate) => candidate.fit.score)).toEqual([84, 81]);
    const asBoarded = [...candidates].sort(compareBoardOrder).map((candidate) => candidate.place.id);
    expect(asBoarded).toEqual(['panorama-gondola', 'hot-creek-geologic-site']);

    const { eligible } = resolveCandidates(
      candidates,
      candidates.map(chosen),
      boardContext(AUGUST_DATES).travel.matrix,
    );
    expect(eligible.map((candidate) => candidate.place.id)).toEqual(asBoarded);

    /* Both pinned, exactly as `planTrip` and `editWorld` pin them. */
    const pinned = eligible
      .map((candidate) => ({ ...candidate, priority: pinnedPriority(candidate) }))
      .sort((a, b) => b.priority - a.priority || a.place.id.localeCompare(b.place.id));

    expect(
      pinned.every((candidate) => candidate.priority >= 10_000),
      'a pin has to reach the band a hand-picked place sits in',
    ).toBe(true);
    expect(
      pinned.map((candidate) => candidate.place.id),
      'pinning re-ranked these two against the board they were chosen from',
    ).toEqual(asBoarded);
  });
});
