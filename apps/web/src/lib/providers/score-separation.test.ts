import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BOTH PRODUCERS OF A `Place`, HELD TO THE SAME MODEL.
 *
 * There are exactly two places in this repository where a source record becomes
 * something a traveller ranks: the compiled backbone, and this package's live
 * fallback. They had drifted into two different formulas for the same field —
 * `0.15 + significance * 0.75` in one, `0.25 + (tagCount / 5) * 0.5` in the
 * other — and both then derived a "hidden gem" score as one minus that number
 * and a crowd level as a threshold on it.
 *
 * The fallback branch itself cannot be exercised offline: it needs a live map
 * query and a classifying model call, and mocking both would test the mock. What
 * *can* be checked without either is the property that made the drift possible —
 * that a producer is allowed to invent its own derivation at all. So this is a
 * structural test, deliberately, and it is the only kind that reaches this
 * branch. The behaviour of the model the two now share is tested directly in
 * `packages/core/src/quality/significance.test.ts` and against real records in
 * `packages/compiler/src/backbone/score-separation.test.ts`.
 */

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

const PRODUCERS = [
  'apps/web/src/lib/providers/live.ts',
  'packages/compiler/src/backbone/inventory.ts',
];

/** Comments describe the defect on purpose; only the code is being checked. */
function code(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('every producer of a place uses the one standing model', () => {
  it('has files to check, so a moved path cannot make this vacuous', () => {
    for (const path of PRODUCERS) {
      expect(code(path).length, path).toBeGreaterThan(1000);
    }
  });

  it('derives the legacy scores from the model rather than by hand', () => {
    for (const path of PRODUCERS) {
      const source = code(path);
      expect(source, `${path} does not assess standing`).toMatch(/assessPlaceStanding\(/);
      expect(source, `${path} does not project standing`).toMatch(/standingFields\(/);
      // Assigning any of the three reads directly is how a second formula gets in.
      expect(source, `${path} assigns popularityScore by hand`).not.toMatch(/popularityScore:/);
      expect(source, `${path} assigns hiddenGemScore by hand`).not.toMatch(/hiddenGemScore:/);
      expect(source, `${path} assigns crowdLevel by hand`).not.toMatch(/crowdLevel:/);
    }
  });

  it('never derives hiddenness as one minus a prominence figure', () => {
    for (const path of PRODUCERS) {
      const source = code(path);
      expect(source, `${path} inverts a score into a hidden-gem figure`).not.toMatch(
        /1\s*-\s*(popularity|prominence|significance)/i,
      );
    }
  });

  it('never reads a crowd level off a prominence threshold', () => {
    for (const path of PRODUCERS) {
      const source = code(path);
      expect(source, `${path} thresholds prominence into a crowd`).not.toMatch(
        /(popularity|prominence)\w*\s*[<>]=?\s*[\d.]+\s*\?/i,
      );
    }
  });

  it('computes the confidence it publishes about a place, rather than stating one', () => {
    /**
     * Scoped to the place builder. Both files also carry confidence figures for
     * food venues and for mapper-recorded hours; those are different claims with
     * their own provenance blocks and their own recheck copy, and folding them
     * into this rule would be asserting something this change did not look at.
     * The literal being refused is the one both producers actually had.
     */
    for (const path of PRODUCERS) {
      const source = code(path);
      expect(source, `${path} still states a flat 0.7 confidence`).not.toMatch(
        /confidence:\s*0\.7\b/,
      );
      expect(source, `${path} does not compute source confidence`).toMatch(
        /confidence:\s*standing\.sourceConfidence/,
      );
    }
  });
});
