import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

/**
 * The same screens at three widths, for a human to look at.
 *
 * Also asserts the one thing a screenshot cannot show at a glance: that the body
 * does not scroll sideways. Horizontal overflow on a phone is the defect that
 * survives every desktop review.
 */
const BASE = 'http://localhost:4200';
const OUT = 'test-results/live/viewports';
const SIZES = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'tablet-1024', width: 1024, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const problems: string[] = [];

for (const size of SIZES) {
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${size.name} console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${size.name} pageerror: ${e.message}`));

  async function check(label: string) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    if (overflow > 1) problems.push(`${size.name}/${label} scrolls sideways by ${overflow}px`);
    await page.screenshot({ path: `${OUT}/${label}-${size.name}.png`, fullPage: true });
  }

  await page.goto(`${BASE}/`);
  await check('01-landing');

  await page.goto(`${BASE}/trips/new`);
  await check('02-composer-empty');

  await page.getByLabel('Destination').fill('Kyrgyz');
  await page.getByRole('option').first().waitFor({ timeout: 10_000 });
  await check('03-suggestions');

  await page.getByRole('option').first().click();
  await page.getByLabel('Arrive').fill('2027-07-05');
  await page.getByLabel('Leave').fill('2027-07-16');
  await check('04-composer-filled');

  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.waitForURL(/\/plan/, { timeout: 30_000 });
  await page.getByRole('radio', { name: 'Two bases' }).waitFor({ timeout: 60_000 });
  await check('05-preflight');

  await context.close();
}

await browser.close();
process.stdout.write(problems.length === 0 ? 'No overflow or runtime problems.\n' : `${problems.join('\n')}\n`);
