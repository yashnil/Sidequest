import { defineConfig, devices } from '@playwright/test';

/**
 * RELEASE-CANDIDATE LIVE ACCEPTANCE, ON THE REAL PROVIDER STACK.
 *
 * Separate from every other configuration because `next start` loads
 * `.env.local`: this and the other `*-live` configs are the only ones that may
 * reach a model. Four trips at one discovery scan each, plus two Help-me-choose
 * requests at no more than one research call each. `retries: 0`, so a failure
 * is a failure rather than a second bill. Writes only to its own database.
 */
const PORT = 4320;
const baseURL = `http://127.0.0.1:${PORT}`;
const DATABASE_PATH = new URL('./apps/web/data/rc-live.db', import.meta.url).pathname;

export default defineConfig({
  testDir: './e2e',
  testMatch: /rc-live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [['list']],
  use: { baseURL, trace: 'off', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `SIDEQUEST_DB_PATH=${DATABASE_PATH} SIDEQUEST_SECURE_COOKIES=off SIDEQUEST_ACTION_FENCES=off SIDEQUEST_BASE_URL=${baseURL} PORT=${PORT} npm run start --workspace @sidequest/web`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
