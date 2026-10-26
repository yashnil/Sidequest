// Screenshot every <section class="frame"> of a prototype page.
// usage: node shoot-frames.cjs <html> <outdir> [waitMs]
const { chromium } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const [file, out, wait = '9000'] = process.argv.slice(2);
(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto('file://' + path.resolve(file));
  await page.waitForTimeout(Number(wait));
  const frames = await page.$$('section.frame');
  for (const f of frames) {
    const id = await f.getAttribute('id');
    await f.screenshot({ path: path.join(out, `${id}.png`) });
  }
  console.log('shot', frames.length, 'frames →', out);
  await browser.close();
})();
