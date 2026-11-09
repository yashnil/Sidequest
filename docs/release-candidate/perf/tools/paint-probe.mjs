#!/usr/bin/env node
/**
 * WHAT THE BROWSER ACTUALLY PAINTED, AND WHEN — UNDER AN APPLIED THROTTLE.
 *
 *   node paint-probe.mjs --seed seed.json --pages landing,decide [--runs 3] [--out probe.json]
 *                        [--block fonts|scripts|tiles|vendor] [--profile slow4g|fast4g|none] [--cpu 4]
 *                        [--reduced-motion] [--desktop]
 *
 * Lighthouse's default number is a *model* (Lantern) of a throttled load built
 * from an unthrottled trace. That model charges the LCP for every request that
 * finished before the LCP paint in the fast trace, so a paint that lands 50 ms
 * late on a fast machine can be billed for the whole JavaScript bundle. This
 * script is the other half of the evidence: a real load with the network and
 * CPU actually slowed (Chrome DevTools Protocol, the same Slow-4G numbers
 * Lighthouse's `devtools` throttling uses: 562.5 ms round trip, 1.44 Mbps down,
 * 0.675 Mbps up, 4x CPU), recording every LCP candidate the browser reported —
 * not only the last — with the element, its size and its time, next to first
 * paint, each web font's arrival, layout shifts and the globe's phase changes.
 *
 * `--block` runs the same load with one class of request refused, which is how
 * a hypothesis ("the fonts hold the LCP", "the map library does") is tested as
 * a controlled experiment instead of argued.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', '..', '..', 'package.json'));
const { chromium } = require('@playwright/test');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : pairs), []),
);
const PORT = Number(process.env.PORT ?? 4420);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const seed = args.seed ? JSON.parse(readFileSync(args.seed, 'utf8')) : {};
const runs = Number(args.runs ?? 3);
const cpu = Number(args.cpu ?? 4);
const PROFILES = {
  slow4g: { latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8, uploadThroughput: (750 * 1024 * 0.9) / 8 },
  fast4g: { latency: 165, downloadThroughput: (9 * 1024 * 1024 * 0.9) / 8, uploadThroughput: (9 * 1024 * 1024 * 0.9) / 8 },
  none: null,
};
const profile = PROFILES[args.profile ?? 'slow4g'];
const blocked = (args.block ?? '').split(',').filter(Boolean);
const settleMs = Number(args.settle ?? 12_000);

const ALL_PAGES = {
  landing: '/',
  decide: '/decide',
  tripNew: '/trips/new',
  trip: seed.tripId ? `/trips/${seed.tripId}/itinerary` : null,
  shortlist: seed.decisionId ? `/decide/${seed.decisionId}` : null,
};
const pages = (args.pages ? args.pages.split(',') : ['landing', 'decide']).filter((name) => ALL_PAGES[name]);

/** Runs in the page before any of its own script: collects what the paint timing APIs report. */
function collector() {
  const describe = (element) => {
    if (!element) return null;
    const classes = typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean).slice(0, 4).join('.') : '';
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes ? `.${classes}` : ''}`;
  };
  const out = { lcp: [], paints: {}, shifts: [], fonts: [], phases: [], longTasks: 0, longTaskMs: 0, fallback: null };
  window.__probe = out;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      out.lcp.push({ t: Math.round(entry.startTime), size: entry.size, element: describe(entry.element), text: (entry.element?.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60), url: entry.url || undefined });
    }
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) out.paints[entry.name] = Math.round(entry.startTime);
  }).observe({ type: 'paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (!entry.hadRecentInput) out.shifts.push({ t: Math.round(entry.startTime), value: Number(entry.value.toFixed(4)), sources: (entry.sources ?? []).slice(0, 2).map((s) => describe(s.node)) });
  }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      out.longTasks += 1;
      out.longTaskMs += Math.max(0, entry.duration - 50);
    }
  }).observe({ type: 'longtask', buffered: true });
  document.addEventListener('DOMContentLoaded', () => {
    document.fonts.addEventListener('loadingdone', (event) => {
      for (const face of event.fontfaces) out.fonts.push({ t: Math.round(performance.now()), family: face.family.replace(/["']/g, '').slice(0, 28), style: face.style, range: face.unicodeRange.slice(0, 14) });
    });
    /* A `loading.tsx` fallback in the document: when did the real content replace it? */
    const fallback = document.querySelector('[data-loading="true"]');
    if (fallback) {
      out.fallback = { seenAt: Math.round(performance.now()), replacedAt: null };
      const watch = new MutationObserver(() => {
        if (document.querySelector('[data-loading="true"]')) return;
        out.fallback.replacedAt = Math.round(performance.now());
        watch.disconnect();
      });
      watch.observe(document.documentElement, { childList: true, subtree: true });
    }
    const globe = document.querySelector('[data-testid="atlas-globe"]');
    if (globe) {
      out.phases.push({ t: Math.round(performance.now()), phase: globe.getAttribute('data-phase') });
      new MutationObserver(() => out.phases.push({ t: Math.round(performance.now()), phase: globe.getAttribute('data-phase') })).observe(globe, { attributes: true, attributeFilter: ['data-phase'] });
    }
  });
}

const median = (values) => {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const result = { at: new Date().toISOString(), profile: args.profile ?? 'slow4g', cpuSlowdown: cpu, blocked, reducedMotion: args['reduced-motion'] === 'true', desktop: args.desktop === 'true', pages: {} };

for (const name of pages) {
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    /* A fresh browser each time: empty HTTP cache, no service worker, nothing warm. */
    const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    try {
      const context = await browser.newContext(
        args.desktop === 'true'
          ? { viewport: { width: 1350, height: 940 }, reducedMotion: args['reduced-motion'] === 'true' ? 'reduce' : 'no-preference' }
          : { viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true, reducedMotion: args['reduced-motion'] === 'true' ? 'reduce' : 'no-preference' },
      );
      if (seed.cookies?.length) await context.addCookies(seed.cookies.map((c) => ({ ...c, url: ORIGIN })));
      const page = await context.newPage();
      await page.addInitScript(collector);
      const refuse = async (pattern) => page.route(pattern, (route) => route.abort());
      if (blocked.includes('fonts')) await refuse('**/*.woff2');
      if (blocked.includes('vendor')) await refuse('**/vendor/maplibre/**');
      if (blocked.includes('scripts')) await refuse('**/_next/static/chunks/*.js');
      /* The public tile hosts are refused unless asked for: their latency from a laptop is not the product's, and a probe should not lean on a volunteer service. */
      if (!args.tiles) {
        await refuse('https://tiles.openfreemap.org/**');
        await refuse('https://s3.amazonaws.com/**');
      }
      const client = await context.newCDPSession(page);
      if (profile) await client.send('Network.emulateNetworkConditions', { offline: false, ...profile });
      if (cpu > 1) await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });
      const started = Date.now();
      await page.goto(`${ORIGIN}${ALL_PAGES[name]}`, { waitUntil: 'load', timeout: 120_000 });
      const loadMs = Date.now() - started;
      await page.waitForTimeout(settleMs);
      const probe = await page.evaluate(() => window.__probe);
      /* Resource Timing, so every time below is on the same clock as the paints (ms since navigation start). */
      const resources = await page.evaluate((origin) => {
        const nav = performance.getEntriesByType('navigation')[0];
        const rows = performance.getEntriesByType('resource').map((entry) => ({ url: entry.name.replace(origin, '').slice(0, 90), kind: entry.initiatorType, start: Math.round(entry.startTime), end: Math.round(entry.responseEnd), bytes: entry.transferSize }));
        return { rows, document: { responseStart: Math.round(nav.responseStart), responseEnd: Math.round(nav.responseEnd), bytes: nav.transferSize, domContentLoaded: Math.round(nav.domContentLoadedEventEnd) } };
      }, ORIGIN);
      const ends = (test) => Math.max(0, ...resources.rows.filter(test).map((r) => r.end));
      const bytes = (test) => resources.rows.filter(test).reduce((sum, r) => sum + r.bytes, 0);
      const isCss = (r) => /\/_next\/static\/.*\.css$/.test(r.url);
      const isJs = (r) => /\/_next\/static\/.*\.js$/.test(r.url);
      const isFont = (r) => /\.woff2$/.test(r.url);
      const isVendor = (r) => r.url.startsWith('/vendor/');
      const final = probe.lcp[probe.lcp.length - 1] ?? null;
      samples.push({
        fcpMs: probe.paints['first-contentful-paint'] ?? null,
        lcpMs: final?.t ?? null,
        lcpElement: final?.element ?? null,
        lcpText: final?.text ?? null,
        lcpCandidates: probe.lcp,
        loadEventMs: loadMs,
        cls: Number(probe.shifts.reduce((sum, s) => sum + s.value, 0).toFixed(4)),
        shifts: probe.shifts.slice(0, 6),
        fonts: probe.fonts,
        globePhases: probe.phases,
        blockingMs: Math.round(probe.longTaskMs),
        longTasks: probe.longTasks,
        document: resources.document,
        cssDoneMs: ends(isCss),
        fontsDoneMs: ends(isFont),
        scriptsDoneMs: ends(isJs),
        vendorDoneMs: ends(isVendor),
        bytes: { document: resources.document.bytes, css: bytes(isCss), fonts: bytes(isFont), appJs: bytes(isJs), mapVendor: bytes(isVendor) },
        fallback: probe.fallback,
      });
    } finally {
      await browser.close();
    }
  }
  const byLcp = [...samples].sort((a, b) => (a.lcpMs ?? 0) - (b.lcpMs ?? 0));
  const representative = byLcp[Math.floor(byLcp.length / 2)];
  result.pages[name] = {
    runs: samples.length,
    fcpMs: median(samples.map((s) => s.fcpMs)),
    lcpMs: median(samples.map((s) => s.lcpMs)),
    lcpMsRuns: samples.map((s) => s.lcpMs),
    cls: median(samples.map((s) => s.cls)),
    blockingMs: median(samples.map((s) => s.blockingMs)),
    documentDoneMs: median(samples.map((s) => s.document.responseEnd)),
    cssDoneMs: median(samples.map((s) => s.cssDoneMs)),
    fontsDoneMs: median(samples.map((s) => s.fontsDoneMs)),
    scriptsDoneMs: median(samples.map((s) => s.scriptsDoneMs)),
    fallbackReplacedMs: median(samples.map((s) => s.fallback?.replacedAt ?? null)),
    loadEventMs: median(samples.map((s) => s.loadEventMs)),
    representative,
  };
  const r = result.pages[name];
  console.log(`${name.padEnd(10)} FCP ${r.fcpMs}  LCP ${r.lcpMs} (${r.lcpMsRuns.join(', ')})  CLS ${r.cls}  | doc ${r.documentDoneMs}  css ${r.cssDoneMs}  fonts ${r.fontsDoneMs}  js ${r.scriptsDoneMs}  ${r.fallbackReplacedMs !== null ? `fallback replaced ${r.fallbackReplacedMs}  ` : ''}blocking ${r.blockingMs}  bytes ${JSON.stringify(representative.bytes)}`);
  for (const candidate of representative.lcpCandidates) console.log(`             LCP candidate @${String(candidate.t).padStart(6)} ms  size ${String(candidate.size).padStart(7)}  ${candidate.element}  "${candidate.text}"`);
  console.log(`             fonts: ${representative.fonts.map((f) => `${f.family}${f.style === 'italic' ? ' italic' : ''}@${f.t}`).join(', ') || '(none loaded)'}`);
  if (representative.globePhases.length) console.log(`             globe: ${representative.globePhases.map((p) => `${p.phase}@${p.t}`).join(' → ')}`);
  if (representative.shifts.length) console.log(`             shifts: ${representative.shifts.map((s) => `${s.value}@${s.t} ${s.sources.join('+')}`).join('; ')}`);
}

if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
