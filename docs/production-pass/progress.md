# Production pass — progress

Ledger: `docs/production-pass/tasks.json`. Research: `docs/production-pass/research/`. Screenshots: `docs/production-pass/{baseline,after}/`. Walker: `docs/production-pass/tools/walk.spec.ts` (`WALK_OUT=<dir> npx playwright test -c docs/production-pass/tools/walk.config.ts --project=desktop` against a fixture server on :4300).

## 2026-10-24

### Root cause of the screenshot failures
- "Sidequest can't reach its research right now." = `provider_auth_failure` on the discovery scan (`lib/discovery-scan/view.ts:60`); "…its trip planner right now." = the same cause on a model-composed build (`lib/planning/build-failure.ts:87`).
- The local `ANTHROPIC_API_KEY` returns **401 `invalid x-api-key`** on `GET /v1/models` (free endpoint, request `req_011CgNLRdS3u17bZp8f2ST9G`). The classifier is correct; the credential is dead.
- Production logs for refs ae47ad04 / bzL4fL00 not read: `railway` CLI is logged out on this machine (`railway whoami` → Unauthorized). Next step for the owner: `railway login`, then `railway logs -p diligent-celebration -e production --json | grep -E 'ae47ad04|bzL4fL00'`.
- Structural weakness behind it: the scan's one proposal call is a single point of failure — no board, no trip. Fix in progress: open-data proposal fallback (OSM + Wikidata), labelled.

### Baseline (fixture build)
- Build 0, walk passes in 29 s, 0 page errors.
- Visual: warm paper + editorial serif already (V8/V11), but: placeholder wave art on every card, many pale bordered boxes, small controls, long explanatory paragraphs, the landing "atlas" is a decorative curve, not geography.

### Decisions
- Hero/maps: MapLibre (already shipped, globe + terrain + gradient line progress), not three.js. Motion for UI motion, React `<ViewTransition>` for route transitions. No GSAP unless a marketing scroll scene needs it. (`research/visual-tech.md`)
- Planner: deterministic ILS improvement phase. (`research/planning.md`)
- Product priorities from `research/market.md`: verified-before-shown verdict, edit-without-loss, "left out and why", import what you have, visible confidence, group hard rules.

### Implemented so far (2026-10-24, evening)
- **Brand**: S-route mark with an off-line flare waypoint (`components/brand/SidequestMark.tsx`, `public/brand/*.svg`), Fraunces/Bricolage Grotesque/JetBrains Mono, night/bone/flare/glacier tokens, generated contour texture (`scripts/generate-contours.mjs`), app icons from the mark's geometry. Directions compared in `docs/production-pass/brand/`.
- **System**: palette retuned (contrast guard 101/101), tighter radii, pill buttons, flare accent action, grain instead of dot grid, `.topo` utility, colophon footer with legal + data credits.
- **Landing**: MapLibre night globe (OpenFreeMap vectors + AWS terrarium hillshade) flying between four example shapes through real towns, labelled "Example shape", pausable, reduced-motion still, poster fallback; inline destination form; scroll-drawn "How it works"; the label vocabulary; three promises.
- **Interview**: "For you" recommended interests (`packages/core/src/interview/recommended.ts`) — destination traits + season + length + party, a reason each, and the priorities smart default.
- **Plates**: card fallbacks and board plates are contour plates (effort = contour density, quiet find = flare waypoint).
- **Agents done**: open-data scan fallback (OSM + Wikidata) — needs `SIDEQUEST_POI_PROVIDER=overpass` in production.
- **Agents running**: planner ILS improvement; hardening (Next 16.4.3, rate limits, deletion/export, legal drafts, OAuth state, observability).

### Late evening
- **Planner ILS done** (`structure-improve.ts`, `createPlannerKernel` validator). Bench greedy→improved: Lisbon 1035→1176, Ireland 697→868, Southern lakes 633→951, Mammoth 922→930, Kyoto 919→959, Norway 60×14 1839→2028; p50 374 ms on the 60×14 board. Ireland replay matrix zeros.
- **Regression found by the redesign walk, fixed**: with ILS on, the fixture Harbour City trip read "Needs a decision" (duplicated decide rows). Root cause in `reconcile.ts`: a moving day with no stated `move` took the transfer's mode from `anchors[0].transport` (base → first stop), so a short first hop made the 45 km base change a *walk*, which the walk check refused → unmeasured transfer → route-completeness blocker. Fix: the day's road mode (car if any stop is driven). Second honesty bug: a withdrawn (refused) figure was still printed as "27 min measured" — title, reason and precision now read the withdrawn state. Regression test in `reconcile.test.ts` fails without the fix. Walk with ILS on → Ready, 9 stops (was 7).
- **Hardening done**: npm audit (prod) 5 → 0 (Next 16.4.3, zod 4.6, postal-mime 4), spend controls (account → trusted IP → cookie; anonymous share; new-cookie admission bucket; hourly billed fence), data export + delete (completeness test over every trip/user table), draft legal pages, OAuth state cookie, request ids + `onRequestError`, Permissions-Policy, noindex headers, sitemap.
- **Scan screen**: night ground + live map of real placed points (`ScanMap.tsx`; `counters.center/points`); every scan records `diagnostics.timings`.
- ~~Route transitions via `<ViewTransition>`~~ — removed after the browser suite (see below).
- **Home** warns only when the scan path is refused (not when the model fallback is down).
- Build 0 after all of the above. Desktop Playwright running.

### Desktop Playwright, round 1 → fixes
- Round 1: 245/253. Re-run of the 8: 3 flaky under load (pass alone), 5 reproducible. Same 5 against a clean `HEAD` worktree (`git worktree add --detach … HEAD`, own `npm ci` + build): **5/5 pass** → all caused by this pass.
- 3 caused by the route `<ViewTransition>` (navigation timing; keyboard focus lost mid-transition). **Removed** — an animation is not worth a keyboard regression.
- `hours.spec` (a hand-picked stop missing): the ILS parked the traveller's include on the departure morning (includes may overflow a day so they are never lost; verification then trimmed it past the departure). Fix: overflow minutes are a lexicographic tier above score (`compareObjective`).
- `transport.spec` (a broken manual pick not listed as "could not be scheduled"): the ILS lets the planner fill the days where it used to fall back to the model composer, which exposed a **latent planner-path gap**: must-do conflicts reached the draft's prose but never `itinerary.unscheduled`. Fixes: `plannerUnscheduledPicks` (reason codes from the board's blocker), merged in `production-plan.ts`; and the omissions list orders the traveller's picks first (`OWNERSHIP_RANK`) so a hand pick is never cut by the 6-item cap. Unit test `planner-unscheduled.test.ts`.

### Browser suites (final round)
- Desktop 253/253 (32.4 min). Mobile 244 passed, 9 skipped (desktop-only), 0 failed (31.3 min).

### Live evaluation → the open-data fallback had to stop depending on public Overpass
- First 31-profile live run (agent, `apps/web/src/lib/eval/`): **4/31 completed**. Every failure was the scan: public Overpass instances throttling (overpass-api.de 406/timeouts, two mirrors timing out, overpass.osm.ch answering *empty* outside Switzerland), each group waiting 25 s per dead endpoint.
- Fixes: `providers/wikidata-around.ts` (Wikidata Query Service `around`, types → OSM-style tags, sitelinks in the same answer; ~0.3–2.3 s), Wikidata-first in `liveOpenDataDeps` with Overpass merged only while thin; Overpass endpoint cooldown (10 min, process-wide); osm.ch out of the default rotation; truthful source refs (`wikidata:Q…`, never a fake `osm:` id); one 429 retry.
- 10-profile subset after the change: **8/10 completed**, most in 4–13 s (Iceland 85 s). Plans read: Tokyo days geographically coherent (Skytree → Sensō-ji → Ueno; Kamakura day trip), Paris Eiffel/Orsay/Tuileries.
- Planner copy fix: "Pack a lunch — food is thin out near Tokyo" was printed for a zoo; now only wild ground categories trigger it.
- Agent's other findings (not yet fixed): days under-filled on some trips (Zurich 6 of 25 places at fast pace), meals are placeholders when food data is unavailable, "Tokyo" resolves as country-scale admin area, rail out / bus back on one journey, city hops priced as 25-min rail.

## 2026-10-25 — local design review pass (before approval; nothing committed)
- Landing globe: 3D terrain (`nightAtlasStyle({ terrain: true })`, one DEM source), land/sea from elevation (`color-relief`) so coasts are right before vector water tiles land, routes drawn only after the region's tiles are idle (2.5 s cap), tour advances from the end of drawing. Frames: `after/globe-frames.png`.
- Header continues the night hero on the landing (`ProductChrome tone="night"`, `.chrome-night` token override); `globals.chrome.test.ts` regex accepts the template class.
- Real-data walk (Lisbon, open-data fallback, dead local key): passes, 0 page errors — `after/real-lisbon/`. Finding: "Lisbon" asks "More than one place is called Lisbon" (Lisboa name relation read as partial).
- Honest read: home + scan are new; interview, board and itinerary are restyled, not restructured. Side-by-sides in `compare/`.
