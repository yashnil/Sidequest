import { expect, test } from '@playwright/test';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from './support/trip';

/**
 * V1 CONVERGENCE — THE DISCOVERY SCAN IS THE STEP BETWEEN THE INTERVIEW AND THE BUILD.
 *
 * Master prompt §9: questionnaire → preliminary scan → Discovery Board (check
 * boxes / Choose for me) → Build. A dynamic destination with no authored region
 * (not Mammoth) reaches a real board through the scan, arrives with Sidequest's
 * picks already ticked, and builds from them. The server pins every provider to
 * fixtures (`SIDEQUEST_COMPOSER_PROVIDER=fixture`, `SIDEQUEST_COMPILER_PROVIDER=fixture`),
 * so the scan is the fixture proposer plus distance estimates and nothing here
 * spends anything.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-16' };
const DESTINATION = 'Harbour City';

test('find places → a pre-picked board → build → the itinerary', async ({ page }) => {
  await createTrip(page, DESTINATION, AUGUST);
  await page.waitForURL(/\/questionnaire$/, { timeout: 20_000 });
  await completeQuestionnaire(page);

  // No board yet: the review's primary action is the scan, not the board and not the build.
  await expect(page.getByTestId('interview-build-board')).toHaveCount(0);
  const find = page.getByTestId('interview-find-places');
  await expect(find).toBeVisible();
  await expect(find).toHaveText(/Find places for my trip/);
  // The model-composed build stays available, plainly labelled as skipping the board.
  await expect(page.getByTestId('interview-build-trip')).toHaveText(/Skip the board and build now/);
  await waitUntilInteractive(find);
  await find.click();

  await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
  // The scan screen may flash past on fixtures; either way the board arrives, with no reload.
  await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('board-provenance')).toContainText('Sidequest’s research proposed these places');
  await expect(page.getByTestId('board-provenance')).toContainText('your picks on places that still appear are kept');
  // Sidequest's picks are pre-selected.
  await expect(page.getByTestId('board-summary')).not.toContainText(/^0 chosen/);
  // Rescan replaces the pool, so it asks before it does anything.
  await page.getByTestId('board-rescan').click();
  await expect(page.getByTestId('board-rescan-confirm')).toContainText('Your picks on places that still appear are kept');
  await page.getByRole('button', { name: 'Keep this board' }).click();
  await expect(page.getByTestId('board-rescan-confirm')).toHaveCount(0);

  const build = page.getByRole('button', { name: /Build my trip|Rebuild my trip/ });
  await expect(build).toBeEnabled();
  await build.click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 90_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
});

test('Plan with smart defaults scans, picks and builds in one press', async ({ page }) => {
  await createTrip(page, DESTINATION, AUGUST);
  await page.waitForURL(/\/questionnaire$/, { timeout: 20_000 });
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  // Through the scan and the build screen, to the plan — never parked on the board.
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 120_000 });
  await expect(page.getByTestId('route-overview')).toBeVisible();
});

test('"I already have a plan": the plan is checked on the board and its places are kept', async ({ page }) => {
  const P = DESTINATION;
  await createTrip(page, DESTINATION, AUGUST, {
    havePlan: true,
    existingPlan: `Day 1: ${P} Old Quarter, ${P} Cathedral, ${P} City Museum, ${P} Central Market, ${P} Castle, ${P} Art Gallery\nDay 2: ${P} River Walk\nDay 3: Somewhere Nobody Has Heard Of`,
  });
  await page.waitForURL(/\/questionnaire$/, { timeout: 20_000 });
  await completeQuestionnaire(page);
  const find = page.getByTestId('interview-find-places');
  await waitUntilInteractive(find);
  await find.click();
  await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 60_000 });

  const critique = page.getByTestId('plan-critique');
  await expect(critique).toBeVisible();
  // Six daytime stops on day 1 is more than any pace holds.
  await expect(critique.locator('[data-kind="rushed_day"]')).toContainText('Day 1 is rushed');
  // A place the board does not have is not checked — never called wrong.
  await expect(critique.locator('[data-kind="not_checked"]')).toContainText('Somewhere Nobody Has Heard Of');
  await expect(critique).toContainText('Every place you named is kept as your own pick');
});
