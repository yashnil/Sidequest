import { defineConfig, devices } from '@playwright/test';
import base from '../../../playwright.config';

/**
 * THE RELEASE-CANDIDATE SCREENSHOT WALK.
 *
 * One first-time traveller's journey, photographed at a desktop and a phone
 * viewport, on the fixture providers (zero spend, no network: the map tiles are
 * answered by `e2e/maps/support/tiles.ts`). It is not part of any suite — it is
 * the tool that produced `docs/release-candidate/screens/{before,after}`.
 *
 *   npm run build
 *   WALK_OUT=after PORT=4410 npx playwright test -c docs/release-candidate/tools/playwright.walk.config.ts
 *
 * `WALK_MAPS=off` photographs the trip page without a vector basemap (the SVG
 * figure a browser without WebGL gets) into `<out>-fallback`.
 */
const root = new URL('../../../', import.meta.url).pathname;
const webServer = base.webServer as { command: string } & Record<string, unknown>;
const mapsOn = process.env.WALK_MAPS !== 'off';
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

export default defineConfig({
  ...base,
  testDir: new URL('.', import.meta.url).pathname,
  testMatch: /walk\.spec\.ts$/,
  globalSetup: `${root}e2e/support/readiness.ts`,
  globalTeardown: `${root}e2e/support/build-identity.ts`,
  timeout: 600_000,
  use: { ...base.use, actionTimeout: 45_000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'light', launchOptions: { args: GL_ARGS } } },
    { name: 'mobile', use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: { width: 390, height: 844 }, launchOptions: { args: GL_ARGS } } },
  ],
  webServer: {
    ...webServer,
    cwd: root,
    command: mapsOn ? webServer.command.replace('SIDEQUEST_MAP_PROVIDER= ', 'SIDEQUEST_MAP_PROVIDER=openfreemap ') : webServer.command,
  },
});
