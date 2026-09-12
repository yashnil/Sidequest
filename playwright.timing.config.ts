import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * V6 — THE TIMING LOCK, END TO END.
 *
 * The main suite runs with climate switched off, so "Tell me when it is best"
 * defers and there is no window to accept. This configuration turns the
 * fixture climate on for one spec, so the press that lost two production
 * trips' dates can be exercised in a real browser.
 */
const webServer = base.webServer as { command: string } & Record<string, unknown>;

export default defineConfig({
  ...base,
  testMatch: /(timing-lock|build-lifecycle|v8-experience|destination-semantics)\.spec\.ts/,
  projects: (base.projects ?? []).filter((project) => project.name === 'desktop').map((project) => ({ ...project, testIgnore: [] })),
  webServer: { ...webServer, command: webServer.command.replace('SIDEQUEST_CLIMATE_PROVIDER=off', 'SIDEQUEST_CLIMATE_PROVIDER=fixture') },
});
