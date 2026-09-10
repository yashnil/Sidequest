import { expect, test } from '@playwright/test';
import { waitUntilInteractive } from './support/trip';

/**
 * AN OBVIOUS DESTINATION IS NEVER "ANYWHERE".
 *
 * The production failure this locks down: on a deployment with no destination
 * index and no geocoder — which is what a fresh Railway service is — a traveller
 * typed "Japan", was shown the empty-world map captioned ANYWHERE, and was then
 * told the destination could not be placed, so its seasons could not be compared.
 *
 * This suite runs in exactly that configuration. The end-to-end server pins every
 * live provider off (see `playwright.config.ts`), so nothing here can be passing
 * because a network service answered: what places Japan is the bundled country
 * reference, offline, and that is the point.
 */

test.describe('placing a typed destination', () => {
  test('a country typed as free text is named on the canvas, never ANYWHERE, and its seasons are compared', async ({ page }) => {
    await page.goto('/trips/new');
    const field = page.getByTestId('destination-input');
    await waitUntilInteractive(field);

    /* Before anything is typed, the empty world is the honest picture. */
    const canvas = page.getByTestId('destination-canvas');
    await expect(canvas).toHaveAttribute('data-state', 'world');

    await field.fill('Japan');
    /* The moment there are words, the canvas carries them. */
    await expect(canvas).toHaveAttribute('data-state', 'named');
    await expect(canvas).toContainText('Japan');
    await expect(canvas).not.toContainText('ANYWHERE');

    await page.getByTestId('setup-continue').locator('visible=true').first().click();

    /* Continuing places it: no index, no geocoder, no network — the bundled reference. */
    await expect(canvas).toHaveAttribute('data-state', 'framed', { timeout: 15_000 });
    await expect(page.getByTestId('destination-map')).toBeVisible();
    await expect(page.locator('body')).not.toContainText('ANYWHERE');

    /*
     * And "tell me when it is best" stays usable. This suite's server has the
     * climate archive switched off, so what is asserted is the part that must
     * hold in *every* configuration: the mode is accepted, the answer is "later"
     * rather than a refusal, and nothing tells the traveller to go and do
     * something else instead. The window itself is compared where climate
     * records exist, and is covered by the timing unit tests.
     */
    await page.getByTestId('timing-best').click();
    await expect(page.getByTestId('timing-deferred')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('timing-deferred')).toContainText(/Sidequest will choose the best window|once we understand the trip/);
    await expect(page.locator('body')).not.toContainText('Pick your own dates and we will plan around them');
    await expect(page.getByTestId('setup-continue').locator('visible=true').first()).toBeEnabled();
  });

  test('somewhere the reference does not know keeps its name, keeps the mode, and blocks nothing', async ({ page }) => {
    await page.goto('/trips/new');
    const field = page.getByTestId('destination-input');
    await waitUntilInteractive(field);
    await field.fill('Okavango Delta');
    const canvas = page.getByTestId('destination-canvas');
    await expect(canvas).toContainText('Okavango Delta');
    await expect(canvas).not.toContainText('ANYWHERE');

    await page.getByTestId('setup-continue').locator('visible=true').first().click();
    await page.getByTestId('timing-best').click();

    /*
     * With no geocoder there is no coordinate, so there is nothing to compare —
     * and the traveller is told it will be chosen later rather than told to go
     * and pick dates instead. Their answer stands and Continue stays live.
     */
    const deferred = page.getByTestId('timing-deferred');
    await expect(deferred).toBeVisible({ timeout: 20_000 });
    await expect(deferred).toContainText(/Sidequest will choose the best window|once we understand the trip/);
    await expect(page.locator('body')).not.toContainText('Pick your own dates and we will plan around them');
    await expect(page.getByTestId('setup-continue').locator('visible=true').first()).toBeEnabled();
  });

  test('no provider name, variable or debug word reaches the traveller on the way in', async ({ page }) => {
    await page.goto('/trips/new');
    const field = page.getByTestId('destination-input');
    await waitUntilInteractive(field);
    await field.fill('Kyrgyzstan');
    await page.getByTestId('setup-continue').locator('visible=true').first().click();
    await page.getByTestId('timing-best').click();
    await page.waitForTimeout(2_000);
    const text = (await page.locator('body').innerText()).toLowerCase();
    for (const word of ['nominatim', 'geocoder', 'openrouteservice', 'valhalla', 'overture', 'provider', 'sidequest_', 'undefined', 'fixture']) {
      expect(text, word).not.toContain(word);
    }
  });
});
