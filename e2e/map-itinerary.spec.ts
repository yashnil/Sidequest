import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildFixtureTrip } from './support/v9';
import { openHubView } from './support/hub';

/**
 * THE MAP AND THE ITINERARY ARE ONE THING.
 *
 * Runs on the SVG figure (no vector basemap in the main suite), which is what a
 * browser without WebGL gets; `e2e/maps/` covers the same link on the real map.
 * Every assertion is about the shared selection: a day or a stop chosen on one
 * side is what the other side shows, it survives a tab change and a reload, and
 * an edit made by hand says what it did and can be taken back.
 */
const rowsOfDay = (page: Page, day: number) => page.locator(`#hub-view-days [data-timeline-place][data-day="${day}"]`);
const numberOf = (row: Locator) => row.getByTestId('stop-number');
const placeOf = async (row: Locator) => (await row.getAttribute('data-timeline-place'))!;
const pinOf = (map: Locator, id: string) => map.locator(`[data-marker="${id}"] [role="button"]`);
const selectedRow = (page: Page) => page.locator('#hub-view-days [data-selected="true"]');

test.describe('desktop', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 1024, 'the sticky map is the wide layout');

  test('a day, a stop and a pin are one selection across the list, the day map and the Map tab', async ({ page }) => {
    test.setTimeout(180_000);
    await buildFixtureTrip(page);
    await openHubView(page, 'days');
    const map = page.getByTestId('day-focus-map-canvas');

    await test.step('selecting a day draws and frames that day', async () => {
      await page.getByTestId('day-rail').locator('a[href="#day-3"]').click();
      await expect(map.locator('svg[aria-roledescription="map"]')).toHaveAttribute('aria-label', /on day 3/);
      await expect(page.getByTestId('trip-selection-status')).toContainText('Day 3 on the map');
    });

    await test.step('list → map: the number marks the pin, and says so', async () => {
      const row = rowsOfDay(page, 2).first();
      await row.scrollIntoViewIfNeeded();
      const id = await placeOf(row);
      await numberOf(row).click();
      await expect(numberOf(row)).toHaveAttribute('aria-pressed', 'true');
      await expect(selectedRow(page)).toHaveCount(1);
      await expect(pinOf(map, id)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('trip-selection-status')).toContainText('is marked on the map');
    });

    await test.step('map → list, by keyboard: the pin brings its row into view and marks it', async () => {
      const other = rowsOfDay(page, 2).last();
      const id = await placeOf(other);
      await pinOf(map, id).focus();
      await page.keyboard.press('Enter');
      await expect(numberOf(other)).toHaveAttribute('aria-pressed', 'true');
      await expect(other).toBeInViewport();
      await expect(other).toBeFocused();
      await expect(page.getByTestId('trip-selection-status')).toContainText('is marked in your itinerary');
    });

    await test.step('the selection survives a tab change, in both directions, and a reload', async () => {
      const id = await placeOf(rowsOfDay(page, 2).last());
      await openHubView(page, 'map');
      const workspace = page.getByTestId('map-workspace');
      await expect(workspace).toHaveAttribute('data-map-mode', 'day');
      await expect(workspace).toHaveAttribute('data-day', '2');
      await expect(pinOf(page.locator('#hub-view-map').getByTestId('trip-overview-map'), id)).toHaveAttribute('aria-pressed', 'true');
      await openHubView(page, 'days');
      await expect(numberOf(rowsOfDay(page, 2).last())).toHaveAttribute('aria-pressed', 'true');
      await page.reload();
      await openHubView(page, 'days');
      await expect(numberOf(rowsOfDay(page, 2).last())).toHaveAttribute('aria-pressed', 'true');
    });
  });
});

test.describe('phone', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 1440) >= 640, 'the dock is the narrow layout');

  test('the map docks beside the list: each answers the other and neither replaces the other', async ({ page }) => {
    test.setTimeout(180_000);
    await buildFixtureTrip(page);
    await openHubView(page, 'days');
    const dock = page.getByTestId('day-map-dock');
    await expect(dock).toBeHidden();

    const row = rowsOfDay(page, 2).first();
    await row.scrollIntoViewIfNeeded();
    const id = await placeOf(row);
    await numberOf(row).tap();

    await expect(dock).toBeVisible();
    await expect(dock).toHaveAttribute('data-day', '2');
    const figure = page.getByTestId('day-map-dock-figure');
    await expect(pinOf(figure, id)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('day-map-dock-status')).not.toBeEmpty();
    /* Both on screen at once: the row is clear of the dock that opened over it. */
    await expect
      .poll(async () => {
        const [rowBox, dockBox] = await Promise.all([row.boundingBox(), dock.boundingBox()]);
        return Boolean(rowBox && dockBox && rowBox.y >= 0 && rowBox.y < dockBox.y);
      })
      .toBe(true);

    const other = rowsOfDay(page, 2).last();
    await pinOf(figure, await placeOf(other)).focus();
    await page.keyboard.press('Enter');
    await expect(numberOf(other)).toHaveAttribute('aria-pressed', 'true');
    await expect(dock, 'a pin never closes the map').toBeVisible();

    await page.getByTestId('day-map-dock-next').tap();
    await expect(dock).toHaveAttribute('data-day', '3');

    await page.getByTestId('day-map-dock-close').tap();
    await expect(dock).toBeHidden();
    await expect(page.getByTestId('day-map-sheet-open')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  });
});

test('an edit says what it did, can be taken back, and a rebuild asks before replacing it', async ({ page }) => {
  test.setTimeout(240_000);
  const tripId = await buildFixtureTrip(page);
  await openHubView(page, 'days');
  const title = 'Harbour swim';
  const days = page.locator('#hub-view-days');

  const addStop = async () => {
    const dayEdit = page.locator('[data-testid^="day-edit-"]').filter({ has: page.getByTestId('add-stop-open') }).first();
    /* Idempotent: the disclosure stays open across an edit and an Undo. */
    if ((await dayEdit.getAttribute('open')) === null) await dayEdit.locator(':scope > summary').click();
    await dayEdit.getByTestId('add-stop-open').click();
    /* Not through `dayEdit`: its filter is on the button the form has just replaced. */
    await page.getByTestId('add-stop-title').first().fill(title);
    await page.getByTestId('add-stop-submit').first().click();
    await expect(days.getByText(title).first()).toBeVisible({ timeout: 20_000 });
  };

  await addStop();
  const toast = page.getByTestId('edit-toast');
  await expect(toast).toHaveAttribute('data-state', 'shown');
  await expect(page.getByTestId('edit-toast-message')).toContainText(title);

  await test.step('Undo restores the plan as it was', async () => {
    await page.getByTestId('edit-toast-undo').click();
    await expect(days.getByText(title)).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('edit-toast-message')).toContainText('Undone');
    await expect(page.getByTestId('edit-toast-undo')).toHaveCount(0);
  });

  await test.step('taking a stop off the plan can be undone too', async () => {
    const row = rowsOfDay(page, 2).first();
    const id = await placeOf(row);
    await row.scrollIntoViewIfNeeded();
    await row.getByTestId('stop-menu').click();
    await page.getByRole('menuitem', { name: /Remove from this day/ }).locator('visible=true').first().click();
    const gone = page.locator(`#hub-view-days [data-timeline-place="${id}"][data-day="2"]`);
    await expect(gone).toHaveCount(0, { timeout: 20_000 });
    await page.getByTestId('edit-toast-undo').click();
    await expect(gone).toHaveCount(1, { timeout: 20_000 });
  });

  await test.step('the board names what a rebuild would replace, and "Keep my plan" keeps it', async () => {
    await addStop();
    await page.goto(`/trips/${tripId}/discover`);
    await page.getByRole('button', { name: 'Rebuild my trip' }).click();
    const confirm = page.getByTestId('board-rebuild-confirm');
    await expect(confirm).toBeVisible();
    await expect(page.getByTestId('board-rebuild-replaced').first()).toContainText('Replaced');
    await page.getByTestId('board-rebuild-keep').click();
    await expect(confirm).toHaveCount(0);
    await expect(page).toHaveURL(/\/discover$/);
    await page.goto(`/trips/${tripId}/itinerary`);
    await openHubView(page, 'days');
    await expect(days.getByText(title).first()).toBeVisible();
  });
});
