import { rmSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * VISUAL CONTINUITY WALK — screenshots of every signed-in surface at three
 * widths, on a fixture server of its own (port 4350, its own database), with
 * the real vector basemap on so the globe and atlas look as they ship.
 *
 *   SHOTS=before npx playwright test -c docs/visual-continuity/tools/playwright.continuity.config.ts
 *
 * Not part of the gate; it writes evidence under docs/visual-continuity/<SHOTS>/.
 */
const PORT = 4350;
const DB = new URL('../../../apps/web/data/continuity.db', import.meta.url).pathname;
if (!process.env.TEST_WORKER_INDEX && !process.argv.includes('--list')) {
  for (const s of ['', '-wal', '-shm', '-journal']) rmSync(DB + s, { force: true });
}

export default defineConfig({
  testDir: '.',
  testMatch: /continuity\.(walk|perf)\.ts$/,
  timeout: 600_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 }, hasTouch: true } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `SIDEQUEST_DB_PATH=${DB} SIDEQUEST_SECURE_COOKIES=off ANTHROPIC_API_KEY= GOOGLE_MAPS_API_KEY= SIDEQUEST_GEOCODER_PROVIDER=off SIDEQUEST_PLACE_BACKBONE=off SIDEQUEST_POI_PROVIDER=off SIDEQUEST_ROUTES_PROVIDER=off SIDEQUEST_RESEARCH_PROVIDER=off SIDEQUEST_IMAGERY_PROVIDER=fixture SIDEQUEST_TIMEZONE_PROVIDER=off SIDEQUEST_TRANSIT_PROVIDER= SIDEQUEST_MAP_PROVIDER=openfreemap SIDEQUEST_WEATHER_PROVIDER=fixture SIDEQUEST_COMPILER_PROVIDER=fixture SIDEQUEST_COMPOSER_PROVIDER=fixture SIDEQUEST_CLIMATE_PROVIDER=off SIDEQUEST_FX_PROVIDER=off SIDEQUEST_DESTINATION_INTERPRETER=fixture SIDEQUEST_BENCHMARK_MODE=fixture SIDEQUEST_ACTION_FENCES=off SIDEQUEST_AUTH_PROVIDER=fixture SIDEQUEST_AUTH_FIXTURE=allow SIDEQUEST_FIXTURES=allow SIDEQUEST_BASE_URL=http://127.0.0.1:${PORT} SIDEQUEST_DESTINATION_INDEX_SEED=../../e2e/support/destination-index.ndjson PORT=${PORT} npm run start --workspace @sidequest/web`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
