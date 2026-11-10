import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { buildFixtureTrip } from '../support/v9';
import { routeTiles } from '../maps/support/tiles';
import { bandAction, openHubView } from '../support/hub';
import { waitUntilInteractive } from '../support/trip';

/**
 * The audit's visible changes, photographed on the fixture server into
 * `docs/release-candidate/final/screens/audit/<AUDIT_SHOT_SET>/` (default `after`).
 * A tool, not a gate.
 */
const SET = process.env.AUDIT_SHOT_SET ?? 'after';
const OUT = path.join(process.cwd(), 'docs', 'release-candidate', 'final', 'screens', 'audit', SET);

for (const [name, width, height] of [['desktop', 1440, 900], ['tablet', 834, 1112], ['mobile', 390, 844]] as const) {
  test(`photograph the audit's surfaces at ${name}`, async ({ browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Widths are set by this test.');
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    await routeTiles(page);
    const shot = async (file: string) => page.screenshot({ path: path.join(OUT, `${name}-${file}.jpg`), type: 'jpeg', quality: 70 });

    const id = await buildFixtureTrip(page);
    await page.goto(`/trips/${id}/itinerary`);
    const share = await bandAction(page, 'Share this plan');
    await waitUntilInteractive(share);
    await share.click();
    await page.getByLabel('Share link').waitFor();
    await page.waitForTimeout(600);
    await shot('share-panel');

    await page.goto(`/trips/${id}/itinerary`);
    await openHubView(page, 'map');
    await page.waitForTimeout(2500);
    await page.getByTestId('journey-scale-day').locator('visible=true').first().click();
    await page.waitForTimeout(1500);
    const pin = page.getByTestId('journey-ribbon-stop').locator('visible=true').nth(1);
    if (await pin.isVisible().catch(() => false)) await pin.click();
    await page.waitForTimeout(2200);
    await shot('map-stop-card');

    await page.goto(`/trips/${id}/discover`);
    await page.getByTestId('board-summary').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await shot('board');
    await context.close();
  });
}
