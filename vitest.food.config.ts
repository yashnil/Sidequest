import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The food evaluation harness (`apps/web/src/lib/discovery-scan/food-eval/`).
 *
 * `eval.harness.ts` replays the recorded fixtures and writes a report under
 * `docs/release-candidate/food/`; `record.harness.ts` re-records them from the
 * keyless sources and only runs with `SIDEQUEST_FOOD_RECORD=1`. Neither belongs
 * in `npm run test`: one writes files, the other reaches the network.
 */
export default defineConfig({
  resolve: base.resolve,
  oxc: base.oxc,
  test: {
    include: ['apps/web/src/lib/discovery-scan/food-eval/*.harness.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
