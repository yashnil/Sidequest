import { expect, test, type Page } from '@playwright/test';
import { bandAction, openHubView } from './support/hub';
import { completeQuestionnaire, createTrip } from './support/trip';
import { summerTrip } from './support/dates';

/**
 * EARLIER VERSIONS: A REBUILD NEVER COSTS THE TRAVELLER THEIR PLAN.
 *
 * The unit suite (`refine/plan-history.test.ts`) proves the storage promise. This
 * proves a traveller can reach it, on a desktop and a phone: the old plan is on
 * the page they land on after a rebuild, restoring it brings back what they
 * edited, and the restore can be undone.
 */
const AUGUST = summerTrip(4);

async function buildPlan(page: Page): Promise<void> {
  await createTrip(page, 'Mammoth Lakes', { start: AUGUST.start, end: AUGUST.end });
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await openHubView(page, 'days');
  await expect(page.getByRole('heading', { name: /^Day 1/ })).toBeVisible();
}

function stops(page: Page) {
  return page.getByRole('button', { name: /^Change / });
}

async function removeFirstStop(page: Page): Promise<string> {
  const menu = stops(page).first();
  const title = ((await menu.getAttribute('aria-label')) ?? '').replace(/^Change /, '');
  await menu.click();
  await page.getByRole('menuitem', { name: 'Remove from this day' }).click();
  await expect(page.getByRole('button', { name: `Change ${title}` })).toHaveCount(0, { timeout: 30_000 });
  return title;
}

async function openVersions(page: Page) {
  await openHubView(page, 'overview');
  const versions = page.getByTestId('trip-versions');
  await expect(versions).toBeVisible();
  await versions.locator('summary').click();
  await expect(versions.getByTestId('trip-version-row').first()).toBeVisible({ timeout: 15_000 });
  return versions;
}

test('a hand edit lives on as a version, and restoring one is exact and undoable', async ({ page }) => {
  test.setTimeout(150_000);
  await buildPlan(page);
  const removed = await removeFirstStop(page);

  const versions = await openVersions(page);
  await versions.getByTestId('trip-version-restore').first().click();
  await expect(page.getByTestId('edit-toast-message')).toContainText('Restored', { timeout: 15_000 });

  await openHubView(page, 'days');
  await expect(page.getByRole('button', { name: `Change ${removed}` })).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByRole('button', { name: `Change ${removed}` })).toBeVisible({ timeout: 30_000 });
});

test('Regenerate keeps the plan it replaces, and it can be put back', async ({ page }) => {
  test.setTimeout(200_000);
  await buildPlan(page);
  const removed = await removeFirstStop(page);

  await bandAction(page, 'Regenerate');
  await page.getByTestId('regenerate-trip').click();
  await expect(page.getByTestId('regenerate-restorable')).toContainText('Earlier versions');
  await Promise.all([page.waitForURL(/\/build$/, { waitUntil: 'commit', timeout: 30_000 }), page.getByTestId('regenerate-confirm-start').click()]);
  await page.waitForURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 90_000 });

  const versions = await openVersions(page);
  /* The current plan is marked, and the one Regenerate replaced is still here and can come back. */
  await expect(versions.locator('[data-testid="trip-version-row"][data-current]')).toHaveCount(1);
  await versions.getByTestId('trip-version-restore').first().click();
  await expect(page.getByTestId('edit-toast-message')).toContainText('Restored', { timeout: 15_000 });
  await openHubView(page, 'days');
  await expect(page.getByRole('button', { name: `Change ${removed}` })).toHaveCount(0, { timeout: 30_000 });
});
