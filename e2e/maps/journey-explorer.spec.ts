import { expect, test, type Page } from '@playwright/test';
import { completeQuestionnaire, createTrip } from '../support/trip';
import { openHubView } from '../support/hub';
import { routeTiles, waitForMap } from './support/tiles';

/**
 * THE INTERACTIVE MAPS, PRESSED IN A REAL BROWSER.
 *
 * Everything here runs the production MapLibre path — the Survey Atlas style,
 * the numbered pins, the evidence-styled legs, the camera — against a
 * controlled tile source (`support/tiles.ts`). The fallback SVG figure is
 * covered by the main suite; nothing in this file accepts it as a pass.
 */

const AUGUST = { start: '2026-08-12', end: '2026-08-15' };

async function reachBoard(page: Page) {
  await routeTiles(page);
  await createTrip(page, 'Mammoth Lakes', AUGUST);
  await completeQuestionnaire(page);
  await page.getByRole('button', { name: 'Open the Discovery Board' }).click();
  await expect(page).toHaveURL(/\/discover$/);
}

async function reachItinerary(page: Page) {
  await reachBoard(page);
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await expect(page).toHaveURL(/\/itinerary(#[a-z-]+)?$/, { timeout: 90_000 });
}

/** The camera, as the map's foot strip records it (`data-camera`: centre, zoom, bearing, tilt). */
async function cameraOf(page: Page, explorer: string): Promise<string> {
  return (await page.getByTestId(explorer).getByTestId('journey-coordbar').getAttribute('data-camera')) ?? '';
}

test('the board stage is a real map: numbered specimens, two-way selection, and a print of the place being read', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'the stage print is a desktop affordance; the phone gets the map window');
  await reachBoard(page);
  await waitForMap(page, 'board-stage');
  const stage = page.getByTestId('board-stage');
  const pins = stage.locator('.maplibregl-marker.atlas-pin');
  expect(await pins.count(), 'the stage should draw several places').toBeGreaterThan(2);
  // Every specimen is labelled with the number its register row wears.
  const label = (await pins.nth(1).getAttribute('aria-label')) ?? '';
  expect(label).toMatch(/^\d{2}, .+/);
  const number = label.slice(0, 2);
  const name = label.replace(/^\d{2}, /, '').replace(/, (in your trip|skipped)$/, '');
  // Pin → register: the row comes into view.
  await pins.nth(1).click();
  const card = page.locator('[data-place-card]').filter({ hasText: name }).first();
  await expect(card).toBeInViewport();
  await expect(card).toContainText(number);
  // Register → stage: hovering a row raises its print over the map.
  await card.hover();
  await expect(page.getByTestId('board-stage-feature')).toContainText(name);
});

test('the day explorer draws the day, shares selection with the timeline, and moves between scales', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(test.info().project.name === 'mobile', 'the sticky explorer is the desktop layout; the phone has its own test');
  await reachItinerary(page);
  await openHubView(page, 'days');
  const explorer = page.getByTestId('day-journey');
  await waitForMap(page, 'day-journey-map');
  await expect(explorer).toHaveAttribute('data-scale', 'day');

  await test.step('stops are plotted with the timeline numbers', async () => {
    const pins = explorer.locator('.maplibregl-marker.atlas-pin[data-state="chosen"]');
    const count = await pins.count();
    expect(count, 'the first day should plot its stops').toBeGreaterThan(0);
    const labels = await pins.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
    expect(labels.every((label) => /^Stop \d+: /.test(label))).toBe(true);
    await expect(explorer.getByTestId('journey-ribbon')).toBeVisible();
  });

  await test.step('pin → row: pressing a pin selects its row and brings it into view', async () => {
    const pin = explorer.locator('.maplibregl-marker.atlas-pin[data-state="chosen"]').first();
    const name = ((await pin.getAttribute('aria-label')) ?? '').replace(/^Stop \d+: /, '');
    await pin.click();
    const selected = page.locator('#hub-view-days [data-selected="true"]').first();
    await expect(selected).toContainText(name);
    await expect(selected).toBeInViewport();
    await expect(explorer.getByTestId('journey-detail')).toContainText(name);
  });

  await test.step('row → map: pressing a row flies the camera to it', async () => {
    const before = await cameraOf(page, 'day-journey');
    const rows = page.locator('#hub-view-days [data-day-focus="1"] [data-row-kind="activity"]');
    const target = rows.last();
    await target.scrollIntoViewIfNeeded();
    await target.click({ position: { x: 24, y: 12 } });
    await expect.poll(() => cameraOf(page, 'day-journey'), { timeout: 8_000 }).not.toBe(before);
    await expect(explorer.locator('.atlas-pin[aria-pressed="true"]')).toHaveCount(1);
  });

  await test.step('a leg says what is known about it, in words', async () => {
    const leg = explorer.getByTestId('journey-ribbon-leg').first();
    await leg.click();
    await expect(explorer.getByTestId('journey-leg')).toContainText(/route as measured|straight line, not the route|not drawn to its route/);
    await explorer.getByTestId('journey-key-toggle').click();
    await expect(explorer.getByTestId('journey-key')).toContainText('Route as measured');
    await expect(explorer.getByTestId('journey-key')).toContainText('not measured');
    await explorer.getByTestId('journey-key-toggle').click();
  });

  await test.step('whole trip, then a day from the strip, then back', async () => {
    await explorer.getByTestId('journey-scale-trip').click();
    await expect(explorer).toHaveAttribute('data-scale', 'trip');
    await expect(explorer.getByTestId('journey-days')).toBeVisible();
    await explorer.getByTestId('journey-day').nth(1).click();
    await expect(explorer).toHaveAttribute('data-scale', 'day');
    await expect(explorer).toHaveAttribute('data-day', '2');
  });

  await test.step('3D terrain over real elevation tiles, and back to 2D', async () => {
    await explorer.getByTestId('journey-3d').click();
    await expect(explorer).toHaveAttribute('data-terrain', '3d', { timeout: 15_000 });
    await expect(explorer.getByTestId('journey-terrain-status')).toContainText(/Relief here: [\d,]+–[\d,]+ m/);
    await expect.poll(() => cameraOf(page, 'day-journey')).toMatch(/tilt=[1-9]\d*/);
    await explorer.getByTestId('journey-2d').click();
    await expect(explorer).toHaveAttribute('data-terrain', '2d');
  });

  await test.step('Replay My Day: play, pause, step, speed, exit', async () => {
    await explorer.getByTestId('journey-replay').click();
    await expect(explorer).toHaveAttribute('data-replay', 'playing');
    const step = explorer.getByTestId('journey-replay-step');
    await expect(step).toContainText(/^Step 1 of \d+/);
    await explorer.getByTestId('journey-replay-toggle').click();
    await expect(explorer).toHaveAttribute('data-replay', 'paused');
    await explorer.getByTestId('journey-replay-next').click();
    await expect(step).toContainText(/^Step 2 of/);
    await explorer.getByTestId('journey-replay-speed').click();
    await expect(explorer.getByTestId('journey-replay-speed')).toHaveText('2×');
    await explorer.getByTestId('journey-replay-exit').click();
    await expect(explorer).toHaveAttribute('data-replay', 'off');
  });

  await test.step('the map never traps the page scroll', async () => {
    const box = await explorer.boundingBox();
    const y = await page.evaluate(() => window.scrollY);
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(y);
  });
});

test('under reduced motion, Replay never plays itself: the traveller steps', async ({ browser }) => {
  test.setTimeout(180_000);
  test.skip(test.info().project.name === 'mobile', 'covered on desktop');
  const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await reachItinerary(page);
  await openHubView(page, 'days');
  await waitForMap(page, 'day-journey-map');
  const explorer = page.getByTestId('day-journey');
  await explorer.getByTestId('journey-replay').click();
  await expect(explorer).toHaveAttribute('data-replay', 'paused');
  await expect(explorer.getByTestId('journey-replay-step')).toContainText('motion reduced');
  await page.waitForTimeout(3_000);
  await expect(explorer.getByTestId('journey-replay-step')).toContainText(/^Step 1 of/);
  await explorer.getByTestId('journey-replay-next').click();
  await expect(explorer.getByTestId('journey-replay-step')).toContainText(/^Step 2 of/);
  await context.close();
});

test('the whole-trip Journey view is the explorer at full size', async ({ page }) => {
  test.setTimeout(180_000);
  await reachItinerary(page);
  await openHubView(page, 'map');
  await waitForMap(page, 'trip-journey-map');
  const explorer = page.getByTestId('trip-journey');
  await expect(explorer).toHaveAttribute('data-scale', 'trip');
  const pins = explorer.locator('.maplibregl-marker.atlas-pin[data-state="chosen"]');
  expect(await pins.count()).toBeGreaterThan(1);
  // In the trip view each stop wears its day's number.
  const labels = await pins.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  expect(labels.every((label) => /^Day \d+: /.test(label))).toBe(true);
  await explorer.getByTestId('journey-day').first().click();
  await expect(explorer).toHaveAttribute('data-scale', 'day');
  // Keyboard: a pin is a real button in the tab order.
  const first = explorer.locator('.maplibregl-marker.atlas-pin[data-state="chosen"]').first();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
});

test('on a phone the day map opens full screen, keeps focus inside, and closes with Escape', async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(test.info().project.name !== 'mobile', 'the phone sheet');
  await reachItinerary(page);
  await openHubView(page, 'days');
  const open = page.getByTestId('day-map-sheet-open');
  await expect(open).toBeVisible();
  await open.click();
  const sheet = page.getByTestId('day-map-sheet');
  await expect(sheet).toBeVisible();
  await waitForMap(page, 'day-map-sheet-journey-map');
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  await expect(page.getByTestId('day-map-sheet-journey').locator('.maplibregl-marker.atlas-pin[data-state="chosen"]').first()).toBeVisible();
  // Escape closes it and gives the page back.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  // Touch: a tap on a ribbon stop closes the map and lands on that stop's row, selected.
  await open.click();
  await waitForMap(page, 'day-map-sheet-journey-map');
  await page.getByTestId('day-map-sheet-journey').getByTestId('journey-ribbon-stop').nth(1).tap();
  await expect(sheet).toBeHidden();
  await expect(page.locator('#hub-view-days [data-selected="true"]').first()).toBeInViewport();
  // No horizontal overflow at a phone width with the map closed.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
});
