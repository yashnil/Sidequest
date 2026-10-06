import { expect, test } from '@playwright/test';
import { buildFixtureTrip } from './support/v9';

/**
 * PRIVATE ALPHA — the feedback hook reaches the server and says so, and only
 * the owner sees it (the share page passes no trip id).
 */
test('an owner can tell us a day is too packed, and the share page has no feedback form', async ({ page, browser }) => {
  const id = await buildFixtureTrip(page);
  const panel = page.getByTestId('alpha-feedback');
  await panel.locator('summary').click();
  await panel.getByTestId('alpha-feedback-too_packed').click();
  await panel.getByLabel(/Which day/).selectOption('2');
  await panel.getByTestId('alpha-feedback-comment').fill('Day two has more than we can do.');
  await panel.getByTestId('alpha-feedback-send').click();
  await expect(panel.getByTestId('alpha-feedback-status')).toContainText('reached us', { timeout: 20_000 });

  await page.goto(`/trips/${id}/pack`);
  const mint = page.getByTestId('pack-share-link').getByRole('button', { name: 'Share this plan' });
  if (await mint.isVisible().catch(() => false)) await mint.click();
  const link = await page.getByLabel('Share link').inputValue();
  const stranger = await browser.newContext();
  const other = await stranger.newPage();
  await other.goto(link);
  await expect(other.getByTestId('alpha-feedback')).toHaveCount(0);
  await stranger.close();
});
