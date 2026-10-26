// Screenshot pages of a trip as its owner (cookie from trips.owner_token).
// usage: node owner-shot.cjs <db> <tripId> <baseUrl> <outdir> <viewport: desktop|mobile> <path1> [path2 ...]
// A path may carry a name: "/trips/{id}/discover=board". Append "!full" for a full-page capture.
const { chromium, devices } = require('@playwright/test');
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const [db, tripId, base, out, vp, ...paths] = process.argv.slice(2);
const token = execSync(`/usr/bin/sqlite3 ${db} "select owner_token from trips where id='${tripId}'"`).toString().trim();
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext(vp === 'mobile' ? { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } : { viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'sidequest_session', value: token, url: base }]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 200)); });
  for (const spec of paths) {
    let [p, name] = spec.split('=');
    const full = (name ?? '').endsWith('!full');
    name = (name ?? p.replace(/\W+/g, '-')).replace('!full', '');
    const hashAt = p.indexOf('#');
    await page.goto(`${base}${p.replace('{id}', tripId)}`);
    await page.waitForTimeout(Number(process.env.SHOT_WAIT ?? 7000));
    if (process.env.SHOT_SCROLL) { await page.mouse.wheel(0, Number(process.env.SHOT_SCROLL)); await page.waitForTimeout(2500); }
    if (process.env.SHOT_HOVER) { const el = page.locator(process.env.SHOT_HOVER).first(); if (await el.count()) { await el.hover(); await page.waitForTimeout(2500); } }
    await page.screenshot({ path: path.join(out, `${name}-${vp}.png`), fullPage: full });
    console.log('shot', name, hashAt);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
