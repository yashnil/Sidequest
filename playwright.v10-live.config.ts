import { defineConfig, devices } from '@playwright/test';

/**
 * V10 §20 — the one live build, on the real provider stack.
 *
 * Separate from every other config on purpose. `.env.local` carries the real
 * keys and `next start` loads it, so this is the only configuration in the
 * repository that may reach a model — and it names the single spec that does.
 * The composer switch is the one thing it changes from the ordinary browser
 * config: everything else (geocoder, routing, places) is whatever the operator
 * has configured, because the point is to prove V10 against the real stack.
 */
const PORT = 4310;
const baseURL = `http://127.0.0.1:${PORT}`;
const DATABASE_PATH = new URL('./apps/web/data/v10-live.db', import.meta.url).pathname;

export default defineConfig({
  testDir: './e2e',
  testMatch: /v10-live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 420_000,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `SIDEQUEST_DB_PATH=${DATABASE_PATH} SIDEQUEST_SECURE_COOKIES=off SIDEQUEST_COMPOSER_PROVIDER=${process.env.SIDEQUEST_COMPOSER_PROVIDER ?? 'fixture'} SIDEQUEST_AUTH_PROVIDER=fixture SIDEQUEST_AUTH_FIXTURE=allow SIDEQUEST_ACTION_FENCES=off SIDEQUEST_BASE_URL=${baseURL} PORT=${PORT} npm run start --workspace @sidequest/web`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
