import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * The lodging harnesses (`apps/web/src/lib/providers/lodging/`).
 *
 * `record.harness.ts` re-records the unit-test fixtures from the keyless
 * sources (Overture place files, Overpass) and only runs with
 * `SIDEQUEST_LODGING_RECORD=1`; `coverage.harness.ts` reports how many named
 * candidates each source returns around a few real bases, live, once, with
 * `SIDEQUEST_LODGING_COVERAGE=1`. Neither belongs in `npm run test`: both reach
 * the network.
 */
export default defineConfig({
  resolve: base.resolve,
  oxc: base.oxc,
  test: {
    include: ['apps/web/src/lib/providers/lodging/*.harness.ts'],
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 600_000,
  },
});
