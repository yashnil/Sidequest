import { writeFileSync } from 'node:fs';
import { test, type Page } from '@playwright/test';
import { buildFixtureTrip } from '../support/v9';

/**
 * WHAT A PAGE COSTS, MEASURED THE WAY A TEST FEELS IT.
 *
 * Time to interactive per route over repeated loads (navigation start to a
 * button React owns), plus the number of same-origin document and server-action
 * requests one load causes. A measuring tool, not a gate; `PERF_OUT` receives
 * the raw figures.
 */
interface Load {
  route: string;
  ttfb: number;
  dcl: number;
  interactive: number;
  documents: number;
  actions: number;
}

const ROUNDS = Number(process.env.PERF_ROUNDS ?? 20);

async function measure(page: Page, route: string, label: string, out: Load[]): Promise<void> {
  let documents = 0;
  let actions = 0;
  const onRequest = (request: { resourceType: () => string; method: () => string; headers: () => Record<string, string> }) => {
    if (request.resourceType() === 'document' || (request.resourceType() === 'fetch' && request.headers()['rsc'])) documents += 1;
    if (request.method() === 'POST') actions += 1;
  };
  page.on('request', onRequest);
  await page.goto(route, { waitUntil: 'commit' });
  const interactive = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const check = () => {
          const element = document.querySelector('body a[href], body button');
          if (element && Object.keys(element).some((key) => key.startsWith('__reactFiber$'))) resolve(performance.now());
          else requestAnimationFrame(check);
        };
        check();
      }),
  );
  const timing = await page.evaluate(() => {
    const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return { ttfb: entry.responseStart, dcl: entry.domContentLoadedEventEnd };
  });
  /* Long enough for anything a load triggers after it is usable. */
  await page.waitForTimeout(3500);
  page.off('request', onRequest);
  out.push({ route: label, ttfb: Math.round(timing.ttfb), dcl: Math.round(timing.dcl), interactive: Math.round(interactive), documents, actions });
}

function summarise(loads: readonly Load[]): Record<string, { n: number; ttiP50: number; ttiP90: number; dclP50: number; ttfbP50: number; documentsPerLoad: number; actionsPerLoad: number }> {
  const out: Record<string, { n: number; ttiP50: number; ttiP90: number; dclP50: number; ttfbP50: number; documentsPerLoad: number; actionsPerLoad: number }> = {};
  for (const route of new Set(loads.map((load) => load.route))) {
    const entries = loads.filter((load) => load.route === route);
    const sort = (values: number[]) => values.sort((a, b) => a - b);
    const p = (values: number[], q: number) => values[Math.min(values.length - 1, Math.floor(values.length * q))]!;
    const tti = sort(entries.map((entry) => entry.interactive));
    out[route] = {
      n: entries.length,
      ttiP50: p(tti, 0.5),
      ttiP90: p(tti, 0.9),
      dclP50: p(sort(entries.map((entry) => entry.dcl)), 0.5),
      ttfbP50: p(sort(entries.map((entry) => entry.ttfb)), 0.5),
      documentsPerLoad: entries.reduce((sum, entry) => sum + entry.documents, 0) / entries.length,
      actionsPerLoad: entries.reduce((sum, entry) => sum + entry.actions, 0) / entries.length,
    };
  }
  return out;
}

test('time to interactive across repeated loads', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'One viewport is the comparison.');
  test.setTimeout(30 * 60_000);
  const id = await buildFixtureTrip(page);
  const loads: Load[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    await measure(page, '/', 'landing', loads);
    await measure(page, '/trips/new', 'new-trip', loads);
    await measure(page, `/trips/${id}/discover`, 'board', loads);
    await measure(page, `/trips/${id}/itinerary`, 'trip', loads);
  }
  const summary = summarise(loads);
  // eslint-disable-next-line no-console -- a measuring tool: this line is its report.
  console.log(`PERF ${JSON.stringify(summary)}`);
  if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, JSON.stringify({ summary, loads }, null, 1));
});
