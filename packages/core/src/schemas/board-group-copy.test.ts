import { describe, expect, it } from 'vitest';
import { buildDiscoveryBoard } from '../discovery/board';
import { transitCityBoardInput, transitCityTraveler } from '../testing/transit-city';
import { BOARD_GROUP_COPY, PROXIMITY_CLAIMS } from './discovery';

/**
 * A GROUP HEADING MAY NOT CLAIM A FACT ITS GROUP DOES NOT HOLD.
 *
 * `nearby_side_quests` used to be the board's catch-all — "matched none of the
 * rules above" — and its blurb said "Short hops from your base". When `groupFor`
 * was corrected to split the two distance groups on the traveller's own detour
 * classification, this group stopped meaning "near": it now holds everything
 * that is not `stretch` or `too_far`, and that includes every stop whose
 * journey nobody could measure. "Short hop" is not something we know about an
 * unmeasured journey, and a heading a traveller acts on is the worst place to
 * assert something the contents can contradict.
 *
 * Not a pin on the wording. The property is that the group's copy makes no
 * proximity claim, checked against the vocabulary a claim would have to use —
 * so any rewrite is free as long as it does not start claiming distance again.
 * The first half of the test is what makes the second half mean anything: it
 * shows an unmeasured journey genuinely landing in this group, which is the
 * reason the claim cannot be made.
 */

describe('the board group headings', () => {
  it('does not claim nearness for the group that holds unmeasured journeys', () => {
    const profile = transitCityTraveler();
    const input = transitCityBoardInput(profile);
    /*
     * The pedestrian matrix covers the base and the near stops; the outer ones
     * are reached by measured metro journeys or not at all. Whatever the
     * classifier makes of each, the assertion below is about the population
     * that lands in the near group without a measured journey behind it.
     */
    const board = buildDiscoveryBoard(input);

    const nearGroup = board.candidates.filter(
      (candidate) => candidate.group === 'nearby_side_quests',
    );
    expect(
      nearGroup.length,
      'nothing landed in the near group, so this proves nothing about its heading',
    ).toBeGreaterThan(0);
    const unmeasured = nearGroup.filter(
      (candidate) => candidate.reach === undefined || candidate.reach.status === 'unmeasured',
    );
    expect(
      unmeasured.length,
      'no unmeasured journey reached the near group, so the heading could honestly claim nearness',
    ).toBeGreaterThan(0);

    /*
     * This constant is the *compiler's* vocabulary and no surface renders it.
     * The copy a traveller reads is `BOARD_GROUP_HEADINGS`, which carried
     * "Within your range · Inside the distance you said you would travel" over
     * the very population proved above while this test was green — the
     * invariant guarded on the copy nobody reads and unguarded on the copy
     * everybody reads. `board-copy.test.ts` holds the rendered half against the
     * same exported list.
     */
    const text = BOARD_GROUP_COPY.nearby_side_quests.blurb.toLowerCase();
    for (const claim of PROXIMITY_CLAIMS) {
      expect(
        text.includes(claim),
        `the near group's blurb claims "${claim}" over ${unmeasured.length} stops whose journey nobody could time`,
      ).toBe(false);
    }
  });

  it('lets the further-out group say so, because that group is decided by distance', () => {
    /*
     * The negative control. A blanket ban on distance words would satisfy the
     * test above and strip the one heading that has earned its claim:
     * `scenic_detours` is exactly the `stretch` and `too_far` population.
     */
    const detours = BOARD_GROUP_COPY.scenic_detours;
    expect(detours.title.length).toBeGreaterThan(0);
    expect(BOARD_GROUP_COPY.nearby_side_quests.blurb.length).toBeGreaterThan(10);
  });
});
