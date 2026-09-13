import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip, compileRegion } from './support/trip';
import { openHubView, openPrepareNotes } from './support/hub';

/**
 * THE CANONICAL GENERATION PATH, PRESSED FROM THE REAL BUTTONS.
 *
 * One architecture, every door: "Build my trip" from the interview review,
 * "Plan with smart defaults" before any question, "Build my trip" on the
 * Discovery Board after an optional exploration, "Regenerate" on the
 * itinerary page, and Auto Pick followed by Build. The server
 * runs with `SIDEQUEST_COMPOSER_PROVIDER=fixture`, so the model is a
 * deterministic offline composer and nothing here spends anything — what is
 * under test is that the product reaches the canonical orchestrator, persists
 * a reconciled itinerary with its package, and renders it.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function reachMammothBoard(page: Page) {
  await createTrip(page, 'Mammoth Lakes', AUGUST);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
}

async function expectCanonicalItinerary(page: Page) {
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await expect(page.getByTestId('route-bases')).toBeVisible();
  // PRODUCTION UI V1 — the hub is five views; the days live under Days.
  await openHubView(page, 'days');
  for (const dayNumber of [1, 2, 3, 4]) {
    await expect(page.getByRole('heading', { name: new RegExp(`^Day ${dayNumber}`) })).toBeVisible();
  }
  // Real content on every day: activities and meals, never the stale "Nothing scheduled" copy beside content.
  await expect(page.getByText(/^Nothing scheduled, and this is not an arrival or departure day/)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /^Lunch/ }).first()).toBeVisible();
  /*
   * V6 — a stop nothing could verify is kept and labelled, not dropped; a
   * verified one says so.
   *
   * V11 §21 — the labels are now the four-word vocabulary. A stop nothing could
   * place reads "Still checking", because it is Sidequest's own unfinished work
   * rather than a task for the traveller; a placed one reads "Confirmed". The
   * behaviour under test — kept and labelled, never dropped — is unchanged.
   */
  await expect(page.getByRole('heading', { name: 'A Quiet Overlook Nobody Documented', exact: true })).toBeVisible();
  const days = page.locator('#hub-view-days');
  await expect(days.getByText('Still checking').first()).toBeVisible();
  await expect(days.getByText('Confirmed').first()).toBeVisible();
  await openHubView(page, 'plan');
  await expect(page.getByTestId('where-to-stay')).toBeVisible();
  await openHubView(page, 'prepare');
  await expect(page.getByTestId('packing-list')).toBeVisible();
  await openPrepareNotes(page);
  await expect(page.getByTestId('before-you-go')).toBeVisible();
  await expect(page.getByTestId('before-you-go')).toContainText(/entry requirements/i);
  await expect(page.getByTestId('backups')).toBeVisible();
  await expect(page.getByTestId('considered-and-left-out')).toBeVisible();
  await openHubView(page, 'overview');
}

test('Build my trip runs the canonical path and renders the reconciled itinerary with its package', async ({ page }) => {
  await reachMammothBoard(page);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expectCanonicalItinerary(page);

  // Persisted: a reload shows the same plan, including the package sections.
  await openHubView(page, 'days');
  const heading = await page.getByRole('heading', { name: /^Day 2/ }).textContent();
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Day 2/ })).toHaveText(heading ?? '');
  await openHubView(page, 'overview');
  await expect(page.getByTestId('route-overview')).toBeVisible();
});

test('Build my trip works with nothing picked on the board', async ({ page }) => {
  await reachMammothBoard(page);
  const included = page.getByRole('button', { name: 'Include', pressed: true });
  /*
   * The pressed state is optimistic and the summary count is server-rendered, so
   * they are two different facts and the loop has to wait for the second one.
   *
   * It used to poll only the pressed count, which flips on the click: twenty-three
   * clicks could finish with several writes still in flight, and the summary
   * assertion then raced a revalidation — passing alone and failing behind a busy
   * suite ("4 chosen · 23 on the board", five seconds after the last click). The
   * loop now advances on what the server says, which is the thing the assertion
   * below is about.
   */
  const chosenCount = async () => Number(/^(\d+) chosen/.exec((await page.getByTestId('board-summary').textContent()) ?? '')?.[1] ?? -1);
  /*
   * The loop advances on the count, not on the buttons — which is the whole of a
   * fix worth restating.
   *
   * It used to run `while (pressed Include count > 0)`, and a click re-renders the
   * board: for an instant during that re-render no button matches, the condition
   * reads zero and the loop leaves. Whatever was still included then stayed
   * included, and the assertion below reported it ("4 chosen · 23 on the board")
   * five seconds later. Reproduced on `main` at 2 failures in 6 repeats, and on
   * this branch at 1 in 6 — a pre-existing race, not a change in behaviour.
   *
   * Driving on the count cannot leave early: a card that is still chosen will
   * render a pressed button again on the next turn, and the loop clicks it.
   */
  let guard = 0;
  while ((await chosenCount()) > 0 && guard < 90) {
    const button = included.first();
    if ((await button.count()) > 0) await button.click({ timeout: 5_000 }).catch(() => undefined);
    else await page.waitForTimeout(150);
    guard += 1;
  }
  await expect.poll(chosenCount, { timeout: 15_000 }).toBe(0);
  await expect(page.getByTestId('board-summary')).toContainText(/^0 chosen/);
  const build = page.getByRole('button', { name: /Build my trip/ });
  await expect(build).toBeEnabled();
  await build.click();
  await expectCanonicalItinerary(page);
});

test('Regenerate on the itinerary page runs the canonical path again', async ({ page }) => {
  await reachMammothBoard(page);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expectCanonicalItinerary(page);
  const regenerate = page.getByTestId('regenerate-trip');
  await expect(regenerate).toBeVisible();
  await regenerate.click();
  await expect(regenerate).toHaveText('Regenerate', { timeout: 60_000 });
  await expectCanonicalItinerary(page);
});

test('Auto pick, then Build, honours the picks as signals', async ({ page }) => {
  await reachMammothBoard(page);
  // Skip one place by hand: the signal the build must honour.
  const convict = page.getByRole('article').filter({ hasText: 'Convict Lake' }).first();
  await convict.getByRole('button', { name: 'Skip' }).click();
  await convict.getByRole('button', { name: 'Not my thing' }).click();
  await expect(convict.getByRole('button', { name: 'Skip' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /Auto-pick|Choose for me|Pick for me/i }).first().click();
  await expect(page.getByTestId('board-summary')).not.toContainText(/^0 chosen/);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expectCanonicalItinerary(page);
  await expect(page.getByRole('heading', { name: 'Convict Lake', exact: true })).toHaveCount(0);
});

test('Plan with smart defaults composes a complete trip before any question is answered and lands on the itinerary', async ({ page }) => {
  await createTrip(page, 'Harbour City', AUGUST);
  await page.waitForURL(/\/questionnaire$/, { timeout: 20_000 });
  const defaults = page.getByTestId('interview-smart-defaults');
  await expect(defaults).toBeVisible({ timeout: 20_000 });
  await defaults.click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await openHubView(page, 'days');
  for (const dayNumber of [1, 2, 3, 4]) {
    await expect(page.getByRole('heading', { name: new RegExp(`^Day ${dayNumber}`) })).toBeVisible();
  }
  await expect(page.getByText(/^Nothing scheduled, and this is not an arrival or departure day/)).toHaveCount(0);
  await expect(page.locator('#hub-view-days').getByText('Still checking').first()).toBeVisible();
  await openHubView(page, 'prepare');
  await expect(page.getByTestId('packing-list')).toBeVisible();
});

test('Build my trip from the interview review, with no research and no board, verifies through the geocoder alone', async ({ page }) => {
  await createTrip(page, 'Harbour City', AUGUST);
  await page.waitForURL(/\/questionnaire$/, { timeout: 20_000 });
  await completeQuestionnaire(page);
  await expect(page.getByTestId('interview-build-board')).toHaveCount(0);
  await page.getByTestId('interview-build-trip').click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await expect(page.getByText(/^Nothing scheduled, and this is not an arrival or departure day/)).toHaveCount(0);
});

test('Explore experiences first, then the board, verifies against the compiled region', async ({ page }) => {
  await createTrip(page, 'Harbour City', AUGUST);
  await compileRegion(page);
  await page.getByRole('link', { name: 'Tell us how you travel' }).click();
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 60_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
  await openHubView(page, 'days');
  await expect(page.locator('#hub-view-days').getByText('Confirmed').first()).toBeVisible();
});
