import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OFFERED_AVOIDANCES } from './definition';

/**
 * EVERY AVOIDANCE THE QUESTIONNAIRE OFFERS MUST BE CONSUMED BY SOMETHING.
 *
 * The constraints step introduces its chips with "these become hard filters,
 * not gentle nudges" — a promise about behaviour, made per value. An audit
 * found three values that broke it: `early_mornings`, `cold_water` and
 * `high_altitude_exertion` were offered as hard filters and read by nothing at
 * all, so checking them changed not one score, not one day, not one sentence.
 * A placebo control is worse than an absent one: it spends the traveller's
 * trust teaching them the checkboxes do something they do not.
 *
 * This test makes the promise structural, the way `render-purity` does for
 * fetching: for every avoidance value the UI offers, some module *outside* the
 * questionnaire's own definition/labelling files must mention the value —
 * scoring, planning, weather, or the profile derivation that feeds them. A new
 * avoidance added to the offer without a consumer fails here, in CI, rather
 * than in a traveller's plan.
 *
 * Grep-based on purpose. An import-graph proof would be stronger and would
 * also be wrong more often: consumers key on the *string* member of the enum
 * (`avoidances.includes('long_hikes')`), so the string is the thing to find.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = resolve(HERE, '..');
const PLANNER_SRC = resolve(HERE, '../../../planner/src');

/**
 * Files that *offer or name* avoidances rather than consuming them. A mention
 * inside any of these proves nothing about behaviour, so they are excluded
 * from the search. Tests are excluded too — a test asserting a consumer exists
 * must not satisfy itself.
 */
const NON_CONSUMERS = [
  join(CORE_SRC, 'schemas'),
  join(CORE_SRC, 'questionnaire', 'definition.ts'),
  join(CORE_SRC, 'intent', 'phrases.ts'),
  join(CORE_SRC, 'testing'),
  join(CORE_SRC, 'data'),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts') && !path.includes('.test.')) out.push(path);
  }
  return out;
}

describe('offered avoidances have consumers', () => {
  const files = [...walk(CORE_SRC), ...walk(PLANNER_SRC)].filter(
    (path) => !NON_CONSUMERS.some((excluded) => path.startsWith(excluded)),
  );
  const sources = files.map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  it('searches a real corpus', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const avoidance of OFFERED_AVOIDANCES) {
    it(`'${avoidance}' feeds scoring, planning or derivation`, () => {
      const consumers = sources
        .filter((source) => source.text.includes(`'${avoidance}'`))
        .map((source) => source.path);
      expect(
        consumers.length,
        `The UI offers '${avoidance}' as a hard filter and nothing consumes it. ` +
          'Wire it into scoring/planning/derivation, or remove it from OFFERED_AVOIDANCES — ' +
          'a placebo control is worse than absence.',
      ).toBeGreaterThan(0);
    });
  }
});
