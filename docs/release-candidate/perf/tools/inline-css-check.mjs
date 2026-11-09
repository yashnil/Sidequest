#!/usr/bin/env node
/**
 * DOES THE PAGE STILL WORK WITH ITS STYLESHEET INLINED?
 *
 * A faster first paint is worthless if the inlined CSS broke something, and the
 * way it would break is quiet: `url(../media/x.woff2)` is relative to the
 * stylesheet, so copied into the document it could resolve somewhere else and
 * every face would fall back with no error on screen. Checks, in a real browser
 * against the running server: every font and asset request succeeds, the three
 * families actually load, and a client-side navigation to another route still
 * arrives styled.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', '..', '..', 'package.json'));
const { chromium } = require('@playwright/test');
const ORIGIN = `http://127.0.0.1:${process.env.PORT ?? 4420}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 412, height: 823 } });
const failures = [];
const fonts = [];
page.on('response', (r) => {
  const url = r.url();
  if (url.startsWith(ORIGIN) && r.status() >= 400 && !url.includes('_rsc=')) failures.push(`${r.status()} ${url.replace(ORIGIN, '')}`);
  if (url.endsWith('.woff2')) fonts.push(`${r.status()} ${url.replace(ORIGIN, '').slice(0, 70)}`);
});
page.on('requestfailed', (r) => {
  if (r.url().startsWith(ORIGIN) && !r.url().includes('_rsc=')) failures.push(`failed ${r.url().replace(ORIGIN, '')}`);
});

await page.goto(ORIGIN, { waitUntil: 'load' });
await page.waitForTimeout(1500);
const report = await page.evaluate(async () => {
  await document.fonts.ready;
  const h1 = document.querySelector('h1');
  const em = h1?.querySelector('em');
  return {
    styleTags: document.querySelectorAll('style').length,
    stylesheetLinks: document.querySelectorAll('link[rel="stylesheet"]').length,
    inlineRelativeUrls: [...document.querySelectorAll('style')].filter((s) => /url\(\.\.\//.test(s.textContent ?? '')).length,
    h1Font: h1 ? getComputedStyle(h1).fontFamily.slice(0, 50) : null,
    faces: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/["']/g, '')} ${f.style}`))],
    emStyle: em ? getComputedStyle(em).fontStyle : null,
    nightBackground: getComputedStyle(document.querySelector('[data-testid="home-hero"]')).backgroundColor,
    htmlBytes: document.documentElement.outerHTML.length,
  };
});
console.log('landing', JSON.stringify(report, null, 1));
console.log('font responses', [...new Set(fonts)]);

await page.getByTestId('home-decide').click();
await page.waitForURL(/\/decide$/);
await page.waitForTimeout(1200);
const after = await page.evaluate(() => ({
  url: location.pathname,
  h1: getComputedStyle(document.querySelector('h1')).fontFamily.slice(0, 50),
  h1Size: getComputedStyle(document.querySelector('h1')).fontSize,
  figureBackground: getComputedStyle(document.querySelector('figure')).backgroundColor,
}));
console.log('after client navigation', JSON.stringify(after));
console.log(failures.length ? `FAILURES:\n${failures.join('\n')}` : 'no failed first-party requests');
await browser.close();
