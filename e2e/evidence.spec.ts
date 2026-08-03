import { expect, test, type Page } from '@playwright/test';
import { compileRegion } from './support/trip';

/**
 * WHAT A TRAVELLER SEES OF THE EVIDENCE.
 *
 * The compiler can resolve every fact perfectly and the product is no better for
 * it unless the board and the itinerary say so. These are the tests that stop
 * this phase being a schema nobody reads: a card that shows its sources, a
 * checklist that names what to book, and — as loudly — the unknowns.
 *
 * Offline throughout, against the synthetic worlds. Nothing here names a real
 * destination.
 */

const DATES = { start: '2026-08-12', end: '2026-08-16' };

async function createTrip(page: Page, destination: string): Promise<string> {
  await page.goto('/trips/new');
  await page.getByLabel('Destination').fill(destination);
  await page.getByLabel('Arrive').fill(DATES.start);
  await page.getByLabel('Leave').fill(DATES.end);
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/);
  return /\/trips\/([^/]+)\/plan/.exec(page.url())?.[1] ?? '';
}

async function compile(page: Page): Promise<void> {
  await compileRegion(page);
}

/**
 * Through the questionnaire to the board.
 *
 * Real interest answers rather than clicking through: the interests step refuses
 * to advance on "if nearby" for everything, and a board scored against a
 * traveller who said nothing is not the board this test is about.
 */
async function reachBoard(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Tell us how you travel' }).click();
  await page.waitForURL(/questionnaire/);

  await page.getByRole('radio', { name: 'Scenic viewpoints: Core' }).check();
  await page.getByRole('radio', { name: 'History & culture: A few times' }).check();
  await page.getByRole('radio', { name: 'Easy nature walks: A few times' }).check();

  for (let step = 0; step < 12; step += 1) {
    const build = page.getByRole('button', { name: 'Build my discovery board' });
    if (await build.isVisible().catch(() => false)) {
      await build.click();
      break;
    }
    const next = page.getByRole('button', { name: 'Continue' });
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await page.waitForTimeout(150);
  }
  await page.waitForURL(/discover/, { timeout: 30_000 });
}

test('a card shows why we trust it, and what nobody publishes', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  const panel = page.getByText(/Why we trust this/).first();
  await expect(panel).toBeVisible();

  // Collapsed by default: the audit trail is available, not imposed.
  const details = page.locator('details', { hasText: 'Why we trust this' }).first();
  expect(await details.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);

  await panel.click();
  await expect(details).toHaveAttribute('open', '');

  // The honest half is inside, in the same panel as the citations.
  await expect(details.getByText(/Nobody we could read publishes/)).toBeVisible();
});

test('a booking requirement is visible before the traveller commits to the stop', async ({
  page,
}) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  await expect(page.getByText(/Book ahead|Timed entry|Permit needed/).first()).toBeVisible();
});

test('the itinerary carries a preparation list built from what the plan schedules', async ({
  page,
}) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  const build = page.getByRole('button', { name: /Build my trip|Rebuild my trip/ });
  await expect(build).toBeEnabled({ timeout: 15_000 });
  await build.click();
  await page.waitForURL(/itinerary/, { timeout: 60_000 });

  const prep = page.getByTestId('before-you-go');
  await expect(prep).toBeVisible();
  await expect(prep.getByRole('heading', { name: 'Before you go' })).toBeVisible();

  // Every line names the place it is about, so it can be tied to a day.
  const items = prep.locator('li');
  expect(await items.count()).toBeGreaterThan(0);
  await expect(items.first()).not.toBeEmpty();
});

test('the preparation list survives a refresh, because it is derived from the stored plan', async ({
  page,
}) => {
  const id = await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await page.waitForURL(/itinerary/, { timeout: 60_000 });

  const before = await page.getByTestId('before-you-go').innerText();
  await page.goto(`/trips/${id}/itinerary`);
  await expect(page.getByTestId('before-you-go')).toBeVisible();
  expect(await page.getByTestId('before-you-go').innerText()).toBe(before);
});

test('the evidence surfaces never claim a confidence percentage', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  /**
   * A number beside a fact reads as a measurement. Everything this product knows
   * about how sure it is comes out as a word — "Verified", "One source",
   * "Sources disagree" — precisely because those can be argued with.
   */
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/\b\d{1,3}%\s*(confident|confidence|sure|certain)/i);
  expect(body).not.toMatch(/confidence score/i);
});

test('the evidence panel is reachable and readable by keyboard', async ({ page }) => {
  await createTrip(page, 'Harbour City');
  await compile(page);
  await reachBoard(page);

  const summary = page.locator('summary', { hasText: 'Why we trust this' }).first();
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  const details = page.locator('details', { hasText: 'Why we trust this' }).first();
  await expect(details).toHaveAttribute('open', '');
});
