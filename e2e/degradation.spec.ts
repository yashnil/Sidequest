import { expect, test } from '@playwright/test';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from './support/trip';
import { openHubView } from './support/hub';

/**
 * PRIVATE ALPHA — FAILURE BEHAVIOUR ON THE PRODUCTION BUILD.
 * Servers and their broken providers: `playwright.degraded.config.ts`.
 */
const NO_LEAKS = /\bstack\b|TypeError|ECONNREFUSED|at Object\.|node_modules|\b401\b|Unauthorized|SIDEQUEST_[A-Z_]+/;

test.describe('routing, weather, geocoder and food all down', () => {
  test.use({ baseURL: 'http://localhost:4321' });
  test('the trip still builds, honestly labelled', async ({ page }) => {
    await createTrip(page, 'Harbour City', { start: '2027-05-10', end: '2027-05-14' });
    await page.waitForURL(/\/questionnaire$/, { timeout: 30_000 });
    await completeQuestionnaire(page);
    const find = page.getByTestId('interview-find-places');
    await waitUntilInteractive(find);
    await find.click();
    await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
    await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 120_000 });
    await expect(page.getByTestId('route-overview')).toBeVisible();
    await openHubView(page, 'days');
    const days = await page.locator('#hub-view-days').innerText();
    expect(days).toMatch(/estimate/i);
    expect(days).not.toMatch(/\d+\s?°C/);
    expect(await page.locator('body').innerText()).not.toMatch(NO_LEAKS);
  });
});

test.describe('the model refuses the key', () => {
  test.use({ baseURL: 'http://localhost:4322' });
  test('discovery fails with a typed, user-safe message', async ({ page }) => {
    await createTrip(page, 'Lisbon, Portugal', { start: '2027-05-10', end: '2027-05-14' });
    await page.waitForURL(/\/questionnaire$/, { timeout: 60_000 });
    await completeQuestionnaire(page);
    const find = page.getByTestId('interview-find-places');
    await waitUntilInteractive(find);
    await find.click();
    await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
    const body = page.locator('body');
    await expect(body).toContainText(/can.t reach|couldn.t|could not|not able|unavailable|try again/i, { timeout: 120_000 });
    expect(await body.innerText()).not.toMatch(NO_LEAKS);
  });
});
