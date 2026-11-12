import { defineConfig, devices } from '@playwright/test';

/**
 * STAGING ACCEPTANCE, AGAINST THE DEPLOYED STAGING ENVIRONMENT.
 *
 * No web server: the target is `STAGING_URL` (the Railway `staging`
 * environment, its own volume and secrets, never production). Real model,
 * real providers, so `retries: 0` — a failure is a failure, not a second bill.
 * `STAGING_TRIPS` picks which live trips run (comma-separated labels from the
 * spec); public-page checks always run, at three widths.
 */
const baseURL = process.env.STAGING_URL ?? 'https://sidequestweb-staging.up.railway.app';
if (/sidequestweb-production/.test(baseURL)) throw new Error('This configuration never targets production.');

export default defineConfig({
  testDir: './e2e/staging',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', use: { ...devices['Desktop Chrome'], viewport: { width: 834, height: 1112 }, hasTouch: true, isMobile: false } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
});
