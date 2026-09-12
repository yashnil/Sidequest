import { expect, test } from '@playwright/test';
import { buildFixtureTrip } from './support/v9';
import { DEFAULT_DATES } from './support/trip';
import { expectNoHorizontalOverflow } from './support/viewports';

/**
 * V9 — TODAY V2 on the fixture clock (`playwright.today.config.ts` sets
 * `SIDEQUEST_FIXTURE_NOW` inside the default trip's dates).
 */
test('Today answers now, next, when to leave, how to get there, and what to fall back on', async ({ page }) => {
  const id = await buildFixtureTrip(page, 'Mammoth Lakes', DEFAULT_DATES);
  await page.goto(`/trips/${id}/today`);
  const today = page.getByTestId('today-page');
  await expect(today).toBeVisible();
  await expect(page.getByTestId('today-now')).toBeVisible();
  await expect(page.getByTestId('today-next')).toBeVisible();
  await expect(page.getByTestId('today-timeline')).toBeVisible();
  expect(await page.getByTestId('today-stop').count()).toBeGreaterThan(0);
  const text = await today.innerText();
  expect(text).not.toMatch(/fixture|provider|dependency unresolved|blast radius/i);
  /* No planner chrome. */
  await expect(page.getByTestId('trip-hub-nav')).toHaveCount(0);
  const change = page.getByTestId('today-change');
  await expect(change).toBeVisible();
});

test('Today fits a phone one-handed with no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await buildFixtureTrip(page, 'Mammoth Lakes', DEFAULT_DATES);
  await page.goto(`/trips/${id}/today`);
  await expect(page.getByTestId('today-page')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const change = page.getByTestId('today-change');
  const box = await change.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test('the dashboard sends a traveling trip to Today', async ({ page }) => {
  await buildFixtureTrip(page, 'Mammoth Lakes', DEFAULT_DATES);
  await page.goto('/trips');
  const card = page.getByTestId('trip-card').first();
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-lifecycle', 'traveling');
  await expect(card.getByTestId('trip-card-action')).toHaveAttribute('href', /\/today$/);
});
