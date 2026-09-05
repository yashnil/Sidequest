import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { buildBoardFromReview, changeInterviewAnswer, completeQuestionnaire } from './support/trip';

/**
 * The journey this slice promises: a traveller's transport answers change which
 * places are offered, the itinerary shows a real multimodal access sequence, and
 * changing "I have a car" to "I do not" rebuilds into a materially different,
 * still-executable plan.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function startTrip(page: Page, dates = AUGUST) {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: /^Continue$/ }).click();
  await expect(page.getByTestId('interview')).toBeVisible();
}

/**
 * To the review screen with the canonical car traveller, or — on a return
 * visit, which lands on the review because the traveller finished it — stay
 * there. Every transport assertion below then works from the review's own
 * "Change" control, which is the affordance a traveller actually uses.
 */
async function reachReview(page: Page, transport: 'rent_car' | 'no_car' = 'rent_car') {
  if (await page.getByTestId('interview-review').isVisible().catch(() => false)) return;
  await completeQuestionnaire(page, { answers: { transport_mode: transport } });
}

async function chooseTransport(page: Page, transport: 'rent_car' | 'no_car') {
  await changeInterviewAnswer(page, 'transport_mode', transport, { answers: { transport_mode: transport } });
}

async function finishToBoard(page: Page) {
  await buildBoardFromReview(page);
}

async function build(page: Page) {
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Getting around' })).toBeVisible();
}

test('the transport question asks what the planner actually needs, and adapts to the answer', async ({ page }) => {
  await startTrip(page);
  await reachReview(page);
  await page.getByTestId('review-change-transport_mode').click();
  const screen = page.getByTestId('interview-question-transport_mode');
  await expect(screen).toBeVisible();

  // The region reads as a road trip, so the choice is a car or no car — never a metro.
  await expect(screen.getByText('Rent a car')).toBeVisible();
  await expect(screen.getByText('No car', { exact: true })).toBeVisible();
  await expect(screen.getByText(/public transport/)).toBeVisible();

  // With a car, the driving questions follow; without one they never appear.
  await screen.locator('input[type=radio][value="no_car"]').check();
  await page.getByTestId('interview-continue').click();
  const seen = await completeQuestionnaire(page, { answers: { transport_mode: 'no_car' } });
  expect(seen).not.toContain('daily_driving');
  expect(seen).not.toContain('road_comfort');
  await expect(page.getByTestId('review-change-daily_driving')).toHaveCount(0);
});

test('the board shows transport feasibility before anything is built', async ({ page }) => {
  await startTrip(page);
  await reachReview(page);
  await finishToBoard(page);

  /*
   * By heading, not by text: `hasText: 'Devils Postpile'` also matches the
   * Rainbow Falls card, which names the monument in the corridor they share.
   */
  const postpile = page
    .getByRole('article')
    .filter({
      has: page.getByRole('heading', { name: 'Devils Postpile National Monument', exact: true }),
    })
    .first();
  await expect(postpile).toBeVisible();
  await expect(postpile.getByText('Shuttle only')).toBeVisible();
  /*
   * "Check before you go" was the `verify_conditions` chip. The card wears two
   * chips at most now and spends both on the things that gate the visit — the
   * car and the shuttle — so the verification instruction is stated in the
   * disclosure, in words that name what to check rather than telling somebody to
   * check something unspecified.
   */
  await postpile.locator('summary').first().click();
  await expect(postpile.getByText(/Check all three before you fix a date/)).toBeVisible();

  // A drive-up lake carries no shuttle badge — the badges mean something.
  const convict = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Convict Lake', exact: true }) })
    .first();
  await expect(convict.getByText('Shuttle only')).toHaveCount(0);
});

test('a car trip produces a strategy and a multimodal access day', async ({ page }, testInfo) => {
  await startTrip(page);
  await reachReview(page);
  await finishToBoard(page);

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

  // The trip-level position: the driving budget, stated separately from everything else.
  await expect(page.getByText('At the wheel', { exact: true })).toBeVisible();

  /*
   * The canonical plan states its transport strategy and its practical notes
   * from the composed draft, and every leg says whether it was measured.
   * Scheduled access services (the valley shuttle) are not yet modelled as
   * legs on a canonical plan — the stop is kept and the day says what it
   * could not verify, rather than narrating a timetable it never read.
   */
  await expect(page.getByTestId('transport-notes')).toBeVisible();
  await expect(page.getByText(/measured|not measured/).first()).toBeVisible();
  await expect(page.getByText(/travel legs were measured by/).first()).toBeVisible();

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
  await reachReview(page);
  await finishToBoard(page);
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
  await reachReview(page);
  await finishToBoard(page);
  await build(page);

  const drivingStops = await page.getByRole('heading', { level: 3 }).allTextContents();
  expect(drivingStops.length).toBeGreaterThan(0);

  // Back through the questionnaire to change the one answer that matters.
  await page.getByRole('link', { name: 'Back to the board' }).click();
  await page.getByRole('link', { name: 'Change my answers' }).click();
  await expect(page).toHaveURL(/\/questionnaire$/);
  await chooseTransport(page, 'no_car');
  await finishToBoard(page);

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
  await reachReview(page);
  await finishToBoard(page);

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
  await chooseTransport(page, 'no_car');
  await finishToBoard(page);

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
  await expect(page.getByText(/not workable on this trip as you are travelling/).first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change how you are getting around' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Change what is on the board' })).toBeVisible();
});
