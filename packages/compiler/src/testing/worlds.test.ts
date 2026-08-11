import { describe, expect, it } from 'vitest';
import { SYNTHETIC_WORLDS } from './fakes';

/**
 * Every synthetic world must be reachable from something that renders.
 *
 * Three of the eight — the broad country, the rail corridor and the weak-data
 * valley — existed for months with no entry in the fixture destination table, so
 * nothing that draws a page ever loaded them. They were exercised by unit tests
 * and by nothing else, which is not what a fixture world is for: the whole point
 * of `broad_country` is the multi-base hotel-move path, and that path lives in
 * the interface.
 *
 * This test cannot import the web app's table — the packages do not depend that
 * way round — so it asserts the invariant from this side: the list of worlds a
 * browser test can reach is declared here, beside the worlds themselves, and the
 * web app's own test asserts its table matches.
 */
export const BROWSER_REACHABLE_WORLDS = [
  'transit_city',
  'ferry_island',
  'remote_road',
  'unreachable_region',
  'unplannable_region',
  'broad_country',
  'rail_corridor',
  'weak_data',
  'transit_metro',
  'transit_mixed',
  'recovery_adversary',
  'unclocked_valley',
] as const;

describe('synthetic worlds', () => {
  it('are all declared reachable from the interface', () => {
    expect([...BROWSER_REACHABLE_WORLDS].sort()).toEqual(Object.keys(SYNTHETIC_WORLDS).sort());
  });

  it('cover the five destination classes the release has to handle', () => {
    /**
     * Named as classes rather than as places. Each is a shape the engine has to
     * get right, and each has at least one world standing for it.
     */
    const classes: Record<string, keyof typeof SYNTHETIC_WORLDS> = {
      'major transit metropolis': 'transit_city',
      'weak-data island / archipelago': 'ferry_island',
      'road and satellite region': 'remote_road',
      'broad regional destination': 'broad_country',
      'multi-base rail corridor': 'rail_corridor',
      'thin evidence': 'weak_data',
      /*
       * Two classes this suite could not express before. The first is the only
       * world in which anything can measure a public-transport journey; the
       * second is the only one deliberately deficient enough for the recovery
       * loop to have something to do.
       */
      'measured public transport': 'transit_metro',
      /*
       * A day that no single network can answer. Distinct from the world above,
       * which proves a journey can be measured at all: this one proves the
       * planner picks between two measurements that disagree about the same day.
       */
      'a day that needs more than one mode': 'transit_mixed',
      'a packet that is not good enough': 'recovery_adversary',
      'a destination nobody published a clock for': 'unclocked_valley',
    };
    for (const [label, world] of Object.entries(classes)) {
      expect(SYNTHETIC_WORLDS[world], `${label} has no world`).toBeDefined();
    }
  });
});
