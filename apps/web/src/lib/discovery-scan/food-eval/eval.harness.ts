import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateFood } from './eval';

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

describe('food evaluation', () => {
  it(`writes ${LABEL}.json`, async () => {
    const report = await evaluateFood(LABEL);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${LABEL}.json`), `${JSON.stringify(report, null, 2)}\n`);
    expect(report.scenarios.length).toBeGreaterThan(0);
  }, 120_000);
});
