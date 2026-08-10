import type { CompiledRegion } from '@sidequest/core';
import { SYNTHETIC_WORLDS } from './fakes';

/**
 * WHICH WORLD DID THIS TEST ACTUALLY GET?
 *
 * A verification audit found the same defect in two places, and it is the one
 * that makes a test suite worse than useless rather than merely incomplete: a
 * test that names a fixture, asserts something true of every fixture, and
 * reports coverage it does not have.
 *
 * Concretely — the browser suite typed `'Outer Isles'` and asserted only that a
 * readiness level rendered; the compiler suite pinned `ferry_island` and
 * asserted only that a count matched its own list. And the app's fixture
 * resolver has **three** silent `?? transit_city` fallbacks, so a query that
 * matches nothing quietly becomes a plausible-looking metro. Two specifications
 * believed they were exercising a ferry archipelago and were exercising a city.
 *
 * `expectWorld` is the assertion those tests were missing, and it checks two
 * things rather than one because one is not enough:
 *
 * 1. **The scope names the world.** Cheap, and catches the resolver falling back.
 * 2. **The places came from the same world.** The scope and the provider set are
 *    chosen separately, so an artifact can report one world's identity while
 *    holding another world's records. Nothing anywhere caught that pairing.
 *
 * Deliberately not a matcher registration: a plain function that throws is
 * importable from the browser suite's helpers as easily as from a unit test,
 * and needs no vitest globals.
 */
export function expectWorld(
  region: Pick<CompiledRegion, 'region' | 'scope' | 'places'>,
  key: keyof typeof SYNTHETIC_WORLDS,
): void {
  const spec = SYNTHETIC_WORLDS[key];
  if (!spec) {
    throw new Error(`expectWorld: there is no synthetic world called ${String(key)}.`);
  }

  if (region.scope.destinationCandidateId !== spec.id) {
    throw new Error(
      `expectWorld: expected the ${String(key)} world (${spec.id}) but the scope says ` +
        `${region.scope.destinationCandidateId}. A fixture resolver fell back, or the test ` +
        `named a destination string nothing maps.`,
    );
  }

  /*
   * The *region's* id, not the artifact's.
   *
   * `CompiledRegion.id` is the compilation id — a fact about the run, chosen by
   * the caller, and therefore useless as an identity check. `region.region.id`
   * is derived from the scope's candidate, and it is what every place is
   * stamped with, which is what makes the two comparable at all.
   */
  const expectedRegionId = `compiled-${spec.id}`;
  if (region.region.id !== expectedRegionId) {
    throw new Error(
      `expectWorld: the scope says ${spec.id} but the region is ${region.region.id}. ` +
        `The scope and the provider set disagree about which world this is.`,
    );
  }

  /*
   * Every place has to belong to the region claiming them.
   *
   * This is the check that catches the pairing failure, and it is worth the
   * loop: a region whose identity is right and whose contents came from
   * somewhere else is exactly the artifact a scope-only assertion passes.
   */
  const foreign = region.places.filter((place) => place.regionId !== expectedRegionId);
  if (foreign.length > 0) {
    throw new Error(
      `expectWorld: ${foreign.length} of ${region.places.length} places belong to another ` +
        `region (first: ${foreign[0]!.regionId}). The scope and the providers disagree.`,
    );
  }
}
