# Staging acceptance — 2026-11-11

Staging: https://sidequestweb-staging.up.railway.app
Railway project `diligent-celebration`, environment `staging` (duplicated from production's service settings), deploying `feat/trip-experience-release-pass`. Own domain, own empty volume, own session secret, `SIDEQUEST_DAILY_MODEL_CALLS=300` (staging only; production unchanged at 60). The API keys are production's, copied inside Railway, so model spend shares production's Anthropic key.

Production was not deployed, merged into or reconfigured. Its last deployment is still 26 October.

## Local release gate (commit 105ac1e + quarantine comment fix)

| Step | Result |
|---|---|
| typecheck | pass |
| lint | 0 errors (147 warnings) |
| unit | 9277 passed, 1 skipped (after the comment fix; the gate run had 1 quarantine failure on a place name in a comment) |
| build | pass |
| Playwright desktop | 269 passed |
| Playwright mobile | 260 passed |
| tablet | 14 passed |
| globe | 23 passed |
| maps | 31 passed |
| Today | 4 passed |
| journeys | 16 passed |
| `git diff --check` | clean |

## Staging acceptance (`playwright.staging.config.ts`, `e2e/staging/staging.spec.ts`)

- Public surface: 12 routes at desktop, tablet and phone. 0 hydration errors, no horizontal overflow, expected status codes.
- Headers: CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, noindex, robots disallow, `/labs` closed, readiness carries no secrets.
- Every live trip ran create → build → reload → remove/undo/re-apply/restore version → booking and route links → ICS → print → share/stranger/revoke → hydration. All passed on the final runs.
- ICS TZIDs: Europe/Lisbon, Atlantic/Reykjavik, Africa/Dar_es_Salaam, Europe/London, Asia/Tokyo, Atlantic/Canary.
- Share: a stranger sees a read-only copy without owner views; a revoked link is 404.
- Routing: Lisbon build measured 14 of 14 legs through openrouteservice. The scan's own matrix is still mostly estimated.

## Trips inspected by hand

| Trip | Before this pass | Final staging result |
|---|---|---|
| Iceland Ring Road, 9 days | 8 nights in Selfoss | Vík → Höfn → Akureyri → Reykjavík, 15 stops; Goðafoss, Dettifoss, Mývatn on the road |
| Tanzania, 9 days | 7 stops | 15–17 stops, Arusha + Karatu bases; light days labelled as such |
| Scotland Highlands, 8 days | build refused (model allowance) | Glencoe → Portree → Inverness, 15 stops |
| Japan linear, 10 days | — | 3–4 bases in order, 23 stops |
| Tenerife, 6 days | — | Puerto de la Cruz, 13 stops |
| Lisbon, 4 days | — | one base, 10–11 stops |
| Help me choose | — | shortlists returned |

## Remaining issues

1. Iceland: Jökulsárlón appears in some scans and not others, because the scan varies and smart defaults cap each interest at one. The Höfn → Akureyri leg is about 6 h 10, over the stated drive limit; the day says so instead of hiding it. One run left the Vík → Höfn move day empty; the replay with final code fills it.
2. Tanzania: no Ngorongoro Crater game drive and nothing in the Serengeti. Serengeti candidates fail to place, so the plan stays in the Arusha/Karatu area.
3. Japan: intercity legs are mostly estimates (no rail routing). A move day was empty in one run.
4. Lisbon: the Gulbenkian Museum was not placed in one run.
5. Real Google sign-in is untested on staging: the staging callback (`https://sidequestweb-staging.up.railway.app/api/auth/google/callback`) must be added to the OAuth client.
6. Staging watch paths are `/apps/web/**`; a change only under `packages/` will not redeploy staging on its own.
7. Provider failure recovery is verified by unit and fixture suites (open-data scan, planner kept without the model), not by forcing a live outage on staging.

## Cost

Railway workspace: $6.00 so far in November, $11.95 estimated for the month. Staging idles at about 680 MB, roughly $7–10 a month while running. Model use on staging this pass: roughly 15–20 scans with supplements and two advisor research calls.
