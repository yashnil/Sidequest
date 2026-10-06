import { appendFileSync, mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from './support/trip';
import { bandAction, openHubView } from './support/hub';

/**
 * V1 CONVERGENCE — THE GOLDEN TRIPS, LIVE, THROUGH THE NORMAL APP.
 *
 * Run only through `playwright.v1-live.config.ts`. Each trip spends one
 * discovery scan (one model call); builds are planner-first and call no model.
 * Trip ids land in `.claude-private/artifacts/v1-convergence/trips.ndjson` so the
 * plans can be read back out of the database afterwards.
 */

const OUT = '.claude-private/artifacts/v1-convergence';
mkdirSync(OUT, { recursive: true });
const record = (row: Record<string, unknown>) => appendFileSync(`${OUT}/trips.ndjson`, `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
const shot = (page: Page, name: string) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
const tripIdOf = (page: Page) => /\/trips\/([0-9a-f-]{36})\//.exec(page.url())?.[1] ?? null;

async function smartDefaults(page: Page, label: string, destination: string, dates: { start: string; end: string }) {
  await createTrip(page, destination, dates);
  await page.waitForURL(/\/questionnaire$/, { timeout: 60_000 });
  const tripId = tripIdOf(page);
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  const started = Date.now();
  await defaults.click();
  await expect(page).toHaveURL(/\/discover$|\/build$/, { timeout: 60_000 });
  await shot(page, `${label}-1-scan`);
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 420_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  record({ label, destination, tripId, seconds: Math.round((Date.now() - started) / 1000), path: 'smart-defaults' });
  await shot(page, `${label}-2-overview`);
  await openHubView(page, 'days');
  await shot(page, `${label}-3-days`);
  return tripId;
}

test.describe.configure({ mode: 'serial' });

test('A — Utah road trip: find places, board, Choose for me, build, map, regenerate, pack', async ({ page }) => {
  await createTrip(page, 'Moab, Arches, Canyonlands and Capitol Reef, Utah', { start: '2026-10-14', end: '2026-10-19' });
  await page.waitForURL(/\/questionnaire$/, { timeout: 60_000 });
  const tripId = tripIdOf(page);
  await completeQuestionnaire(page);
  const find = page.getByTestId('interview-find-places');
  await waitUntilInteractive(find);
  const started = Date.now();
  await find.click();
  await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
  await shot(page, 'utah-1-scan');
  await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 300_000 });
  record({ label: 'utah', tripId, scanSeconds: Math.round((Date.now() - started) / 1000) });
  await shot(page, 'utah-2-board');
  await page.getByTestId('board-auto-pick').click();
  await expect(page.getByTestId('board-auto-pick-notes')).toBeVisible({ timeout: 60_000 });
  await shot(page, 'utah-3-autopick');
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 300_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await shot(page, 'utah-4-overview');
  await openHubView(page, 'days');
  await shot(page, 'utah-5-days');
  await openHubView(page, 'map');
  await page.waitForTimeout(3_000);
  await shot(page, 'utah-6-map');
  await openHubView(page, 'overview');
  await bandAction(page, 'Regenerate');
  await page.getByTestId('regenerate-trip').click();
  await expect(page.getByTestId('regenerate-confirm')).toBeVisible();
  await shot(page, 'utah-7-regenerate-confirm');
  await page.getByTestId('regenerate-confirm-start').click();
  await expect(page).toHaveURL(/\/build$/, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 300_000 });
  await page.goto(`/trips/${tripId}/pack`);
  await shot(page, 'utah-8-pack');
  record({ label: 'utah', tripId, done: true });
});

test('B — Mammoth Lakes (authored region) and the Mammoth Cave collision', async ({ page }) => {
  await smartDefaults(page, 'mammoth', 'Mammoth Lakes, California', { start: '2026-10-20', end: '2026-10-23' });
  await createTrip(page, 'Mammoth Cave National Park, Kentucky', { start: '2026-10-20', end: '2026-10-22' });
  await page.waitForURL(/\/questionnaire$/, { timeout: 60_000 });
  record({ label: 'mammoth-cave', tripId: tripIdOf(page) });
  await shot(page, 'mammoth-cave-questionnaire');
});

test('C — Tokyo, car-free', async ({ page }) => {
  await smartDefaults(page, 'tokyo', 'Tokyo', { start: '2026-11-03', end: '2026-11-08' });
});

test('D — New York City', async ({ page }) => {
  await smartDefaults(page, 'nyc', 'New York City', { start: '2026-11-10', end: '2026-11-14' });
});

/* The budget pair, split so either can be re-verified alone with `--grep`. */
test('E — Zurich (budget pair, expensive side)', async ({ page }) => {
  await smartDefaults(page, 'zurich', 'Zurich, Switzerland', { start: '2026-11-16', end: '2026-11-20' });
});

test('F — Hanoi (budget pair, cheap side)', async ({ page }) => {
  await smartDefaults(page, 'hanoi', 'Hanoi, Vietnam', { start: '2026-11-16', end: '2026-11-20' });
});
