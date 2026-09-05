import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * LIVE WORLD V1 — the Today-mode run: the base configuration with a fixture
 * clock inside the default trip's dates (2026-08-12 → 2026-08-16), honoured
 * only because the composer is the offline fixture. One spec, desktop only.
 */
const webServer = base.webServer as { command: string } & Record<string, unknown>;

export default defineConfig({
  ...base,
  testMatch: ['**/live-world-today.spec.ts'],
  projects: (base.projects ?? []).filter((p) => p.name === 'desktop').map((p) => ({ ...p, testIgnore: [] })),
  webServer: { ...webServer, command: `SIDEQUEST_FIXTURE_NOW=2026-08-13T17:30:00Z ${webServer.command}` },
});
