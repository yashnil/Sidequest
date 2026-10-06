import { defineConfig, devices } from '@playwright/test';

/**
 * V1 CONVERGENCE — the live golden trips, on the real provider stack.
 *
 * Modelled on the V12.1 live config and separate from every other one for the
 * same reason: `next start` loads `apps/web/.env.local`, so this is a
 * configuration that may reach a model. Each golden trip spends one discovery
 * scan (one model call); the builds are planner-first and call no model.
 * `retries: 0`: a failure is a failure, never a second paid call.
 *
 * Food grounding uses public Overpass (`SIDEQUEST_POI_PROVIDER=overpass`), set
 * here for the acceptance only — production should point `SIDEQUEST_POI_URL`
 * at a hosted endpoint (see the progress log).
 */
const PORT = 4314;
const baseURL = `http://localhost:${PORT}`;
const DATABASE_PATH = new URL('./apps/web/data/v1-live.db', import.meta.url).pathname;

export default defineConfig({
  testDir: './e2e',
  testMatch: /v1-live\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `SIDEQUEST_DB_PATH=${DATABASE_PATH} SIDEQUEST_SECURE_COOKIES=off SIDEQUEST_POI_PROVIDER=overpass SIDEQUEST_ACTION_FENCES=off SIDEQUEST_BASE_URL=${baseURL} PORT=${PORT} npm run start --workspace @sidequest/web`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
