import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE BOARD AND THE PLANNER MUST READ THE SAME TRAVEL REALITY.
 *
 * Phase 9's most expensive defect, in one sentence: `travelFromBase` was left at
 * zero on every compiled place, so the Discovery Board offered nine stops as
 * zero-minute hops, auto-pick took all nine, and the planner then refused every
 * one of them because the round trip was a hundred and sixty minutes against a
 * hundred-and-fifty-minute limit. Two surfaces, one region, two different
 * worlds — and nothing in the code said they had to agree.
 *
 * These are lints rather than proofs, and honest about that. What they catch is
 * somebody reintroducing the *mechanism*: a second travel-time source, a default
 * of zero, or a straight-line distance leaking into a field a traveller reads.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

function code(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('one travel layer, read by everything', () => {
  it('the board never computes a travel time of its own', () => {
    /*
     * The board renders `place.travelFromBase`, which the compiler writes from
     * the matrix. It must not derive one — a second formula is a second answer.
     */
    const board = code('packages/core/src/discovery/board.ts');
    expect(board).not.toMatch(/haversine/i);
    expect(board).not.toMatch(/straightLine/i);
    expect(board).not.toMatch(/driveMinutes\s*[:=]\s*0\b/);
  });

  it('the geometric prefilter is not importable by anything that renders', () => {
    /*
     * `straightLineKm` decides which pairs are worth buying. A surface that
     * imported it could render a straight line as a drive, which is the one
     * thing the whole hierarchical design forbids.
     */
    for (const file of [
      'packages/core/src/discovery/board.ts',
      'packages/core/src/scoring/fit.ts',
      'packages/planner/src/plan.ts',
      'packages/planner/src/assign.ts',
    ]) {
      expect(code(file), `${file} imports the prefilter`).not.toMatch(/straightLineKm/);
    }
  });

  it('the planner reads travel only through the matrix helpers', () => {
    /*
     * `leg` and `tryLeg` are the single boundary, and they now refuse a
     * non-finite cell. A planner that indexed `matrix.minutes` directly would
     * walk straight past that check and read a NaN as a number.
     */
    const planner = code('packages/planner/src/plan.ts');
    expect(planner).not.toMatch(/matrix\.minutes\s*\[/);
    expect(planner).not.toMatch(/\.minutes\[[a-zA-Z]/);
  });

  it('an unmeasured leg can never be read as zero', () => {
    const matrix = code('packages/geo/src/matrix.ts');
    // The guard that makes NaN an error rather than a number.
    expect(matrix).toMatch(/Number\.isFinite\(minutes\)/);
    expect(matrix).toMatch(/Number\.isFinite\(km\)/);
  });

  it('the compiler writes travel from the base a place is actually visited from', () => {
    const compiler = code('packages/compiler/src/compile.ts');
    // The old bug: every place measured from bases[0].
    expect(compiler).not.toMatch(/legBetween\(bases\[0\]/);
    expect(compiler).toMatch(/baseOfPlace/);
  });
});

describe('the routing layers stay apart', () => {
  it('no module merges the inter-cluster and intra-cluster blocks into one request', () => {
    const routing = code('packages/compiler/src/routing.ts');
    // Blocks are requested individually; a single call over every point is the
    // flat design coming back.
    expect(routing).toMatch(/for \(const block of plan\.blocks\)/);
  });

  it('the plan is costed before a provider is called', () => {
    const routing = code('packages/compiler/src/routing.ts');
    const planIndex = routing.indexOf('planRouting(');
    const callIndex = routing.indexOf('routing.matrix(');
    expect(planIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeLessThan(callIndex);
  });

  it('no destination name reaches the routing layer', () => {
    for (const file of [
      'packages/core/src/routing/plan.ts',
      'packages/core/src/routing/portfolio.ts',
      'packages/compiler/src/routing.ts',
    ]) {
      const source = code(file).toLowerCase();
      for (const name of ['kyrgyz', 'bishkek', 'iceland', 'japan', 'bali', 'mammoth', 'eastern sierra']) {
        expect(source.includes(name), `${file} names ${name}`).toBe(false);
      }
    }
  });
});
