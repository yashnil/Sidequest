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

/**
 * THE PROVISIONAL FIREWALL.
 *
 * A board emitted before the route matrix exists is the newest way for a zero to
 * become a drive. `travelFromBase` is `{0, 0}` from the moment a candidate is
 * built until the matrix corrects it; every comparison against zero passes; a
 * day carrying one satisfies every drive limit and every daylight check
 * silently.
 *
 * The defence is a type with no minutes field. These assert it stays that way,
 * and that the planner cannot reach one.
 */
describe('a provisional board cannot become a plan', () => {
  const PROVISIONAL = [
    'packages/core/src/schemas/provisional.ts',
    'packages/compiler/src/provisional.ts',
  ];

  it.each(PROVISIONAL)('%s carries no travel time, in any spelling', (file) => {
    const source = code(file);
    for (const banned of [/driveMinutes/, /distanceKm/, /travelFromBase/, /detourClass/]) {
      expect(banned.test(source), `${file} matches ${banned}`).toBe(false);
    }
  });

  /**
   * A `Place` carries six unmeasured defaults — a zeroed travel time, twelve
   * open months, a paved road, no remote-services flag, a constant source
   * confidence, and a hidden-gem score that is the algebraic inverse of its own
   * popularity. Handing one out would put all six on a card. So the schema does
   * not name the type.
   */
  it('never lets a Place cross into a provisional card', () => {
    const source = code('packages/core/src/schemas/provisional.ts');
    expect(/from '\.\/place'/.test(source)).toBe(false);
    expect(/\bplace\s*:\s*placeSchema\b/.test(source)).toBe(false);
  });

  it('keeps the planner unable to name the provisional layer', () => {
    for (const file of [
      'packages/planner/src/plan.ts',
      'packages/planner/src/types.ts',
      'packages/planner/src/candidates.ts',
      'packages/planner/src/assign.ts',
      'packages/planner/src/schedule.ts',
    ]) {
      expect(/Provisional/.test(code(file)), `${file} names the provisional layer`).toBe(false);
    }
  });

  /**
   * The emission must happen before the first call anybody pays for. Asserted
   * from the source's own ordering, because a browser test of it would be racing
   * a fixture compiler that finishes in about a second.
   */
  it('emits the board before anything is bought', () => {
    const compiler = code('packages/compiler/src/compile.ts');
    const cut = compiler.indexOf('onProvisionalBoard(');
    const food = compiler.indexOf("runStage('discovering_food'");
    const funnel = compiler.indexOf("runStage('enriching_priority_candidates'");
    const paid = compiler.indexOf("runStage('discovering_sources'");

    expect(cut).toBeGreaterThan(food);
    expect(cut).toBeLessThan(funnel);
    expect(cut).toBeLessThan(paid);
  });

  /** The projection buys nothing and cannot fail a build by being slow. */
  it('builds the board without a provider and without awaiting', () => {
    const source = code('packages/compiler/src/provisional.ts');
    expect(/\bawait\b/.test(source)).toBe(false);
    expect(/ledger\./.test(source)).toBe(false);
  });

  /** The route that shows it starts no external work, so a refresh costs nothing. */
  it('renders the provisional board without reaching anything', () => {
    const page = code('apps/web/src/app/trips/[id]/provisional/page.tsx');
    for (const banned of [/resolveTripRegion/, /resolveTripWeather/, /compilerProviders/, /\bfetch\(/]) {
      expect(banned.test(page), `the provisional route matches ${banned}`).toBe(false);
    }
  });
});
