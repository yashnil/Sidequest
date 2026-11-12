import { expect, test, type Page } from '@playwright/test';
import { createTrip, waitUntilInteractive } from './support/trip';
import { addDays, span, todayIso } from './support/dates';
import { expectNoHorizontalOverflow } from './support/viewports';
import { buildFixtureTrip } from './support/v9';

/**
 * THE TRIPS HOME'S NIGHT STAGE (2026-11 visual continuity).
 *
 * Signing in continues the front page: the chrome turns night over the stage,
 * the greeting uses the account's name (never an address), a first visit gets
 * the destination line and example shapes that open the first question filled
 * in, and a returning visit gets its trips as marks on the world.
 */
async function signIn(page: Page, email: string, name?: string) {
  await page.goto('/signin');
  const door = page.getByTestId('signin-fixture');
  await waitUntilInteractive(door);
  await page.getByTestId('signin-email').fill(email);
  if (name) await page.getByTestId('signin-name').fill(name);
  await page.getByTestId('signin-submit').click();
  await page.waitForURL(/\/trips/, { timeout: 30_000 });
}

test('a first visit opens on the night stage, and an example starts a trip', async ({ page }) => {
  await signIn(page, `stage-first-${Date.now()}@example.com`, 'Maya Okafor');
  const stage = page.getByTestId('dashboard-empty');
  await expect(stage).toBeVisible();
  await expect(stage.getByRole('heading', { level: 1 })).toContainText('Where first?');
  await expect(stage).toContainText('Welcome, Maya');
  /* The chrome continues the stage's night instead of sitting on it as a pale strip. */
  const chromeBg = await page.getByTestId('product-chrome').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(chromeBg).toMatch(/rgba?\(13, 26, 31/);
  await expectNoHorizontalOverflow(page, 'first-visit trips home');

  const examples = page.getByTestId('dashboard-example');
  await expect(examples).toHaveCount(4);
  await examples.first().click();
  await page.waitForURL(/\/trips\/new\?destination=/);
  await expect(page.getByTestId('destination-input')).toHaveValue(/Iceland/i);
});

test('a returning visit greets by name, never by address, and puts each trip on the atlas', async ({ page }) => {
  const email = `stage-back-${Date.now()}@example.com`;
  await signIn(page, email);
  await createTrip(page, 'Lisbon', span(addDays(todayIso(), 50), 4));
  await page.goto('/trips');
  const stage = page.getByTestId('dashboard-stage');
  await expect(stage).toBeVisible();
  await expect(stage.getByRole('heading', { level: 1 })).toHaveText(/Welcome back\./);
  await expect(stage).not.toContainText(email.split('@')[0]!);
  await expect(page.getByTestId('trip-card')).toHaveCount(1);
  await expectNoHorizontalOverflow(page, 'returning trips home');

  /* The stage's own start is a plain form into the first question. */
  await page.getByTestId('dashboard-destination').fill('Kyoto');
  await page.getByTestId('dashboard-destination').press('Enter');
  await page.waitForURL(/\/trips\/new\?destination=Kyoto/);
});

test('reduced motion holds the stage still', async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await signIn(page, `stage-still-${Date.now()}@example.com`);
  const animation = await page.getByTestId('dashboard-empty').evaluate((el) => getComputedStyle(el, '::before').animationName);
  expect(animation).toBe('none');
  await context.close();
});

/*
 * A signed-in trip's facts line ends "· Saved to your Sidequest account". It
 * was set in `.coordbar` (nowrap) with a `whitespace-normal` that lost to it on
 * order, so on a phone narrower than ~540 px the line widened the layout, the
 * page zoomed out and the fixed tab bar sat below the visible screen.
 */
test('a signed-in trip fits a phone, and its tab bar can be pressed', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'The phone width is the case');
  await signIn(page, `stage-phone-${Date.now()}@example.com`);
  await buildFixtureTrip(page);
  await expect(page.getByTestId('saved-to-account')).toBeVisible();
  await expectNoHorizontalOverflow(page, 'signed-in trip on a phone');
  /* The check above cannot see this one: a mobile browser zooms out, so scrollWidth and clientWidth widen together. The layout width can. */
  expect(await page.evaluate(() => window.innerWidth)).toBe(page.viewportSize()!.width);
  await page.getByTestId('hub-bottom-map').click();
  await expect(page.locator('#hub-view-map')).toBeVisible();
});
