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
    /* A country places from the bundled reference, so the geocoder being down does not stop the trip. */
    await createTrip(page, 'Portugal', { start: '2027-05-10', end: '2027-05-14' });
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
    /* An unmeasured leg is printed with the estimate prefix (≈, `travelFigurePrefix`) or the word itself. */
    expect(days).toMatch(/estimate|≈/i);
    expect(days).not.toMatch(/\d+\s?°C/);
    expect(await page.locator('body').innerText()).not.toMatch(NO_LEAKS);
  });
});

test.describe('the routing quota is already spent (simulated)', () => {
  test.use({ baseURL: 'http://localhost:4323' });
  test('the planner keeps the trip, says the times are estimates, and stops asking the router', async ({ page, request }) => {
    await createTrip(page, 'Portugal', { start: '2027-05-10', end: '2027-05-14' });
    await page.waitForURL(/\/questionnaire$/, { timeout: 30_000 });
    await completeQuestionnaire(page);
    const find = page.getByTestId('interview-find-places');
    await waitUntilInteractive(find);
    await find.click();
    await expect(page.getByTestId('board-summary')).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
    await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 120_000 });
    await expect(page.getByTestId('route-overview')).toBeVisible();
    /* The planner's plan shipped and says why its times are estimates. */
    await expect(page.getByTestId('routing-degraded')).toContainText(/estimates/);
    await openHubView(page, 'days');
    expect(await page.locator('#hub-view-days').innerText()).toMatch(/estimate|≈/i);
    expect(await page.locator('body').innerText()).not.toMatch(NO_LEAKS);
    /* The breaker: the first refusal shut the service until its reset; the rest were never sent. */
    const { count } = (await (await request.get('http://127.0.0.1:4399/count')).json()) as { count: number };
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(2);
  });
});

test.describe('the geocoder is down and the destination is a town nobody bundled', () => {
  test.use({ baseURL: 'http://localhost:4321' });
  test('discovery stops with a typed, user-safe message and the answers are kept', async ({ page }) => {
    await createTrip(page, 'Harbour City', { start: '2027-05-10', end: '2027-05-14' });
    await page.waitForURL(/\/questionnaire$/, { timeout: 30_000 });
    await completeQuestionnaire(page);
    const find = page.getByTestId('interview-find-places');
    await waitUntilInteractive(find);
    await find.click();
    await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
    const body = page.locator('body');
    await expect(body).toContainText(/answers are saved|could not|couldn.t|can.t/i, { timeout: 150_000 });
    expect(await body.innerText()).not.toMatch(NO_LEAKS);
  });
});

test.describe('the model refuses the key', () => {
  test.use({ baseURL: 'http://localhost:4322' });
  test('discovery fails with a typed, user-safe message', async ({ page }) => {
    await createTrip(page, 'Lisbon, Portugal', { start: '2027-05-10', end: '2027-05-14' });
    await page.waitForURL(/\/questionnaire$/, { timeout: 60_000 });
    await completeQuestionnaire(page);
    const find = page.getByTestId('interview-find-places');
    const body = page.locator('body');
    /*
     * V1 convergence: when the deployment already knows the search cannot run,
     * the primary action is disabled with the reason beside it, before anyone
     * presses it. Either honest state passes; a silent one does not.
     */
    await expect(find.or(page.getByTestId('build-unavailable')).first()).toBeVisible({ timeout: 60_000 });
    if (await find.isDisabled()) {
      await expect(page.getByTestId('build-unavailable')).toContainText(/can.t|couldn.t|could not|not able|unavailable|try again|isn.t/i);
    } else {
      await waitUntilInteractive(find);
      await find.click();
      await expect(page).toHaveURL(/\/discover$/, { timeout: 30_000 });
      await expect(body).toContainText(/can.t reach|couldn.t|could not|not able|unavailable|try again/i, { timeout: 120_000 });
    }
    expect(await body.innerText()).not.toMatch(NO_LEAKS);
  });
});
