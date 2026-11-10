import { defineConfig } from '@playwright/test';
import base from '../../playwright.config';

/**
 * THE AUDIT RUN: the real map provider on (every tile answered by
 * `e2e/maps/support/tiles.ts`), software GL, and only the specs that read the
 * whole product. Not part of the ordinary suites.
 *
 *   npm run build
 *   PORT=4520 npx playwright test -c e2e/audit/playwright.audit.config.ts
 */
const root = new URL('../../', import.meta.url).pathname;
const webServer = base.webServer as { command: string } & Record<string, unknown>;
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  ...base,
  testDir: `${root}e2e`,
  testMatch: ['**/audit/*.spec.ts', '**/hydration.spec.ts'],
  globalSetup: `${root}e2e/support/readiness.ts`,
  globalTeardown: `${root}e2e/support/build-identity.ts`,
  projects: (base.projects ?? [])
    .filter((project) => project.name === 'desktop' || project.name === 'mobile')
    .map((project) => ({ ...project, testIgnore: [], use: { ...project.use, launchOptions: { args: GL_ARGS } } })),
  webServer: { ...webServer, cwd: root, command: process.env.AUDIT_MAPS === 'off' ? webServer.command : webServer.command.replace('SIDEQUEST_MAP_PROVIDER= ', 'SIDEQUEST_MAP_PROVIDER=openfreemap ') },
});
