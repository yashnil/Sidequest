import { expect, test, type Page } from '@playwright/test';
import { waitUntilInteractive } from './support/trip';

/**
 * THE SHARE LINK, END TO END: MINTED BY THE OWNER, READ BY A STRANGER.
 *
 * One journey, deliberately, because the property under test is a relationship
 * between two browsers: the owner's — cookie, board, edit controls — and a
 * fresh context that has never seen the trip and holds nothing but the link.
 * The fresh context is the whole point: a share view that only renders for the
 * browser that built the trip is not sharing, and a share view that renders
 * *more* than the plan for a stranger is the leak §22 forbids.
 *
 * The refusals are asserted in the same journey: an invented token and the
 * trip's own id both meet a plain 404 that names nothing, because the token is
 * the only key and a guess must not learn whether it was close.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function reachBoard(page: Page, dates = AUGUST) {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();

  await page.getByRole('radio', { name: 'Hiking: A few times' }).check();
  await page.getByRole('radio', { name: 'Lakes & rivers: A few times' }).check();
  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'Geology & geothermal: Once or twice' }).check();

  for (const heading of [
    'How should the days feel?',
    'What is the spending style?',
    'How do you want to eat?',
    'Famous or off the track?',
    'How are you getting around?',
    'How far from Mammoth Lakes?',
    'Anything to steer around?',
    'Your trip personality',
  ]) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }

  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: 'Classics worth your time' })).toBeVisible();
}

async function buildTrip(page: Page) {
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Mammoth Lakes', exact: true })).toBeVisible();
}

test('a share link opens the plan, read-only, for a browser that never saw the trip', async (
  { page, browser },
  testInfo,
) => {
  await reachBoard(page);
  await buildTrip(page);
  const tripId = /\/trips\/([^/]+)\//.exec(page.url())?.[1];
  expect(tripId, 'a trip id should be in the URL').toBeTruthy();

  // The owner mints the link. The control is a client leaf, so wait for the
  // app to own it before pressing — see `waitUntilInteractive`.
  const share = page.getByRole('button', { name: 'Share this plan' });
  await waitUntilInteractive(share);
  await share.click();
  const linkField = page.getByLabel('Share link');
  await expect(linkField).toBeVisible();
  const url = await linkField.inputValue();
  // A token path, never an id path: the id is the key to the owner surfaces.
  expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{22,}$/);
  expect(url).not.toContain(tripId!);

  // A second press next week hands back the same link, not a replacement.
  await page.reload();
  const shareAgain = page.getByRole('button', { name: 'Share this plan' });
  await waitUntilInteractive(shareAgain);
  await shareAgain.click();
  await expect(page.getByLabel('Share link')).toHaveValue(url);

  // A stranger: fresh context, no cookies, nothing but the link.
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const reader = await context.newPage();

  // A guessed token is a plain 404 that names nothing.
  const invented = await reader.goto('/share/AAAAAAAAAAAAAAAAAAAAAA');
  expect(invented?.status()).toBe(404);
  await expect(reader.getByRole('heading', { name: 'Nothing here' })).toBeVisible();

  // The trip's own id is not a key. Enumerate-by-id opens nothing.
  const byId = await reader.goto(`/share/${tripId}`);
  expect(byId?.status()).toBe(404);

  // The real link opens the real plan: days, stops, meals, transport.
  await reader.goto(url);
  await expect(reader.getByRole('heading', { name: 'Mammoth Lakes', exact: true })).toBeVisible();
  await expect(reader.getByText('Shared with you')).toBeVisible();
  for (const dayNumber of [1, 2, 3, 4]) {
    await expect(
      reader.getByRole('heading', { name: new RegExp(`^Day ${dayNumber}`) }),
    ).toBeVisible();
  }
  await expect(reader.getByText(/\d+ min on the road/).first()).toBeVisible();
  await expect(reader.getByRole('heading', { name: 'Lunch' }).first()).toBeVisible();
  await expect(reader.getByText(/modelled travel time/).first()).toBeVisible();
  // The licence notice survives into the shared copy; the data obligation
  // follows the plan wherever it is read.
  await expect(reader.getByTestId('itinerary-attribution')).toBeVisible();

  // Read-only: none of the owner's controls exist for the reader.
  await expect(reader.getByRole('link', { name: 'Back to the board' })).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Share this plan' })).toHaveCount(0);
  await expect(reader.getByText('Make this day easier')).toHaveCount(0);
  await expect(reader.getByLabel(/^Change /)).toHaveCount(0);
  await expect(reader.getByText('Calendar file (.ics)')).toHaveCount(0);

  // Stronger than hidden buttons: the owner's key is not in the bytes at all.
  const html = await reader.content();
  expect(html, 'the shared page leaked the trip id').not.toContain(tripId!);

  // Print works from the shared copy: the print stylesheet applies here too.
  await reader.emulateMedia({ media: 'print' });
  await expect(reader.getByTestId('day-rail')).toBeHidden();
  await expect(reader.getByRole('heading', { name: /^Day 1/ })).toBeVisible();

  await context.close();
});
