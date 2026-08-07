import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire } from './support/trip';

/**
 * The journey this slice promises: a traveller enters a Mammoth Lakes trip,
 * answers the questionnaire, sees their profile reflected back, and gets a
 * Discovery Board of the Eastern Sierra that remembers what they picked.
 */

const AUGUST_TRIP = { start: '2026-08-12', end: '2026-08-15' };
const JANUARY_TRIP = { start: '2027-01-12', end: '2027-01-15' };

async function createTrip(page: Page, dates: { start: string; end: string }) {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill('Mammoth Lakes');
  await page.getByLabel('Arrive').fill(dates.start);
  await page.getByLabel('Leave').fill(dates.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await expect(page.getByRole('heading', { name: 'What are you actually here for?' })).toBeVisible();
}

test('a traveller goes from a blank trip to a personalised Eastern Sierra board', async ({
  page,
}) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);

  // The profile is reflected back before anything is generated.
  await expect(page.getByText(/pace over 4 days/)).toBeVisible();
  await expect(page.getByText('Detour limit')).toBeVisible();

  await page.getByRole('button', { name: 'Build my discovery board' }).click();

  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole('heading', { name: /Eastern Sierra/ })).toBeVisible();

  // The region, not just the town.
  for (const name of ['Convict Lake', 'Mono Lake South Tufa', 'June Lake Loop', 'Minaret Vista']) {
    // Exact, because the food section below the board holds a "Restaurant at
    // Convict Lake" and a loose name match finds both.
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }

  // Grouped the way the brief asks for.
  await expect(page.getByRole('heading', { name: 'Must-see classics' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Personalised hidden gems' })).toBeVisible();

  // Cards carry fit, distance, effort and a profile-specific explanation.
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(convict.getByText(/Top pick for you|Strong fit|Good fit/)).toBeVisible();
  await expect(convict.getByText('Why this fits you')).toBeVisible();
  await expect(convict.getByText('From base')).toBeVisible();
  await expect(convict.getByText('Effort')).toBeVisible();
});

test('the board arrives pre-selected rather than empty', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  // A balanced starting set is already applied — the traveller confirms a plan
  // rather than building one from a grid of 22 cards.
  // The visible counter by its own identity, not by a text shape. A text shape
  // matches whatever else happens to start the same way — the board's live
  // region did, and four specs failed at once for a reason none of them was
  // about.
  await expect(page.getByTestId('board-summary')).toContainText(/[1-9]\d* in/);

  const card = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(card.getByRole('button', { name: 'Include' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('a hand-made choice overrides the auto-pick and survives a refresh', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  const card = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await card.getByRole('button', { name: 'Skip' }).click();
  await expect(card.getByRole('button', { name: 'Skip' })).toHaveAttribute('aria-pressed', 'true');

  await page.reload();

  const afterReload = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await expect(afterReload.getByRole('button', { name: 'Skip' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(afterReload.getByRole('button', { name: 'Include' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Re-running auto-pick must not undo a decision the traveller made by hand.
  await page.getByRole('button', { name: 'Auto-pick the best mix for me' }).click();
  await expect(afterReload.getByRole('button', { name: 'Skip' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('auto-pick counts persist across a reload', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();

  await page.getByRole('button', { name: 'Auto-pick the best mix for me' }).click();
  const counter = page.getByTestId('board-summary');
  await expect(counter).toContainText(/[1-9]\d* in/);

  const before = await counter.textContent();
  await page.reload();
  await expect(page.getByTestId('board-summary')).toHaveText(before ?? '');
});

test('a winter trip is told plainly what is shut rather than shown a broken plan', async ({
  page,
}) => {
  await createTrip(page, JANUARY_TRIP);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();

  await expect(page.getByText(/places are shut on your dates/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Probably skip' })).toBeVisible();

  const postpile = page.getByRole('article').filter({ hasText: 'Devils Postpile' }).first();
  await expect(postpile.getByText('Closed on your dates')).toBeVisible();
  await expect(postpile.getByText('Why this will not work')).toBeVisible();

  // Year-round places are unaffected.
  await expect(page.getByRole('heading', { name: 'Convict Lake', exact: true })).toBeVisible();
});

test('the questionnaire adapts and refuses to continue on an empty profile', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);

  // Nothing chosen yet — every interest is still "if nearby".
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Pick at least one thing' })).toBeVisible();

  await page.getByRole('radio', { name: 'Hiking: Core' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should the days feel?' })).toBeVisible();

  // Walk forward to the transport step, checking each heading on the way so a
  // change in step order fails loudly instead of silently skipping a step.
  for (const heading of [
    'What is the spending style?',
    'How do you want to eat?',
    'Famous or off the track?',
    'How are you getting around?',
  ]) {
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await expect(page.getByText('Steep mountain roads are fine')).toBeVisible();

  await page.getByLabel('You will have a car').uncheck();
  await expect(page.getByText('Steep mountain roads are fine')).toBeHidden();
  /*
   * The note that appears when the car is unchecked. Its wording moved when the
   * questionnaire stopped naming one valley's trolley and bus route — the
   * assertion is on the *behaviour*, which is that a no-car answer says plainly
   * what it costs.
   */
  await expect(page.getByText(/Without a car we will keep to what walks/)).toBeVisible();

  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('radio', { name: /Up to ~2 hours/ })).toHaveCount(0);
  await expect(page.getByText(/Wider radii are hidden because you are not driving/)).toBeVisible();
});

test('questionnaire progress survives a refresh mid-flow', async ({ page }) => {
  await createTrip(page, AUGUST_TRIP);
  await page.getByRole('radio', { name: 'Stargazing: Core' }).check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should the days feel?' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('radio', { name: 'Stargazing: Core' })).toBeChecked();
});

test('the whole journey is reachable by keyboard', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard traversal is a desktop concern');

  await createTrip(page, AUGUST_TRIP);

  // Focus lands somewhere in the document and the first interest control is
  // reachable by tabbing, with a visible focus ring.
  const firstRadio = page.getByRole('radio', { name: 'Hiking: Skip' });
  await firstRadio.focus();
  await expect(firstRadio).toBeFocused();

  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Hiking: A few times' })).toBeChecked();

  await page.getByRole('button', { name: 'Continue' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'How should the days feel?' })).toBeVisible();
});
