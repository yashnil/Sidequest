import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { createTrip, waitForLookup, waitUntilInteractive } from '../../../e2e/support/trip';
import { signInFixture } from '../../../e2e/support/v9';
import { openHubView } from '../../../e2e/support/hub';
import { addDays, span, summerTrip, todayIso } from '../../../e2e/support/dates';

/**
 * Every signed-in surface, before and after. One fresh account per width, so
 * the first dashboard is truly empty; then one trip, then several at different
 * points in their life (idea, planning, under way, past).
 */
const SHOTS = process.env.SHOTS ?? 'before';
const ROOT = new URL(`../${SHOTS}/`, import.meta.url).pathname;

async function settle(page: Page, ms = 1200) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function shot(page: Page, project: string, name: string, full = false) {
  mkdirSync(`${ROOT}${project}`, { recursive: true });
  await page.screenshot({ path: `${ROOT}${project}/${name}.jpg`, fullPage: full, type: 'jpeg', quality: 72 });
}

async function buildTrip(page: Page, project: string, destination: string, dates: { start: string; end: string }, snap: boolean): Promise<string> {
  const id = await createTrip(page, destination, dates);
  if (/\/plan/.test(page.url())) await waitForLookup(page);
  await page.goto(`/trips/${id}/questionnaire`);
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  if (snap) {
    await settle(page);
    await shot(page, project, '05-questionnaire');
  }
  await defaults.click();
  await page.waitForURL(/\/itinerary$/, { timeout: 120_000 });
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 30_000 });
  return id;
}

test('the signed-in experience, end to end', async ({ page }, info) => {
  const project = info.project.name;
  const email = `continuity-${project}-${Date.now()}@example.test`;

  await page.goto('/');
  await settle(page, 4500);
  await shot(page, project, '00-landing');
  await page.goto('/signin');
  await settle(page);
  await shot(page, project, '01-signin');

  await signInFixture(page, email);
  await settle(page, 2000);
  await shot(page, project, '02-dashboard-first');
  await shot(page, project, '02-dashboard-first-full', true);

  await page.goto('/decide');
  await settle(page);
  await shot(page, project, '03-decide');

  await page.goto('/trips/new');
  await settle(page);
  await shot(page, project, '04-new-trip');

  const id = await buildTrip(page, project, 'Mammoth Lakes', summerTrip(5), true);
  await settle(page, 2000);
  await shot(page, project, '07-itinerary');
  await shot(page, project, '07-itinerary-full', true);
  for (const view of ['map', 'book', 'prepare'] as const) {
    await openHubView(page, view).catch(async () => {
      await page.getByTestId(page.viewportSize()!.width < 640 ? `hub-bottom-${view}` : `hub-link-${view}`).click({ force: true });
    });
    await settle(page, 1500);
    await shot(page, project, `08-${view}`);
  }
  await page.goto(`/trips/${id}/discover`);
  await settle(page, 2000);
  await shot(page, project, '06-board');

  await page.goto('/trips');
  await settle(page, 2000);
  await shot(page, project, '09-dashboard-one', true);

  /* An idea (never built), a trip under way today, and one that is over. */
  await createTrip(page, 'Lisbon', span(addDays(todayIso(), 60), 4)).catch(() => undefined);
  await buildTrip(page, project, 'Mammoth Lakes', span(addDays(todayIso(), -1), 4), false).catch(() => undefined);
  await buildTrip(page, project, 'Mammoth Lakes', span(addDays(todayIso(), -40), 3), false).catch(() => undefined);
  await page.goto('/trips');
  await settle(page, 2500);
  await shot(page, project, '10-dashboard-many');
  await shot(page, project, '10-dashboard-many-full', true);
});
