// Drive the Journey Explorer on a real trip and screenshot each interaction.
// usage: node journey-drive.cjs <db> <tripId> <baseUrl> <outdir> [dayNumber]
const { chromium } = require('@playwright/test');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [db, tripId, base, out, dayArg = '2'] = process.argv.slice(2);
const token = execSync(`/usr/bin/sqlite3 ${db} "select owner_token from trips where id='${tripId}'"`).toString().trim();
const shot = (page, name) => page.screenshot({ path: path.join(out, `${name}.png`) });
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'sidequest_session', value: token, url: base }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/trips/${tripId}/itinerary#days`);
  await page.waitForTimeout(3000);
  await page.evaluate((n) => document.getElementById(`day-${n}`)?.scrollIntoView({ block: 'start' }), dayArg);
  const explorer = page.getByTestId('day-journey');
  await explorer.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('[data-testid="day-journey-map"]')?.getAttribute('data-map-health') === 'ready', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  await explorer.scrollIntoViewIfNeeded();
  await shot(page, '01-day');
  const log = {};
  // pin → row
  const pin = explorer.locator('.atlas-pin[data-state="chosen"]').first();
  if (await pin.count()) {
    await pin.click();
    await page.waitForTimeout(1800);
    log.rowSelected = await page.locator('[data-selected="true"]').count();
    await shot(page, '02-pin-selected');
  }
  // row → map
  const row = page.locator('#hub-view-days [data-row-kind="activity"] h3').nth(2);
  if (await row.count()) {
    const before = await explorer.locator('[data-testid="journey-coordbar"]').textContent();
    await row.click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.locator('#hub-view-days [data-row-kind="activity"]').nth(2).click({ position: { x: 20, y: 20 } }).catch(() => {});
    if (await page.getByTestId("place-sheet").isVisible().catch(() => false)) await page.keyboard.press("Escape");
    await page.waitForTimeout(2200);
    log.cameraMoved = before !== (await explorer.locator('[data-testid="journey-coordbar"]').textContent());
    await shot(page, '03-row-selected');
  }
  // key + leg
  await explorer.getByTestId('journey-key-toggle').click();
  const leg = explorer.getByTestId('journey-ribbon-leg').nth(1);
  if (await leg.count()) await leg.click();
  await page.waitForTimeout(1200);
  await shot(page, '04-key-leg');
  await explorer.getByTestId('journey-key-toggle').click();
  // 3D
  await explorer.getByTestId('journey-3d').click();
  await page.waitForTimeout(9000);
  log.terrain = await explorer.getAttribute('data-terrain');
  log.terrainStatus = await explorer.getByTestId('journey-terrain-status').textContent().catch(() => null);
  await shot(page, '05-3d');
  // replay
  await explorer.getByTestId('journey-replay').click();
  for (let i = 0; i < 4; i += 1) {
    await page.waitForTimeout(2600);
    await shot(page, `06-replay-${i}`);
  }
  log.replayStep = await explorer.getByTestId('journey-replay-step').textContent();
  await explorer.getByTestId('journey-replay-toggle').click();
  log.replayPaused = await explorer.getAttribute('data-replay');
  await explorer.getByTestId('journey-replay-exit').click();
  await page.waitForTimeout(1500);
  // whole trip
  await explorer.getByTestId('journey-3d').isVisible();
  await explorer.getByTestId('journey-2d').click();
  await page.waitForTimeout(1500);
  await explorer.getByTestId('journey-scale-trip').click();
  await page.waitForTimeout(2500);
  await shot(page, '07-trip');
  log.errors = errors;
  console.log(JSON.stringify(log, null, 1));
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
