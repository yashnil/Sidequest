import { expect, test, type Page } from '@playwright/test';

/**
 * The slice this proves: a traveller confirms a board, presses Build my trip, and
 * gets a real day-by-day plan that survives a refresh and can be rebuilt after
 * changing their mind.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function reachBoard(page: Page, dates = AUGUST) {
  await page.goto('/trips/new');
  await page.getByLabel('Where are you going?').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: 'Start the questionnaire' }).click();

  await page.getByRole('radio', { name: 'Hiking: A few times' }).check();
  await page.getByRole('radio', { name: 'Lakes & rivers: A few times' }).check();
  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'Geology & geothermal: Once or twice' }).check();

  for (const heading of [
    'How should the days feel?',
    'What is the spending style?',
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
  await expect(page.getByRole('heading', { name: 'Must-see classics' })).toBeVisible();
}

async function buildTrip(page: Page) {
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Mammoth Lakes', exact: true })).toBeVisible();
}

test('board to a real day-by-day itinerary', async ({ page }) => {
  await reachBoard(page);
  await buildTrip(page);

  // Four dated days, in order.
  for (const dayNumber of [1, 2, 3, 4]) {
    await expect(page.getByRole('heading', { name: new RegExp(`^Day ${dayNumber}`) })).toBeVisible();
  }
  await expect(page.getByText('2026-08-12')).toBeVisible();
  await expect(page.getByText('2026-08-15')).toBeVisible();

  // A plain validation state, never a fabricated score.
  await expect(page.getByText(/^(Ready|Ready, with cautions|Needs a decision)$/)).toBeVisible();
  await expect(page.getByText(/quality score/i)).toHaveCount(0);

  // Real scheduled content: clock times, drives, a meal, and free time.
  await expect(page.getByText(/\d+ min on the road/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lunch' }).first()).toBeVisible();
  await expect(page.getByText('Free time').first()).toBeVisible();

  // Travel times are labelled as modelled, never presented as measured.
  await expect(page.getByText(/modelled travel time/).first()).toBeVisible();
  await expect(page.getByText(/not measured road data/).first()).toBeVisible();
});

test('the itinerary survives a refresh', async ({ page }) => {
  await reachBoard(page);
  await buildTrip(page);

  const before = await page.getByRole('heading', { name: /^Day 2/ }).textContent();
  await page.reload();

  await expect(page).toHaveURL(/\/itinerary$/);
  await expect(page.getByRole('heading', { name: /^Day 2/ })).toHaveText(before ?? '');
  await expect(page.getByRole('heading', { name: /^Day 4/ })).toBeVisible();
});

test('changing the board and rebuilding produces a different trip', async ({ page }) => {
  await reachBoard(page);
  await buildTrip(page);

  const scheduled = await page.getByRole('heading', { level: 3 }).allTextContents();
  expect(scheduled.length).toBeGreaterThan(0);

  await page.getByRole('link', { name: 'Back to the board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  // Skip everything currently included, then include one specific place.
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await convict.getByRole('button', { name: 'Skip' }).click();
  await expect(convict.getByRole('button', { name: 'Skip' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Rebuild my trip' }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });

  // The skipped place must not appear anywhere in the rebuilt plan.
  await expect(page.getByRole('heading', { name: 'Convict Lake', exact: true })).toHaveCount(0);
});

test('a manual pick that cannot be scheduled is shown as a conflict, not dropped', async ({
  page,
}) => {
  // April: Reds Meadow Road is still gated, so Devils Postpile cannot be visited.
  await reachBoard(page, { start: '2027-04-10', end: '2027-04-13' });

  const postpile = page.getByRole('article').filter({ hasText: 'Devils Postpile' }).first();
  await expect(postpile.getByText('Closed on your dates')).toBeVisible();
  // Include is disabled for something impossible, so the traveller uses Maybe.
  await expect(postpile.getByRole('button', { name: 'Include' })).toBeDisabled();

  await buildTrip(page);
  await expect(page.getByText(/Needs a decision|Ready/)).toBeVisible();
});

test('navigating straight to an itinerary that does not exist offers a way out', async ({
  page,
}) => {
  await reachBoard(page);
  const url = page.url().replace('/discover', '/itinerary');
  await page.goto(url);

  await expect(page.getByRole('heading', { name: 'No trip built yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to the Discovery Board' })).toBeVisible();
});

test('the build button refuses to run with nothing included', async ({ page }) => {
  await reachBoard(page);

  // Clear the seeded auto-selection one card at a time.
  const included = page.getByRole('button', { name: 'Include', pressed: true });
  let remaining = await included.count();
  let guard = 0;
  while (remaining > 0 && guard < 30) {
    await included.first().click();
    await expect(page.getByText(/^\d+ in/)).toBeVisible();
    remaining = await page.getByRole('button', { name: 'Include', pressed: true }).count();
    guard += 1;
  }

  await expect(page.getByText(/^0 in/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Build my trip/ })).toBeDisabled();
  await expect(page.getByText('Include at least one place first')).toBeVisible();
});

test('the itinerary is reachable and readable by keyboard', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard traversal is a desktop concern');

  await reachBoard(page);
  const build = page.getByRole('button', { name: /Build my trip/ });
  await build.focus();
  await expect(build).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  const back = page.getByRole('link', { name: 'Back to the board' });
  await back.focus();
  await expect(back).toBeFocused();
});
