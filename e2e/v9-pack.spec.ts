import { expect, test } from '@playwright/test';
import { buildFixtureTrip } from './support/v9';
import { expectNoHorizontalOverflow } from './support/viewports';

/**
 * V9 — TAKE SIDEQUEST WITH YOU: the one export surface, the images, the
 * offline copy, the map handoff.
 */
test('the Trip Pack offers every export from one place, and the images carry no private data', async ({ page }) => {
  const id = await buildFixtureTrip(page);
  await page.goto(`/trips/${id}/pack`);
  await expect(page.getByTestId('trip-pack')).toBeVisible();
  for (const testId of ['pack-pdf', 'pack-calendar-file', 'pack-feed-create', 'pack-offline', 'pack-card-image', 'pack-packing']) {
    await expect(page.getByTestId(testId), testId).toBeVisible();
  }
  await expect(page.getByTestId('pack-map-day-1')).toBeVisible();
  const google = await page.getByTestId('pack-map-day-1').getAttribute('href');
  /* A day with one positioned stop hands off a place; two or more, a route. Both are the official URL form. */
  expect(google).toMatch(/google\.com\/maps\/(dir|search)\/\?api=1/);

  const card = await page.request.get(`/trips/${id}/card`);
  expect(card.ok()).toBe(true);
  expect(card.headers()['content-type']).toMatch(/image\/png/);
  const day = await page.request.get(`/trips/${id}/days/1/card`);
  expect(day.ok()).toBe(true);

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const json = (await manifest.json()) as { name?: string; icons?: unknown[]; display?: string };
  expect(json.name).toMatch(/Sidequest/);
  expect(json.display).toBe('standalone');
  expect((json.icons ?? []).length).toBeGreaterThan(0);
});

test('the offline copy opens Today and the itinerary without a network', async ({ page, context }) => {
  const id = await buildFixtureTrip(page);
  await page.goto(`/trips/${id}/pack`);
  await expect(page.getByTestId('pack-offline')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  await context.setOffline(true);
  await page.goto(`/trips/${id}/itinerary`);
  await expect(page.getByTestId('atlas-band')).toBeVisible({ timeout: 30_000 });
  await page.goto(`/trips/${id}/today`);
  await expect(page.getByTestId('today-page').or(page.getByText(/not travelling today/i)).first()).toBeVisible({ timeout: 30_000 });
  await context.setOffline(false);
});

test('a foreign browser cannot fetch another trip’s images, pack or calendar', async ({ page, browser }) => {
  const id = await buildFixtureTrip(page);
  const stranger = await browser.newContext();
  for (const path of [`/trips/${id}/card`, `/trips/${id}/days/1/card`, `/trips/${id}/itinerary/calendar`]) {
    const response = await stranger.request.get(path);
    expect(response.status(), path).toBe(404);
  }
  const packPage = await stranger.newPage();
  const response = await packPage.goto(`/trips/${id}/pack`);
  expect(response?.status()).toBe(404);
  await stranger.close();
});

test('the Pack and Book views fit a narrow phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const id = await buildFixtureTrip(page);
  await page.goto(`/trips/${id}/pack`);
  await expect(page.getByTestId('trip-pack')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.goto(`/trips/${id}/itinerary#book`);
  await expect(page.locator('#hub-view-book')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
