# Final product completion and release validation (2026-11-10)

Branch `feat/trip-experience-release-pass`, from `8907053`. Nothing merged, deployed or changed in production; production was only read (variable names, `/api/health`, `/api/readiness`).

Evidence in this folder: `journeys.json` (486 journey steps), `screens/{desktop,tablet,phone,audit}/`, `routing-calibration.json`, `itinerary-after.json`, `recommendations/`, `live/` and `gate/` (filled in at the end of the pass).

## 1. Feature and workflow matrix

Status: **E2E** verified end to end · **LIM** verified with limitations · **EXT** blocked by an external dependency · **NI** not implemented · **FAIL** failed.
Method: J = fixture journey spec (`e2e/journeys/`, desktop 10 trips, tablet and phone 3 each) · L = live model and providers (`e2e/rc-live.spec.ts`, real road routing on a local Valhalla) · S = existing browser suite · U = unit or harness · A = interaction crawler (`e2e/audit/`).

| Workflow | Intended behaviour | Status | Method | Real-data evidence | Remaining issue (severity) |
|---|---|---|---|---|---|
| Landing | Explains Sidequest, two doors, globe | E2E | S, A, J | Mobile LCP 1.14 s (throttled) | — |
| Account, sign-in, sign-out | Google OAuth; guest trips claimed on sign-in | LIM | J (fixture auth), S | Production has the OAuth client set; real Google sign-in not exercised here | Real OAuth callback untested in this pass (P2) |
| Saved traveller profile | Learned leanings, editable | E2E | S | — | — |
| Questionnaire | Adaptive, smart defaults, review shows needs | E2E | J, L | 7 live trips through smart defaults | — |
| I know where I want to go | Destination resolved, region framed | E2E | J, L | Tenerife, Kyoto, Utah, Tanzania, Iceland, Kyrgyzstan, Lisbon live | — |
| Help me choose | Global atlas, vague requests, named things | E2E | J, L, U | 2 live requests; 211-request benchmark 428/468 | Estimators weak for scenic driving, rail, hot springs (P2) |
| Optimize an existing plan ("I already have a plan") | Plan critiqued on the board and the finished trip | E2E | J | Lisbon journey | Fixed in this pass: critique was missing without a must-do |
| Regional expansion and nearby discovery | Scan proposes candidates, bases, food | LIM | L | 22–35 places per live scan | Ring-road trips: see the Iceland row (P1) |
| Preliminary scan | One model call, placement, timing | E2E | L, S | 7/7 live scans after two fixes | Base lookup retry added after a live Moab failure |
| Discovery Board | Groups, picks, rejections persist | E2E | J, A | — | — |
| Auto-pick | Plans the board; never picks what it says to skip | E2E | J, U | — | Fixed: picks sat under "Why we would skip it" |
| Itinerary generation | Planner, no model call, audited | E2E | J, L, U | 7 live itineraries | — |
| Hotel-base optimisation | One objective; decision shown | LIM | U, L | 228 harness trips; live sentences shown | Iceland Ring Road became 8 nights in Selfoss: east-side places not placed (P1) |
| Transportation | Mode from the traveller; measured legs | LIM | L, U | 97 of 142 live legs measured by a router | Production depends on its OpenRouteService key (not verifiable here) |
| Travel times | Measured, or labelled estimate | E2E | L, U | Calibration on 792 real road pairs | Mountain passes and sea crossings estimated too fast when no router answers (P2) |
| Weather and seasonality | Forecast or normals, stated as which | E2E | S | — | — |
| Safety | Three governments, regional scope | LIM | U | Atlas advisories | Single-authority veto on Uganda is an owner decision |
| Budget | Ranges, never current prices | LIM | U, J | — | Thin price evidence (P2) |
| Food | Real venues, chains labelled, sparse-area advice | LIM | L, U | 4–136 venues per live scan | Hours rarely known (said so); breakfast not named (P2) |
| Map and itinerary | One selection; pins match stops | E2E | J, A, S | — | — |
| Day and stop editing | Move, remove, add, duration, undo | E2E | J | Read back after reload | — |
| Replanning and versions | Old plan kept before any rebuild; restore | E2E | J, S, U | `plan-versions` spec | Plans from a stale build version cannot be recorded (P2) |
| Booking links and checklists | Links carry destination, dates, party | E2E | J | URLs parsed (third-party sites not visited) | — |
| Preparation and packing | Derived, no provider on open | E2E | S, A | — | — |
| Refresh trip information | Evidence only, never structure | E2E | U | Structure compared before and after | — |
| PDF / print | Every day in the packet | E2E | J | `page.pdf` | Real print dialog not exercised (P3) |
| Calendar export and feed | Valid ICS, time zone, no private fields | LIM | J | ICS parsed | Time zone wrong when the geocoder is off (fixture only); correct live for Iceland (P2) |
| Map links | Google and Apple links with stops | E2E | J | — | — |
| Sharing | Stripped public view; revocation | E2E | J, S | — | — |
| Reopening, restart, other user | Same plan; isolation | E2E | J, S | 32-door ownership test | — |
| Today mode | Live day view on a fixed clock | see gate | S | — | — |
| Mobile and tablet | Usable map and list together | E2E | J, S, A | Phone dock, tablet layout | Real devices not used (P3) |
| Error recovery | Failed requests keep the page | E2E | J, U | Live map crash and slow router fixed | — |
| Mobile app (Expo) | In the original vision | NI | — | — | Roadmap, not a current promise |
| Learning from feedback (ML) | In the original vision | NI | — | — | Roadmap |

## 2. Defects found and fixed in this pass

| Found by | Defect | Fix |
|---|---|---|
| Journeys | A dropped connection during an edit took down the trip page | Edits go through one guarded action call |
| Journeys | A typed must-do nobody could place vanished | Listed under "Could not be scheduled" |
| Journeys | "I already have a plan" got no critique without a must-do | Critique always runs |
| Journeys | The review never showed mobility needs | Party row states needs |
| Journeys | Auto-pick chose places the board says to skip | Excluded from auto-pick |
| Audit | Hydration error #418 on the Pack | Origin via `useSyncExternalStore`; feed time fixed format |
| Audit | Share panel squeezed; More menu swallowed taps; dead Book link; map card over the route | Fixed |
| Audit | Community hours shown as "Open" | "Listed … · not confirmed" |
| Audit | Opening a trip triggered 20 page requests | 11 requests, 0.08 actions |
| Undo work | Rebuilds lost the previous plan | Every overwrite records a version; restore on the trip page |
| Routing | Board printed estimates as plain figures | "about" on every unmeasured time |
| Routing | Mid-range drive speeds a little fast | Calibrated anchors |
| Live | Moab scan failed on one base lookup timeout | One retry for failed bases |
| Me | "Gorillas" returned Denali; flight hours ignored | Named things gate the primaries; hours set reach |
| Suite | Flaky browser runs | Root cause was the laptop sleeping on battery; runs keep it awake and report sleep |

## 3. Verification on the final code (`4d0dcec`)

| Check | Result |
|---|---|
| Typecheck | clean |
| Lint | 0 errors, 147 warnings |
| Unit | 9,232 passed, 1 skipped, 0 failed |
| Production build | succeeds |
| Playwright desktop | 269 passed, 1 skipped |
| Playwright mobile | 260 passed, 10 skipped |
| Playwright tablet | 14 passed (on `ef78d35`; auto-pick changed after) |
| Today, globe, maps configs | 4, 23 (1 skipped), 31 (7 skipped) passed (on `f364e17`) |
| Journeys desktop | 10 of 10 trips, every step |
| Journeys tablet and phone | 3 trips each, every step |
| Hydration guard | in the desktop and mobile suites |

The gate caught three regressions after the merges, all fixed before the green run: Choose for me picked nothing on boards of mostly weak fits; a base revisited on a route failed the region check; an unmatched typed place was critiqued as dropped.

## 4. Live model and provider acceptance

`playwright.rc-live.config.ts`, real Anthropic model, Nominatim, Overture, OpenFreeMap and a local Valhalla with eight regions of OpenStreetMap roads (`.routing-cache/`, not shipped). Nine of nine passed on the final live run: Moab and Arches, Kyoto and Nara, Tenerife, Arusha and the Serengeti, Iceland Ring Road, Karakol and Issyk-Kul, Lisbon, and two Help me choose requests. About 30 recorded model calls across every live attempt in this pass.

Across the seven trips 97 legs were measured by the router, 39 estimated and 6 unmeasured. Scans took 89–196 s and placed 22–35 places. Live runs found and this pass fixed: a Tenerife namesake abroad, a 404 on vague requests, a slow router consuming the scan, a map crash hiding the finished trip, and one failed base lookup failing a whole scan.

Known live quality issues: Iceland Ring Road planned as 8 nights in Selfoss (east-side places did not place, so the Höfn base was never worth using); Tanzania a sparse 7 stops in 9 days; the scan's own matrix often fell back to estimates on the local router (45 s budget), though the plan's legs were then measured.

## 5. Production configuration, read only

Production has `SIDEQUEST_TRUSTED_PROXY_HOPS=1`, `SIDEQUEST_DAILY_MODEL_CALLS=60`, an OpenRouteService key with `SIDEQUEST_ROUTES_GLOBAL_PROVIDER=openrouteservice`, Google OAuth, and `GOOGLE_MAPS_API_KEY` set. `/api/health` answers `{"ok":true,"database":"ready"}`. Production runs `main`, not this branch; nothing was deployed.
