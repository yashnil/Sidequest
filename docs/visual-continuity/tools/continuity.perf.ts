import { appendFileSync, mkdirSync } from 'node:fs';
import { test, type Browser, type BrowserContextOptions } from '@playwright/test';
import { createTrip } from '../../../e2e/support/trip';
import { signInFixture } from '../../../e2e/support/v9';
import { span, addDays, todayIso } from '../../../e2e/support/dates';

/**
 * Cold-load measurements for the pages this pass changes: each in a brand-new
 * browser context (empty cache, the account's cookies only), three runs, the
 * median kept. `PERF=before|after` names the output.
 *
 *   PERF=before npx playwright test -c docs/visual-continuity/tools/playwright.continuity.config.ts continuity.perf --project=desktop
 */
const LABEL = process.env.PERF ?? 'before';
const OUT = new URL(`../perf-${LABEL}.ndjson`, import.meta.url).pathname;

interface Sample { lcp: number; cls: number; tbt: number; fcp: number; jsKB: number; cssKB: number; totalKB: number }

async function coldLoad(browser: Browser, options: BrowserContextOptions, url: string, baseURL: string): Promise<Sample> {
  const context = await browser.newContext({ ...options, baseURL });
  const page = await context.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __p: { lcp: number; cls: number; tbt: number } };
    w.__p = { lcp: 0, cls: 0, tbt: 0 };
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (w.__p.lcp = e.startTime))).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => { const s = e as unknown as { hadRecentInput: boolean; value: number }; if (!s.hadRecentInput) w.__p.cls += s.value; })).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (w.__p.tbt += Math.max(0, e.duration - 50)))).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(url);
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  const sample = await page.evaluate(() => {
    const w = window as unknown as { __p: { lcp: number; cls: number; tbt: number } };
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
    const kb = (f: (r: PerformanceResourceTiming) => boolean) => Math.round(res.filter(f).reduce((s, r) => s + (r.encodedBodySize || r.transferSize), 0) / 1024);
    return {
      lcp: Math.round(w.__p.lcp),
      cls: Number(w.__p.cls.toFixed(4)),
      tbt: Math.round(w.__p.tbt),
      fcp: Math.round(fcp),
      jsKB: kb((r) => /\.js(\?|$)/.test(r.name)),
      cssKB: kb((r) => /\.css(\?|$)/.test(r.name)),
      totalKB: kb(() => true) + Math.round((nav.encodedBodySize || nav.transferSize) / 1024),
    };
  });
  await context.close();
  return sample;
}

function median(samples: Sample[]): Sample {
  const pick = (k: keyof Sample) => [...samples].sort((a, b) => a[k] - b[k])[Math.floor(samples.length / 2)]![k];
  return { lcp: pick('lcp'), cls: pick('cls'), tbt: pick('tbt'), fcp: pick('fcp'), jsKB: pick('jsKB'), cssKB: pick('cssKB'), totalKB: pick('totalKB') };
}

test('cold loads of the changed pages', async ({ page, browser, baseURL }, info) => {
  mkdirSync(new URL('..', import.meta.url).pathname, { recursive: true });
  const options: BrowserContextOptions = { viewport: page.viewportSize() ?? undefined, userAgent: undefined, isMobile: info.project.use.isMobile, hasTouch: info.project.use.hasTouch, deviceScaleFactor: info.project.use.deviceScaleFactor };
  const record = async (label: string, url: string, state: BrowserContextOptions['storageState']) => {
    const runs: Sample[] = [];
    for (let i = 0; i < 3; i += 1) runs.push(await coldLoad(browser, { ...options, storageState: state }, url, baseURL!));
    appendFileSync(OUT, JSON.stringify({ project: info.project.name, label, ...median(runs) }) + '\n');
  };

  await record('landing', '/', undefined);
  await record('signin', '/signin', undefined);
  await signInFixture(page, `perf-${info.project.name}-${Date.now()}@example.test`);
  const signedIn = await page.context().storageState();
  await record('dashboard-empty', '/trips', signedIn);
  await createTrip(page, 'Lisbon', span(addDays(todayIso(), 60), 4));
  await createTrip(page, 'Mammoth Lakes', span(addDays(todayIso(), 90), 4));
  await record('dashboard-two', '/trips', await page.context().storageState());
});
