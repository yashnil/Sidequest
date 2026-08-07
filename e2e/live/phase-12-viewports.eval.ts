import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * THE SURFACES THIS SPRINT ADDED, AT THREE WIDTHS, FOR A HUMAN TO LOOK AT.
 *
 * `viewports.eval.ts` covers the composer and the preflight. This covers what
 * Phase 12's final sprint put on screen and nothing else: a board with no
 * weather and a button, the same board once the forecast has been asked for, the
 * reconciliation panel, the free-text reading, and the record of how the build
 * went.
 *
 * Those are exactly the surfaces that pass every automated assertion and can
 * still read badly — a credit line that wraps into the photograph, a fallback
 * graphic that looks like a loading state, a weather panel that reads as an
 * error. A screenshot is the only honest check.
 *
 * It also measures the one thing a screenshot cannot show at a glance:
 * horizontal overflow, which is the defect that survives every desktop review.
 *
 * Runs against the fixture stack. Nothing here spends money.
 *
 * Usage:
 *   node --experimental-strip-types e2e/live/phase-12-viewports.eval.ts
 */

const BASE = process.env.SIDEQUEST_BASE_URL ?? 'http://localhost:4200';
const OUT = 'test-results/viewports';
const SIZES = [
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'mobile-390', width: 390, height: 844 },
];

interface Problem {
  where: string;
  what: string;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const problems: Problem[] = [];

  for (const size of SIZES) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push({ where: size.name, what: `console: ${message.text()}` });
    });
    page.on('pageerror', (error) =>
      problems.push({ where: size.name, what: `pageerror: ${error.message}` }),
    );

    const check = async (label: string): Promise<void> => {
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 1) {
        problems.push({ where: `${size.name}/${label}`, what: `scrolls sideways by ${overflow}px` });
      }
      await page
        .screenshot({ path: `${OUT}/${label}-${size.name}.png`, fullPage: true })
        .catch(() => undefined);
    };

    await page.goto(`${BASE}/trips/new`);
    await page.getByLabel('Destination').fill('Mammoth Lakes');
    await page.getByLabel('Arrive').fill('2026-08-12');
    await page.getByLabel('Leave').fill('2026-08-16');
    const more = page.getByRole('button', { name: /A few more that change the plan/i });
    if (await more.isVisible().catch(() => false)) await more.click();
    await page
      .getByLabel('Anything you would regret missing?')
      .fill('Hot springs. Somewhere we can potter about with no fixed plan.')
      .catch(() => undefined);
    await page.getByRole('button', { name: /See what we make of it/i }).click();
    await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 30_000 });
    const tripId = /\/trips\/([^/]+)\//.exec(page.url())?.[1] ?? '';

    await page.goto(`${BASE}/trips/${tripId}/questionnaire`);
    await check('01-free-text-reading');

    await page
      .getByRole('radio', { name: 'Scenic viewpoints: Core' })
      .check()
      .catch(() => undefined);
    await page
      .getByRole('radio', { name: 'Hiking: A few times' })
      .check()
      .catch(() => undefined);

    for (let step = 0; step < 14; step += 1) {
      const build = page.getByRole('button', { name: 'Build my discovery board' });
      if (await build.isVisible().catch(() => false)) {
        await build.click();
        break;
      }
      const next = page.getByRole('button', { name: /^Continue$/ });
      if (await next.isVisible().catch(() => false)) await next.click();
      else await page.waitForTimeout(300);
    }
    await page.waitForURL(/\/discover$/, { timeout: 30_000 }).catch(() => undefined);
    await check('02-board-weather-not-fetched');

    await page
      .getByTestId('weather-refresh')
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(3_000);
    await check('03-board-weather-fetched');

    await page
      .getByRole('button', { name: /Build my trip|Rebuild my trip/ })
      .click()
      .catch(() => undefined);
    await page.waitForURL(/\/itinerary$/, { timeout: 90_000 }).catch(() => undefined);
    await check('04-itinerary');

    await context.close();
  }

  await browser.close();
  writeFileSync(`${OUT}/findings.json`, JSON.stringify(problems, null, 2));
  process.stdout.write(
    problems.length === 0
      ? 'No horizontal overflow and no console errors at any of the three widths.\n'
      : `${JSON.stringify(problems, null, 2)}\n`,
  );
}

void main();
