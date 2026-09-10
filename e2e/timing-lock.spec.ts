import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, waitUntilInteractive } from './support/trip';

/**
 * V6 §2 — A TRAVELLER ACCEPTING A WINDOW CAN NEVER RECEIVE ANOTHER.
 *
 * The exact press that lost two production trips' dates: "Tell me when it is
 * best" → "Use this timing" → the rest of the setup → the interview → Build.
 * The finished trip must be dated to the accepted window, and the Overview
 * must not explain a month the trip is not in.
 *
 * Runs under `playwright.timing.config.ts`, which turns the fixture climate on
 * so a window is proposed; the main suite keeps climate off and asserts the
 * deferred copy instead.
 */

const continueButton = (page: Page) => page.getByTestId('setup-continue').locator('visible=true').first();

test('the accepted window is the trip’s dates, from the press to the finished plan', async ({ page }) => {
  await page.goto('/trips/new');
  const field = page.getByTestId('destination-input');
  await waitUntilInteractive(field);
  /* A country the bundled reference places offline, so the recommender has a centre to compare months for. */
  await field.fill('Japan');
  await continueButton(page).click();
  await expect(page.getByTestId('destination-canvas')).toHaveAttribute('data-state', 'framed', { timeout: 15_000 });

  await expect(page.getByTestId('timing-best')).toBeVisible();
  await page.getByTestId('timing-best').click();
  const accept = page.getByTestId('timing-accept');
  await expect(accept).toBeVisible({ timeout: 20_000 });
  const window = (await page.getByTestId('timing-pick').innerText()).match(/(\d{4}-\d{2}-\d{2}) → (\d{4}-\d{2}-\d{2})/);
  expect(window, 'the pick shows its dates').toBeTruthy();
  const [, startDate, endDate] = window!;
  await accept.click();

  /* Nights are pre-filled from the window; confirm them. Who: a couple. */
  await expect(page.getByRole('heading', { name: /How many nights/ })).toBeVisible();
  await continueButton(page).click();
  await expect(page.getByTestId('party-couple')).toBeVisible();
  await page.getByTestId('party-couple').click();
  await continueButton(page).click();
  await expect(page.getByTestId('setup-flow')).toHaveAttribute('data-step', 'fixed');
  await continueButton(page).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
  const tripId = /\/trips\/([^/]+)\//.exec(page.url())![1]!;

  /* The review states the accepted dates as the traveller's, before anything is built. */
  await completeQuestionnaire(page);
  await expect(page.getByTestId('interview-review')).toBeVisible();
  await page.getByRole('button', { name: /Build my trip/ }).click();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/itinerary(#[a-z-]+)?$`), { timeout: 120_000 });

  /* The finished trip is dated to the accepted window, not a placeholder or a model window. */
  const hero = page.getByTestId('atlas-band').first();
  await expect(hero).toBeVisible({ timeout: 30_000 });
  const startLabel = new Date(`${startDate!}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const monthShort = startLabel.split(' ')[1]!;
  await expect(hero).toContainText(monthShort);
  /* The days are rendered (in the Days panel, hidden until chosen) and there are exactly as many as the window holds. */
  const days = page.locator('[id^="day-"]');
  const nights = Math.round((Date.parse(`${endDate!}T00:00:00Z`) - Date.parse(`${startDate!}T00:00:00Z`)) / 86_400_000);
  await expect(days).toHaveCount(nights + 1);

  /* And the Overview never explains a month the trip is not in. */
  const monthName = new Date(`${startDate!}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  const rationale = page.getByTestId('timing-rationale');
  if (await rationale.count()) {
    const text = (await rationale.innerText()).toLowerCase();
    const named = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].filter((m) => text.includes(m));
    for (const m of named) expect(m, `the timing rationale names ${m}`).toBe(monthName.toLowerCase());
  }
});
