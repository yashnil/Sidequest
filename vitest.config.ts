import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    /**
     * `server-only` throws on import outside a React Server Component, which is
     * exactly its job — and it means the pure logic inside `apps/web/src/lib`
     * cannot be unit-tested at all. Aliasing it to nothing under Vitest is the
     * standard resolution: the guard still fires in the real build, where it
     * matters, and calendar arithmetic living behind it becomes testable.
     */
    alias: {
      'server-only': new URL('./vitest.server-only.ts', import.meta.url).pathname,
      /*
       * The web app's own path alias, so a module under `apps/web/src` can be
       * unit-tested without inventing a second import convention for the files
       * that happen to have a test beside them.
       *
       * The key carries its trailing slash deliberately. Vite matches a string
       * alias as a prefix, so a bare `'@'` would also capture `@sidequest/bench`
       * and rewrite every workspace import in the repository.
       */
      '@/': new URL('./apps/web/src/', import.meta.url).pathname,
    },
  },
  /*
   * `apps/web/tsconfig.json` sets `jsx: preserve`, which is right for Next and
   * leaves Vite's transformer emitting JSX that Node cannot run — so a component
   * could not be rendered in a unit test at all. Stated here rather than changed
   * there, because the build's setting is the build's business.
   */
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: [
      'packages/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      /*
       * The live-evaluation harness's own offline tests.
       *
       * They run here rather than in Playwright: no server, no browser, no
       * network, a virtual clock. Including them means `npm run test` covers the
       * thing that decides whether a live evaluation's numbers can be trusted —
       * which is worth as much as covering the product it measures.
       */
      'e2e/live/**/*.test.ts',
      /*
       * Assertions about the repository's own configuration — currently
       * `playwright.config.test.ts`, which checks that the browser suite still
       * declares the viewports and the `testMatch` it is supposed to.
       *
       * Root-level rather than under `e2e/`, because Playwright's `testDir` is
       * `e2e/` and a runner tripping over the other runner's files is the exact
       * failure this test exists to prevent.
       */
      '*.test.ts',
    ],
    /*
     * V9.1 — the performance measurement runs on its own (`npm run test:perf`),
     * not inside this parallel pass.
     *
     * It is a measurement, not a regression gate: it repeats the heavy
     * execution paths twenty-plus times and saturates every core, which starved
     * the workers around it and timed out four unrelated suites that pass
     * comfortably on their own. Excluding it keeps `npm run test` a true signal
     * and keeps the numbers reproducible, since a measurement taken while
     * hundreds of other tests fight for the same cores measures the contention,
     * not the code.
     */
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/web/src/lib/execution/perf-offline.test.ts', 'apps/web/src/lib/destinations/recommend-perf.test.ts'],
    environment: 'node',
    /*
     * FX is on by default in the product (keyless ECB rates). The unit suite
     * stays hermetic: no generation under test reaches the network for a rate
     * unless a test opts in with its own choice or fetch stub.
     */
    env: { SIDEQUEST_FX_PROVIDER: process.env.SIDEQUEST_FX_PROVIDER ?? 'off' },
    passWithNoTests: false,
  },
});
