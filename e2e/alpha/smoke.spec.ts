import { expect, test, type Page } from '@playwright/test';
import { continueButton, waitUntilInteractive } from '../support/trip';

/**
 * DEPLOYED SMOKE — no model call, no paid provider call.
 * See `playwright.alpha.config.ts`.
 */

const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

test('health and readiness answer, and readiness says the primary flow works', async ({ request }) => {
  const health = await request.get('/api/health');
  expect(health.status()).toBe(200);
  const readiness = await request.get('/api/readiness');
  const body = await readiness.json();
  expect(body.ready, JSON.stringify(body.blocking ?? body.problems)).toBe(true);
  // No secret value and no filesystem path ever leaves the readiness route.
  expect(JSON.stringify(body)).not.toMatch(/sk-ant-|AIza|\/data\/|\.db\b/);
});

test('the landing page renders its three doors without horizontal scroll', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /plan|start|new trip/i }).first()).toBeVisible();
  await noHorizontalScroll(page);
  // Nothing on a public page points at a developer machine or an internal host.
  const html = await page.content();
  expect(html).not.toMatch(/localhost|railway\.internal/);
});

test('a new trip reaches the interview and survives a reload', async ({ page }) => {
  await page.goto('/trips/new');
  const field = page.getByTestId('destination-input');
  await waitUntilInteractive(field);
  await field.fill('Lisbon, Portugal');
  await continueButton(page).click();
  await page.getByTestId('timing-exact').click();
  await page.getByTestId('timing-start').fill('2027-05-10');
  await page.getByTestId('timing-end').fill('2027-05-14');
  await continueButton(page).click();
  await page.getByTestId('party-couple').click();
  await continueButton(page).click();
  await expect(page.getByTestId('setup-flow')).toHaveAttribute('data-step', 'fixed');
  await continueButton(page).click();
  await page.waitForURL(/\/trips\/[^/]+\/questionnaire/, { timeout: 60_000 });
  const tripId = /\/trips\/([^/]+)\//.exec(page.url())![1]!;
  await noHorizontalScroll(page);
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/trips/${tripId}/`));
  await expect(page.locator('body')).toContainText(/Lisbon/);
});

test('an existing shared itinerary opens for a stranger without private facts', async ({ page }) => {
  const share = process.env.SIDEQUEST_ALPHA_SHARE_URL;
  test.skip(!share, 'Set SIDEQUEST_ALPHA_SHARE_URL to a share link on this deployment.');
  const response = await page.goto(share!);
  expect(response?.status()).toBe(200);
  const text = await page.locator('body').innerText();
  expect(text.length).toBeGreaterThan(200);
  expect(text).not.toMatch(/sk-ant-|ANTHROPIC|SIDEQUEST_|stack trace|at Object\./i);
  await noHorizontalScroll(page);
});
