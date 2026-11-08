import { rmSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
import { releaseIsolation } from './e2e/support/isolated-run';
import maps from './playwright.maps.config';

/**
 * THE LANDING GLOBE, END TO END, ON ITS OWN SERVER.
 *
 * The maps configuration (real map provider, controlled tiles, SwiftShader GL)
 * narrowed to the landing-globe specs, with a database and a port of its own so
 * it can run beside another browser run without touching that run's files:
 *
 *   PORT=4340 npx playwright test -c playwright.globe.config.ts
 *
 * `isolated-run` is imported first so evaluating the base config does not empty
 * `apps/web/data/e2e.db`; this config empties only its own file, under the same
 * guards the base uses.
 */
releaseIsolation();

const DATABASE = 'apps/web/data/e2e-globe.db';
const DATABASE_PATH = new URL(`./${DATABASE}`, import.meta.url).pathname;
const BASE_DATABASE_PATH = new URL('./apps/web/data/e2e.db', import.meta.url).pathname;

function emptyTheGlobeDatabase(): void {
  if (process.env.VITEST) return;
  if (process.env.TEST_WORKER_INDEX !== undefined) return;
  if (process.argv.some((a) => a === '--list' || a === 'show-report' || a === 'show-trace')) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    rmSync(new URL(`./${DATABASE}${suffix}`, import.meta.url), { force: true });
  }
}
emptyTheGlobeDatabase();

const webServer = maps.webServer as { command: string } & Record<string, unknown>;
if (!webServer.command.includes(`SIDEQUEST_DB_PATH=${BASE_DATABASE_PATH} `)) {
  throw new Error('playwright.globe.config.ts could not find the base database path in the web server command.');
}

export default defineConfig({
  ...maps,
  testMatch: /maps\/landing-globe[^/]*\.spec\.ts$/,
  webServer: { ...webServer, command: webServer.command.replace(`SIDEQUEST_DB_PATH=${BASE_DATABASE_PATH} `, `SIDEQUEST_DB_PATH=${DATABASE_PATH} `) },
});
