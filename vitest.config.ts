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
    include: ['packages/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
