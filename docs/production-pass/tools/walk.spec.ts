import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from '../../../e2e/support/trip';

/**
 * The primary journey, one screenshot per surface: home → new trip → interview
 * → review → scan/board → build → itinerary views → share. Fixture providers only.
 */
const OUT = process.env.WALK_OUT ?? 'docs/production-pass/shots';
const DESTINATION = process.env.WALK_DESTINATION ?? 'Harbour City';
const DATES = { start: '2026-11-10', end: '2026-11-14' };

let n = 0;
async function shot(page: Page, name: string, full = false) {
  n += 1;
  const project = test.info().project.name;
  const dir = path.join(OUT, project);
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(Number(process.env.WALK_SETTLE_MS ?? 600));
  await page.screenshot({ path: path.join(dir, `${String(n).padStart(2, '0')}-${name}.png`), fullPage: full, animations: 'disabled' });
}

test('walk the primary journey', async ({ page }) => {
  n = 0;
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await shot(page, 'home');
  await shot(page, 'home-full', true);
  await page.goto('/trips/new');
  await waitUntilInteractive(page.getByTestId('destination-input'));
  await shot(page, 'new-trip');
  await page.getByTestId('destination-input').fill(DESTINATION);
  await shot(page, 'new-trip-typed');
  await createTrip(page, DESTINATION, DATES);
  /* A real geocoder may ask "which one?" on the plan page — the walk records it and takes the first reading. */
  const which = page.getByRole('heading', { name: /More than one place is called/ });
  await Promise.race([page.waitForURL(/\/questionnaire$/, { timeout: 60_000 }), which.waitFor({ timeout: 60_000 })]);
  if (await which.isVisible().catch(() => false)) {
    await shot(page, 'which-one');
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await page.waitForURL(/\/questionnaire$/, { timeout: 60_000 });
  await expect(page.getByTestId('interview')).toBeVisible({ timeout: 20_000 });
  await shot(page, 'interview-start');
  const start = page.getByTestId('interview-start');
  if (await start.isVisible().catch(() => false)) { await waitUntilInteractive(start); await start.click(); }
  await page.waitForTimeout(800);
  await shot(page, 'interview-q1');
  await completeQuestionnaire(page);
  await shot(page, 'review');
  await shot(page, 'review-full', true);
  const find = page.getByTestId('interview-find-places');
  await waitUntilInteractive(find);
  await find.click();
  await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
  await shot(page, 'scan');
  await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 90_000 });
  await shot(page, 'board');
  await shot(page, 'board-full', true);
  const build = page.getByRole('button', { name: /Build my trip|Rebuild my trip/ });
  await build.click();
  await page.waitForTimeout(700);
  await shot(page, 'building');
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 120_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await shot(page, 'itinerary');
  await shot(page, 'itinerary-full', true);
  for (const view of ['days', 'map', 'prepare', 'book']) {
    const link = page.getByTestId(test.info().project.name === 'mobile' ? `hub-bottom-${view}` : `hub-link-${view}`);
    if (await link.count()) {
      await link.first().click().catch(() => undefined);
      await page.waitForTimeout(700);
      await shot(page, `hub-${view}`);
    }
  }
  await page.goto('/trips');
  await shot(page, 'trips');
  console.log('page errors:', errors.length, errors.slice(0, 5));
});
