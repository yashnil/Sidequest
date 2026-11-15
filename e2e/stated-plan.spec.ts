import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, continueButton, waitUntilInteractive } from './support/trip';
import { openHubView } from './support/hub';
import { adviseToShortlist } from './support/advisor';

/**
 * MODE 3 — A PLAN THE TRAVELLER ALREADY HAD SURVIVES INTO THE TRIP.
 *
 * Offline throughout: the suite's fixture geocoder answers from the recorded
 * corpus (`lib/destinations/fixtures/nominatim/`), the composer and the scan
 * are fixtures. Rome and Florence are both in that corpus.
 *
 * What is held: "3 nights in Rome, 2 nights in Florence" goes through the
 * parse, the change-aware proposal, trip creation (the stated itinerary on the
 * composer answers and the trip contract), the discovery scan (the stated
 * stays are the bases), the planner, the save, a reopen, and the guide the
 * PDF prints — and the party is never a silent "two adults" on any door.
 */

async function checkPlan(page: Page, text: string): Promise<void> {
  await page.goto('/improve');
  const input = page.getByTestId('plan-check-input');
  await waitUntilInteractive(input);
  await input.fill(text);
  await page.getByTestId('plan-check-submit').click();
  await expect(page.getByTestId('plan-check-result')).toBeVisible({ timeout: 20_000 });
}

async function expectStays(page: Page) {
  const cards = page.getByTestId('base-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText('Rome');
  await expect(cards.nth(0)).toContainText(/3\s*nights/);
  await expect(cards.nth(1)).toContainText('Florence');
  await expect(cards.nth(1)).toContainText(/2\s*nights/);
  const stated = page.getByTestId('stated-plan');
  await expect(stated).toBeVisible();
  await expect(stated.getByTestId('stated-stay')).toHaveCount(2);
  await expect(stated.getByTestId('stated-stay').nth(0)).toHaveAttribute('data-outcome', 'honoured');
  await expect(stated.getByTestId('stated-stay').nth(0)).toContainText('Rome · 3 nights');
  await expect(stated.getByTestId('stated-stay').nth(1)).toHaveAttribute('data-outcome', 'honoured');
  await expect(page.getByTestId('stated-conflict')).toHaveCount(0);
}

test('"3 nights in Rome" survives parse, proposal, creation, scan, planning, save, reopen and the printed guide', async ({ page }) => {
  test.setTimeout(240_000);
  await checkPlan(page, 'June 10-15: 3 nights in Rome, 2 nights in Florence by train, for the two of us');

  /* What we read, and the two versions side by side: the stated nights are theirs. */
  await expect(page.getByTestId('plan-check-stop').nth(0)).toContainText('3 nights · you said');
  const original = page.getByTestId('plan-check-original');
  await expect(original.getByTestId('plan-check-version-stop').nth(0)).toContainText('Rome');
  await expect(original.getByTestId('plan-check-version-stop').nth(0)).toContainText('3 nights');
  await expect(page.getByTestId('plan-check-suggested').getByTestId('plan-check-version-stop').nth(0)).toContainText('3 nights');
  /* "For the two of us" settles the party: no question, and it says where it came from. */
  await expect(page.getByTestId('plan-check-party-known')).toContainText('2 adults');
  await expect(page.getByTestId('party-later')).toHaveCount(0);

  const plan = page.getByTestId('plan-check-plan');
  await waitUntilInteractive(plan);
  await plan.click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
  const tripId = /\/trips\/([^/]+)\//.exec(page.url())![1]!;

  await completeQuestionnaire(page);
  await page.getByRole('button', { name: /Find places for my trip|Open the Discovery Board/ }).click();
  await expect(page).toHaveURL(/\/discover$/, { timeout: 90_000 });
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 120_000 });
  await expectStays(page);

  /* Saved: a reopen shows the same stays and the same stated plan. */
  await page.goto(`/trips/${tripId}/itinerary`);
  await expectStays(page);
  await openHubView(page, 'days');
  await expect(page.getByRole('heading', { name: /^Day 6/ })).toBeVisible();

  /* The printed guide (what the PDF renders) sleeps in the same places. */
  await page.goto(`/trips/${tripId}/guide`);
  await expect(page.locator('body')).toContainText('Rome');
  await expect(page.locator('body')).toContainText('Florence');
});

test('a major change is proposed, never applied: tick to accept, untick to undo', async ({ page }) => {
  await checkPlan(page, 'Inverness, Isle of Skye and Fort William, United Kingdom in 4 days. Is that too much?');
  const changes = page.getByTestId('plan-check-change');
  await expect(changes.first()).toBeVisible();
  const major = page.locator('[data-testid="plan-check-change"][data-class="major"]').first();
  await expect(major).toBeVisible();
  await expect(major).toHaveAttribute('data-accepted', 'false');
  await expect(major).toContainText(/a place you named/);

  const suggested = page.getByTestId('plan-check-suggested');
  const before = (await suggested.textContent()) ?? '';
  await major.getByRole('checkbox').check();
  await expect(major).toHaveAttribute('data-accepted', 'true');
  await expect(suggested).not.toHaveText(before);
  await expect(page.getByTestId('plan-check-savings')).toContainText('estimates');
  /* Undo before planning is the toggle back. */
  await major.getByRole('checkbox').uncheck();
  await expect(major).toHaveAttribute('data-accepted', 'false');
  await expect(suggested).toHaveText(before);

  await major.getByRole('checkbox').check();
  await page.getByTestId('party-later').click();
  await expect(page.getByTestId('plan-check-party')).toHaveAttribute('data-basis', 'assumed');
  await page.getByTestId('plan-check-plan').click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
});

test('the plan check asks who is going only when nobody said, and labels a skip as assumed', async ({ page }) => {
  await checkPlan(page, '3 nights Lisbon, 2 nights Porto');
  const plan = page.getByTestId('plan-check-plan');
  await expect(plan).toBeDisabled();
  await page.getByTestId('party-later').click();
  await expect(page.getByTestId('party-assumed-note')).toContainText('assumed');
  await expect(plan).toBeEnabled();
  await plan.click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
  await expect(page.getByTestId('interview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/2 adults \(assumed\)/).first()).toBeVisible({ timeout: 20_000 });
});

test('the composer offers "skip — decide later" and labels the party as assumed', async ({ page }) => {
  await page.goto('/trips/new');
  const field = page.getByTestId('destination-input');
  await waitUntilInteractive(field);
  await field.fill('Lisbon');
  await continueButton(page).click();
  await page.getByTestId('timing-exact').click();
  await page.getByTestId('timing-start').fill('2027-06-10');
  await page.getByTestId('timing-end').fill('2027-06-14');
  await continueButton(page).click();
  await expect(page.getByTestId('party-later')).toBeVisible();
  await page.getByTestId('party-later').click();
  await expect(page.getByTestId('party-assumed-note')).toBeVisible();
  await continueButton(page).click();
  await expect(page.getByTestId('setup-flow')).toHaveAttribute('data-step', 'fixed');
  await continueButton(page).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
  await expect(page.getByTestId('interview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/2 adults \(assumed\)/).first()).toBeVisible({ timeout: 20_000 });
});

test('the advisor asks who is going before planning a pick, and a skip is labelled assumed', async ({ page }) => {
  test.setTimeout(180_000);
  await adviseToShortlist(page);
  const planThis = page.getByTestId('advisor-plan-this').first();
  await waitUntilInteractive(planThis);
  await planThis.click();
  const question = page.getByTestId('advisor-party-question').first();
  await expect(question).toBeVisible();
  await expect(question.getByTestId('advisor-party-continue')).toBeDisabled();
  await question.getByTestId('party-later').click();
  await question.getByTestId('advisor-party-continue').click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
  await expect(page.getByTestId('interview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/2 adults \(assumed\)/).first()).toBeVisible({ timeout: 20_000 });
});
