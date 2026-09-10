import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * SHIP V1 — the deployment-posture smoke.
 *
 * The base configuration proves the product against fixture providers with the
 * abuse fences and the cookie's `Secure` attribute deliberately pinned off, for
 * the reasons written where they are pinned. Neither pin is how the thing is
 * actually deployed, so neither is evidence about the deployment.
 *
 * This config brings its own server instead: started by hand with the fences up,
 * `Secure` cookies on, the free providers real (geocoder, weather, climate,
 * basemap, imagery) and only the composer on fixtures, because a smoke that
 * spends a model call is a smoke nobody runs twice. `reuseExistingServer` is the
 * whole point — the server under test is the one an operator started.
 */
export default defineConfig({
  ...base,
  webServer: undefined,
  workers: 1,
  retries: 0,
  use: { ...base.use, baseURL: process.env.SHIP_BASE_URL ?? 'http://localhost:4400' },
  projects: (base.projects ?? []).map((project) => ({ ...project, use: { ...project.use, baseURL: process.env.SHIP_BASE_URL ?? 'http://localhost:4400' } })),
});
