import { expect, test, type Page } from '@playwright/test';
import { waitUntilInteractive } from './support/trip';

/**
 * THE THIRD DOOR — "I ALREADY HAVE A PLAN".
 *
 * Offline throughout: the suite's fixture resolver answers the queries the
 * destination-semantics corpus recorded from the public geocoder
 * (`lib/destinations/fixtures/nominatim/`), so every stop below is placed on
 * a real recorded row and nothing reaches a live provider. The plans use only
 * places that corpus recorded.
 */

async function checkPlan(page: Page, text: string): Promise<void> {
  await page.goto('/improve');
  const input = page.getByTestId('plan-check-input');
  await waitUntilInteractive(input);
  await input.fill(text);
  await page.getByTestId('plan-check-submit').click();
}

test('the home page offers three doors and the third opens the plan check', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'I know where I want to go' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Help me choose' })).toBeVisible();
  const third = page.getByTestId('home-improve');
  await expect(third).toBeVisible();
  await expect(third).toHaveText('I already have a plan');
  await third.click();
  await page.waitForURL(/\/improve$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/Got a plan/);
});

test('a rushed plan is called too much, with estimated moves, and the improved version becomes a trip', async ({ page }) => {
  await checkPlan(page, 'Inverness, Isle of Skye and Fort William, United Kingdom in 4 days. Is that too much?');

  const result = page.getByTestId('plan-check-result');
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('plan-check-headline')).toContainText(/Too much for 3 nights/);
  await expect(result).toContainText('You asked: “Is that too much?”');

  /* What we read: three places, each with an even split it says it chose. */
  const stops = page.getByTestId('plan-check-stop');
  await expect(stops).toHaveCount(3);
  await expect(stops.first()).toContainText('Inverness');
  await expect(stops.first()).toContainText('an even split');

  /* Every move is an estimate and says so. */
  const moves = page.getByTestId('plan-check-move');
  await expect(moves).toHaveCount(2);
  for (const move of await moves.all()) await expect(move).toContainText('estimate');

  /* Findings are grounded in numbers; the island move does not pretend to be a road. */
  await expect(page.getByTestId('plan-check-finding').filter({ hasText: '3 places to sleep in 3 nights' })).toHaveCount(1);
  await expect(page.getByTestId('plan-check-finding').filter({ hasText: /ferry or a flight/ }).first()).toBeVisible();

  await expect(page.getByTestId('plan-check-improved')).toBeVisible();
  const plan = page.getByTestId('plan-check-plan-improved');
  await waitUntilInteractive(plan);
  await plan.click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)$/, { timeout: 20_000 });
});

test('a jump too far for a day overland is a flight, and the plan as written becomes a trip', async ({ page }) => {
  await checkPlan(page, 'Day 1-3: Bariloche\nDay 4-6: El Calafate');

  await expect(page.getByTestId('plan-check-result')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('plan-check-stop')).toHaveCount(2);
  await expect(page.getByTestId('plan-check-stop').first()).toContainText('from your day list');
  await expect(page.getByTestId('plan-check-move')).toContainText('door to door by air');
  await expect(page.getByTestId('plan-check-finding').filter({ hasText: /so this is a flight/ })).toHaveCount(1);

  const asWritten = page.getByTestId('plan-check-plan-as-written');
  await waitUntilInteractive(asWritten);
  await asWritten.click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)$/, { timeout: 20_000 });
});

test('text with no places gets a plain answer, not a critique', async ({ page }) => {
  await checkPlan(page, '???');
  await expect(page.getByTestId('plan-check-error')).toContainText(/couldn’t find any places/);
  await expect(page.getByTestId('plan-check-result')).toHaveCount(0);
});
