import { defineConfig, devices } from '@playwright/test';

/**
 * PRIVATE ALPHA — SUITES THAT RUN AGAINST A DEPLOYED URL.
 *
 * No web server: `SIDEQUEST_ALPHA_URL` names the deployment (for example the
 * Railway production URL). Two suites live here and they cost very different
 * amounts:
 *
 * - `smoke.spec.ts` — every deploy. Spends no model call and no paid provider
 *   call: landing, health and readiness, trip creation up to the interview,
 *   saved state across a reload, an existing shared itinerary when
 *   `SIDEQUEST_ALPHA_SHARE_URL` names one, and the three widths. It does create
 *   one interview-stage trip row per run.
 * - `persistence.spec.ts` — manual, gated by `SIDEQUEST_ALPHA_LIVE=1`. Builds one
 *   real trip (one discovery scan = one model call), records decisions, a
 *   booking, a calendar feed and a share link, and saves the browser session;
 *   run again with `SIDEQUEST_ALPHA_PHASE=verify` after a restart or redeploy to
 *   prove all of it survived, and that a stranger can see only the share page.
 *
 * `retries: 0`: a failure against a live deployment is a finding, never a
 * second paid call.
 */
const baseURL = process.env.SIDEQUEST_ALPHA_URL;
if (!baseURL) throw new Error('Set SIDEQUEST_ALPHA_URL to the deployment under test (e.g. https://sidequestweb-production.up.railway.app).');

export default defineConfig({
  testDir: './e2e/alpha',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'tablet', testMatch: /smoke\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 768, height: 1024 }, isMobile: false } },
    { name: 'mobile', testMatch: /smoke\.spec\.ts/, use: { ...devices['iPhone 13'], viewport: { width: 375, height: 812 }, browserName: 'chromium' } },
  ],
});
