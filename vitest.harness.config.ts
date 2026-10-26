import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** One-off harnesses that need a real database and must never run inside `npm run test`. */
export default defineConfig({
  resolve: base.resolve,
  oxc: base.oxc,
  test: {
    include: ['apps/web/src/lib/destinations/advisor-compare.harness.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
