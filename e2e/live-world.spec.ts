import { expect, test, type Page } from '@playwright/test';
import { createTrip, waitForLookup, waitUntilInteractive } from './support/trip';
import { openHubView, openPrepareReference } from './support/hub';

/** The hub nav that exists at this viewport: the segmented bar on desktop, the bottom bar on phones. */
function hubNav(page: Page) {
  return (page.viewportSize()?.width ?? 1440) < 640 ? page.getByTestId('trip-hub-bottom-nav') : page.getByTestId('trip-hub-nav');
}

/**
 * LIVE WORLD V1 — browser acceptance, fixture mode, zero spend.
 *
 * Day editing without a model call; a deterministic "Fix this day"; booking
 * status edits; targeted discovery that never quotes a price; the recheck
 * manifest; navigation handoff only for verified stops; route shapes on the
 * map; and the plan surviving the network going away.
 */
async function buildWithDefaults(page: Page): Promise<string> {
  const id = await createTrip(page, 'Mammoth Lakes');
  if (/\/plan/.test(page.url())) await waitForLookup(page);
  await page.goto(`/trips/${id}/questionnaire`);
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await page.waitForURL(/\/itinerary$/, { timeout: 120_000 });
  await expect(hubNav(page)).toBeVisible();
  return id;
}

test('a stop can be moved later, a stop of your own added, and a day fixed — without a model call', async ({ page }) => {
  await buildWithDefaults(page);
  await openHubView(page, 'days');
  const controls = page.getByTestId('stop-day-controls').first();
  await waitUntilInteractive(controls);
  await controls.getByRole('button', { name: /Move, re-time or keep/ }).click();
  await page.getByTestId('stop-later').first().click();
  // The moved stop keeps its open controls (rows are keyed by item id) but is no longer first.
  await expect(page.getByRole('status').filter({ hasText: /now comes|already last/ }).first()).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('add-stop-open').first().click();
  await page.getByTestId('add-stop-title').first().fill('Harbour swim');
  await page.getByTestId('add-stop-submit').first().click();
  await expect(page.getByText('Harbour swim').first()).toBeVisible({ timeout: 15_000 });
  // An added stop is unverified until a rebuild looks it up — never a link to a guess.
  await expect(page.getByText(/You added this yourself/).first()).toBeVisible();

  const fix = page.getByTestId('fix-day').first();
  await fix.click();
  await expect(page.getByTestId('fix-day-status').first()).toContainText(/fits|still|already/, { timeout: 15_000 });
});

test('a booking can change status and cost; the Verify section says when to look again; stays can be found without a price', async ({ page }) => {
  await buildWithDefaults(page);
  await openHubView(page, 'plan');
  await page.getByTestId('booked-add').first().click();
  await page.getByTestId('booked-title').fill('Hotel by the creek');
  await page.getByTestId('booked-date').fill('2026-08-12');
  await page.getByTestId('booked-end-date').fill('2026-08-16');
  await page.getByTestId('booked-save').click();
  // EXPERIENCE V2 — bookings are one Plan segment; the saved item lists there.
  await page.getByTestId('plan-tab-bookings').click();
  const status = page.getByTestId('booked-status').first();
  await expect(status).toBeVisible({ timeout: 15_000 });
  await status.selectOption('idea');
  await expect(page.getByTestId('booked-item').first()).toContainText(/idea/, { timeout: 15_000 });
  await page.reload();
  await openHubView(page, 'plan');
  await expect(page.getByTestId('booked-item').first()).toContainText(/idea/);

  await openHubView(page, 'prepare');
  await openPrepareReference(page);
  await expect(page.getByTestId('hub-recheck')).toBeVisible();
  await expect(page.locator('[data-testid="hub-recheck"] li').first()).toHaveAttribute('data-window', /.+/);

  await openHubView(page, 'plan');
  await page.getByTestId('plan-tab-stays').click();
  const discover = page.getByTestId('discover-stays-button').first();
  await discover.scrollIntoViewIfNeeded();
  await discover.click();
  const results = page.getByTestId('discover-stays-results').first();
  await expect(results).toBeVisible({ timeout: 15_000 });
  await expect(results).toContainText('Harbourside Guesthouse');
  await expect(results).toContainText(/no live room prices or availability/);
  await expect(results).not.toContainText(/tonight|rooms available/);
});

test('verified stops hand off to a map app, measured legs draw as routes or straight lines, and the plan opens offline', async ({ page, context }) => {
  await buildWithDefaults(page);
  await openHubView(page, 'days');
  await expect(page.getByTestId('stop-navigation').first()).toBeVisible();
  const anchor = page.getByTestId('stop-navigation').first().getByRole('link').first();
  await expect(anchor).toHaveAttribute('href', /google\.com\/maps\/search/);
  await expect(page.locator('[data-connector-shape]').first()).toBeAttached();

  const snapshot = page.getByTestId('offline-snapshot');
  await expect(snapshot).toHaveAttribute('data-state', 'saved', { timeout: 20_000 });
  // Let the worker take control and cache the shell.
  await page.waitForTimeout(1_000);
  await page.reload();
  await expect(hubNav(page)).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(hubNav(page)).toBeVisible({ timeout: 20_000 });
  await context.setOffline(false);
});
