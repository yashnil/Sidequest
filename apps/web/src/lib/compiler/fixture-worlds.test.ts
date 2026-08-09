import { describe, expect, it } from 'vitest';
import { SYNTHETIC_WORLDS } from '@sidequest/compiler/testing';
import { fixtureWorldsFor } from './providers';

/**
 * The other half of the world-reachability invariant.
 *
 * `packages/compiler` declares which worlds exist. This asserts that the fixture
 * destination table can actually reach each of them — that there is a name a
 * browser test can type which loads that world and not the default.
 *
 * The failure this prevents already happened twice. Three worlds had no entry at
 * all, so the multi-base and weak-data shapes were never rendered by anything.
 * And two specifications typed "Ferry Island", which matched no entry, fell
 * through to the default, and exercised a dense transit city while their names
 * and comments said otherwise. Both are silent: a test against the wrong fixture
 * passes, and reports coverage nobody has.
 */

/** A name a traveller could type, per world. Kept beside the assertion. */
const NAME_FOR_WORLD: Record<keyof typeof SYNTHETIC_WORLDS, string> = {
  transit_city: 'Harbour City',
  ferry_island: 'Outer Isles',
  remote_road: 'Outer Isles',
  unreachable_region: 'Faraway Reaches',
  unplannable_region: 'Longday Basin',
  broad_country: 'Wide Republic',
  rail_corridor: 'The Northern Line',
  weak_data: 'Little-Known Valley',
};

describe('the fixture destination table', () => {
  it.each(Object.keys(SYNTHETIC_WORLDS) as (keyof typeof SYNTHETIC_WORLDS)[])(
    'can reach %s from a name a test can type',
    (world) => {
      const name = NAME_FOR_WORLD[world];
      expect(name, `${world} has no typeable name`).toBeDefined();
      expect(fixtureWorldsFor(name!)).toContain(world);
    },
  );

  it('does not silently fall through to the metro for an unmatched ferry name', () => {
    /**
     * The exact regression. "Ferry Island" contains no entry's substring, so it
     * resolved to `transit_city` — and two specs believed otherwise for months.
     * The assertion is that the *correct* name reaches the ferry world; a name
     * that matches nothing still defaults, which is fine as long as no test
     * relies on it.
     */
    expect(fixtureWorldsFor('Outer Isles')).toContain('ferry_island');
    expect(fixtureWorldsFor('Outer Isles')).not.toEqual(['transit_city']);
  });

  it('prefers the most specific entry when several match', () => {
    expect(fixtureWorldsFor('Wide Republic')).toEqual(['broad_country']);
    expect(fixtureWorldsFor('The Northern Line')).toEqual(['rail_corridor']);
  });
});
