// Open a trip's board as its owner, optionally auto-pick, press Build, wait for the itinerary.
// usage: node owner-build.cjs <db> <tripId> <baseUrl> [autopick]
const { chromium } = require('@playwright/test');
const { execSync } = require('node:child_process');
const [db, tripId, base, autopick] = process.argv.slice(2);
const token = execSync(`/usr/bin/sqlite3 ${db} "select owner_token from trips where id='${tripId}'"`).toString().trim();
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'sidequest_session', value: token, url: base }]);
  const page = await ctx.newPage();
  await page.goto(`${base}/trips/${tripId}/discover`);
  await page.getByTestId('board-summary').waitFor({ timeout: 120000 });
  if (autopick) { await page.getByTestId('board-auto-pick').click(); await page.waitForTimeout(4000); }
  console.log('summary', await page.getByTestId('board-summary').textContent());
  await page.getByRole('button', { name: /Build my trip|Rebuild my trip/ }).click();
  await page.waitForURL(/\/itinerary/, { timeout: 300000 });
  console.log('built', page.url());
  await browser.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
