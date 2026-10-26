# Sidequest production pass — report (2026-10-25)

**Verdict: not ready for widespread launch.** The visual reinvention is integrated across the primary journeys, the research/planner failure is root-caused with an honest working fallback, the planner is materially better, and hardening P0s are closed in code — but the production model credential is dead, measured routing and food data depend on keys/self-hosting not yet provided, three country-scale trip shapes still fail on open data, and legal text needs owner/legal review. Details below; ledger in `tasks.json`, running notes in `progress.md`.

## 1. The two screenshot failures
- "Sidequest can't reach its research right now." and "…its trip planner right now." are both `provider_auth_failure` (`lib/discovery-scan/view.ts:60`, `lib/planning/build-failure.ts:87`).
- The local `ANTHROPIC_API_KEY` returns **401 `invalid x-api-key`** on the free `GET /v1/models` endpoint (request `req_011CgNLRdS3u17bZp8f2ST9G`). The classifier was right; the key is dead. **Production logs for refs ae47ad04 / bzL4fL00 were not read** — the `railway` CLI on this machine is logged out.
- Structural repair: the scan no longer dies with the model. When the proposal call is unavailable it builds the board from **Wikidata + OpenStreetMap** (no model), says so on the board, and reports the model's real cause if open data also fails.

## 2. What changed (by area)
**Brand & visual system** — S-route mark with an off-line flare waypoint; Fraunces / Bricolage Grotesque / JetBrains Mono; night · bone · flare · glacier palette (contrast guard passes both themes); generated contour texture as the only ground; contour plates where data lives in the texture (density = effort, waypoint = quiet find); pill controls, flare primary action; colophon footer with legal links and data credits. `design-system.md`, `brand/`.
**Landing** — MapLibre night globe (OpenFreeMap vectors + AWS Terrain hillshade) flying between four example trip shapes through real towns, labelled "Example shape", pausable, reduced-motion still, poster fallback without WebGL; inline destination form; scroll-drawn "How it works"; the confidence vocabulary; three promises.
**Journey** — context-aware "For you" interests (traits + season + length + party, a reason each, and the "Decide for me" default); scan screen on the night ground with a **live map of real placed points**; shorter board copy; flare build action; night trip cards; atlas band with the verdict as the badge.
**Reliability** — open-data scan fallback; Wikidata-first source (~1 s) with Overpass merged only while thin; process-wide cooldown for failing Overpass endpoints; Swiss-only mirror out of rotation; truthful source refs; per-stage scan timings on every row; home warns only when the scan path is refused.
**Planner** — deterministic iterated local search after greedy construction (insert / relocate / swap / replace / make-room / 2-opt / shake) over a stated lexicographic objective; one whole-day validator. Bench (greedy → improved score): Lisbon 1035→1176, Ireland 697→868, Southern lakes 633→951, Mammoth 922→930, Kyoto 919→959, Norway 60×14 1839→2028; p50 374 ms on the 60×14 board.
**Correctness bugs found and fixed this pass** — moving-day transfer took the first stop's "walk" (untimed base change → false "Needs a decision"); a withdrawn figure printed as "27 min measured"; ILS parked a traveller include on the departure morning; a blocked must-do never reached `itinerary.unscheduled` on the planner path; hand picks could be cut from the omissions list; "Pack a lunch, food is thin" on a city zoo; **"Rome" read as Rome, Georgia** and **"Bali" read as Paris** (alias of every language). Each has a regression test.
**Hardening** — prod `npm audit` 5 → 0 (Next 16.4.3, zod 4.6, postal-mime 4); spend controls (account → trusted IP → cookie, anonymous share, new-cookie admission bucket, hourly billed fence); data export + delete-all with a table-completeness test; draft Privacy / Terms / Support; OAuth state bound to the browser; request ids + structured `onRequestError`; Permissions-Policy, noindex headers, sitemap; image optimizer off.

## 3. Visual technology choices
MapLibre (already shipped: globe, terrain, gradient-line progress) over three.js/R3F (+250 KB, duplicates the globe); Motion for interface motion; GSAP, Lenis, Spline, Aceternity skipped; React `<ViewTransition>` **tried and removed** — it changed navigation timing and dropped keyboard focus (three browser tests caught it). Research: `research/visual-tech.md`.

## 4. Evidence
| Gate | Result |
|---|---|
| Unit tests | 8,459 passed, 1 skipped, 0 failed |
| Typecheck / lint / build / diff-check | 0 errors / 0 errors (124 warnings) / exit 0 / clean |
| Playwright desktop | 253/253 on the final build (32.7 min) |
| Playwright mobile | 244 passed, 9 desktop-only skipped, 0 failed |
| Live eval, 33 profiles, no model | 26/33 itineraries (79%), was 4/31; time-to-plan p50 5.0 s, p95 15.5 s; 0 silent anchor loss, 0 zero-minute legs, 0 car legs on car-free trips |
Screenshots: `baseline/` (before) and `after/` (after), same walker (`tools/walk.spec.ts`).

## 5. Latency
Measured on the open-data path only (the model path cannot run): resolve p50 2.0 s; scan p50 0.8 s / p95 11 s; build p50 2.2 s / p95 3.0 s. The 60 s p95 target for the model path is **unmeasured** — needs a valid key.

## 6. Blockers and owner actions
1. **Rotate `ANTHROPIC_API_KEY`** in Railway (production) and locally; confirm with `npm run doctor -- --probe`.
2. **`railway login`**, then read refs ae47ad04 / bzL4fL00 to confirm production matches the local diagnosis.
3. **Routing**: add `OPENROUTESERVICE_API_KEY` + `SIDEQUEST_ROUTES_GLOBAL_PROVIDER=openrouteservice` — every leg in the eval is a labelled distance estimate.
4. **Map data**: public Overpass cannot carry a launch; self-host or contract an Overpass endpoint (`SIDEQUEST_POI_URL`); keep `SIDEQUEST_POI_PROVIDER=overpass`.
5. Set `SIDEQUEST_TRUSTED_PROXY_HOPS=1` (verify with a header dump) and `SIDEQUEST_SUPPORT_EMAIL`.
6. **Legal**: Privacy / Terms are drafts marked for review (lawful basis, retention, US transfer, special-category data, liability, operator entity).
7. Off-platform backups, an error tracker/log drain, spend alerts (documented, not built).

## 7. Open product gaps (not fixed)
Country-scale and wilderness trips on open data (one box around one centre → thin boards; needs per-part queries); Patagonia-type regions without the interpreter; meal placeholders when food data is unavailable; some days under-filled; religious sites over-weighted by sitelinks; Tokyo resolves at country scale; competitor-informed features not built (group voting, Google Maps list import); native mobile app not started (PWA exists; Expo needs a versioned JSON API).

## 8. Git
Nothing committed or pushed. All work is uncommitted on `main`.
