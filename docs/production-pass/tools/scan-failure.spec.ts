import { expect, test } from '@playwright/test';
import { completeQuestionnaire, createTrip, waitUntilInteractive } from '../../../e2e/support/trip';

/** The scan screen's failure state on the night ground, for a screenshot. */
test('scan failure screen', async ({ page }) => {
  await createTrip(page, 'Unscannable Harbour City', { start: '2026-11-10', end: '2026-11-14' });
  await page.waitForURL(/\/questionnaire$/, { timeout: 30_000 });
  await completeQuestionnaire(page);
  const find = page.getByTestId('interview-find-places');
  await waitUntilInteractive(find);
  await find.click();
  await expect(page.getByTestId('scan-failure')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `docs/production-pass/after/${test.info().project.name}-scan-failure.png` });
});
