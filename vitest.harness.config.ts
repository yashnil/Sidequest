import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** One-off harnesses that need a real database or write a report, and must never run inside `npm run test`. */
export default defineConfig({
  resolve: base.resolve,
  oxc: base.oxc,
  test: {
    include: ['apps/web/src/lib/destinations/advisor-compare.harness.ts', 'packages/core/src/advisor/eval/benchmark/*.harness.ts', 'apps/web/src/lib/atlas/*.harness.ts', 'packages/atlas/build/*.harness.ts', 'packages/atlas/src/*.harness.ts', 'apps/web/src/lib/planning/evaluation/*.harness.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
