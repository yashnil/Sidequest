import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { deriveModelledWalk as deriveWithinAccessCap, MODELLED_WALK_KMH } from '@sidequest/core';
import { deriveModelledWalk } from './modelled-walk';
import type { TravelKnowledge } from './travel';

/**
 * ONE DERIVATION OF THE MODELLED WALK, TWO DELIBERATELY DIFFERENT CAPS.
 *
 * The road-distance-to-walk repair was grown in the planner and then moved into
 * `@sidequest/core` so the Discovery Board could read the same answer — a board
 * that called a 1.2 km stop a transport conflict while the planner walked to it
 * is the defect that move exists to end. The planner kept its copy afterwards.
 * Both said 4.5 km/h, so nothing failed, and that is the state worth testing:
 * two definitions that agree today are one edit from a board and a plan
 * disagreeing about whether the same stop is reachable.
 *
 * What is *not* shared is the ceiling, and that is on purpose. Core caps a
 * derived walk at the furthest the traveller said they would walk to reach a
 * place, which is the right limit for "is there a way in at all". The planner
 * caps it at their detour tolerance, which is the right limit for a leg taken
 * mid-day between two stops they have already accepted. Collapsing the two
 * would be the tempting simplification, so it is the second thing asserted
 * here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');
const SEARCHED = [
  join(REPO, 'packages/core/src'),
  join(REPO, 'packages/planner/src'),
  join(REPO, 'packages/geo/src'),
  join(REPO, 'apps/web/src'),
];

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(path) && !path.includes('.test.')) out.push(path);
  }
  return out;
}

/** The road distance the fixture uses, and the walk it derives to. */
const ROAD_KM = 1.2;
const DERIVED_MINUTES = Math.ceil((ROAD_KM * 60) / MODELLED_WALK_KMH);

function roadKnowledge(maxWalkMinutes: number): TravelKnowledge {
  const ids = ['base', 'stop'];
  const matrix: TravelTimeMatrix = {
    mode: 'car',
    ids,
    minutes: [
      [0, 5],
      [5, 0],
    ],
    km: [
      [0, ROAD_KM],
      [ROAD_KM, 0],
    ],
    provenance: { kind: 'measured', note: 'Test road network.' },
  };
  return {
    matrix,
    transit: null,
    /* No car: the road matrix can offer nothing, which is what sends the pair to the derivation. */
    permitted: new Set(['walk']),
    maxWalkMinutes,
    maxDailyDriveMinutes: 0,
    maxDailyTransportMinutes: 240,
    journeys: new Map(),
  };
}

describe('the modelled walk has one definition', () => {
  it('declares the walking pace in exactly one module', () => {
    const declaring = SEARCHED.flatMap((dir) => sources(dir))
      .filter((path) => /(export\s+)?const\s+MODELLED_WALK_KMH\s*=/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(REPO, path))
      .sort();
    /*
     * Named rather than counted, so a second declaration fails with its own
     * address in the message instead of "expected 2 to be 1".
     */
    expect(declaring).toEqual(['packages/core/src/travel/reach.ts']);
  });

  it('keeps the planner on its own cap rather than core’s access cap', () => {
    /*
     * The pair is 16 modelled minutes. Core is told the traveller will walk 10
     * to reach somewhere, so core refuses it; the planner is asked with a
     * 30-minute detour tolerance, so the planner takes it. One derivation, two
     * answers, because the two callers are asking different questions.
     */
    const knowledge = roadKnowledge(10);
    expect(DERIVED_MINUTES).toBeGreaterThan(10);
    expect(deriveWithinAccessCap(knowledge, 'base', 'stop')).toBeNull();

    const planned = deriveModelledWalk(knowledge, 'base', 'stop', 30);
    expect(planned, 'the planner inherited core’s access cap instead of passing its own').not.toBeNull();
    expect(planned!.minutes).toBe(DERIVED_MINUTES);
    expect(planned!.mode).toBe('walk');
    expect(planned!.provenance).toBe('modelled');
  });

  it('still refuses a walk past the cap the planner did pass', () => {
    /*
     * The negative control for the test above: a cap that is not read at all
     * would satisfy it just as well as a cap that is read. Here core would
     * allow the walk and the planner must not.
     */
    const knowledge = roadKnowledge(60);
    expect(deriveWithinAccessCap(knowledge, 'base', 'stop')).not.toBeNull();
    expect(deriveModelledWalk(knowledge, 'base', 'stop', DERIVED_MINUTES - 1)).toBeNull();
  });
});
