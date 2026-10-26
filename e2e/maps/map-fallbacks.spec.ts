import { expect, test } from '@playwright/test';
import { completeQuestionnaire, createTrip } from '../support/trip';
import { routeTiles } from './support/tiles';

/**
 * WHEN THE INTERACTIVE MAP CANNOT DRAW.
 *
 * With the map provider on, a tile service that refuses must never leave an
 * unexplained blank ground. (No WebGL: `no-webgl.spec.ts`.)
 */
const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

test('a tile service that refuses says so over the map, and the places stay drawn', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'covered on desktop');
  await routeTiles(page, { failStyle: true });
  await createTrip(page, 'Mammoth Lakes', AUGUST);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  /*
   * MapLibre still loads with its basemap source refused, so the marks are drawn
   * on an empty ground; the map must say that rather than pass a blank ground
   * off as a map. (A failure before the style loads falls back to the figure:
   * see no-webgl.spec.ts for that path.)
   */
  const stage = page.getByTestId('board-stage');
  await expect(stage).toHaveAttribute('data-tiles', 'failed', { timeout: 30_000 });
  await expect(stage.getByTestId('map-tiles-failed')).toBeVisible();
  expect(await stage.locator('.maplibregl-marker.atlas-pin').count()).toBeGreaterThan(1);
});
