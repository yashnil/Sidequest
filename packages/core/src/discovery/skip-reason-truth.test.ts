import { describe, expect, it } from 'vitest';
import { buildDiscoveryBoard } from './board';
import { transitCityBoardInput, transitCityTraveler } from '../testing/transit-city';

/**
 * WHAT THE BOARD SAYS WHEN IT CANNOT PRICE THE JOURNEY.
 *
 * With no transit provider the matrix prices pedestrian journeys only, so a
 * landmark a few stops away surfaces as a measured hour-long walk. The skip
 * sentence was then built out of the two things that are untrue about such a
 * journey: a walking clock for a ride, and "you said" for an answer that ruled
 * nothing out. Live evidence — a car-free metropolitan board filed the
 * destination's most famous sights under "Probably skip" reading "1 hr 29 min
 * each way on foot is past how far you said you would go", over a city whose own
 * pack records a hundred-odd railway stations.
 *
 * The fact that decides the sentence lives on the board and nowhere else, so the
 * board is where it has to be supplied. This is the wiring test: the quality
 * layer's own unit test proves the branch exists, and proves nothing about
 * whether production reaches it — which is exactly the gap that let the last
 * repair pass its tests while the delivered board still blamed the traveller.
 */
describe('the reason a car-free board gives for skipping something far', () => {
  const boardForCarFreeTraveller = (network: 'observed' | 'not_observed') => {
    const profile = transitCityTraveler();
    const input = transitCityBoardInput(profile);
    return buildDiscoveryBoard({
      ...input,
      travel: {
        ...input.travel,
        /*
         * The production shape, and the whole point of the test: nothing was
         * bought, and the reason nothing was bought is that no provider here can
         * price a scheduled journey. The shared fixture ships *measured*
         * timetables, which is the one world in which this defect cannot occur.
         */
        transit: { journeys: [], requested: 0, measured: 0, absence: 'unsupported' as const },
        scheduledNetwork: network,
      },
    });
  };

  /** Every sentence the board offers as a reason to leave something out. */
  const skipReasons = (built: ReturnType<typeof buildDiscoveryBoard>): string[] =>
    built.candidates
      .map((candidate) => candidate.quality?.reason ?? '')
      .filter((reason) => reason.length > 0);

  it('names our own gap, never the traveller’s answer, when a ride is what they would take', () => {
    const reasons = skipReasons(boardForCarFreeTraveller('observed'));
    expect(reasons.length).toBeGreaterThan(0);

    const blamesTheTraveller = reasons.filter((reason) => /you said you would go/.test(reason));
    expect(
      blamesTheTraveller,
      'a walking clock and "you said" were quoted for a journey nobody could price',
    ).toEqual([]);
  });

  it('still quotes the distance where the walk really is the journey', () => {
    /*
     * The control, and the reason this cannot be fixed by deleting the sentence:
     * where no scheduled network was observed, a long walk is exactly what the
     * traveller would have to do, and saying so is the honest and useful answer.
     */
    const reasons = skipReasons(boardForCarFreeTraveller('not_observed'));
    const quotesTheDistance = reasons.some((reason) => /past how far you said you would go/.test(reason));
    expect(
      quotesTheDistance,
      'the honest distance refusal disappeared along with the dishonest one',
    ).toBe(true);
  });
});

/**
 * §6 / GROUP H — A CARD GOES UNDER THE HEADING THAT DESCRIBES ITS REASON.
 *
 * ---
 *
 * **The live evidence class.** The board's `weak_fit` group is captioned
 * "Probably skip · Popular or nearby, but a poor match for this trip", and the
 * packet renders the same set under "Worth skipping · Popular or nearby, and
 * still a poor match for how you said you travel." The grouping rule sent every
 * `insufficient_evidence` card there, and every card refused over a journey
 * nobody could price, while routing only `low_confidence` to the verification
 * heading — so a heading asserting a personal-fit verdict stood over sentences
 * that say we did not check. `board.ts` named that distinction in its own
 * comment ("statements about *our* knowledge rather than about the place, and a
 * traveller acts on them differently") and then did not apply it.
 *
 * **What this drives.** `buildDiscoveryBoard` in the same car-free
 * configuration as the tests above — the one that produces unpriced journeys —
 * and asserts on `candidate.group`, which is what the discover page reads to
 * decide which heading a card renders under.
 */
describe('an evidence gap is not filed under a fit verdict', () => {
  const board = () => {
    const input = transitCityBoardInput(transitCityTraveler());
    return buildDiscoveryBoard({
      ...input,
      travel: {
        ...input.travel,
        transit: { journeys: [], requested: 0, measured: 0, absence: 'unsupported' as const },
        scheduledNetwork: 'observed' as const,
      },
    });
  };

  it('never puts a “we could not check” sentence under the probably-skip heading', () => {
    const built = board();
    const misfiled = built.candidates.filter(
      (candidate) =>
        candidate.quality.reasonBasis === 'evidence_gap' &&
        candidate.group === 'weak_fit',
    );
    expect(
      misfiled.map((candidate) => `${candidate.place.name}: ${candidate.quality.reason}`),
      'a data-gap sentence rendered under a heading claiming a personal-fit verdict',
    ).toEqual([]);
  });

  it('sends it to the verification heading instead, rather than dropping it', () => {
    const built = board();
    const gaps = built.candidates.filter(
      (candidate) => candidate.quality.reasonBasis === 'evidence_gap',
    );
    for (const candidate of gaps) {
      expect(candidate.group, candidate.place.name).toBe('needs_verification');
    }
  });

  /**
   * The other direction, so the routing cannot be satisfied by moving
   * everything. A card the fit model genuinely weighed and rejected still says
   * so, under the heading that makes that claim.
   */
  it('leaves a genuine fit refusal where the traveller can read it as one', () => {
    const built = board();
    const judged = built.candidates.filter(
      (candidate) =>
        candidate.quality.reasonBasis === 'fit_judgement' &&
        candidate.group === 'weak_fit',
    );
    for (const candidate of judged) {
      expect(candidate.quality.reason, candidate.place.name).not.toMatch(/could not/);
    }
  });
});
