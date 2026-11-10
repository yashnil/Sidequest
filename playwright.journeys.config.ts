import { rmSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * THE TRAVELLER JOURNEYS, END TO END.
 *
 * Ten archetypes from idea to a saved, edited, exported and reopened trip, on the
 * fixture providers (`base.webServer` pins every one of them). Its own config
 * because a journey is minutes long and asserts across surfaces: it is a release
 * gate rather than part of the everyday browser run, which ignores `journeys/`.
 *
 * Its own database file, so a run neither inherits the suite's trips nor empties
 * a server another run is using. `JOURNEY_REUSE=1` attaches to a server already
 * running on PORT, which is how a failing step is iterated on without a restart.
 */
const DATABASE = new URL('./apps/web/data/e2e-journeys.db', import.meta.url).pathname;
const REUSE = process.env.JOURNEY_REUSE === '1';

if (!REUSE && process.env.TEST_WORKER_INDEX === undefined && !process.env.VITEST && !process.argv.includes('--list')) {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${DATABASE}${suffix}`, { force: true });
}

const webServer = base.webServer as { command: string } & Record<string, unknown>;

export default defineConfig({
  ...base,
  testDir: './e2e/journeys',
  testMatch: '**/*.spec.ts',
  /* Generous by design: one test is a whole trip, from the first field to a revoked share link. */
  timeout: 900_000,
  expect: { timeout: 20_000 },
  workers: 1,
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, colorScheme: 'light' } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 }, colorScheme: 'light' } },
    { name: 'phone', use: { ...devices['iPhone 13'], browserName: 'chromium', viewport: { width: 390, height: 664 } } },
  ],
  webServer: {
    ...webServer,
    command: webServer.command.replace(/SIDEQUEST_DB_PATH=\S+/, `SIDEQUEST_DB_PATH=${DATABASE}`),
    reuseExistingServer: REUSE,
  },
});
