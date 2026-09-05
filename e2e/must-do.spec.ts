import { expect, test, type Page } from '@playwright/test';
import {
  DEFAULT_DATES,
  compileRegion,
  completeQuestionnaire,
  waitUntilInteractive,
} from './support/trip';

/**
 * DOES TYPING "I CANNOT MISS THIS" CHANGE ANYTHING A TRAVELLER SEES?
 *
 * For every phase before this one it did not. The composer captured the
 * sentence, the parser said "noted, and not looked up", and whether the place
 * was found, shut, ambiguous or nowhere in the data was known internally and
 * said nowhere. These specifications exist to make that impossible to repeat:
 * each drives the ordinary product routes and asserts what is on the screen
 * **before** any itinerary is generated.
 *
 * Every trip names its synthetic world and asserts which one it got, so a
 * specification can never quietly pass against the wrong fixture — which has
 * happened in this suite before.
 */

/**
 * Create a trip with something typed into "anything you would regret missing".
 *
 * Through the composer's own second section, which is where the field lives, so
 * the journey exercised is the one a traveller actually takes.
 */
async function createTripNaming(page: Page, destination: string, mustDo: string): Promise<void> {
  await page.goto('/trips/new');
  const field = page.getByLabel('Destination');
  await waitUntilInteractive(field);
  await field.fill(destination);
  await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
  await page.getByLabel('Leave').fill(DEFAULT_DATES.end);
  await page.getByRole('button', { name: /A few more that change the plan/i }).click();
  await page.getByLabel('Anything you would regret missing?').fill(mustDo);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/);
}

/** The statuses on screen, in order. Empty when the panel is absent. */
async function statuses(page: Page): Promise<string[]> {
  const panel = page.getByTestId('must-do-panel');
  if ((await panel.count()) === 0) return [];
  return panel.getByTestId('must-do-row').evaluateAll((rows) =>
    rows.map((row) => row.getAttribute('data-must-do-status') ?? ''),
  );
}

test('a place we cannot find is said so before the questionnaire, not after the plan', async ({
  page,
}) => {
  await createTripNaming(page, 'Harbour City', 'We cannot miss the Bellweather Observatory.');
  await compileRegion(page);

  /*
   * Asserted, not conditioned on. Wrapping this in "if the panel exists" is how
   * a specification passes against a product where the panel never renders — the
   * exact vacuity this file exists to prevent, and a mistake already made once in
   * this suite.
   */
  const panel = page.getByTestId('must-do-panel');
  await expect(panel).toBeVisible();
  expect(await statuses(page)).toEqual(['not_found']);

  // The traveller's own characters, quoted back rather than paraphrased.
  await expect(panel).toContainText('Bellweather Observatory');
  // Our sentence, in English, with no compiler words in it.
  await expect(panel).toContainText(/could not confidently find/i);
  for (const jargon of ['candidate', 'containment', 'packet', 'resolution']) {
    await expect(panel).not.toContainText(new RegExp(jargon, 'i'));
  }

  // And the journey continues: one name we could not find is not a broken trip.
  await expect(page.getByRole('link', { name: /Tell us how you travel/i })).toBeVisible();
});

test('a place the region actually holds comes back found', async ({ page }) => {
  /*
   * The name is one the synthetic world's own generator produces
   * (`${spec.name} ${category} ${n}` in `pack-fakes`), so it is a real record
   * rather than a string this file invented. If the fixture stops producing it
   * the assertion below fails loudly — which is the point: a hard-coded name
   * that no longer exists makes this test go red, never quietly green.
   */
  await createTripNaming(page, 'Harbour City', 'A morning at Harbour City Viewpoint 1.');
  await compileRegion(page);

  const panel = page.getByTestId('must-do-panel');
  await expect(panel).toBeVisible();
  expect(await statuses(page)).toEqual(['covered']);
  await expect(panel).toContainText('Harbour City Viewpoint 1');
  await expect(panel).toContainText(/Found and included/i);
});

test('the traveller can take a request off, and it stays off across a refresh', async ({ page }) => {
  await createTripNaming(page, 'Harbour City', 'We cannot miss the Bellweather Observatory.');
  await compileRegion(page);

  const panel = page.getByTestId('must-do-panel');
  await expect(panel).toBeVisible();
  expect(await statuses(page)).toEqual(['not_found']);

  /*
   * The same hydration condition as the questionnaire below: this control lives
   * in a client component, and a press it cannot yet hear is a silently lost
   * decision rather than a slow one.
   */
  const withdraw = panel.getByTestId('must-do-withdraw').first();
  await waitUntilInteractive(withdraw);
  await withdraw.click();
  await expect(panel.getByTestId('must-do-row').first()).toHaveAttribute(
    'data-must-do-status',
    'withdrawn',
    { timeout: 15_000 },
  );

  /*
   * The decision is stored on the trip, not held in a component. A refresh is the
   * cheapest possible test of that, and it is the one a traveller performs by
   * accident.
   */
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  expect(await statuses(page)).toEqual(['withdrawn']);
  // And the shortfall is gone from the reading, rather than the two disagreeing.
  await expect(page.getByTestId('must-do-panel')).toContainText(/accounted for/i);
});

test('a trip that names nothing shows no panel at all', async ({ page }) => {
  await page.goto('/trips/new');
  const field = page.getByLabel('Destination');
  await waitUntilInteractive(field);
  await field.fill('Harbour City');
  await page.getByLabel('Arrive').fill(DEFAULT_DATES.start);
  await page.getByLabel('Leave').fill(DEFAULT_DATES.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/);
  await compileRegion(page);

  await expect(page.getByTestId('must-do-panel')).toHaveCount(0);
});

test('the status follows the traveller onto the Discovery Board', async ({ page }) => {
  /*
   * The board is the other screen that comes before an itinerary, and it is the
   * one where a missing card cannot explain its own absence. A traveller who
   * named one place and is shown twenty others is owed a sentence about theirs
   * here too, not only on the screen before.
   */
  await createTripNaming(page, 'Harbour City', 'A morning at Harbour City Viewpoint 1.');
  await compileRegion(page);
  await page.getByRole('link', { name: /Tell us how you travel/i }).click();

  /*
   * Wait for the questionnaire to own its controls before answering it.
   *
   * A server-rendered radio is visible, stable and checkable *before* the script
   * that gives it behaviour has run, so `check()` sets the DOM state, no handler
   * observes it, and the wizard refuses to continue from a form it believes is
   * empty. That is not a slow test — it is a lost click, and it is unrecoverable,
   * because React does not re-read a pre-existing checked state when it hydrates.
   * It cost one flaked run of this specification before it was added.
   */
  await expect(page.getByTestId('interview')).toBeVisible({ timeout: 20_000 });
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Build my discovery board' }).click();
  await expect(page).toHaveURL(/\/discover$/);

  const panel = page.getByTestId('must-do-panel');
  await expect(panel).toBeVisible();
  expect(await statuses(page)).toEqual(['covered']);

  /*
   * And the named place is *chosen*, not merely found. This is the join between
   * the compile-time half of the guarantee and the downstream one: only a
   * selection the traveller owns makes `must_include_unscheduled` an error, and
   * typing a place by name is a more explicit statement than ticking a box.
   */
  // Exact, because the board also holds a "Harbour City Viewpoint 17".
  const decision = page.getByRole('group', {
    name: 'Your decision on Harbour City Viewpoint 1',
    exact: true,
  });
  await expect(decision).toBeVisible();
  await expect(decision.getByRole('button', { name: 'Include' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
