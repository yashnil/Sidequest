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
    alias: { 'server-only': new URL('./vitest.server-only.ts', import.meta.url).pathname },
  },
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
    environment: 'node',
    passWithNoTests: false,
  },
});
