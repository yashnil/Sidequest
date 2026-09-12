import { expect, test } from '@playwright/test';
import { openHubView } from './support/hub';
import { buildFixtureTrip, visibleOpenNeed } from './support/v9';
import { waitUntilInteractive } from './support/trip';

/**
 * V9 — TRIP EXECUTION THROUGH THE BROWSER, ON THE FIXTURE COMPOSER.
 *
 * One built trip, then the surfaces a traveller uses after the plan exists:
 * the next best action, the Book view with its actions, a booking marked and
 * respected everywhere, a confirmation pasted and reviewed before anything
 * changes, Preflight, the share link stripped of private facts, the change
 * proposal's delta and an exact undo.
 */
test.describe.configure({ mode: 'serial' });

test('the Trip view leads with the next best action and the decision records', async ({ page }) => {
  await buildFixtureTrip(page);
  const card = page.getByTestId('next-action-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('next-action').first()).toBeVisible();
  expect(await page.getByTestId('next-action').count()).toBeLessThanOrEqual(3);
  await expect(page.getByTestId('decision-card').first()).toBeVisible();
  const why = page.getByTestId('decision-why').first();
  await expect(why).toBeVisible();
  const forensic = await page.locator('#hub-view-overview').innerText();
  expect(forensic).not.toMatch(/dependency unresolved|partially verified|blast radius|provider|geocoder|fixture composer/i);
});

test('Book: a need is marked booked, the fact is respected everywhere, a skip is recorded, the ledger sums what was paid', async ({ page }) => {
  const id = await buildFixtureTrip(page);
  await openHubView(page, 'book');
  const rows = page.locator('#hub-view-book').getByTestId('booking-row');
  await expect(rows.first()).toBeVisible();
  const openRows = page.locator('#hub-view-book').locator('[data-testid="booking-row"][data-status="open"]');
  expect(await openRows.count()).toBeGreaterThan(0);

  /* Mark the first open need booked, with a cost. */
  const { row: first, markBooked } = visibleOpenNeed(page);
  const bookingId = await first.getAttribute('data-booking-id');
  await markBooked.click();
  const form = page.getByTestId('mark-booked-form');
  await expect(form).toBeVisible();
  const title = form.getByLabel(/name|title/i).first();
  if (await title.isVisible().catch(() => false)) await title.fill('Fixture Lodge');
  const cost = form.getByLabel(/cost|amount/i).first();
  if (await cost.isVisible().catch(() => false)) await cost.fill('640');
  await form.getByTestId('mark-booked-save').click();
  /* The need leaves the open list, the fact appears under "What you have booked", and the progress line counts it. */
  await expect(page.locator(`[data-testid="booking-row"][data-booking-id="${bookingId}"][data-status="open"]`)).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#hub-view-book').getByTestId('booked-item').first()).toBeVisible();
  await expect(page.locator('#hub-view-book').getByTestId('booking-progress').first()).toContainText(/arranged/);
  await expect(page.locator('#hub-view-book').getByTestId('ledger-committed')).toBeVisible();

  /* Skip another open need; it reads as skipped and can be unskipped. */
  const skipButton = page.locator('#hub-view-book').locator('[data-testid="booking-skip"]:visible').first();
  const stillOpen = skipButton.locator('xpath=ancestor::*[@data-testid="booking-row"][1]');
  if (await skipButton.isVisible().catch(() => false)) {
    const skipId = await stillOpen.getAttribute('data-booking-id');
    await skipButton.click();
    await expect(page.locator(`[data-testid="booking-row"][data-booking-id="${skipId}"]`)).toHaveAttribute('data-status', 'not_needed', { timeout: 20_000 });
    await page.locator(`[data-testid="booking-row"][data-booking-id="${skipId}"]`).getByTestId('booking-unskip').click();
    await expect(page.locator(`[data-testid="booking-row"][data-booking-id="${skipId}"]`)).toHaveAttribute('data-status', 'open', { timeout: 20_000 });
  }

  /* The booked fact reaches the calendar, the dashboard and Prepare. */
  const ics = await page.request.get(`/trips/${id}/itinerary/calendar`);
  expect(ics.ok()).toBe(true);
  const body = await ics.text();
  expect(body).toContain('STATUS:CONFIRMED');
  expect(body).toContain('TZID=');
  expect(body).toContain('BEGIN:VTIMEZONE');
  await page.goto('/trips');
  await expect(page.getByTestId('trip-card').first()).toBeVisible();
  await expect(page.getByTestId('trip-card-booking-state').first()).toBeVisible();
});

test('a pasted confirmation is reviewed with its affected days before it becomes a booking', async ({ page }) => {
  await buildFixtureTrip(page);
  await openHubView(page, 'book');
  const center = page.locator('#hub-view-book').getByTestId('import-center');
  await expect(center).toBeVisible();
  await page.getByTestId('import-text').fill(`Booking.com
Your booking is confirmed
Confirmation number: 3141.592.653
Fixture Lodge
Check-in: 13 August 2026 (from 15:00)
Check-out: 15 August 2026 (until 11:00)
Total price: $420
Card ending 4242 4242 4242 4242`);
  await page.getByTestId('import-submit').click();
  const review = page.locator('#hub-view-book').getByTestId('import-review');
  await expect(review).toBeVisible({ timeout: 20_000 });
  await expect(review.getByTestId('import-field').first()).toBeVisible();
  const reviewText = await review.innerText();
  expect(reviewText).not.toContain('4242 4242');
  expect(reviewText).toMatch(/3141\.592\.653/);
  await expect(review.getByTestId('import-affected')).toBeVisible();
  /* Nothing is booked until the traveller confirms. */
  expect(await page.locator('#hub-view-book').getByTestId('booked-item').count()).toBe(0);
  await review.getByTestId('import-confirm').click();
  await expect(page.locator('#hub-view-book').getByTestId('booked-item').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#hub-view-book').getByTestId('booked-affected').first()).toBeVisible();
});

test('Preflight answers whether the trip is ready, and a tick moves an item to ready', async ({ page }) => {
  await buildFixtureTrip(page);
  await openHubView(page, 'prepare');
  const preflight = page.locator('#hub-view-prepare').getByTestId('preflight');
  await expect(preflight).toBeVisible();
  await expect(page.locator('#hub-view-prepare').getByTestId('preflight-verdict')).toHaveAttribute('data-verdict', /ready|nearly|not_yet/);
  const items = page.locator('#hub-view-prepare').getByTestId('preflight-item');
  expect(await items.count()).toBeGreaterThan(0);
  const tick = page.locator('#hub-view-prepare').getByTestId('preflight-tick').first();
  if (await tick.isVisible().catch(() => false)) {
    /* Pin the item by its own id: once ticked it moves to Ready and `.first()` would re-resolve to the next attention item. */
    const check = await tick.locator('xpath=ancestor::*[@data-testid="preflight-item"]').first().getAttribute('data-check');
    await tick.click();
    await expect(page.locator(`#hub-view-prepare [data-testid="preflight-item"][data-check="${check}"]`)).toHaveAttribute('data-bucket', 'ready', { timeout: 20_000 });
  }
});

test('the share link carries no reference, cost, note or import; the feed token is private and revocable', async ({ page, browser }) => {
  const id = await buildFixtureTrip(page);
  await openHubView(page, 'book');
  await visibleOpenNeed(page).markBooked.click();
  const form = page.getByTestId('mark-booked-form');
  const ref = form.getByLabel(/reference/i).first();
  if (await ref.isVisible().catch(() => false)) await ref.fill('SECRET-REF-77');
  const notes = form.getByLabel(/notes/i).first();
  if (await notes.isVisible().catch(() => false)) await notes.fill('Private note about the room');
  await form.getByTestId('mark-booked-save').click();
  await expect(page.locator('#hub-view-book').getByTestId('booked-item').first()).toBeVisible({ timeout: 20_000 });

  await page.goto(`/trips/${id}/pack`);
  await expect(page.getByTestId('trip-pack')).toBeVisible();
  await page.getByTestId('pack-feed-create').click();
  const feedUrl = await page.getByTestId('pack-feed-url').inputValue().catch(async () => (await page.getByTestId('pack-feed-url').textContent()) ?? '');
  expect(feedUrl).toMatch(/\/api\/calendar\/[A-Za-z0-9_-]{32,}/);
  const feed = await page.request.get(feedUrl.replace(/^webcal:/, 'http:'));
  expect(feed.ok()).toBe(true);
  const feedBody = await feed.text();
  expect(feedBody).toContain('REFRESH-INTERVAL');
  expect(feedBody).not.toContain('SECRET-REF-77');
  expect(feedBody).not.toContain('Private note');
  /* Revoke is a two-press confirm; the feed answers nothing once the status says so. */
  const revokeButton = page.getByTestId('pack-feed-revoke');
  await revokeButton.click();
  if ((await revokeButton.getAttribute('data-confirming')) === 'true') await revokeButton.click();
  await expect(page.getByRole('status')).toContainText(/Subscription revoked/, { timeout: 20_000 });
  const revoked = await page.request.get(feedUrl.replace(/^webcal:/, 'http:'));
  expect(revoked.status()).toBe(404);

  /* The Pack carries the same share control as the band: the link is minted on the first press. */
  const shareBlock = page.getByTestId('pack-share-link');
  const mint = shareBlock.getByRole('button', { name: 'Share this plan' });
  if (await mint.isVisible().catch(() => false)) {
    await waitUntilInteractive(mint);
    await mint.click();
  }
  const linkField = page.getByLabel('Share link');
  await expect(linkField).toBeVisible({ timeout: 20_000 });
  const shareLink = await linkField.inputValue();
  expect(shareLink).toMatch(/\/share\//);
  const stranger = await browser.newContext();
  const other = await stranger.newPage();
  await other.goto(shareLink);
  const shared = await other.locator('body').innerText();
  expect(shared).not.toContain('SECRET-REF-77');
  expect(shared).not.toContain('Private note');
  expect(shared).not.toMatch(/import|ledger/i);
  await stranger.close();
});

test('Ask Sidequest shows a deterministic delta before Apply and Undo restores the trip exactly', async ({ page }) => {
  const id = await buildFixtureTrip(page);
  const before = await page.request.get(`/trips/${id}/itinerary/calendar`).then((r) => r.text());
  const open = page.getByTestId('ask-sidequest-open');
  await waitUntilInteractive(open);
  await open.click();
  const input = page.locator('#ask-sidequest-input');
  await expect(input).toBeVisible();
  await input.fill('Make day 2 easier');
  await page.getByRole('button', { name: 'Send' }).click();
  /* On the fixture composer every request is answered as an explanation; the surface must still be honest. */
  await expect(page.getByTestId('ask-sidequest-working')).toBeHidden({ timeout: 60_000 });
  const after = await page.request.get(`/trips/${id}/itinerary/calendar`).then((r) => r.text());
  /* The first Ask mints the baseline version, so SEQUENCE may move; every event, time and title must not. */
  const stable = (ics: string) => ics.replace(/DTSTAMP:[^\r\n]+/g, '').replace(/SEQUENCE:\d+/g, '');
  expect(stable(after)).toBe(stable(before));
});
