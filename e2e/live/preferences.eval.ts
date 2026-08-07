import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * THE BOUNDED PREFERENCE FALLBACK, AGAINST THE REAL MODEL.
 *
 * One mixed sentence: half of it the deterministic phrase table can read, half
 * of it the table cannot. What this proves that the offline suite cannot is that
 * the *real* model, given only the unresolved spans and a closed key space,
 * comes back with something the strict schema accepts — and that the known half
 * never reached it.
 *
 * Deliberately carries no sensitive personal data. The safety asymmetry is
 * tested offline against an adversarial corpus; sending a real medical sentence
 * to a real model to watch it be refused would be spending somebody's privacy to
 * re-prove a property a type already holds.
 *
 * Usage:
 *   node --experimental-strip-types e2e/live/preferences.eval.ts
 */

const BASE = process.env.SIDEQUEST_BASE_URL ?? 'http://localhost:4200';
const OUT = 'test-results/live';
const slug = 'prefs';

const TEXT =
  'Hot springs and scenic drives. Somewhere we can potter about with no fixed plan.';

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const record: Record<string, unknown> = { text: TEXT };

  await page.goto(`${BASE}/trips/new`);
  await page.getByLabel('Destination').fill('Iceland');
  const option = page.getByRole('option').first();
  if (await option.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false)) {
    await option.click();
  }
  await page.getByLabel('Arrive').fill('2027-06-10');
  await page.getByLabel('Leave').fill('2027-06-16');

  const more = page.getByRole('button', { name: /A few more that change the plan/i });
  if (await more.isVisible().catch(() => false)) await more.click();
  await page.getByLabel('Anything you would regret missing?').fill(TEXT);

  await page.getByRole('button', { name: /See what we make of it/i }).click();
  await page.waitForURL(/\/trips\/[^/]+\/(plan|questionnaire)/, { timeout: 60_000 });
  const tripId = /\/trips\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  record.tripId = tripId;

  await page.goto(`${BASE}/trips/${tripId}/questionnaire`);
  const panel = page.getByRole('region', { name: /This is what we made of it/i });
  await panel.waitFor({ timeout: 30_000 });
  record.beforeReading = (await panel.innerText()).slice(0, 1200);
  await page.screenshot({ path: `${OUT}/${slug}-deterministic.png`, fullPage: true });

  const button = panel.getByRole('button', { name: 'Have a go at the rest' });
  const offered = await button.isVisible().catch(() => false);
  record.readerOffered = offered;
  if (offered) {
    const t0 = Date.now();
    await button.click();
    await button.waitFor({ state: 'detached', timeout: 60_000 }).catch(() => undefined);
    await page.waitForTimeout(2_000);
    record.readingMs = Date.now() - t0;
    record.afterReading = (await panel.innerText()).slice(0, 1600);
    await page.screenshot({ path: `${OUT}/${slug}-after-reading.png`, fullPage: true });
  }

  await browser.close();
  writeFileSync(`${OUT}/${slug}-preferences.json`, JSON.stringify(record, null, 2));
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

void main();
