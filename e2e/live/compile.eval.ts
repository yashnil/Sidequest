import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * A FULL LIVE COMPILATION, MEASURED.
 *
 * Run by hand against a dev server with the open provider stack. Drives one
 * destination all the way from the composer to a compiled region, capturing the
 * progress screen on the way and every number the report needs: how long each
 * phase took, what the funnel produced, and what the traveller could look at
 * while they waited.
 *
 * Usage:
 *   node --experimental-strip-types e2e/live/compile.eval.ts "Kyrgyzstan" kg
 */

const BASE = process.env.SIDEQUEST_BASE_URL ?? 'http://localhost:4200';
const OUT = 'test-results/live';

const destination = process.argv[2] ?? 'Kyrgyzstan';
const slug = process.argv[3] ?? 'kg';
const start = process.argv[4] ?? '2027-07-05';
const end = process.argv[5] ?? '2027-07-16';
const strategy = process.argv[6] ?? 'Two bases';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const record: Record<string, unknown> = { destination, start, end, strategy };

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(`${BASE}/trips/new`);
  await page.getByLabel('Destination').fill(destination);
  const option = page.getByRole('option').first();
  await option.waitFor({ timeout: 10_000 });
  await option.click();
  await page.getByLabel('Arrive').fill(start);
  await page.getByLabel('Leave').fill(end);

  // Shape and themes, so the compiler knows what is worth researching.
  await page.getByRole('radio', { name: 'Two bases, split the trip' }).check();
  await page.getByRole('radio', { name: 'Drive' }).check();
  for (const theme of ['Mountains and high country', 'Hiking and being outside']) {
    await page.getByRole('checkbox', { name: theme }).check();
  }
  await page.getByRole('radio', { name: 'Balanced', exact: true }).check();
  await page.screenshot({ path: `${OUT}/${slug}-composer.png`, fullPage: true });

  const t0 = Date.now();
  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 30_000 });
  const tripId = /\/trips\/([^/]+)\/plan/.exec(page.url())?.[1];
  record.tripId = tripId;

  await page.getByRole('radio', { name: strategy }).waitFor({ timeout: 60_000 });
  record.timeToPreflightMs = Date.now() - t0;
  await page.screenshot({ path: `${OUT}/${slug}-preflight.png`, fullPage: true });
  record.preflightText = (await page.locator('#main').innerText()).slice(0, 1200);

  await page.getByRole('radio', { name: strategy }).check();
  await page.getByRole('button', { name: /Go and research this/i }).click();

  // Whatever clarifications survive the strategy answer.
  const proceed = page.getByRole('button', { name: /^Continue$/ });
  if (await proceed.isVisible({ timeout: 8_000 }).catch(() => false)) {
    const radios = page.locator('input[type=radio]');
    const groups = new Set<string>();
    for (let index = 0; index < (await radios.count()); index += 1) {
      const name = await radios.nth(index).getAttribute('name');
      if (name && !groups.has(name)) {
        groups.add(name);
        await radios.nth(index).check();
      }
    }
    await page.screenshot({ path: `${OUT}/${slug}-clarify.png`, fullPage: true });
    await proceed.click();
  }

  await page.getByRole('heading', { name: 'Here is what we are about to do' }).waitFor({
    timeout: 30_000,
  });
  await page.screenshot({ path: `${OUT}/${slug}-scope.png`, fullPage: true });

  const t1 = Date.now();
  await page.getByRole('button', { name: 'Build the region' }).click();

  // Capture the progress screen a few seconds in, while it is genuinely working.
  await page.waitForTimeout(12_000);
  await page.screenshot({ path: `${OUT}/${slug}-progress.png`, fullPage: true });
  record.progressText = await page
    .locator('#main')
    .innerText()
    .then((text) => text.slice(0, 1500))
    .catch(() => '');

  const outcome = await page
    .getByRole('heading', { name: 'What this trip is built on' })
    .waitFor({ timeout: 900_000 })
    .then(() => 'ready')
    .catch(() => 'failed_or_timeout');
  record.compileMs = Date.now() - t1;
  record.outcome = outcome;
  await page.screenshot({ path: `${OUT}/${slug}-ready.png`, fullPage: true });
  record.readyText = (await page.locator('#main').innerText()).slice(0, 2500);

  // Open the technical panel so the funnel numbers are captured.
  await page
    .getByTestId('technical-stages')
    .locator('summary')
    .click()
    .catch(() => undefined);
  await page.screenshot({ path: `${OUT}/${slug}-technical.png`, fullPage: true });

  record.consoleErrors = consoleErrors;
  await browser.close();

  writeFileSync(`${OUT}/${slug}-compile.json`, JSON.stringify(record, null, 2));
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

void main();
