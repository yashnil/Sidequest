import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * V9.1 — the performance measurement, on its own.
 *
 * `vitest.config.ts` excludes this file from `npm run test` because repeating
 * the heavy execution paths twenty-plus times saturates every core and starves
 * the suites running beside it. Here it is the only file, so the figures it
 * prints measure the code rather than the contention. Run it with
 * `npm run test:perf` on an otherwise idle machine.
 *
 * The base config supplies the `server-only` and `@/` aliases and the JSX
 * runtime; only the file list differs, and it replaces rather than extends the
 * base's (merging the two would run the whole suite again).
 */
export default defineConfig({
  resolve: base.resolve,
  oxc: base.oxc,
  test: {
    include: ['apps/web/src/lib/execution/perf-offline.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    passWithNoTests: false,
  },
});
