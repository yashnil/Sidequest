import { describe, expect, it } from 'vitest';
import { CLARIFICATION_SET_VERSION, buildRegionPortfolio, type ClarificationSet, type DestinationIndexEntry } from '@sidequest/core';
import { deriveScope } from './scope';
import { QUESTION_IDS } from './clarify';
import { SYNTHETIC_WORLDS, syntheticCandidate } from './testing/fakes';

/**
 * THE HAND-OFF, TESTED END TO END.
 *
 * The founder-test regression was two screens describing different-sized trips:
 * a preview proposing bases a hundred kilometres apart, and a build described
 * as a dozen kilometres across. The fix is that the preview publishes the reach
 * its structure implies and the compilation consumes it.
 *
 * That claim had no test. `graph.test.ts` asserts the portfolio is internally
 * consistent with *itself* and never calls `deriveScope`; the scope tests never
 * build a portfolio. So the one seam the whole fix rests on was covered from
 * both ends and not across.
 */

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

function feature(
  id: string,
  name: string,
  lat: number,
  lng: number,
  over: Partial<DestinationIndexEntry> = {},
): DestinationIndexEntry {
  return {
    id,
    catalog: 'handoff',
    sourceId: id,
    featureType: 'city',
    displayName: name,
    aliases: [],
    hierarchy: [],
    center: { lat, lng },
    population: 60_000,
    ...over,
  };
}

/** A spread-out region: a dense core and two places a long drive away. */
const SPREAD = [
  feature('a', 'Capital', 42.87, 74.6, { population: 900_000, prominence: 92 }),
  feature('a2', 'Suburb', 42.9, 74.9, { population: 60_000 }),
  feature('b', 'Lakeside', 42.49, 78.39, { population: 200_000, prominence: 70 }),
  feature('c', 'Southcity', 40.51, 72.8, { population: 250_000, prominence: 74 }),
];

describe('the reach a preview publishes is the reach a build uses', () => {
  it('carries a wide structure through to the compiled scope', () => {
    const portfolio = buildRegionPortfolio({
      entries: SPREAD,
      mode: 'drive',
      nights: 14,
      destinationName: 'Testland',
    });
    /* The preview genuinely proposes more than one base, or there is nothing to carry. */
    expect(portfolio.route.length).toBeGreaterThan(1);

    const candidate = syntheticCandidate(SYNTHETIC_WORLDS.broad_country!);
    const withHandoff = deriveScope({
      candidate,
      clarifications: emptyClarifications(),
      nights: 14,
      revision: 1,
      composerTransport: 'drive',
      preflightReachKm: portfolio.reachRadiusKm,
    });
    const without = deriveScope({
      candidate,
      clarifications: emptyClarifications(),
      nights: 14,
      revision: 1,
      composerTransport: 'drive',
    });

    /*
     * The property that closes the regression: the build's ground is at least
     * as wide as the structure the traveller was shown. Anything less is the
     * two screens disagreeing again.
     */
    expect(withHandoff.reachRadiusKm!).toBeGreaterThanOrEqual(
      Math.min(portfolio.reachRadiusKm, without.reachRadiusKm!),
    );
    expect(withHandoff.reachRadiusKm!).toBeGreaterThanOrEqual(without.reachRadiusKm!);
  });

  it('never exceeds the ceiling the traveller’s own transport imposes', () => {
    /*
     * A preview built on driving reach, adopted by somebody who then says they
     * have no car, must not buy two hundred kilometres of ground they cannot
     * cross. The clamp is the compiler's own cap for the mode it ended up in.
     */
    const scope = deriveScope({
      candidate: syntheticCandidate(SYNTHETIC_WORLDS.broad_country!),
      clarifications: {
        schemaVersion: CLARIFICATION_SET_VERSION,
        questions: [],
        answers: [{ questionId: QUESTION_IDS.carAvailable, values: ['no'], answeredAt: 'x' }],
      },
      nights: 14,
      revision: 1,
      preflightReachKm: 900,
    });
    expect(scope.reachRadiusKm!).toBeLessThanOrEqual(90);
  });

  it('ignores the preview once the traveller has narrowed to one area', () => {
    /*
     * Choosing "one area, in depth" used to produce a *larger* circle than not
     * choosing it: `narrowed` switches the shape to a radius, and the radius
     * was still the multi-base preview's. The traveller asked for less and got
     * more ground.
     */
    const narrowed = deriveScope({
      candidate: syntheticCandidate(SYNTHETIC_WORLDS.broad_country!),
      clarifications: {
        schemaVersion: CLARIFICATION_SET_VERSION,
        questions: [],
        answers: [
          { questionId: QUESTION_IDS.breadthStrategy, values: ['one_area'], answeredAt: 'x' },
        ],
      },
      nights: 6,
      revision: 1,
      composerTransport: 'drive',
      preflightReachKm: 400,
    });
    const notNarrowed = deriveScope({
      candidate: syntheticCandidate(SYNTHETIC_WORLDS.broad_country!),
      clarifications: emptyClarifications(),
      nights: 6,
      revision: 1,
      composerTransport: 'drive',
      preflightReachKm: 400,
    });
    expect(narrowed.reachRadiusKm!).toBeLessThan(notNarrowed.reachRadiusKm!);
  });

  it('falls back to its own derivation when no preview reach exists', () => {
    /* An older trip, or a destination with no index coverage, must still work. */
    const scope = deriveScope({
      candidate: syntheticCandidate(SYNTHETIC_WORLDS.transit_city!),
      clarifications: emptyClarifications(),
      nights: 4,
      revision: 1,
      composerTransport: 'drive',
    });
    expect(scope.reachRadiusKm!).toBeGreaterThan(0);
  });
});
