import { defineConfig, devices } from '@playwright/test';

/**
 * Drives the fixture journeys against a server that is ALREADY RUNNING
 * (`serve.sh`), so a measurement can separate the first request after process
 * start from later ones. No `webServer`, and — unlike `playwright.config.ts`,
 * which this deliberately does not import — nothing here deletes a database.
 */
const PORT = Number(process.env.PORT ?? 4420);

export default defineConfig({
  testDir: '.',
  testMatch: /journeys\.perf\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
});
