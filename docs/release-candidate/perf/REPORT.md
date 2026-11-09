# Performance: release-candidate report

## Before / after, mobile
Medians of 3 interleaved rounds (before and after alternated on port 4420, because the machine's load average moved between 11 and 115).

| Page | Applied throttle LCP | Simulated LCP (individual runs) | Other |
|---|---|---|---|
| `/` | **3.00 → 1.14 s** | **5.43 → 1.33 s** (1.2/5.4/5.6 → 1.27/1.33/1.34) | applied FCP 2.37 → 1.14 s, TBT 1907 → 376 ms |
| `/decide` | **2.35 → 1.01 s** | 1.22 → 1.25 s (1.22/4.98/1.22 → 1.25/1.25/1.28) | first 5-run baseline had a 4.98 s median; CLS 0.18 → 0 in rounds where it occurred |
| trip | 3.80 → 3.45 s (within noise) | **1.68 → 5.13 s (not fixed, see below)** | |

Desktop simulated LCP stayed fine: `/` 342 → 316 ms, `/decide` 341 → 317 ms, trip 406 → 395 ms.

| Client bytes (gzip) | Before | After |
|---|---|---|
| Landing JS | 253 KB | 163 KB |
| `/decide` JS | 186 KB | 151 KB |
| Trip JS | 322 KB | 319 KB |
| Preloaded fonts (raw) | 347 KB | 198 KB |
| Landing document | 12.6 KB | 114 KB |
| `/decide` document | 31 KB | 131 KB |
| Trip document | 89 KB | 193 KB |

## What the "6 seconds" was
It is Lighthouse's simulated number. Lighthouse charges LCP for every request finished before it was observed, so an LCP even slightly after FCP jumps from 1.2 s to 5.4 s. The hero's largest text started at `opacity: 0` with a 420 ms delay, which created that gap on most loads. With the throttle really applied, the page was 3.0 s.

## Changes and measured effect
- **Hero text entrance (`.rise-in`, transform only):** `/` simulated LCP stops flipping; every after run is 1.2–1.3 s. The headline's masked rise is unchanged.
- **`experimental.inlineCss`:** applied throttle, against the same build without it, `/` 1.98 → 1.03 s and `/decide` 1.91 → 0.97 s, with no overlap across rounds. Fonts and client navigation verified working.
- **Fraunces italic no longer preloaded:** the preload drop in the table.
- **Landing JS:** Motion removed (the one reveal is now CSS), and the trip list is lazy through a client wrapper.
- **zod out of the shared path:** schemas moved to `naming/display-name-schema.ts`, which accounts for the `/decide` JS drop.
- **Globe waits for load and idle on phones:** part of the TBT drop, not isolated from the others.
- **`/decide/loading.tsx` removed, and loading screens fill the viewport:** removes the CLS.
- **Atlas decoded before serving** (awaited in `register()`, loader state shared across bundles): see cold timings below.

## Costs the owner should weigh
- Inline CSS adds about 100 KB gzip to every full document load, about 67 KB net on a first visit. A returning visitor pays the full 100 KB where a cached stylesheet was free. Client navigations are unchanged. The flag is experimental, so re-measure on Next upgrades.
- `/decide` no longer shows a loading screen on client navigation.
- Boot is longer: `/api/health` took about 7 s at load 50–60 because the atlas decodes first, against 0.6–1.9 s before.
- Each process holds about 460 MB from boot.

## Server timings
"Cold" is the first request after `/api/health` answers; one process per target; both builds back to back at load about 50–60.

| Target | Before cold / 10th request | After cold / 10th request |
|---|---|---|
| `/` | 1376 / 31 ms | 450 / 210 ms |
| `/decide` | 4264 / 17 ms | 1355 / 277 ms |
| Interview step | 5402 / 1728 ms | 4018 / 901 ms |

- Warm numbers swing with contention, so don't compare them across builds. The step measured about 440 ms warm at lower load.
- RSS after every target: 949 MB before, 1051 MB after; 1208 MB peak under load.
- SQLite on the trip page: 37 statements, about 3 ms of a 65 ms render, so not a bottleneck.
- Trip creation on fixtures: scan 273 ms, build 636 ms, server-side. Nothing to optimize there, and it says nothing about live model and provider latency, which I did not measure.
- No atlas, ranking, planner or database code in client chunks. The one flagged chunk is a zod field name.

## Concurrency (run once, final build)
autocannon, 30 connections, 30 s, generator and server on one machine at load about 60.

| Target | req/s | p50 | p99 | Errors |
|---|---|---|---|---|
| Landing | 22.2 | 1.2 s | 2.4 s | 0 |
| Trip | 4.7 | 5.6 s | 10.9 s | 0 |
| Interview step | 0.8 | 17.9 s | 29.6 s | 6 timeouts |

**What it shows:** requests queue behind one synchronous event loop.

**What it does not show:** production capacity. There was no TLS, network or real data volume, one identity, instant fixtures, and a starved process (33–41% CPU).

**First bottleneck:** the interview step, ranking about 36,800 destinations synchronously, at least 440 ms per request, during which nothing else responds.

**Beta hosting recommendation:** at least 2 GB of memory, one replica (SQLite on one volume), keep the 120 s health-check timeout, and keep the beta small while watching event-loop lag. `docs/DEPLOYMENT.md` does not state the instance size.

## Tried and discarded
- My Playwright paint probe: unreliable on this busy machine (no paint reported even unthrottled). Applied numbers come from Lighthouse `devtools` mode instead.
- `#__PURE__` on the schemas: Turbopack keeps the module, so no effect.
- Atlas warm-up via `setTimeout`: ran after health passed and made the first visitor slower (`/` 1.4 → 5.9 s). Corrected to awaited.
- Removing the itinerary `loading.tsx`: no improvement, reverted.

## The trip page
Its simulated LCP is bimodal both before and after, and the median looks worse with inline CSS (individual after runs 1.6–5.7 s). Under applied throttling it is flat and still above 2.5 s. Deeper work belongs with the trip-page owner.

## Tests
- **Typecheck:** clean. **ESLint on changed files:** clean. `git diff --check` clean.
- **Scoped vitest (instrumentation, render-purity, naming, atlas, globals, map-vendor, advisor):** 257 passed. After the final `register()` change I re-ran only the instrumentation and render-purity files: 20 of 21 passed, the one failure a 5 s timeout under load, which passed with a longer timeout. Full `npm run test` was not run.
- **`e2e/design-lab.spec.ts` + `e2e/decide.spec.ts`, desktop:** 11 passed.
- **`e2e/routes.spec.ts`, desktop:** 2 passed.
- **Globe specs (`playwright.globe.config.ts`):** 22 passed, 1 skipped, 1 failed on a 60 s timeout under load; that spec passed when re-run alone.

## What remains, ranked
1. Move interview-step ranking to a worker thread. Largest server-side risk; ranking was out of my scope.
2. Trip page: 319 KB JS and its LCP bimodality.
3. Shrink the 196 KB raw CSS, which would also cut the inline-CSS document cost.
4. Atlas memory and boot time, for example a binary format.
5. CDN for static assets.
6. `/trips/new` still ships Motion.

## Caveats
- The final Lighthouse rounds ran one build before the warm-up was made awaited. That change is server-only and emits no client code. Server timings are from the final build.
- Three runs per page, as instructed; the simulated metric is bimodal enough that three runs can't pin a median.
- Live third-party tile hosts were hit during Lighthouse runs, so transfer totals on `/` and the trip page vary.
- Everything is local. I am not claiming production scalability from any of it.
