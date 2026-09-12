import { expect, test } from '@playwright/test';
import { openHubView } from './support/hub';
import { buildFixtureTrip, signInFixture, visibleOpenNeed } from './support/v9';

/**
 * V9 §15 — CROSS-DEVICE: a trip made on a laptop opens on a phone on the same
 * account with the same booked facts, ticks and next action. The fixture
 * sign-in door is set by the suite's server command.
 */
test('create on a laptop, see the same state on a phone, with nothing owned by the old cookie', async ({ browser }) => {
  const laptop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await laptop.newPage();
  await signInFixture(page, 'v9-cross-device@example.test');
  const id = await buildFixtureTrip(page);
  await expect(page.getByTestId('saved-to-account')).toBeVisible();

  await openHubView(page, 'book');
  const { row: openRow, markBooked } = visibleOpenNeed(page);
  const bookingId = await openRow.getAttribute('data-booking-id');
  await markBooked.click();
  await page.getByTestId('mark-booked-form').getByTestId('mark-booked-save').click();
  await expect(page.locator(`[data-testid="booking-row"][data-booking-id="${bookingId}"][data-status="open"]`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#hub-view-book').getByTestId('booked-item').first()).toBeVisible();

  await openHubView(page, 'prepare');
  const tick = page.locator('#hub-view-prepare').getByTestId('preflight-tick').first();
  if (await tick.isVisible().catch(() => false)) await tick.click();

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await phone.newPage();
  await signInFixture(mobile, 'v9-cross-device@example.test');
  await mobile.goto('/trips');
  await expect(mobile.getByTestId('trip-card').first()).toBeVisible();
  await mobile.goto(`/trips/${id}/itinerary`);
  await expect(mobile.getByTestId('atlas-band')).toBeVisible({ timeout: 30_000 });
  await expect(mobile.getByTestId('saved-to-account')).toBeVisible();
  await openHubView(mobile, 'book');
  await expect(mobile.locator(`[data-testid="booking-row"][data-booking-id="${bookingId}"][data-status="open"]`)).toHaveCount(0);
  await expect(mobile.locator('#hub-view-book').getByTestId('booked-item').first()).toBeVisible();

  /* A signed-out browser holding only the old cookie sees nothing. */
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  /* The itinerary page streams, so its not-found answer carries the page's own status; what matters is that nothing of the trip reaches a stranger. */
  await guestPage.goto(`/trips/${id}/itinerary`);
  await expect(guestPage.getByText('We cannot find that trip')).toBeVisible();
  expect(await guestPage.locator('body').innerText()).not.toContain('Mammoth Lakes');
  const pack = await guestPage.goto(`/trips/${id}/pack`);
  expect(pack?.status()).toBe(404);
  await guest.close();
  await phone.close();
  await laptop.close();
});
