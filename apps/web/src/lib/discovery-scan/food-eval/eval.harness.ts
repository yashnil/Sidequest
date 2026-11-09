import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { overtureFoodRow } from '../../providers/overture-food';
import { evaluateFood } from './eval';
import { asOvertureRow, loadFoodFixture } from './replay';
import { FOOD_SCENARIOS } from './scenarios';

/**
 * WRITE THE FOOD EVALUATION REPORT.
 *
 *   SIDEQUEST_FOOD_EVAL_LABEL=after npx vitest run -c vitest.food.config.ts apps/web/src/lib/discovery-scan/food-eval/eval.harness.ts
 *
 * Replays every recorded scenario through the product's food steps and writes
 * `docs/release-candidate/food/<label>.json`. Offline and deterministic: two
 * runs of the same code write the same bytes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '../../../../../../docs/release-candidate/food');
const LABEL = process.env.SIDEQUEST_FOOD_EVAL_LABEL ?? 'current';

/** `SIDEQUEST_FOOD_WRITE_PRIOR=1`: regenerate `packages/core/src/food/cuisine-prior.json`, each scenario weighted equally. */
describe.runIf(process.env.SIDEQUEST_FOOD_WRITE_PRIOR === '1')('cuisine prior', () => {
  it('writes the prior', () => {
    const shares = FOOD_SCENARIOS.map((scenario) => {
      const seen = new Map<string, string>();
      for (const box of loadFoodFixture(scenario.label).boxes) {
        for (const raw of box.overture?.rows ?? []) {
          const row = overtureFoodRow(asOvertureRow(raw));
          if (row?.cuisine && !row.shop) seen.set(row.id, row.cuisine);
        }
      }
      const counts = new Map<string, number>();
      for (const cuisine of seen.values()) counts.set(cuisine, (counts.get(cuisine) ?? 0) + 1);
      return new Map([...counts].map(([cuisine, n]) => [cuisine, n / Math.max(1, seen.size)]));
    });
    const labels = [...new Set(shares.flatMap((s) => [...s.keys()]))].sort();
    const prior = Object.fromEntries(labels.map((label) => [label, Math.round((shares.reduce((n, s) => n + (s.get(label) ?? 0), 0) / shares.length) * 10000) / 10000]));
    writeFileSync(join(HERE, '../../../../../../packages/core/src/food/cuisine-prior.json'), `${JSON.stringify(prior, null, 1)}\n`);
    expect(labels.length).toBeGreaterThan(10);
  });
});

describe('food evaluation', () => {
  it(`writes ${LABEL}.json`, async () => {
    const report = await evaluateFood(LABEL);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${LABEL}.json`), `${JSON.stringify(report, null, 2)}\n`);
    expect(report.scenarios.length).toBeGreaterThan(0);
  }, 120_000);
});
