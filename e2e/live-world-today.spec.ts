import { expect, test } from '@playwright/test';
import { createTrip, waitForLookup, waitUntilInteractive } from './support/trip';

/**
 * LIVE WORLD V1 — Today mode, on a fixture clock set inside the trip's dates
 * (see `playwright.today.config.ts`). The section appears only while the trip
 * is under way and reads the persisted plan; nothing is fetched.
 */
test('Today mode shows now, next, the next leg with its basis, and the day’s stops', async ({ page }) => {
  const id = await createTrip(page, 'Mammoth Lakes');
  if (/\/plan/.test(page.url())) await waitForLookup(page);
  await page.goto(`/trips/${id}/questionnaire`);
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await page.waitForURL(/\/itinerary$/, { timeout: 120_000 });
  const today = page.getByTestId('hub-today');
  await expect(today).toBeVisible();
  await expect(today).toContainText(/Today · day 2/);
  await expect(page.getByTestId('today-now')).toBeVisible();
  await expect(page.getByTestId('today-next')).toBeVisible();
  await expect(page.getByTestId('today-stops').locator('li').first()).toBeVisible();
});
