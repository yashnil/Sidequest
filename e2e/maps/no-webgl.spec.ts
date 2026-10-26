import { expect, test } from '@playwright/test';
import { completeQuestionnaire, createTrip } from '../support/trip';
import { routeTiles } from './support/tiles';

/** Without WebGL the interactive map reports itself failed and the drawn figure stands in, every pin still pressable. */
test.use({ launchOptions: { args: ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis'] } });

test('with no WebGL the board stage falls back to the drawn figure', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'covered on desktop');
  await routeTiles(page);
  await createTrip(page, 'Mammoth Lakes', { start: '2026-08-12', end: '2026-08-15' });
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  const stage = page.getByTestId('board-stage');
  await expect(stage).toHaveAttribute('data-map-health', 'failed', { timeout: 15_000 });
  const figure = stage.getByTestId('board-map');
  await expect(figure).toBeVisible();
  expect(await figure.getByRole('button').count()).toBeGreaterThan(1);
});
