import { defineConfig, devices } from '@playwright/test';

/**
 * PRIVATE ALPHA — THE PRODUCTION BUILD WITH ITS PROVIDERS BROKEN ON PURPOSE.
 *
 * Two servers from the same `next build`, neither able to spend:
 *
 * - 4321 "degraded": the geocoder points at a closed port, openrouteservice
 *   gets a key it will refuse, weather is off, and no food provider is set. The
 *   composer is the fixture (the scan proposes and places offline) while the
 *   router and geocoder are the real, broken clients, so a trip can still be
 *   built — the question is whether it is, honestly.
 * - 4322 "model refused": an invalid Anthropic key and nothing else, so a
 *   discovery scan reaches the real model API and is turned away (401, free).
 *
 * Run: `npm run build && npx playwright test -c playwright.degraded.config.ts`.
 */
const common = 'SIDEQUEST_SECURE_COOKIES=off SIDEQUEST_ACTION_FENCES=off NODE_ENV=production';
const degradedDb = new URL('./test-results/degraded.db', import.meta.url).pathname;
const refusedDb = new URL('./test-results/refused.db', import.meta.url).pathname;

export default defineConfig({
  testDir: './e2e',
  testMatch: /degradation\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: [['list']],
  use: { trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  webServer: [
    {
      command: `rm -f ${degradedDb}* && ${common} SIDEQUEST_DB_PATH=${degradedDb} SIDEQUEST_FIXTURES=allow SIDEQUEST_COMPOSER_PROVIDER=fixture SIDEQUEST_COMPILER_PROVIDER= ANTHROPIC_API_KEY= GOOGLE_MAPS_API_KEY= SIDEQUEST_GEOCODER_PROVIDER=nominatim SIDEQUEST_GEOCODER_URL=http://127.0.0.1:9 SIDEQUEST_ROUTES_PROVIDER= SIDEQUEST_ROUTES_GLOBAL_PROVIDER=openrouteservice OPENROUTESERVICE_API_KEY=invalid-for-degradation-test SIDEQUEST_WEATHER_PROVIDER=off SIDEQUEST_CLIMATE_PROVIDER=off SIDEQUEST_POI_PROVIDER= SIDEQUEST_BASE_URL=http://localhost:4321 PORT=4321 npm run start --workspace @sidequest/web`,
      url: 'http://localhost:4321/api/health',
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: `rm -f ${refusedDb}* && ${common} SIDEQUEST_DB_PATH=${refusedDb} ANTHROPIC_API_KEY=invalid-anthropic-key-for-degradation-test GOOGLE_MAPS_API_KEY= SIDEQUEST_COMPOSER_PROVIDER= SIDEQUEST_COMPILER_PROVIDER= SIDEQUEST_BASE_URL=http://localhost:4322 PORT=4322 npm run start --workspace @sidequest/web`,
      url: 'http://localhost:4322/api/health',
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
