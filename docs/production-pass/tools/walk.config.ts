import { defineConfig, devices } from '@playwright/test';

/**
 * Production-pass screenshot walk. Runs against an already-running fixture
 * server (default http://localhost:4300) — it starts nothing and deletes
 * nothing. `WALK_OUT` names the screenshot directory.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /(walk|scan-failure|building)\.spec\.ts$/,
  timeout: 300_000,
  workers: 1,
  reporter: 'line',
  outputDir: '/tmp/sidequest-walk-results',
  use: { baseURL: process.env.WALK_URL ?? 'http://localhost:4300', trace: 'off' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
