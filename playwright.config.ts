import { readFileSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * The port is not defined here. `config.port` in the root package.json is the one
 * canonical value; the root `dev` and `start` scripts export it as PORT, Next
 * honours PORT, and this config reads the same field so an end-to-end run can
 * never drift onto a different port from the app.
 */
const rootPackage = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { config?: { port?: string } };

const PORT = Number(process.env.PORT ?? rootPackage.config?.port);
if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error('No usable port: set PORT, or config.port in the root package.json.');
}

const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...devices['Desktop Chrome'], colorScheme: 'dark' } },
    {
      // Chromium at an iPhone viewport. This verifies responsive layout and touch
      // targets, not WebKit engine behaviour — running real WebKit would mean
      // pulling a second browser for no extra signal at this stage.
      name: 'mobile',
      use: { ...devices['iPhone 13'], browserName: 'chromium' },
    },
  ],
  webServer: {
    // Its own database file so an end-to-end run never touches development data.
    // The app and the tests now share one port, so stop `npm run dev` first —
    // reusing a running dev server here would silently test a different build
    // against the development database.
    // The fixture weather provider, so a browser test asserts against weather it
    // chose rather than against whatever the sky was doing that morning — and so
    // an end-to-end run never depends on an external service being reachable.
    // The fixture compiler provider, for the same reason and a sharper one: the
    // live stack reaches volunteer-run map services, and a test suite that hits
    // those on every run is precisely the abuse their policies complain about.
    command: `SIDEQUEST_DB_PATH=./data/e2e.db SIDEQUEST_WEATHER_PROVIDER=fixture SIDEQUEST_COMPILER_PROVIDER=fixture PORT=${PORT} npm run start --workspace @sidequest/web`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
