import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createTrip, waitUntilInteractive } from '../support/trip';
import { bandAction, openHubView } from '../support/hub';

/**
 * PRIVATE ALPHA — DOES A REAL TRIP SURVIVE A REDEPLOY, AND WHO CAN SEE IT?
 *
 * Manual and paid (one discovery scan): `SIDEQUEST_ALPHA_LIVE=1`.
 *
 *   SIDEQUEST_ALPHA_PHASE=create  build a trip, record a "maybe", a booking with a
 *                                 private reference and note, a calendar feed and
 *                                 a share link; save the browser session and a
 *                                 snapshot to SIDEQUEST_ALPHA_STATE.
 *   (restart or redeploy the service)
 *   SIDEQUEST_ALPHA_PHASE=verify  reopen with the saved session and compare;
 *                                 open everything a stranger could reach.
 */
const live = process.env.SIDEQUEST_ALPHA_LIVE === '1';
const phase = process.env.SIDEQUEST_ALPHA_PHASE ?? 'create';
const statePath = process.env.SIDEQUEST_ALPHA_STATE ?? 'test-results/alpha-state.json';
const sessionPath = `${statePath}.session.json`;
const DESTINATION = process.env.SIDEQUEST_ALPHA_DESTINATION ?? 'Seoul, South Korea';
const PRIVATE_REF = 'ALPHA-REF-4471';
const PRIVATE_NOTE = 'Private alpha note about the room';

interface Snapshot { tripId: string; dayThemes: string[]; maybePlaceId: string | null; shareUrl: string; feedUrl: string; bookedTitle: string | null }

test.skip(!live, 'Paid live suite: set SIDEQUEST_ALPHA_LIVE=1.');

test('create: one real trip with decisions, a booking, a feed and a share link', async ({ page, context }) => {
  test.skip(phase !== 'create');
  await createTrip(page, DESTINATION, { start: '2027-04-12', end: '2027-04-16' });
  await page.waitForURL(/\/questionnaire$/, { timeout: 60_000 });
  const tripId = /\/trips\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 480_000 });
  await openHubView(page, 'days');
  const dayThemes = (await page.locator('#hub-view-days [data-testid^="day-card-"]').allInnerTexts()).map((t) => t.split('\n').slice(0, 3).join(' | ').slice(0, 160));
  expect(dayThemes.length).toBeGreaterThan(2);

  // A traveller decision on the board.
  await page.goto(`/trips/${tripId}/discover`);
  await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 60_000 });
  const card = page.locator('[data-place-card]').nth(3);
  const maybePlaceId = await card.getAttribute('data-place-card');
  await card.getByRole('group', { name: /Your decision on/ }).getByRole('button').nth(1).click();
  await expect(card.getByRole('group', { name: /Your decision on/ }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });

  // A booking with private facts.
  await page.goto(`/trips/${tripId}/itinerary`);
  await openHubView(page, 'book');
  const markBooked = page.locator('#hub-view-book').locator('[data-testid="booking-mark-booked"]:visible').first();
  let bookedTitle: string | null = null;
  if (await markBooked.isVisible().catch(() => false)) {
    await markBooked.click();
    const form = page.getByTestId('mark-booked-form');
    const ref = form.getByLabel(/reference/i).first();
    if (await ref.isVisible().catch(() => false)) await ref.fill(PRIVATE_REF);
    const notes = form.getByLabel(/notes/i).first();
    if (await notes.isVisible().catch(() => false)) await notes.fill(PRIVATE_NOTE);
    await form.getByTestId('mark-booked-save').click();
    const booked = page.locator('#hub-view-book').getByTestId('booked-item').first();
    await expect(booked).toBeVisible({ timeout: 30_000 });
    bookedTitle = (await booked.innerText()).split('\n')[0] ?? null;
  }

  // A calendar feed and a share link.
  await page.goto(`/trips/${tripId}/pack`);
  await expect(page.getByTestId('trip-pack')).toBeVisible();
  await page.getByTestId('pack-feed-create').click();
  const feedUrl = await page.getByTestId('pack-feed-url').inputValue().catch(async () => (await page.getByTestId('pack-feed-url').textContent()) ?? '');
  expect(feedUrl).toMatch(/\/api\/calendar\/[A-Za-z0-9_-]{32,}/);
  const mint = page.getByTestId('pack-share-link').getByRole('button', { name: 'Share this plan' });
  if (await mint.isVisible().catch(() => false)) {
    await waitUntilInteractive(mint);
    await mint.click();
  }
  const linkField = page.getByLabel('Share link');
  await expect(linkField).toBeVisible({ timeout: 20_000 });
  const shareUrl = await linkField.inputValue();

  const snapshot: Snapshot = { tripId, dayThemes, maybePlaceId, shareUrl, feedUrl, bookedTitle };
  writeFileSync(statePath, JSON.stringify(snapshot, null, 1));
  await context.storageState({ path: sessionPath });
});

test('verify: everything survived, and a stranger sees only the share page', async ({ browser }) => {
  test.skip(phase !== 'verify');
  expect(existsSync(statePath), `no snapshot at ${statePath}; run the create phase first`).toBe(true);
  const snap = JSON.parse(readFileSync(statePath, 'utf8')) as Snapshot;

  // The owner, with the same browser session.
  const owner = await browser.newContext({ storageState: sessionPath });
  const page = await owner.newPage();
  await page.goto(`/trips/${snap.tripId}/itinerary`);
  await expect(page.getByTestId('route-overview')).toBeVisible({ timeout: 60_000 });
  await openHubView(page, 'days');
  const themes = (await page.locator('#hub-view-days [data-testid^="day-card-"]').allInnerTexts()).map((t) => t.split('\n').slice(0, 3).join(' | ').slice(0, 160));
  expect(themes).toEqual(snap.dayThemes);
  if (snap.bookedTitle) {
    await openHubView(page, 'book');
    await expect(page.locator('#hub-view-book').getByTestId('booked-item').first()).toContainText(snap.bookedTitle.slice(0, 20));
  }
  if (snap.maybePlaceId) {
    await page.goto(`/trips/${snap.tripId}/discover`);
    const card = page.locator(`[data-place-card="${snap.maybePlaceId}"]`);
    await expect(card.getByRole('group', { name: /Your decision on/ }).getByRole('button').nth(1)).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
  }
  const feed = await page.request.get(snap.feedUrl.replace(/^webcal:/, 'https:'));
  expect(feed.status()).toBe(200);
  const ics = await feed.text();
  expect(ics).toContain('BEGIN:VCALENDAR');
  expect(ics).not.toContain(PRIVATE_REF);
  expect(ics).not.toContain(PRIVATE_NOTE);
  expect(ics).not.toMatch(/localhost|railway\.internal/);
  await owner.close();

  // A stranger: the share page only.
  const stranger = await browser.newContext();
  const other = await stranger.newPage();
  const shared = await other.goto(snap.shareUrl);
  expect(shared?.status()).toBe(200);
  const sharedText = await other.locator('body').innerText();
  expect(sharedText).not.toContain(PRIVATE_REF);
  expect(sharedText).not.toContain(PRIVATE_NOTE);
  expect(sharedText).not.toMatch(/import|ledger|sk-ant-|SIDEQUEST_/i);
  const sharedHtml = await other.content();
  expect(sharedHtml).not.toContain(snap.tripId);
  expect(sharedHtml).not.toMatch(/localhost|railway\.internal/);
  for (const path of [`/trips/${snap.tripId}/itinerary`, `/trips/${snap.tripId}/discover`, `/trips/${snap.tripId}/pack`, `/trips/${snap.tripId}/questionnaire`]) {
    await other.goto(path);
    const body = await other.locator('body').innerText();
    const ownerLine = (snap.dayThemes[1] ?? '').split(' | ').find((part) => part.length > 12) ?? '\u0000never';
    expect(body, `${path} must not show the owner's trip to a stranger`).not.toContain(ownerLine);
    expect(body).not.toContain(PRIVATE_NOTE);
  }
  const strangerIcs = await other.request.get(`/trips/${snap.tripId}/itinerary/calendar`);
  expect(strangerIcs.status()).not.toBe(200);
  await stranger.close();
});

test('regenerate: the owner rebuilds the saved trip on the planner (no model call)', async ({ browser }) => {
  test.skip(phase !== 'regenerate');
  const snap = JSON.parse(readFileSync(statePath, 'utf8')) as Snapshot;
  const owner = await browser.newContext({ storageState: sessionPath });
  const page = await owner.newPage();
  await page.goto(`/trips/${snap.tripId}/itinerary`);
  await expect(page.getByTestId('route-overview')).toBeVisible({ timeout: 60_000 });
  await openHubView(page, 'overview');
  await bandAction(page, 'Regenerate');
  await page.getByTestId('regenerate-trip').click();
  await page.getByTestId('regenerate-confirm-start').click();
  await expect(page).toHaveURL(/\/build$/, { timeout: 30_000 });
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 300_000 });
  await openHubView(page, 'days');
  const days = await page.locator('#hub-view-days').innerText();
  writeFileSync(`${statePath}.regenerated.txt`, days);
  await owner.close();
});
