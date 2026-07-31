import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * The journey this slice promises: a traveller's transport answers change which
 * places are offered, the itinerary shows a real multimodal access sequence, and
 * changing "I have a car" to "I do not" rebuilds into a materially different,
 * still-executable plan.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function startTrip(page: Page, dates = AUGUST) {
  await page.goto('/trips/new');
  await page.getByLabel('Where are you going?').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: 'Start the questionnaire' }).click();
  await page.getByRole('radio', { name: 'Hiking: A few times' }).check();
  await page.getByRole('radio', { name: 'Lakes & rivers: A few times' }).check();
  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'Geology & geothermal: Once or twice' }).check();
}

/** Steps through to the transport step, leaving it on screen. */
async function reachTransportStep(page: Page) {
  for (const heading of ['How should the days feel?', 'What is the spending style?', 'Famous or off the track?']) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How are you getting around?' })).toBeVisible();
}

async function finishFromTransport(page: Page) {
  for (const heading of ['How far from Mammoth Lakes?', 'Anything to steer around?', 'Your trip personality']) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
}

async function build(page: Page) {
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Getting around' })).toBeVisible();
}

test('the transport step asks the questions the planner actually needs', async ({ page }) => {
  await startTrip(page);
  await reachTransportStep(page);

  await expect(page.getByText('You will have a car')).toBeVisible();
  await expect(page.getByText('Shuttles and buses are fine')).toBeVisible();
  await expect(page.getByText('Furthest you would walk to reach a stop')).toBeVisible();
  await expect(
    page.getByText('When there is more than one way in, what matters?'),
  ).toBeVisible();

  // Turning the car off hides the questions that only make sense with one, and
  // says plainly what is left.
  await page.getByText('You will have a car').click();
  await expect(page.getByText('Steep mountain roads are fine')).toHaveCount(0);
  await expect(page.getByText('Shuttles and buses are fine')).toHaveCount(0);
  await expect(page.getByText(/free summer trolley/)).toBeVisible();
});

test('the board shows transport feasibility before anything is built', async ({ page }) => {
  await startTrip(page);
  await reachTransportStep(page);
  await finishFromTransport(page);

  const postpile = page.getByRole('article').filter({ hasText: 'Devils Postpile' }).first();
  await expect(postpile).toBeVisible();
  await expect(postpile.getByText('Shuttle only')).toBeVisible();
  await expect(postpile.getByText('Check before you go')).toBeVisible();

  // A drive-up lake carries no shuttle badge — the badges mean something.
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(convict.getByText('Shuttle only')).toHaveCount(0);
});

test('a car trip produces a strategy and a multimodal access day', async ({ page }, testInfo) => {
  await startTrip(page);
  await reachTransportStep(page);
  await finishFromTransport(page);

  // Hand-pick the valley so the shuttle day is guaranteed to be in the plan.
  for (const name of ['Devils Postpile', 'Rainbow Falls']) {
    const card = page.getByRole('article').filter({ hasText: name }).first();
    // The controls toggle, so route through Maybe to land on a definite Include
    // whether or not auto-pick already chose it.
    await card.getByRole('button', { name: 'Maybe' }).click();
    await card.getByRole('button', { name: 'Include' }).click();
    await expect(card.getByRole('button', { name: 'Include' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }

  await build(page);

  // The trip-level position, with both budgets shown separately.
  await expect(page.getByText(/hand over to a shuttle|Drive —/)).toBeVisible();
  await expect(page.getByText('At the wheel', { exact: true })).toBeVisible();
  await expect(page.getByText('Riding & waiting', { exact: true })).toBeVisible();
  await expect(page.getByText('On foot to reach things', { exact: true })).toBeVisible();

  // The sequence a traveller has to execute, in order.
  await expect(page.getByText(/Board the Reds Meadow/).first()).toBeVisible();
  await expect(page.getByText(/Ride to Reds Meadow Valley/).first()).toBeVisible();
  await expect(page.getByText(/Ride back to/).first()).toBeVisible();
  await expect(page.getByText(/last .* out leaves at/i).first()).toBeVisible();

  // Modelled and published data are labelled as what they are, never as measured.
  await expect(page.getByText(/published timetable/).first()).toBeVisible();
  await expect(page.getByText(/not measured road data/).first()).toBeVisible();
  await expect(page.getByText(/Check these before you book/)).toBeVisible();

  // The centrepiece of this slice, captured for a human to look at. The
  // multimodal day is the one screen that cannot be judged from assertions.
  mkdirSync('test-results/screens', { recursive: true });
  await page.screenshot({
    path: `test-results/screens/12-transport-${testInfo.project.name}.png`,
    fullPage: true,
  });
});

test('the transport plan survives a refresh', async ({ page }) => {
  await startTrip(page);
  await reachTransportStep(page);
  await finishFromTransport(page);
  await build(page);

  const before = await page
    .getByText('At the wheel', { exact: true })
    .locator('..')
    .textContent();
  await page.reload();

  await expect(page).toHaveURL(/\/itinerary$/);
  await expect(page.getByRole('heading', { name: 'Getting around' })).toBeVisible();
  await expect(page.getByText('At the wheel', { exact: true }).locator('..')).toHaveText(
    before ?? '',
  );
});

test('dropping the car rebuilds into a different, still-workable plan', async ({ page }) => {
  await startTrip(page);
  await reachTransportStep(page);
  await finishFromTransport(page);
  await build(page);

  const drivingStops = await page.getByRole('heading', { level: 3 }).allTextContents();
  expect(drivingStops.length).toBeGreaterThan(0);

  // Back through the questionnaire to change the one answer that matters.
  await page.getByRole('link', { name: 'Back to the board' }).click();
  await page.getByRole('link', { name: 'Change my answers' }).click();
  await expect(page).toHaveURL(/\/questionnaire$/);
  await reachTransportStep(page);
  await page.getByText('You will have a car').click();
  await finishFromTransport(page);

  // The board itself now says the car-only places will not work.
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(convict.getByText('Not workable this trip')).toBeVisible();
  await expect(convict.getByRole('button', { name: 'Include' })).toBeDisabled();

  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });

  // The strategy changed, and nothing on the plan asks them to drive.
  await expect(page.getByRole('heading', { name: 'Getting around' })).toBeVisible();
  await expect(page.getByText('Drive — there is no practical alternative here')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Convict Lake', exact: true })).toHaveCount(0);
});

test('a manual pick broken by a transport answer stays visible with a way out', async ({
  page,
}) => {
  await startTrip(page);
  await reachTransportStep(page);
  await finishFromTransport(page);

  // Auto-pick may already have chosen it, and the buttons toggle — so go via
  // Maybe to guarantee the stored row ends up as a hand-made "Include".
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await convict.getByRole('button', { name: 'Maybe' }).click();
  await expect(convict.getByRole('button', { name: 'Maybe' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await convict.getByRole('button', { name: 'Include' }).click();
  await expect(convict.getByRole('button', { name: 'Include' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('link', { name: 'Change my answers' }).click();
  await reachTransportStep(page);
  await page.getByText('You will have a car').click();
  await finishFromTransport(page);

  // The choice is preserved and explained, not silently flipped to "Skip".
  const broken = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(broken.getByRole('button', { name: 'Include' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(broken.getByText(/You picked this, and it no longer works/)).toBeVisible();

  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });

  // And the itinerary offers routes that actually resolve it.
  await expect(
    page.getByRole('heading', { name: /could not be scheduled/ }),
  ).toBeVisible();
  await expect(page.getByText(/needs your own vehicle/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change how you are getting around' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change what is on the board' })).toBeVisible();
});
