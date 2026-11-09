#!/usr/bin/env node
/**
 * LIGHTHOUSE, N RUNS PER PAGE AND FORM FACTOR, REDUCED TO MEDIANS.
 *
 *   PERF_TOOLS=<dir with node_modules/lighthouse> node lighthouse-run.mjs \
 *     --seed seed.json --out result.json [--runs 5] [--pages landing,decide] \
 *     [--forms mobile,desktop] [--throttling simulate|devtools] [--keep <dir>]
 *
 * Lighthouse is not a dependency of this repository (it is a measuring
 * instrument, not part of the product), so it is resolved from `PERF_TOOLS`:
 * `mkdir t && cd t && npm init -y && npm i lighthouse chrome-launcher`.
 *
 * Mobile is Lighthouse's default profile: Moto G Power emulation, Slow 4G
 * (150 ms RTT, 1.6 Mbps down), 4x CPU slowdown. `--throttling simulate` (the
 * default, and what PageSpeed Insights reports) models that from an unthrottled
 * trace; `--throttling devtools` actually applies it, which is slower and
 * noisier but is a real page load — used here as the cross-check, because a
 * simulated LCP can only be as good as the model's guess at what blocked it.
 *
 * A fresh Chrome per run: no HTTP cache, no service worker, no warmed renderer.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => (arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]?.startsWith('--') || all[i + 1] === undefined ? 'true' : all[i + 1]]] : pairs), []),
);
const tools = process.env.PERF_TOOLS;
if (!tools) throw new Error('Set PERF_TOOLS to a directory where `npm i lighthouse chrome-launcher` was run.');
const load = async (path) => import(pathToFileURL(join(tools, 'node_modules', path)).href);
const { default: lighthouse } = await load('lighthouse/core/index.js');
const { default: desktopConfig } = await load('lighthouse/core/config/desktop-config.js');
const chromeLauncher = await load('chrome-launcher/dist/index.js');

const PORT = Number(process.env.PORT ?? 4420);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const seed = args.seed ? JSON.parse(readFileSync(args.seed, 'utf8')) : {};
const cookie = (seed.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
const runs = Number(args.runs ?? 5);
const throttlingMethod = args.throttling ?? 'simulate';
const forms = (args.forms ?? 'mobile,desktop').split(',');

const ALL_PAGES = {
  landing: { url: '/', owned: false },
  decide: { url: '/decide', owned: false },
  tripNew: { url: '/trips/new', owned: false },
  trip: { url: seed.tripId ? `/trips/${seed.tripId}/itinerary` : null, owned: true },
  shortlist: { url: seed.decisionId ? `/decide/${seed.decisionId}` : null, owned: true },
};
const pages = (args.pages ? args.pages.split(',') : Object.keys(ALL_PAGES)).filter((name) => ALL_PAGES[name]?.url);

const median = (values) => {
  const sorted = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (value, digits = 0) => (value === null || value === undefined ? null : Number(value.toFixed(digits)));

function summarise(lhr) {
  const audit = (id) => lhr.audits[id];
  const observed = audit('metrics')?.details?.items?.[0] ?? {};
  const requests = audit('network-requests')?.details?.items ?? [];
  const bytes = {};
  const counts = {};
  let thirdPartyBytes = 0;
  let thirdPartyRequests = 0;
  for (const request of requests) {
    const type = (request.resourceType ?? 'Other').toLowerCase();
    bytes[type] = (bytes[type] ?? 0) + (request.transferSize ?? 0);
    counts[type] = (counts[type] ?? 0) + 1;
    if (!String(request.url).startsWith(ORIGIN) && !String(request.url).startsWith('data:') && !String(request.url).startsWith('blob:')) {
      thirdPartyBytes += request.transferSize ?? 0;
      thirdPartyRequests += 1;
    }
  }
  const lcpElement =
    audit('largest-contentful-paint-element')?.details?.items?.[0]?.items?.[0]?.node ??
    audit('lcp-breakdown-insight')?.details?.items?.find((item) => item.type === 'node') ??
    null;
  const breakdownItems =
    audit('lcp-breakdown-insight')?.details?.items?.find((item) => item.type === 'table')?.items ??
    audit('largest-contentful-paint-element')?.details?.items?.[1]?.items ??
    [];
  const mainThread = Object.fromEntries((audit('mainthread-work-breakdown')?.details?.items ?? []).map((item) => [item.group, round(item.duration)]));
  return {
    performanceScore: round((lhr.categories.performance?.score ?? 0) * 100),
    lcpMs: round(audit('largest-contentful-paint')?.numericValue),
    fcpMs: round(audit('first-contentful-paint')?.numericValue),
    tbtMs: round(audit('total-blocking-time')?.numericValue),
    cls: round(audit('cumulative-layout-shift')?.numericValue, 4),
    speedIndexMs: round(audit('speed-index')?.numericValue),
    ttiMs: round(audit('interactive')?.numericValue),
    serverResponseMs: round(audit('server-response-time')?.numericValue),
    /* What the unthrottled browser actually saw, before any model or throttle was applied. */
    observed: {
      lcpMs: round(observed.observedLargestContentfulPaint),
      fcpMs: round(observed.observedFirstContentfulPaint),
      domContentLoadedMs: round(observed.observedDomContentLoaded),
      loadMs: round(observed.observedLoad),
    },
    lcpElement: lcpElement ? { selector: lcpElement.selector, snippet: String(lcpElement.snippet ?? '').slice(0, 220), label: String(lcpElement.nodeLabel ?? '').slice(0, 120) } : null,
    lcpBreakdown: breakdownItems.map((item) => ({ phase: item.label ?? item.phase ?? item.subpart, ms: round(item.duration ?? item.timing) })),
    transferBytes: bytes,
    requestCounts: counts,
    totalTransferBytes: Object.values(bytes).reduce((sum, v) => sum + v, 0),
    requestCount: requests.length,
    thirdParty: { bytes: thirdPartyBytes, requests: thirdPartyRequests },
    mainThreadMs: mainThread,
    mainThreadTotalMs: round(audit('mainthread-work-breakdown')?.numericValue),
    scriptBootupMs: round(audit('bootup-time')?.numericValue),
  };
}

function reduce(samples) {
  const pick = (read) => median(samples.map(read));
  const keys = (read) => [...new Set(samples.flatMap((s) => Object.keys(read(s) ?? {})))];
  const table = (read) => Object.fromEntries(keys(read).map((key) => [key, round(pick((s) => read(s)?.[key] ?? 0))]));
  const elements = {};
  for (const sample of samples) {
    const key = sample.lcpElement?.selector ?? '(none reported)';
    elements[key] = (elements[key] ?? 0) + 1;
  }
  /* The run whose LCP is the median one, for its element and breakdown. */
  const byLcp = [...samples].sort((a, b) => (a.lcpMs ?? 0) - (b.lcpMs ?? 0));
  const representative = byLcp[Math.floor(byLcp.length / 2)];
  return {
    runs: samples.length,
    performanceScore: pick((s) => s.performanceScore),
    lcpMs: pick((s) => s.lcpMs),
    lcpMsRuns: samples.map((s) => s.lcpMs),
    fcpMs: pick((s) => s.fcpMs),
    tbtMs: pick((s) => s.tbtMs),
    cls: round(pick((s) => s.cls), 4),
    speedIndexMs: pick((s) => s.speedIndexMs),
    ttiMs: pick((s) => s.ttiMs),
    serverResponseMs: pick((s) => s.serverResponseMs),
    observed: table((s) => s.observed),
    lcpElement: representative.lcpElement,
    lcpElementCounts: elements,
    lcpBreakdown: representative.lcpBreakdown,
    transferBytes: table((s) => s.transferBytes),
    requestCounts: table((s) => s.requestCounts),
    totalTransferBytes: pick((s) => s.totalTransferBytes),
    requestCount: pick((s) => s.requestCount),
    thirdParty: table((s) => s.thirdParty),
    mainThreadMs: table((s) => s.mainThreadMs),
    mainThreadTotalMs: pick((s) => s.mainThreadTotalMs),
    scriptBootupMs: pick((s) => s.scriptBootupMs),
  };
}

const result = { at: new Date().toISOString(), origin: ORIGIN, runs, throttlingMethod, lighthouseVersion: null, pages: {} };
if (args.keep) mkdirSync(args.keep, { recursive: true });

for (const name of pages) {
  const page = ALL_PAGES[name];
  result.pages[name] = { url: page.url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ':id') };
  for (const form of forms) {
    const samples = [];
    for (let run = 0; run < runs; run += 1) {
      const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless=new', '--no-first-run', '--disable-extensions'] });
      try {
        const flags = {
          port: chrome.port,
          output: 'json',
          logLevel: 'error',
          onlyCategories: ['performance'],
          throttlingMethod,
          ...(page.owned && cookie ? { extraHeaders: { Cookie: cookie } } : {}),
        };
        const runner = await lighthouse(`${ORIGIN}${page.url}`, flags, form === 'desktop' ? desktopConfig : undefined);
        const lhr = runner.lhr;
        result.lighthouseVersion = lhr.lighthouseVersion;
        if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
        samples.push(summarise(lhr));
        if (args.keep) writeFileSync(join(args.keep, `${name}-${form}-${run}.json`), JSON.stringify(lhr));
      } catch (error) {
        console.error(`  ${name} ${form} run ${run} failed: ${error instanceof Error ? error.message : error}`);
      } finally {
        await chrome.kill();
      }
    }
    if (samples.length === 0) continue;
    const reduced = reduce(samples);
    result.pages[name][form] = reduced;
    console.log(`${name.padEnd(10)} ${form.padEnd(8)} LCP ${reduced.lcpMs} FCP ${reduced.fcpMs} TBT ${reduced.tbtMs} CLS ${reduced.cls} SI ${reduced.speedIndexMs} score ${reduced.performanceScore} | ${reduced.lcpElement?.selector ?? '-'} | runs ${reduced.lcpMsRuns.join(', ')}`);
  }
}

if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2));
