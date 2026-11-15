# Final completion pass — report

Branch `feat/trip-experience-release-pass`. Staging `https://sidequestweb-staging.up.railway.app`.
Nothing merged to `main`; no production deploy, data or secrets touched; no paid service added.

## 1. Deployed staging commit

The last commit verified, pushed and deployed is recorded at the end of this file (§12). Every
push in this pass was preceded by the full unit suite, typecheck, lint, build and the browser
suites on that exact code, and Railway's deployment list was checked for the commit hash.

## 2. What changed (all generic — no destination-name logic)

| Area | Change | Found by |
|---|---|---|
| Routing | Process-wide openrouteservice quota breaker; a router that went quiet keeps the planner's plan instead of an unbound model composition (`package.planning.routing`); a quota spent *before* the scan counts too | eval-v3 Tanzania (Zanzibar added) |
| Routing | Simulated quota exhaustion end to end (`playwright.degraded.config.ts` :4323 + `e2e/support/ors-quota-stub.mjs`): plan ships, says times are estimates, the stub sees ≤ 2 requests | brief §1 |
| Time | Coordinate → IANA zone (`@sidequest/core/zone-lookup`, offline boundaries) for sky timing, scan bases, trail dusk, envelope, calendar | eval-v3 Kauai midnight sunsets |
| Geography | A base far outside the trip's footprint is unplaced; move-day backtracks corrected; the placement reach always covers every named part | eval-v3; live Mode 3 (Sapporo) |
| Destinations | An `unknown` reading is never cached or served (epoch 9); route words ("road trip") and trailing interest lists ("food and culture") never reach the geocoder as names; a row that does not carry the phrase's head word triggers a shorter retry; one lookup per named part (≤ 8) | live staging: Tanzania (stale cache → 6 nights Arusha), Faroe, Oaxaca, Madeira, Sapporo |
| Mode 3 | `/improve`: deterministic parse + critique; the plan travels as `statedItinerary` on the TripContract (stated nights `user_explicit`, booked `booked_lock`); the scan is told the stated stays and guarantees them as bases; every stay's fate on `package.contract.statedItinerary`; change-aware improvements (safe apply, major need a tick, every change toggles back) | brief §2 |
| Party | Never a silent two adults on any door: chosen → own words → saved travellers → assumed and labelled, with "decide later" | brief §3 |
| Trails | Over-long stages split at any placed point in a corridor; long stages start early for dusk; unresolved stage blocks Ready; placed stage-end villages become beds when no proposed bed sits at a stage end | eval-v3 TMB; live Kumano (one base + rental car) |
| Daily limit | Hard limits held by stays and day detour budgets; what still exceeds carries explicit choices (`package.planning.travelLimit`) | eval-v3 (41 → 49 days over) |
| Lodging | A business filed under lodging ("Arusha Website Design") or a row that is only the town ("Les Houches") is refused | live Tanzania, TMB |
| Transport words | Metro named for a stay in a city (named city part or ≥ 8 placed places within 5 km) where the country has one; no "N min on foot" claim beside a bus; guide shows "Driving" only on a driven trip; sentences cut at a word | live Tokyo–Kyoto PDF |
| Learning | Learned taste reaches planner builds through `boardFor` (fills unstated interests only); account-wide off switch; isolation between accounts tested | brief §6 |
| Trip page | Calmer overview (reasoning behind a fold), compact durations, qualified legs with a key, overlapping-pin offsets, a numbered day list beside the map, keyboard tab list | brief §5 |
| Feature | Mode 3 door on the home page | spec §7 |

## 3. Final-code test results

| Check | Result |
|---|---|
| `npm run test` (on `0704faa`) | **9,738 passed, 1 skipped, 0 failed** |
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors (154 pre-existing warnings) |
| `npm run build` | passes |
| Full desktop browser suite (on `047e17a`, after all agent work) | **283 passed, 2 skipped, 0 failed** |
| Desktop key suites on final code (canonical-plan, itinerary, trip-hub, live-world, stated-plan, plan-check, composer, map-itinerary) | 48 passed |
| Mobile (itinerary, plan-check, stated-plan, composer, decide, map-itinerary at `047e17a`) | 46 passed; on final code (itinerary, stated-plan): 12 passed |
| Maps suite | 17 passed |
| Today mode (fixture clock) | 4 passed |
| Degraded providers incl. simulated quota exhaustion | 4 passed |

## 4. Live real-provider acceptance (staging, sequential, one worker)

Graded by `docs/final-completion/eval/grade.py` (eval-v3 checks + unseen requirements written
before any run, `eval/requirements-unseen.json`). Name-matched coverage is lower-trust than the
hard counts; PDFs and screens are the check on it.

| Scenario | Build | Defining | Hard | Impossible legs | Walking-pace "measured" rides | Longest day (min) | Bases | Notes |
|---|---|---|---|---|---|---|---|---|
| Tanzania safari | pass 1 `047e17a` | 3/5 | 0 | 0 | 0 | 230 | 2 | stale cached reading → Serengeti refused; fixed |
| Tanzania safari | pass 2 `f7a81d9` | **4/5** | 0 | 0 | 0 | 235 | 2 | Karatu/Ngorongoro lodges named |
| Kyrgyzstan | pass 1 | **6/6** | 0 | 0 | 0 | 430 | 3 | eval-v3 fixed: 3.0/6 |
| Kauai | pass 1 | **5/5** | 0 | 0 | 0 | 155 | 2 | |
| Kumano Kodo | pass 1 | 4/5 | 5 | 0 | 0 | 130 | 1 | one base + rental car; fixed |
| Kumano Kodo | pass 2 | 4/5 | **1** | 0 | 0 | 110 | 2 | one "drive to Hongu" phrase remains |
| Tour du Mont Blanc (Alpine trek) | pass 1 | 4/6 | 1 | 0 | 0 | 185 | 3 | closed-refuge flag |
| Tokyo–Kyoto by rail | pass 1 / pass 2 | 4/5 / 4/5 | 0 / 0 | 0 | 0 | 250 / 280 | 2 | bus wording fixed after pass 2 (`0704faa`, not re-run live) |
| Family retreat (Help me choose) | pass 1 | 1/4 | 1 | 0 | 0 | 155 | 1 | advisor picked Tenerife; requirements expected other regions |
| **Unseen** Faroe Islands road trip | pass 2 | **5/6** | 0 | 0 | 0 | 250 | 3 | pass 1: no centre; fixed |
| **Unseen** Oaxaca food and culture | pass 2 | **5/6** | 2 | 0 | 0 | 155 | 1 | rental car under the harness's "will drive" default |
| **Unseen** Madeira levada hiking | pass 2 | 3/6 | 1 | 0 | 0 | 210 | 1 | a "train" leg: island off the national rail network (P1) |
| Imported itinerary (Mode 3) | pass 3 `e149f02` | **4/4 stated stays honoured** | 0 conflicts | — | — | — | 4 | Tokyo 4 · Kyoto 3 · Osaka 2 · Sapporo 1 |

Every scenario produced both PDFs (HTTP 200, 7–12 pages). Lodging picks were shown for every
trip (4 named properties each, no prices or availability invented).

## 5. Mode 3 — preservation and optimisation

- Live (`eval/live3/`): "April 5–15 2027: 4 nights Tokyo, 3 nights Kyoto, 2 nights Osaka, 1 night
  Sapporo, by train, for the two of us. Is that too much?" → read as four stays "you said", party
  2 adults from the words (no question asked), verdict "Doable but full", findings with figures
  (3 hotel moves, Sapporo 1 night, Osaka → Sapporo is a 1,059 km flight, beds cost 13 % of the
  trip). Nothing changed without consent; "add 1 night" offered. Built trip: all four stays
  honoured, reopened identically. Screens: `eval/live3/screens/`.
- Offline (`e2e/stated-plan.spec.ts`): "3 nights in Rome, 2 nights in Florence" survives parse,
  proposal, creation, scan, planner, save, reopen and the printed guide; major changes need a tick
  and untick exactly.

## 6. Screenshots

Before/after of the trip page (overview, day, map, bookings at desktop/tablet/mobile):
`docs/final-completion/screens/{before,after}/` (gitignored PNGs on disk). Live screens per
scenario: `docs/final-completion/eval/live*/screens/`.

## 7. PDF guides

`docs/final-completion/eval/live*/pdf/<scenario>-{compact,complete}.pdf` (gitignored, on disk).
Read: Tokyo–Kyoto compact (Japanese venue names render, times "local GMT+9, Asia/Tokyo", clean
page breaks), Tanzania complete. Defects found in the read and fixed: "Driving 12 km" on a train
trip, a mid-word cut, "on foot" beside a bus, Tokyo hops as buses.

## 8. Objective quality metrics

See §4: hard failures, coverage, impossible legs (0 everywhere), walking-pace measured rides
(0 everywhere), longest day, bases, lodging. Per-row JSON: `eval/live*/grades.json`.

## 9. Feature matrix

`docs/final-completion/FEATURE-MATRIX.md`.

## 10. Remaining issues

**P0** — none known blocking a web beta on staging.

**P1**
- Islands off a national rail network (Madeira, Azores, Canaries) still inherit the country's rail facts: add ISO 3166-2 network rows and carry the scope's region code to the planner.
- Kumano follows the trail with two bases now, but one day still reads as a drive to the shrines; trail-following is not yet consistent run to run.
- A city food trip gets a rental car when the interview's default says the traveller will drive (Oaxaca): the arrangement should prefer no car when the destination is urban and walkable.
- "Help me choose" family retreat: the advisor's pick (Tenerife) matched 1/4 of the expected experiences.
- Daily-limit choices are recorded and stated, but no control applies them yet.
- Mode 3 does not offer a tick-able "make Sapporo a 2-night stay or cut it" proposal when every night was stated; it offers "add a night".
- Real Google sign-in, revocation and session persistence were not exercised by this pass (needs the owner's Google account); the fixture sign-in paths and share/revoke specs pass.
- Legal pages are marked draft; owner/legal review needed before public launch.
- Production needs a paid or self-hosted router (ORS free quota) and a licensed or self-hosted geocoder; SQLite on one volume is single-instance.

**P2**
- A source row can mislocate lodging (a Japanese Alps hut listed in central Tokyo).
- React hydration warning #418 unlocated; mobile LCP ~3.5 s; phone map pins at the frame edge clip.
- `board-integrity` "hide every place" spec is timing-sensitive.
- Native iOS/Android apps are not built (PWA only) — see the matrix's concrete path.

## 11. Beta readiness verdict

**Ready for a staged web beta with known P1 limits; not ready for a public launch.** Evidence:
the final code passes every automated gate; thirteen live journeys on real providers built and
printed, with zero impossible legs and zero walking-pace "measured" rides; the routing-failure,
quota and destination-resolution failure modes found in eval-v3 and in this pass's live runs are
fixed and covered by tests; Mode 3 preserves a traveller's own plan live. Public launch needs the
P1 list above — chiefly production routing/geocoding capacity, the Postgres move, legal review,
and the island-transport and trail-consistency fixes. Native apps are a separate deliverable.

## 12. Deployed commit and git status

- Staging `https://sidequestweb-staging.up.railway.app` was confirmed (Railway deployment list, `SUCCESS`) on `7324cec`, whose application code is identical to `0704faa`, the last code commit that passed the full gate (9,738 unit tests, typecheck, lint, build, 48 desktop + 12 mobile browser tests). The commit adding this section is documentation only.
- Branch `feat/trip-experience-release-pass`, pushed to `origin`; `main` untouched. Untracked: earlier eval runs' screenshots/PDFs under `docs/experience-transformation/` and this pass's `docs/final-completion/eval/live*/{screens,pdf}` (gitignored images and PDFs kept on disk).
