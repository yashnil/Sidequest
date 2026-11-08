import { expect, test } from '@playwright/test';
import { routeTiles } from './support/tiles';

/**
 * THE LANDING GLOBE WITHOUT WEBGL.
 *
 * A browser that cannot draw the globe goes straight from the silhouette to the
 * designed still (`ExampleStill`): no map library is built, no canvas, no
 * retry loop, and the hero's example index keeps working.
 */
test.use({ launchOptions: { args: ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis'] } });

test('with no WebGL the landing hero settles on the example still', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await routeTiles(page);
  await page.goto('/');
  const globe = page.getByTestId('atlas-globe');
  await globe.scrollIntoViewIfNeeded();
  await expect(globe).toHaveAttribute('data-phase', 'failed', { timeout: 15_000 });
  await expect(globe.locator('.survey-night')).toBeVisible();
  await expect(page.getByTestId('globe-silhouette')).toHaveCount(0);
  await expect(globe.locator('canvas')).toHaveCount(0);
  await expect(page.locator('link#maplibre-gl-css')).toHaveCount(0);
  /* The example index still drives the still. */
  const regions = page.getByRole('list', { name: 'Example regions' }).getByRole('button');
  await regions.nth(1).click();
  await expect(regions.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(globe.locator('.survey-night')).toBeVisible();
  expect(errors).toEqual([]);
});
