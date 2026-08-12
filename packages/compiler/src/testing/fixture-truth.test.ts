import { describe, expect, it } from 'vitest';
import { deriveScope } from '../scope';
import { SYNTHETIC_WORLDS, fakeProviders, syntheticCandidate, syntheticPlace } from './fakes';
import { packBackedProviders } from './pack-fakes';
import { CLARIFICATION_SET_VERSION, type ClarificationSet } from '@sidequest/core';

/**
 * THE FIXTURES ARE HELD TO THE SAME TRUTH THE PRODUCT IS.
 *
 * Two defects, both found only when the plan validator started checking a
 * leg's own arithmetic against what its mode can physically do, and both of
 * them *in the test doubles*:
 *
 *  1. `fakeProviders().routing` derived every distance as `minutes * 0.9` —
 *     54 km/h — whatever mode was asked for. A foot matrix therefore claimed
 *     13.5 km walks in a quarter of an hour.
 *  2. `packBackedProviders().constraints` published `approachMinutes: 10` for
 *     every place in a walk-shaped world. That is the exact constant
 *     `accessRuleSchema` records as "the product's worst factual defect" — a
 *     live provider with no source writing ten minutes for every place on
 *     earth — reproduced by the fixture that is supposed to help catch it.
 *
 * Both were invisible while nothing compared a duration with a distance, and
 * both then made real suites fail for reasons that were about the apparatus.
 * A fixture that states something impossible cannot prove anything about the
 * code that consumes it, so the invariants are asserted here, at the source.
 *
 * Nothing below names a destination: every case is built from a synthetic
 * world, which is a shape rather than a place.
 */

const CLARIFICATIONS: ClarificationSet = {
  schemaVersion: CLARIFICATION_SET_VERSION,
  questions: [],
  answers: [],
};

/** Generous ceilings — the point is "possible at all", not "typical". */
const CEILING_KMH: Record<string, number> = { foot: 6, car: 110 };

const POINTS = Array.from({ length: 6 }, (_, index) => ({
  id: `p${index}`,
  lat: 38.72 + index * 0.01,
  lng: -9.14 + index * 0.01,
}));

describe('the synthetic routing matrix states possible speeds', () => {
  for (const mode of ['foot', 'car'] as const) {
    it(`keeps every ${mode} pair under what the mode can do`, async () => {
      const providers = fakeProviders(SYNTHETIC_WORLDS.transit_city!);
      const matrix = await providers.routing.matrix({
        points: POINTS,
        mode,
        maxElements: 400,
      });

      let checked = 0;
      matrix.minutes.forEach((row, i) => {
        row.forEach((minutes, j) => {
          if (i === j || minutes <= 0) return;
          const km = matrix.km?.[i]?.[j] ?? 0;
          if (km <= 0) return;
          checked += 1;
          const kmh = (km / minutes) * 60;
          expect(
            kmh,
            `${mode} pair ${i}→${j}: ${km} km in ${minutes} min is ${Math.round(kmh)} km/h`,
          ).toBeLessThanOrEqual(CEILING_KMH[mode]!);
        });
      });
      // A vacuous pass is the failure mode this guard exists for.
      expect(checked).toBeGreaterThan(10);
    });
  }

  it('still separates the two networks: walking a pair is slower than driving it', async () => {
    const providers = fakeProviders(SYNTHETIC_WORLDS.transit_city!);
    const foot = await providers.routing.matrix({ points: POINTS, mode: 'foot', maxElements: 400 });
    const car = await providers.routing.matrix({ points: POINTS, mode: 'car', maxElements: 400 });
    /*
     * The durations are deliberately the same in this fixture — it models
     * geometry, not two networks — so what must differ is the distance the
     * same duration is allowed to cover.
     */
    expect(foot.km?.[0]?.[1]).toBeLessThan(car.km?.[0]?.[1] ?? 0);
  });
});

describe('the synthetic access rules describe the trip’s own mode', () => {
  const scopeFor = (world: keyof typeof SYNTHETIC_WORLDS, composerTransport?: string) =>
    deriveScope({
      candidate: syntheticCandidate(SYNTHETIC_WORLDS[world]!),
      clarifications: CLARIFICATIONS,
      nights: 3,
      revision: 1,
      ...(composerTransport ? { composerTransport } : {}),
    });

  const rulesFor = async (world: keyof typeof SYNTHETIC_WORLDS, composerTransport?: string) => {
    const spec = SYNTHETIC_WORLDS[world]!;
    const scope = scopeFor(world, composerTransport);
    /*
     * The research provider is asked directly, with places from the same
     * generator the pack path produces. Going through the backbone first would
     * test acquisition, which is not what is on trial here.
     */
    const places = Array.from({ length: 8 }, (_, index) => syntheticPlace(spec, index));
    const result = await packBackedProviders(spec).constraints.research({
      scope,
      places,
      dates: ['2027-05-18'],
      maxSubjects: places.length,
    });
    return result.accessRules;
  };

  it('never authors the banned ten-minute walking allowance', async () => {
    const rules = await rulesFor('transit_city', 'public_transport');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      if (rule.approachMode === 'drive') continue;
      /*
       * `null` is the schema's way of saying "no source". A number here is a
       * fixture inventing a duration, which is the defect, not the control.
       */
      expect(rule.approachMinutes, `${rule.label} authored an allowance`).toBeNull();
    }
  });

  it('gives a car-free trip a walking approach the matrix will be able to measure', async () => {
    const rules = await rulesFor('transit_city', 'public_transport');
    expect(rules.some((rule) => rule.approachMode === 'walk')).toBe(true);
  });

  it('gives a driving trip a driving approach, whatever shape the world is', async () => {
    /*
     * The mismatch that produced the defect: a pedestrian world researched for
     * a traveller who drives. The compiler buys a road matrix for that trip, so
     * a walking approach rule would be unmeasurable and the planner would have
     * nothing but an authored constant to schedule from.
     */
    const rules = await rulesFor('transit_city', 'drive');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.approachMode, `${rule.label} is not on the trip's own network`).toBe('drive');
    }
  });
});
