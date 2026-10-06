import { defineConfig, devices } from '@playwright/test';

/**
 * V12 §55 §56 §57 — the three live acceptances, on the real provider stack.
 *
 * Separate from every other config on purpose, and modelled directly on
 * `playwright.v11-live.config.ts`. `.env.local` carries the real keys and
 * `next start` loads it, so this and the V10/V11 configs are the only
 * configurations in the repository that may reach a model — and each names the
 * single spec that does.
 *
 * **Three tests, three compositions, and no more.** The architecture forbids a
 * retry, a critic and a repair call; `retries: 0` here means a failure is a
 * failure rather than a second call, which is the whole point of a budget.
 */
const PORT = 4312;
const baseURL = `http://127.0.0.1:${PORT}`;
const DATABASE_PATH = new URL('./apps/web/data/v12-live.db', import.meta.url).pathname;

export default defineConfig({
  testDir: './e2e',
  testMatch: /v12-live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 480_000,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `SIDEQUEST_DB_PATH=${DATABASE_PATH} SIDEQUEST_SECURE_COOKIES=off SIDEQUEST_COMPOSER_PROVIDER=${process.env.SIDEQUEST_COMPOSER_PROVIDER ?? 'fixture'} SIDEQUEST_AUTH_PROVIDER=fixture SIDEQUEST_AUTH_FIXTURE=allow SIDEQUEST_FIXTURES=allow SIDEQUEST_ACTION_FENCES=off SIDEQUEST_BASE_URL=${baseURL} PORT=${PORT} npm run start --workspace @sidequest/web`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
