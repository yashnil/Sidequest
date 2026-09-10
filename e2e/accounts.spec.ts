import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createTrip } from './support/trip';

/** Dates in the future, so the dashboard files these under ideas and planning rather than the past. */
const AHEAD = { start: '2027-06-13', end: '2027-06-20' };

/**
 * V6 §21/§22/§50 — ACCOUNTS, THE GUEST CLAIM, AND THE OWNERSHIP BOUNDARY IN
 * A REAL BROWSER.
 *
 * Two people, three browsers. The fixture sign-in door is open in the suite
 * (`SIDEQUEST_AUTH_PROVIDER=fixture`); it is refused on a production
 * deployment unless explicitly allowed, and the unit suite proves that.
 */

async function signIn(page: Page, email: string, name?: string): Promise<void> {
  await page.goto('/signin');
  await expect(page.getByTestId('signin-fixture')).toBeVisible();
  await page.getByTestId('signin-email').fill(email);
  if (name) await page.getByTestId('signin-name').fill(name);
  await page.getByTestId('signin-submit').click();
  await page.waitForURL(/\/trips(\?|$)/, { timeout: 30_000 });
  await expect(page.getByTestId('nav-account')).toBeVisible();
}

async function freshPage(context: BrowserContext): Promise<Page> {
  return context.newPage();
}

test('a guest’s trips can be saved to an account, and only that browser’s trips move', async ({ page, browser }) => {
  test.skip(test.info().project.name !== 'desktop', 'One viewport is enough for an ownership proof');
  const guestTrip = await createTrip(page, 'Harbour City', AHEAD);

  /* A second, unrelated guest browser makes its own trip. */
  const other = await browser.newContext();
  const otherPage = await freshPage(other);
  const otherTrip = await createTrip(otherPage, 'Harbour City', AHEAD);

  /* The first browser signs in and is offered its own trip. */
  await signIn(page, 'ana@example.com', 'Ana');
  await expect(page.getByTestId('claim-banner')).toBeVisible();
  await expect(page.getByTestId('claim-banner')).toContainText(/made a trip before you signed in/);
  await page.getByTestId('claim-trips').click();
  /* The page re-reads: the offer is gone because nothing is left to claim, and the trip is on the account. */
  await expect(page.getByTestId('claim-banner')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('trip-card')).toHaveCount(1);
  await expect(page.getByTestId('trip-card').first()).toHaveAttribute('data-lifecycle', /idea|planning/);

  /* The other browser's trip was not touched: it still owns it, unsigned. */
  await otherPage.goto(`/trips/${otherTrip}/questionnaire`);
  await expect(otherPage).toHaveURL(new RegExp(`/trips/${otherTrip}/`));
  await expect(otherPage.getByTestId('nav-account')).toHaveCount(0);
  await otherPage.goto('/trips');
  await expect(otherPage.getByTestId('trip-card')).toHaveCount(1);

  /* And the other browser cannot reach the claimed trip. */
  await otherPage.goto(`/trips/${guestTrip}/questionnaire`);
  await expect(otherPage.getByTestId('setup-flow').or(otherPage.getByTestId('interview'))).toHaveCount(0);
  await expect(otherPage.getByText(/trip/i).first()).toBeVisible();
  await expect(otherPage.locator('body')).not.toContainText('Harbour City');
  await other.close();
});

test('a claimed trip follows the account to a new browser and is refused to another account', async ({ page, browser }) => {
  test.skip(test.info().project.name !== 'desktop', 'One viewport is enough for an ownership proof');
  await signIn(page, 'ben@example.com', 'Ben');
  const tripId = await createTrip(page, 'Harbour City', AHEAD);
  await page.goto('/trips');
  await expect(page.getByTestId('trip-card')).toHaveCount(1);
  /* Nothing answered yet: an idea. */
  await expect(page.getByTestId('dashboard-section-ideas')).toBeVisible();

  /* Same account, brand-new browser: the trip is there. */
  const second = await browser.newContext();
  const secondPage = await freshPage(second);
  await signIn(secondPage, 'ben@example.com');
  await expect(secondPage.getByTestId('trip-card')).toHaveCount(1);
  await secondPage.goto(`/trips/${tripId}/questionnaire`);
  await expect(secondPage).toHaveURL(new RegExp(`/trips/${tripId}/`));
  await expect(secondPage.locator('body')).toContainText('Harbour City');
  await second.close();

  /* A different account: refused, and learns nothing. */
  const third = await browser.newContext();
  const thirdPage = await freshPage(third);
  await signIn(thirdPage, 'cara@example.com', 'Cara');
  await expect(thirdPage.getByTestId('dashboard-empty')).toBeVisible();
  await thirdPage.goto(`/trips/${tripId}/itinerary`);
  await expect(thirdPage.locator('body')).not.toContainText('Harbour City');
  await third.close();

  /* Sign out ends the session: the original browser is a guest again and sees no account trips. */
  await page.getByTestId('nav-account').locator('summary').click();
  await page.getByTestId('nav-signout').click();
  await page.waitForURL(/\/$/);
  await page.goto('/trips');
  await expect(page.getByTestId('nav-signin')).toBeVisible();
  await expect(page.getByTestId('trip-card')).toHaveCount(0);
});

test('the dashboard can rename, archive and restore a trip', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop', 'One viewport is enough');
  await createTrip(page, 'Harbour City', AHEAD);
  await page.goto('/trips');
  const card = page.getByTestId('trip-card').first();
  await card.getByTestId('trip-card-menu').click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByTestId('trip-rename-input').fill('Harbour long weekend');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('trip-card-title').first()).toHaveText('Harbour long weekend');
  await card.getByTestId('trip-card-menu').click();
  await page.getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.getByTestId('dashboard-section-archived')).toBeVisible();
  await page.getByTestId('trip-card').first().getByTestId('trip-card-menu').click();
  await page.getByRole('menuitem', { name: 'Restore' }).click();
  await expect(page.getByTestId('dashboard-section-archived')).toHaveCount(0);
});
