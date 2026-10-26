import { test } from '@playwright/test';
import { createTrip, waitUntilInteractive } from '../../../e2e/support/trip';

/** The build screen mid-run (fixture token `slowbuild` holds the composer 8 s), for a screenshot. */
test('building screen', async ({ page }) => {
  await createTrip(page, 'Slowbuild Harbour City', { start: '2026-11-10', end: '2026-11-14' });
  await page.waitForURL(/\/questionnaire$/, { timeout: 30_000 });
  const defaults = page.getByTestId('interview-smart-defaults');
  await waitUntilInteractive(defaults);
  await defaults.click();
  await page.waitForURL(/\/(discover|build)$/, { timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `docs/production-pass/after/${test.info().project.name}-building-a.png` });
  await page.waitForURL(/\/build$/, { timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `docs/production-pass/after/${test.info().project.name}-building-b.png` });
});
