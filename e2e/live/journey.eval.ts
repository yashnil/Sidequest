import { chromium, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * LIVE PRODUCT EVALUATION — NOT PART OF THE TEST SUITE.
 *
 * Deliberately outside `e2e/`'s test glob and run by hand against a dev server
 * with real providers. The automated suite must stay offline; this exists to
 * answer the questions an offline suite cannot: does the real destination index
 * find Kyrgyzstan, does the real climate service answer, how long does the
 * preflight actually take, and how many screens does a traveller cross.
 *
 * Usage:
 *   npx tsx e2e/live/journey.eval.ts            (or: node --experimental-strip-types)
 *
 * Writes screenshots and a measurements table to `test-results/live/`.
 */

const BASE = process.env.SIDEQUEST_BASE_URL ?? 'http://localhost:4200';
const OUT = 'test-results/live';

interface Measurement {
  destination: string;
  suggestionMs?: number;
  topSuggestions?: string[];
  identity?: string;
  preflightMs?: number;
  clusters?: number;
  bases?: number;
  excluded?: number;
  strategies?: string[];
  dateWindows?: string[];
  durationOptions?: string[];
  supply?: string;
  clicksToPreflight?: number;
  screens?: string[];
  error?: string;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
}

async function measureSuggestions(page: Page, query: string): Promise<{ ms: number; names: string[] }> {
  const started = Date.now();
  const response = await page.request.get(
    `${BASE}/api/destinations/suggest?q=${encodeURIComponent(query)}`,
  );
  const ms = Date.now() - started;
  const body = (await response.json()) as {
    kind: string;
    suggestions?: { displayName: string; typeLabel: string; context: string }[];
  };
  const names = (body.suggestions ?? []).map(
    (entry) => `${entry.displayName} (${entry.typeLabel}${entry.context ? ` · ${entry.context}` : ''})`,
  );
  return { ms, names };
}

async function runJourney(
  browser: Browser,
  destination: string,
  dates: { start: string; end: string },
  slug: string,
): Promise<Measurement> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const measurement: Measurement = { destination, screens: [] };
  let clicks = 0;

  try {
    const suggestions = await measureSuggestions(page, destination.slice(0, 6));
    measurement.suggestionMs = suggestions.ms;
    measurement.topSuggestions = suggestions.names.slice(0, 3);

    await page.goto(`${BASE}/trips/new`);
    measurement.screens!.push('composer');
    await page.getByLabel('Destination').fill(destination);

    // Take the first suggestion, which is the whole point of the index.
    const options = page.getByRole('option');
    await options.first().waitFor({ timeout: 8_000 }).catch(() => undefined);
    if (await options.first().isVisible().catch(() => false)) {
      measurement.identity = (await options.first().innerText()).split('\n')[0];
      await options.first().click();
      clicks += 1;
    }
    await shot(page, `${slug}-01-composer`);

    await page.getByLabel('Arrive').fill(dates.start);
    await page.getByLabel('Leave').fill(dates.end);
    await shot(page, `${slug}-02-composer-filled`);

    const started = Date.now();
    await page.getByRole('button', { name: /See what we make of it/i }).click();
    clicks += 1;
    await page.waitForURL(/\/trips\/[^/]+\/plan/, { timeout: 30_000 });

    await page
      .getByRole('heading', { name: /as we read it/i })
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    // Wait for the preflight content itself, not just the heading.
    await page
      .locator('[data-testid="supply-panel"], [data-testid="no-index-coverage"]')
      .first()
      .waitFor({ timeout: 60_000 })
      .catch(() => undefined);
    measurement.preflightMs = Date.now() - started;
    measurement.clicksToPreflight = clicks;
    measurement.screens!.push('preflight');
    await shot(page, `${slug}-03-preflight`);

    const body = await page.locator('#main').innerText();
    measurement.supply = /(?:Plenty|Enough|Thin|Not enough|Our sources)[^\n]*/.exec(body)?.[0];
    measurement.clusters = Number(/(\d+) distinct areas? found/.exec(body)?.[1] ?? 0);
    measurement.bases = Number(/this route uses (\d+)/.exec(body)?.[1] ?? 0);
    measurement.excluded = Number(/(\d+) areas? left out/.exec(body)?.[1] ?? 0);
    measurement.strategies = await page
      .locator('fieldset', { hasText: 'Pick a shape' })
      .locator('label')
      .allInnerTexts()
      .then((rows) => rows.map((row) => row.split('\n')[0] ?? ''))
      .catch(() => []);
    measurement.dateWindows = await page
      .getByTestId('date-guidance')
      .locator('li p')
      .first()
      .innerText()
      .then((text) => [text])
      .catch(() => []);
    const durationRows = await page
      .locator('section', { hasText: 'How long it wants to be' })
      .locator('li')
      .allInnerTexts()
      .catch(() => []);
    measurement.durationOptions = durationRows.map((row) => row.replace(/\n/g, ' · ').slice(0, 90));
  } catch (error) {
    measurement.error = error instanceof Error ? error.message : String(error);
  } finally {
    await context.close();
  }

  return measurement;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();

  const cases: { destination: string; slug: string; dates: { start: string; end: string } }[] = [
    { destination: 'Kyrgyzstan', slug: 'kyrgyzstan', dates: { start: '2027-07-05', end: '2027-07-16' } },
    { destination: 'New York', slug: 'new-york', dates: { start: '2027-05-10', end: '2027-05-14' } },
    { destination: 'Bali', slug: 'bali', dates: { start: '2027-06-01', end: '2027-06-08' } },
    { destination: 'Singapore', slug: 'singapore', dates: { start: '2027-03-02', end: '2027-03-06' } },
    { destination: 'Slovenia', slug: 'slovenia', dates: { start: '2027-06-12', end: '2027-06-20' } },
    { destination: 'Iceland', slug: 'iceland', dates: { start: '2027-08-01', end: '2027-08-10' } },
    { destination: 'Japan', slug: 'japan', dates: { start: '2027-10-05', end: '2027-10-18' } },
    { destination: 'Turkey', slug: 'turkey', dates: { start: '2027-09-08', end: '2027-09-20' } },
    { destination: 'Portugal', slug: 'portugal', dates: { start: '2027-05-04', end: '2027-05-13' } },
    { destination: 'New Zealand', slug: 'new-zealand', dates: { start: '2027-11-05', end: '2027-11-22' } },
  ];

  const results: Measurement[] = [];
  for (const entry of cases) {
    process.stdout.write(`\n=== ${entry.destination} ===\n`);
    const measurement = await runJourney(browser, entry.destination, entry.dates, entry.slug);
    results.push(measurement);
    process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
  }

  await browser.close();
  writeFileSync(`${OUT}/measurements.json`, JSON.stringify(results, null, 2));
  process.stdout.write(`\nWrote ${OUT}/measurements.json\n`);
}

void main();
