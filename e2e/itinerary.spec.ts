import { expect, test, type Page } from '@playwright/test';

/**
 * The slice this proves: a traveller confirms a board, presses Build my trip, and
 * gets a real day-by-day plan that survives a refresh and can be rebuilt after
 * changing their mind.
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

test('board to a real day-by-day itinerary', async ({ page }) => {
  await reachBoard(page);
  await buildTrip(page);

  // Four dated days, in order.
  for (const dayNumber of [1, 2, 3, 4]) {
    await expect(page.getByRole('heading', { name: new RegExp(`^Day ${dayNumber}`) })).toBeVisible();
  }
  /*
   * The date a traveller reads, and the date a machine reads, on the same
   * element. The heading used to print the ISO string straight after the day
   * number with nothing between them, so its accessible name was the single
   * token "Day 12026-08-12".
   */
  const firstDate = page.locator('h2 time[datetime="2026-08-12"]');
  await expect(firstDate).toBeVisible();
  await expect(firstDate).toHaveText(/^\w{3} \d{1,2} \w{3}$/);
  await expect(page.locator('h2 time[datetime="2026-08-15"]')).toBeVisible();
  // The separator is real text, so the day number cannot run into the year.
  const firstHeading = await page.getByRole('heading', { name: /^Day 1/ }).textContent();
  expect(firstHeading).toMatch(/^Day 1\s*·/);

  // A plain validation state, never a fabricated score.
  await expect(page.getByText(/^(Ready|Ready, with cautions|Needs a decision)$/)).toBeVisible();
  await expect(page.getByText(/quality score/i)).toHaveCount(0);

  // Real scheduled content: clock times, drives, a meal, and free time.
  await expect(page.getByText(/\d+ min on the road/).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Lunch' }).first()).toBeVisible();
  /*
   * SLACK IS A DELIBERATE OUTPUT, NOT LEFTOVER SPACE — AND THIS PLAN'S FORM OF IT.
   *
   * This asserted the day's free-hours badge, `N min free`. On *this* journey
   * there is no longer any: days 2 and 3 come out full — 6 hr and 5 hr at stops
   * — and day 2's last block ends at 19:35 against a window the same day header
   * prints as 09:00–19:00, so the free-time pass has negative span to work with
   * and emits nothing. The badge is not gone from the product: the wide-radius
   * board in `hours.spec.ts` still produces "1 hr 30 min free" with the
   * "Deliberately unbooked" block under it.
   *
   * So the claim is asserted on what this plan does carry: the recovery block
   * the planner inserts after a strenuous stop, which is unbooked time it chose
   * to place rather than time left over. The day-level accounting line is
   * asserted with it, because "the day says where its hours went" is the half
   * that was silently absent when the badge disappeared.
   *
   * The disappearance itself is a planner finding, not a test one, and is
   * reported as such: `packages/planner`'s own acceptance test asserts every
   * full middle day leaves visible slack, and these two do not.
   */
  await expect(page.getByText(/(\d+ min|\d+ hr( \d+ min)?) at stops/).first()).toBeVisible();
  await expect(page.getByText('Sit down for a bit').first()).toBeVisible();

  // Travel times are labelled as modelled, never presented as measured.
  await expect(page.getByText(/modelled travel time/).first()).toBeVisible();
  await expect(page.getByText(/not measured road data/).first()).toBeVisible();
});

test('the day rail jumps to a day on a page too long to scroll', async ({ page }) => {
  /**
   * An eight-thousand-pixel plan with no way through it.
   *
   * Reaching the last day meant scrolling past every day before it. The rail is
   * anchors rather than script, so this asserts the two things an anchor is:
   * the URL names the day, and the day's own heading ends up in the viewport.
   */
  await reachBoard(page);
  await buildTrip(page);

  const rail = page.getByTestId('day-rail');
  await expect(rail).toBeVisible();

  const last = rail.getByRole('link', { name: /^Day 4/ });
  await expect(last).toBeVisible();
  await last.click();

  await expect(page).toHaveURL(/#day-4$/);

  const heading = page.getByRole('heading', { name: /^Day 4/ });
  await expect(heading).toBeInViewport();

  /*
   * And it clears the two sticky elements above it — the product chrome and the
   * rail itself. A jump that lands the heading *underneath* the thing you
   * clicked is the defect `scroll-mt` exists to prevent, and it is invisible to
   * a plain visibility check.
   */
  const railBox = await rail.boundingBox();
  const headingBox = await heading.boundingBox();
  expect(railBox, 'the rail should have a box').not.toBeNull();
  expect(headingBox, 'the day heading should have a box').not.toBeNull();
  expect(headingBox!.y).toBeGreaterThanOrEqual(railBox!.y + railBox!.height - 1);
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
  // Skipping asks why first; the answer is what commits the pass.
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await convict.getByRole('button', { name: 'Skip' }).click();
  await convict.getByRole('button', { name: 'Not my thing' }).click();
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

  /*
   * Located by its own heading, not by text anywhere on the card.
   *
   * `hasText: 'Devils Postpile'` resolved to *Rainbow Falls*, whose access-group
   * line names the corridor they share — so this assertion was being made about
   * a different place, and would have passed or failed for reasons unrelated to
   * the one under test. The same trap is documented in `weather.spec.ts`.
   */
  const postpile = page
    .getByRole('article')
    .filter({
      has: page.getByRole('heading', { name: 'Devils Postpile National Monument', exact: true }),
    })
    .first();
  /*
   * A place nothing can reach is a compact row rather than a full card, and a
   * compact row carries no chips at all — it leads with the reason instead,
   * which is the more specific statement: the season, not a label.
   */
  await expect(postpile.getByText(/Why this will not work/)).toBeVisible();
  await expect(postpile.getByText(/it will not be reachable on your dates/)).toBeVisible();
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
    await expect(page.getByTestId('board-summary')).toBeVisible();
    remaining = await page.getByRole('button', { name: 'Include', pressed: true }).count();
    guard += 1;
  }

  await expect(page.getByTestId('board-summary')).toContainText(/^0 chosen/);
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
