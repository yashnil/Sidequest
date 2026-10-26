import { chromium } from '@playwright/test';
const [url, out, w = '1440', h = '900', wait = '9000', full = ''] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--enable-webgl', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
p.on('pageerror', (e) => console.log('PAGEERROR', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await p.goto(url, { waitUntil: 'load' });
await p.waitForTimeout(+wait);
if (full === 'full') { const hgt = await p.evaluate(() => document.body.scrollHeight); for (let y = 0; y < hgt; y += 400) { await p.evaluate((yy) => window.scrollTo(0, yy), y); await p.waitForTimeout(120); } await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(600); }
await p.screenshot({ path: out, fullPage: full === 'full' });
console.log(await p.locator('[data-testid=atlas-globe]').getAttribute('data-phase').catch(() => 'n/a'));
await b.close();
