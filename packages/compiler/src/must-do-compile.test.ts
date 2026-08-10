import { describe, expect, it } from 'vitest';
import {
  CLARIFICATION_SET_VERSION,
  mayShowDiscoveryBoard,
  normalizeDestinationQuery,
  type ClarificationSet,
  type MustDoRequest,
} from '@sidequest/core';
import { compileRegion } from './compile';
import { deriveScope } from './scope';
import { SYNTHETIC_WORLDS, syntheticCandidate } from './testing/fakes';
import { packBackedProviders, syntheticPack } from './testing/pack-fakes';

/**
 * THE WHOLE PIPELINE, ASKED THE ONE QUESTION THAT MATTERS.
 *
 * The resolver has its own unit tests over hand-made records. These drive the
 * *compiler* — pack, overlay, inventory, evidence, routing and readiness — and
 * assert that a name somebody typed at the very front survives all of it and
 * comes out the other end with a status on the artifact.
 *
 * Every case names the synthetic world it uses and asserts something specific
 * about that world's own records, so a specification can never quietly pass
 * against the wrong fixture.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
const MONTHS = [8];

function scopeFor(worldKey: keyof typeof SYNTHETIC_WORLDS) {
  const spec = SYNTHETIC_WORLDS[worldKey]!;
  const clarifications: ClarificationSet = {
    schemaVersion: CLARIFICATION_SET_VERSION,
    questions: [],
    answers: [],
  };
  const candidate = syntheticCandidate(spec);
  void normalizeDestinationQuery(spec.name);
  const scope = deriveScope({ candidate, clarifications, nights: 4, revision: 1 });
  return { ...scope, confirmedByUser: true };
}

function named(quote: string, index = 0): MustDoRequest {
  return {
    id: `mustdo:span:${index}`,
    kind: 'named_subject',
    source: 'composer_text',
    quote,
    span: [index, index + quote.length],
    namedExplicitly: true,
  };
}

async function compileWith(
  worldKey: keyof typeof SYNTHETIC_WORLDS,
  mustDo: readonly MustDoRequest[],
  decisions: Parameters<typeof compileRegion>[0]['mustDoDecisions'] = undefined,
) {
  const spec = SYNTHETIC_WORLDS[worldKey]!;
  const result = await compileRegion({
    compilationId: `must-do-${worldKey}`,
    scope: scopeFor(worldKey),
    dates: DATES,
    months: MONTHS,
    providers: packBackedProviders(spec),
    now: NOW,
    mustDo,
    ...(decisions ? { mustDoDecisions: decisions } : {}),
  });
  if (!result.ok) throw new Error(`compilation failed: ${result.message}`);
  return result;
}

describe('a name typed into the composer, carried through a whole compilation', () => {
  it('comes out covered when the region actually holds it', async () => {
    const result = await compileWith('transit_city', []);
    /*
     * Asserted before it is used. A specification that asked about a place name
     * the fixture does not produce would pass vacuously on the negative case and
     * silently stop testing anything on the positive one.
     */
    const target = result.region.places[0];
    expect(target, 'the transit city fixture should produce places').toBeDefined();

    const withMustDo = await compileWith('transit_city', [named(target!.name)]);
    const coverage = withMustDo.region.mustDoCoverage;
    expect(coverage, 'the artifact should carry a coverage record').toBeDefined();
    expect(coverage!.resolutions).toHaveLength(1);
    expect(coverage!.resolutions[0]!.status).toBe('covered');
    expect(coverage!.resolutions[0]!.match?.id).toBe(target!.id);

    // And the reading agrees: nothing named is outstanding.
    const dimension = withMustDo.region.researchReadiness?.dimensions.find(
      (entry) => entry.dimension === 'must_do_coverage',
    );
    expect(dimension?.state).toBe('met');
  });

  it('says so, and does not withhold the board, when it holds nothing of the name', async () => {
    const result = await compileWith('transit_city', [named('Bellweather Observatory')]);
    const coverage = result.region.mustDoCoverage;
    expect(coverage!.resolutions[0]!.status).toBe('not_found');

    const readiness = result.region.researchReadiness;
    expect(readiness, 'the artifact should carry a reading').toBeDefined();
    expect(readiness!.dimensions.find((e) => e.dimension === 'must_do_coverage')?.state).toBe(
      'unmet',
    );
    /*
     * The rule that keeps one unfound request from replacing a good trip with no
     * trip. `blocked` withholds the Discovery Board entirely, and a name we could
     * not find says nothing about whether the other places are real.
     */
    expect(readiness!.level).not.toBe('blocked');
  });

  /**
   * THE SECOND LOOK, AND WHAT IT COSTS WHEN IT FAILS.
   *
   * A name nothing answers to makes the reading `recoverable`, which is a promise
   * to go back for more. The loop goes back — it reads the whole map layer rather
   * than only what survived admission — finds nothing, and the reading must stop
   * promising. `recoverable` after the loop has run and returned empty-handed is
   * the one sentence on that panel a traveller cannot check for themselves.
   */
  it('goes back for it once, records the attempt, and stops promising when it fails', async () => {
    const result = await compileWith('transit_city', [named('Bellweather Observatory')]);
    const readiness = result.region.researchReadiness!;
    const attempt = readiness.repairsAttempted.find(
      (entry) => entry.repair === 'targeted_subject_query',
    );
    expect(attempt, 'the targeted second look should have been attempted').toBeDefined();
    expect(attempt!.outcome).toBe('no_change');
    expect(readiness.level).not.toBe('recoverable');
    expect(readiness.repairs).not.toContain('targeted_subject_query');
  });

  /**
   * The same loop, on a name the ground *does* hold outside what survived
   * admission. The repair changes the answer from "we could not find it" to
   * something evidenced — which is a resolution, and is the only kind this
   * repair may produce. It must never manufacture an inclusion: the matrix, the
   * hours and the access rules were bought for the set that survived, and a
   * record added after them would be a card with no travel time.
   */
  it('turns an unexplained miss into an evidenced answer when the map layer holds it', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const plain = await compileWith('transit_city', []);
    const onTheBoard = new Set(plain.region.places.map((place) => place.name));
    const pack = syntheticPack(spec, scopeFor('transit_city'));
    const groundOnly = pack.layers
      .flatMap((layer) => layer.records)
      .map((record) => record.name)
      .find((name) => !onTheBoard.has(name));

    /*
     * Asserted before it is used, and this one has teeth: if the fixture ever
     * admits every record it publishes, the case below would be testing the
     * covered path while claiming to test the repair.
     */
    expect(groundOnly, 'the fixture should publish a record the board does not carry').toBeDefined();

    const result = await compileWith('transit_city', [named(groundOnly!)]);
    const resolution = result.region.mustDoCoverage!.resolutions[0]!;

    // The first pass could not account for it, so the loop went back.
    const attempt = result.region.researchReadiness!.repairsAttempted.find(
      (entry) => entry.repair === 'targeted_subject_query',
    );
    expect(attempt, 'the miss should have triggered the targeted second look').toBeDefined();
    expect(attempt!.outcome).toBe('improved');

    // And the answer it produced is evidenced rather than manufactured.
    expect(resolution.status).not.toBe('not_found');
    expect(resolution.status).not.toBe('covered');
    expect(resolution.match?.name).toBe(groundOnly);

    /*
     * The board is not quietly larger for it. A repair that widened the plan
     * after the matrix, the hours and the access rules were bought would be
     * adding a card with no travel time and no opening hours.
     */
    expect(result.region.places.map((place) => place.id).sort()).toEqual(
      plain.region.places.map((place) => place.id).sort(),
    );
  });

  /**
   * THE SECOND LOOK MAY ONLY IMPROVE AN ANSWER.
   *
   * The widened pass re-resolves every request against a much larger subject
   * set, and a larger set can change an earlier answer: distinctiveness is
   * counted over the names in play, so a one-word name that identified one place
   * among the plannable set can stop identifying anything once the whole map
   * layer joins it. A repair that turned a `covered` request into `not_found`
   * would be a second look that lost something.
   */
  it('never un-answers a request that the first pass had already accounted for', async () => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    const plain = await compileWith('transit_city', []);
    const found = plain.region.places[0]!;
    const onTheBoard = new Set(plain.region.places.map((place) => place.name));
    const missing = syntheticPack(spec, scopeFor('transit_city'))
      .layers.flatMap((layer) => layer.records)
      .map((record) => record.name)
      .find((name) => !onTheBoard.has(name));
    expect(missing, 'the fixture should publish a record the board does not carry').toBeDefined();

    // One request the first pass answers, and one it cannot — so the loop runs.
    const result = await compileWith('transit_city', [named(found.name, 0), named(missing!, 40)]);
    const byQuote = new Map(
      result.region.mustDoCoverage!.resolutions.map((entry) => [entry.request.quote, entry]),
    );
    expect(
      result.region.researchReadiness!.repairsAttempted.some(
        (entry) => entry.repair === 'targeted_subject_query',
      ),
      'the miss should have triggered the second look',
    ).toBe(true);
    expect(byQuote.get(found.name)?.status).toBe('covered');
  });

  it('honours a withdrawal without pretending the place was found', async () => {
    const result = await compileWith('transit_city', [named('Bellweather Observatory')], [
      { requestId: 'mustdo:span:0', kind: 'withdrawn', decidedAt: '2026-08-11T00:00:00Z' },
    ]);
    const resolution = result.region.mustDoCoverage!.resolutions[0]!;
    expect(resolution.status).toBe('withdrawn');
    expect(resolution.match).toBeUndefined();
    expect(
      result.region.researchReadiness!.dimensions.find(
        (entry) => entry.dimension === 'must_do_coverage',
      )?.state,
    ).toBe('met');
  });

  it('says nothing at all about must-dos when nobody named one', async () => {
    const result = await compileWith('transit_city', []);
    expect(result.region.mustDoCoverage).toBeUndefined();
    expect(
      result.region.researchReadiness!.dimensions.find(
        (entry) => entry.dimension === 'must_do_coverage',
      )?.state,
    ).toBe('not_applicable');
  });

  /**
   * A thin world, because the interesting interaction is with a destination that
   * has real deficits of its own: a named request must not be able to make an
   * already-weak reading claim a repair it cannot perform, and must not be
   * drowned out by the other deficits either.
   */
  it('reports a named request on a thin destination without disturbing its other findings', async () => {
    const plain = await compileWith('weak_data', []);
    const withMustDo = await compileWith('weak_data', [named('Bellweather Observatory')]);

    const before = plain.region.researchReadiness!;
    const after = withMustDo.region.researchReadiness!;
    expect(withMustDo.region.mustDoCoverage!.resolutions[0]!.status).toBe('not_found');
    // Every deficit the destination had on its own is still reported.
    for (const dimension of before.binding) {
      expect(after.binding).toContain(dimension);
    }
    expect(after.level).not.toBe('blocked');
  });
});

/**
 * EVERY SHAPE OF DESTINATION THE PRODUCT CLAIMS TO HANDLE.
 *
 * A dense transit city, an archipelago with ferry-dependent satellites, a remote
 * road region, a broad country, a multi-base rail corridor and a region almost
 * nobody publishes about. The rule under test is the same for all six and is the
 * one a release turns on: whatever the destination, a name somebody typed comes
 * back with a truthful status, and failing to find it never withholds the board.
 *
 * Driven by the world table rather than by a written list, so a world added later
 * is covered on the day it is added rather than on the day somebody remembers.
 */
describe('across every destination shape', () => {
  const WORLDS = [
    'transit_city',
    'ferry_island',
    'remote_road',
    'broad_country',
    'rail_corridor',
    'weak_data',
  ] as const;

  for (const key of WORLDS) {
    it(`${key}: reports a name it does not hold, and still shows the board`, async () => {
      const result = await compileWith(key, [named('Bellweather Observatory')]);
      // The world is the one this case names, so a fixture rename fails loudly.
      expect(result.region.scope.destinationName).toBe(SYNTHETIC_WORLDS[key]!.name);

      const coverage = result.region.mustDoCoverage;
      expect(coverage, 'the artifact should carry a coverage record').toBeDefined();
      expect(coverage!.resolutions).toHaveLength(1);
      expect(coverage!.resolutions[0]!.status).toBe('not_found');
      expect(coverage!.resolutions[0]!.match).toBeUndefined();

      const readiness = result.region.researchReadiness!;
      expect(readiness.dimensions.find((e) => e.dimension === 'must_do_coverage')?.state).toBe(
        'unmet',
      );
      expect(mayShowDiscoveryBoard(readiness)).toBe(true);
    });

    it(`${key}: covers a place it does hold, and marks it accounted for`, async () => {
      const plain = await compileWith(key, []);
      const target = plain.region.places[0];
      expect(target, `${key} should compile at least one place`).toBeDefined();

      const result = await compileWith(key, [named(target!.name)]);
      const resolution = result.region.mustDoCoverage!.resolutions[0]!;
      expect(resolution.status).toBe('covered');
      expect(resolution.match?.id).toBe(target!.id);
      expect(
        result.region.researchReadiness!.dimensions.find(
          (entry) => entry.dimension === 'must_do_coverage',
        )?.state,
      ).toBe('met');
    });
  }
});
