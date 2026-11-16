# Surgical audit and repair — 2026-11-16

**Verdict:** **not yet beta-clean by the stated criteria.**

- One narrow beta-blocking class remains: a **move-day "train" between towns where one end has no railway** (Fes → Chefchaouen). It is labelled an estimate, but it is still an invented service.
- Everything else on the beta-blocking list is fixed or was not found.
- A **small invited beta is reasonable** once three owner actions are done (volume backups, a real Google sign-in, a decision on Railway config-as-code before 2026-12-01) and the owner either accepts that known issue for testers or waits for the station-data fix.
- **Not public-launch ready.** See §10.

## 1. Commits

| | |
|---|---|
| Branch | `feat/trip-experience-release-pass` (`main` and production untouched) |
| Start | `9929564`. Staging was running `6352fd5`, the same code; `9929564` only adds documents. |
| End | `00af94b` (code), pushed with this report. Staging deploy is recorded in §7. |
| This pass | 21 code commits plus this report: about 60 files changed and 1,900 lines added, plus two binary data files. |

## 2. Defects found, root causes and fixes

| Sev | Defect (as seen) | General root cause | Fix (commit) | Unseen analog tests |
|---|---|---|---|---|
| **P1** (was P2) | "Drive to Mykines, ≈45 min": an island reached by boat, shown as a timed drive | When no router measured a leg, Sidequest estimated it from straight-line distance. A straight line knows nothing about the sea. | Two offline indexes built by `packages/atlas/build/10-water.py`: OSM coastline land polygons (ODbL, kept as its own file and joined only in memory) and HydroLAKES ≥20 km² (CC BY 4.0). `travel/water.ts#assessCrossing` returns `separate_land`, `water_between`, `land` or `unknown`. If an unmeasured leg runs **between landmasses**, it becomes "Crossing to X", `water_crossing`, `other_mode_required`, with a stated allowance. If an unmeasured leg on **one landmass** runs mostly over water, it keeps a labelled estimate raised for the road around. A router's measurement always wins (bridges and car ferries are roads to a router). Applied in both the scan matrix (planner) and the reconciler (traveller-facing legs). (`bd47977`, `0476e50`) | Naxos→Paros, Oban→Mull, Copenhagen→Malmö (bridge = still two landmasses, so it needs a router), Split→Hvar (harbour pin offshore), Lofoten→Bodø, Naples→Capri, Maui→Lānaʻi; Lake Geneva, Ometepe (lake island), Sognefjord, Sorrento→Pompeii (bay); controls: Zürich→Lucerne, Chamonix→Courmayeur (mountain, not water), Oʻahu end to end, Lisbon→Cascais, a point far out at sea gives `unknown` |
| **P1** (was P2) | Tanzania safari "built around markets and hot springs"; Serengeti missing | (a) Activities whose locality said "Central Serengeti" were placed at tour offices in Arusha, 250 km away. With the park base lost to the geocoder, nothing judged them, and the stays "reached" the Serengeti from town. (b) The traveller never ticked *wildlife*, so the default frequency cap allowed **one** wildlife stop on a safari. | (a) `withdrawLocalityOutliers`: candidates whose localities share a distinctive word must land together. A stray beyond max(80 km, 1.5× the radius holding two-thirds of the group around its medoid), and farther than 80 km from every core member, is unplaced. Its position is withdrawn; the place is not deleted. (b) Essentials (the contract's bounded handful) are held back only by an interest the traveller asked to **avoid**. (`355cb72`) | Recorded Tanzania scan (Arusha offices and a Moshi "Ngorongoro" village withdrawn; Grumeti, the park's far west, kept); Etosha night drive placed in Windhoek; controls: Kyoto, the far end of a Lofoten route, a split group, generic words |
| **P1** (was P2) | "Old towns by train" (advisor) → 10 nights in one Fes riad, no train | 48 curated regions resolve as one of their own towns (`resolveAs: 'Fes, Morocco'` for "Fes & Chefchaouen", Kyoto for "Kyoto & Nara", Ella for "Sri Lanka Hill Country"). Planning received a single city and built an urban single-base trip. | `advisor/adoption.ts#adoptionPhrase`: such a region is planned as its own places ("Fes, Chefchaouen and Meknes, Morocco"), the and-list-in-a-container shape the intent graph already reads as parts. Regions that resolve as themselves, cities, and countries the reference does not know are unchanged. The closing container country no longer joins the extent union (it framed the towns at country scale; "Tokyo and Kyoto, Japan" had the same bug). (`56133a2`) | Every changed curated phrase parses into ≥2 towns inside one country (test over the whole catalog) |
| P2 | Tour du Mont Blanc plan walked 3 of the 6 stages found and read as the trek | Nothing said which section the plan walks | `trailScope`: day 1 states "walks the trail from A to B: n of the m stages found…"; a section left partly unwalked is a `trail_section` contract violation shown under "what this plan still lacks". (`26a02cd`) | Unseen-name circuit, closed loop, a stage covered by bus, a point-to-point trail walked in full (no circuit claim) |
| P2 | The advisor card said "no car needed"; the trip booked a hire car (family retreat) | The card's structured `access.car` never left the advisor, so the transport question used its generic default. **Not** the harness: it pressed "smart defaults" and never chose to drive. | The pick carries `carNeed`. Adoption stores it as `advisorCarNeed`: Sidequest's assessment, never the traveller's answer. It is the transport question's destination prior; the traveller's own choice still replaces it. (`84e4d02`) | Interview test with signals only |
| P2 | Car-free trail legs printed "45 min drive · 52 km" (Kumano) | Default leg mode read the traveller's `willDrive`, not the trip's ground arrangement | On a trip whose ground is transit, taxi or none, a road leg becomes taxi/rideshare; the figure is unchanged. (`0d0a388`) | Fictional valley with a driver party on a car-free trip; the test fails without the fix |
| P2 | Removing a booking took one tap, gave no confirmation and swallowed errors; "Applied." shown for a refused change; packing ticks not rolled back; inline booking cost stored as silent USD | Optimistic UI without reconciliation | Second-press confirm and error message; Ask Sidequest card reopens on refusal or throw; tick rollback; currency field required, save on blur. (`42d4284`) | Hub component tests |
| P2 (sec) | PDF route: cache key included the live clock (every request rendered), no rate fence | `generatedAt` was hashed into the key | Key on content; `guide_pdf` fence charged only on a miss. (`4a6039b`) | net/guide tests |
| P2 (sec) | Destination interpreter (a billed model call) was charged to one literal key shared by every anonymous caller | `dailySpendGate(now, 'destination_interpretation')` | Charged to `callerKey()`, plus the hourly billed fence, only when a real call is made. (`4a6039b`) | |
| P3 (sec) | `SIDEQUEST_ACTION_FENCES=off` honoured in any environment | | Under `next start` it is honoured only when the server's own base URL is loopback. (`4a6039b`) | |
| **P1** (new) | TMB lost every Swiss and Italian stage and bed: `country_mismatch` (found in this pass's live run) | The trail resolved as one point in one country. Every placement call gated on that single country and asked the geocoder for "Rifugio Bonatti, …, France". | `countryBelongs`; one `placementCountry` rule feeds every placement in a scan. A trail or route drops the single-country gate and suffix (the distance gate still holds); other trips accept every country the concept spans. (`0244260`, `543d505`, `a26a4b1`) | Three-country trail, a single-country refusal, rows without a country |
| **P1** (new) | Cyclades: "≈55 min train" and metro on Naxos and Santorini | Three separate paths: (a) the country's intercity-rail fact applied to a small island; (b) the interpreter's towns (Naxos, Mykonos) counted as "metro areas"; (c) an island read at settlement scale counted as a city. | (a) `onSmallIsland` (land index, under 1,000 km²) removes intercity rail on the planner's legs and moves, and the reconciler refuses an unconfirmed rail hint. (b) A metro area must be a city the traveller's own phrase named. (c) City-scale metro needs an urban concept type. (`5a21449`, `c6ad697`, `9105077`, `f89e1c1`) | Naxos, Malta, Paros (vs mainland Greece, Sardinia); Tokyo and Kyoto vs Cyclades parts; an island at settlement scale. Two tests fail without their fix. |
| **P1** (introduced and caught in this pass) | A screenshot of the live Faroe run showed "≈30 min drive" from Sandoy to Hestur, drawn across the sea | **My first land index** toggled the component edge by edge in storage order rather than along the ray, so a cell holding two islands' edges could answer backwards | Parity per polygon. Checked against shapely on 3,000 random points in the Faroes, Aegean, Lofoten, Croatia and the Philippines: **3,000/3,000 land or water, 776/776 same polygon**. (`cfcb914`) | Sandoy → Hestur regression |
| P2 (new) | Operator safari move days printed "bus" (Tanzania, Botswana) | Car-free move fell through to the public-network default | `carFreeMoveHow`: an operator trip's move is the operator transfer. (`46146a5`) | Pure test |
| **P1** (new) | Advisor trips failed `destination_unplaced: no destination centre` | The plan screen's client resolves the destination. Leaving it early (a multi-part phrase takes several geocoder calls) reached a scan with no centre. | Both scan doors resolve on demand, once, behind the same fence. (`83b7fa8`) | Live: the advisor rail trip went from failing to planned |
| **Ops** | Railway skipped every push that touched only `packages/**` | The **service-instance** watch paths in Railway were `["/apps/web/**"]` and override `railway.json` | Staging instance watch paths set to the `railway.json` list via the API; the previous value is recorded here for rollback. Proof: the packages-only commit `bd47977` deployed **SUCCESS**. | — |

**No destination-specific planning logic was introduced.** No new rule reads a place name. The water indexes are sourced, rebuildable data. Locality consensus compares words *between candidates*. The adoption phrase reads the pick's own `bases`. Check: `git diff 9929564..HEAD -- '*.ts' ':!*.test.ts' | grep -iE "mykines|serengeti|atitl|mont blanc|kumano|fes\b|faroe"` matches only comments that describe the reported regression.

## 3. Found and not fixed (honest list)

| Sev | Issue | Why not fixed now |
|---|---|---|
| **Blocker (ops)** | **Neither the staging nor the production volume has any backup or backup schedule.** Railway API: `volumeInstanceBackupList: []`, `volumeInstanceBackupScheduleList: []` for both. | Changes production configuration and adds billed storage, so it needs the owner. Tested scripts exist (`apps/web/scripts/backup-db.mjs`, `restore-db.mjs`, `docs/DEPLOYMENT.md#backup-and-restore`). |
| **Blocker (ops, dated)** | Railway CLI: "Config as Code (railway.json) is deprecated … Existing files keep working until **2026-12-01**." | Migration (`railway config migrate`) affects production; owner decision. Until then the service-instance watch paths (now fixed on staging) carry the behaviour. **Production's instance watch paths were not changed.** |
| **P2 (invented service)** | A car-free move between towns in a rail country is called a train even where one end has no station: Fes → Chefchaouen "≈3 hr train" (CTM buses serve Chefchaouen). The same class covers a "train" in the Swiss Val Ferret. | Fixing it needs railway-station evidence per town (OSM stations or Wikidata), a data task this pass did not take on. Until then, rail on a move day is a country fact, not a station fact. **Share with beta testers.** |
| P2 | "Island hopping" can come back as one base with day crossings (Cyclades), and a trail is still walked as a section when the stays prefer sightseeing days. | Stay-objective tuning: the plan is honest about it, but it is not the best reading of the request. |
| P2 | The board's headline interests ("built around scenic viewpoints…") come from the picks, not the trip's purpose (a safari headline without "wildlife"). | Wording; low risk. |
| P2 | The bundled country reference has 69 countries. Typed "X, Albania" (or Belize, Georgia, Laos…) treats the country as a named place, and the advisor adoption fix stays off for those countries. | The facts table carries currency, plugs and emergency numbers per country. Adding about 130 rows correctly is its own data task. |
| P2 | A narrow fjord or strait below the simplified coastline (Geirangerfjord, about 1 km) reads as land. | Resolution limit of the simplified OSM land layer. A router still speaks for any measured pair. |
| P2 | An untimed boat crossing is stated plainly ("Crossing to X … check the ferry, boat or bridge") but is not a traveller to-do on Prepare. | Existing doctrine: an untimeable mode is Sidequest's gap, never a task. Worth an owner decision. |
| P3 | Short city hops worded "train" (Kyoto). Weak third advisor pick (Lagos City). | Low impact; not reached. |
| P3 (sec) | On a shared browser, signing in or out does not rotate the guest cookie, and a previous auth session row stays valid for 90 days. Unclaimed trips stay with the browser. | Design trade-off in `trip-access.ts`; owner decision. |
| P3 (sec) | `/api/readiness` is public (lists provider names and fixture switches); there is no fence on weather refresh, image fill or calendar-feed creation. | Owner-only or low cost; noted. |
| Info | Production has no PDF renderer configured. "Get the PDF" falls back to the browser print layout, and a `download` link may save the redirect's HTML. | Owner adds the renderer service and secret to production. |

## 4. Tests on the final code

| Gate | Result |
|---|---|
| Unit (vitest, full), on final `00af94b` | 689 files: **9,885 passed**, 1 skipped, 0 failed |
| Typecheck (workspace) | clean. It caught an invalid entity type in one of this pass's tests, which vitest does not check; fixed in `00af94b`. |
| Lint | 0 errors (155 existing warnings) |
| Production build | OK |
| `git diff --check` | clean |
| Browser, desktop (full), on `f89e1c1` | **285 passed**, 2 skipped, 0 failed (38 min), including `board-integrity`. Also green earlier on `4a6039b`. |
| Browser, mobile (full), on `f89e1c1` | **277 passed**, 10 skipped, 0 failed (37 min) |
| Not run | Tablet project, `playwright.today.config.ts` and the degraded-provider config, as separate runs (Today mode and degraded-routing specs ran inside the desktop and mobile suites where they are part of them). The two commits after `f89e1c1` (`cfcb914`: water-index parity; `00af94b`: test type) are server logic and a test, covered by the unit run. |

## 5. Real-provider journeys

**How they ran.**

- **Staging:** one journey on `84e4d02`, before the per-caller daily model share stopped further runs from the evaluator's IP (§8).
- **Local:** the other journeys ran on a local production build (`next start` on port 4300) with the **real model, real geocoder and Google Places**, and **no router** (no openrouteservice key locally; the local router does not cover these areas). So every leg there is a labelled estimate. That is the hardest case for water and transport honesty, and it is weaker evidence for travel times.
- **Requirements:** written before any run (`eval/requirements-audit.json`, plus the beta files).
- **Records:** `eval/audit-live`, `audit-live-local` and `audit-live-local2`–`5` (`scenarios.ndjson` and screenshots).

| Journey (build) | Before this pass | Now | Still wrong |
|---|---|---|---|
| Family retreat via advisor, staging (`84e4d02`) | hire car after a card said "no car needed" | Lake Atitlán, **no hire car**, bus/walk legs | one base for 10 nights (fine for a retreat) |
| Tanzania safari (`4a6039b`) | Arusha + Karatu, no Serengeti, "built around markets" | **Serengeti central (Seronera) 3 nights** + Karatu 5; Serengeti game drive, Moru Kopjes, Ngorongoro Crater floor, Lake Manyara; misplaced "Serengeti" activities withdrawn | the move day said "bus" (fixed after this run in `46146a5`, not re-run live); headline interests chosen from the board, not the purpose |
| Faroe road trip (`4a6039b`) | "Drive to Mykines ≈45 min" | island-to-island moves read "Crossing to …"; 3 stays. **One leg, Sandoy → Hestur, was still a "≈30 min drive" across the sea**, caused by the index bug fixed in `cfcb914` (found from this run's screenshot; the corrected index now reads that pair as two landmasses; not re-run live) | with **no router**, the tunnel-linked islands read as crossings (1,764 of 2,070 cells). This is the intended behaviour, but conservative; a measuring router (staging has openrouteservice) replaces it |
| Tour du Mont Blanc (`c6ad697`) | 3 French stays, 3 stages, 4–5 idle nights, no word that it was partial | **6 stays across France, Italy and Switzerland** (Les Chapieux → Mottets → Courmayeur → Rifugio Bonatti → Champex-Lac → Trient), 5 stages walked inn to inn; day 1 says "5 of the 10 stages Sidequest found … a section of the trail, not all of it" | not the full loop in 10 days, and said so; some stage starts reached by long estimated bus legs; one "train" in Switzerland unverified |
| Old towns by train, advisor (`5a21449`) | 10 nights in one Fes riad | **"Fes, Chefchaouen and Meknes"**: Fez 6 nights + Chefchaouen 4 | the Fes → Chefchaouen move reads "≈3 hr train": **Chefchaouen has no railway** (open; needs station data, §3) |
| Cyclades island hopping, unseen (`f89e1c1`) | not run before. The first run of this pass printed "≈55 min train" on Naxos (metro and rail hints), fixed in 4 commits | **0 trains, 0 metro**; 8 "Crossing to …" legs for Mykonos and Paros; buses on Naxos | one Naxos base with day crossings is a thin reading of "island hopping"; Santorini absent in this run (model variance) |
| Botswana safari, unseen (`4a6039b`) | not run before | **Okavango Delta 4 → Khwai 2 → Chobe riverfront 2**; 4 of 4 defining (Okavango, Chobe, game drives in distinct parks, a pans/flight experience); no hire car; not town-built | one move read "bus" (same fix as Tanzania, `46146a5`) |

**Across these runs:**

- One timed drive between two landmasses: Faroe, Sandoy → Hestur, from the index bug now fixed and checked against ground truth.
- No hire car on an operator or no-car trip.
- No train or metro on a small island in the final Cyclades run.
- Every trip generated in planner mode (no model composition fallback).

## 6. Security and accounts

An independent read-only audit covered 31 server-action files and 14 route handlers. Its findings:

- **No critical or high finding.**
- Every trip-scoped action reaches `tripAccessRefusal`.
- OAuth checks state, uses PKCE S256, has a login-CSRF cookie and a same-origin `returnTo`.
- Guest claim is cookie-scoped and transactional.
- Export and deletion are owner-scoped.
- Share and feed surfaces strip private data.
- Cookies are HttpOnly, SameSite=Lax, and Secure in production.

The medium findings were fixed (§2). Both deployed environments set `SIDEQUEST_TRUSTED_PROXY_HOPS`, so per-caller fences do not fall back to the unsigned cookie.

**Real Google sign-in was not tested by me.** It needs the owner's account (`OWNER-ACCEPTANCE.md` A–F).

## 7. Railway staging

- **Root cause of the skipped deploys:** service-instance `watchPatterns = ["/apps/web/**"]`.
- **Fix:** watch paths set to `/apps/web/**, /packages/**, /package.json, /package-lock.json, /railway.json, /.nvmrc` on **staging only**. Rollback is to set them back to `["/apps/web/**"]`.
- **Verified:**
  - `bd47977` (packages-only) was BUILDING and then **SUCCESS**.
  - `84e4d02` was **SUCCESS**.
  - `5a21449`, `c6ad697` and `f89e1c1` were each **SUCCESS**; final deployment `1cb1713a` = `f89e1c1`.
  - Public pages `/`, `/decide`, `/improve`, `/signin`, `/privacy`, `/terms` return 200; `/api/health` is ok.
  - The production build logs "Land index loaded with lakes in ~115 ms".
  - The docs-only `9929564` stayed SKIPPED, as intended.

## 8. Providers and cost

- **Anthropic:**
  - Cap of 300 calls a day, with a per-caller share.
  - The share worked as designed during this pass: the evaluator's IP hit "your share of today's live research" on staging after one journey. The scan then failed honestly instead of silently falling back.
  - Caps were not raised. The remaining journeys ran on a local production build with the real model (§5).
- **Routing:** openrouteservice public API, with a quota breaker. Production scale needs a paid plan or a self-hosted router.
- **Geocoding:** public Nominatim, 1 request/s. Production needs a licensed or self-hosted geocoder.
- **New in this pass:** two offline datasets, about 17 MB committed, loaded once per process, no runtime network. Attribution was added to `/terms`.
- No new paid services.

## 9. Original specification, screenshots, PDFs

**Specification:** reconciled row by row in `FEATURE-MATRIX.md`, updated in this pass. Status by state:

- **Verified:** Modes 1 and 3, questionnaire, Discovery Board and auto-pick, planner generation, editing, undo, versions, sharing, calendar, Today on a fixture clock.
- **Limited, with stated limits:** Mode 2, transport per ground, routes, trails, meals, budget, lodging, maps, learning, PWA.
- **External:** PDF renderer in production, database scale, OAuth credentials.
- **Missing:** native iOS and Android apps. The PWA is not a native app; the path is in the matrix.

**Screenshots** of the changed behaviour, from the live runs (`docs/final-completion/eval/`):

- `audit-live-local/screens/faroe-roadtrip-days.jpg`: "Crossing to …" rows.
- `audit-live-local3/screens/point-to-point-trek-days.jpg`: three-country stays and the day-1 scope line.
- `audit-live-local/screens/tanzania-safari-overview.jpg`: Serengeti stays.
- `audit-live-local5/screens/cyclades-islands-days.jpg`: bus and crossing legs, no trains.
- `audit-live-local2/screens/advisor-history-rail-overview.jpg`: two stays.

**PDFs: not re-verified visually in this pass.** Staging's renderer could not be reached with a fresh trip once the evaluator's daily share ran out. Production has no renderer configured, and the local build falls back to the print page. The previous pass's Compact and Complete PDFs (HTTP 200, `docs/final-completion/eval/live*/pdf/`) predate these changes. The guide's cache key and fence changed (§2), not its layout.

## 10. Readiness by stage

| Stage | Verdict | Conditions |
|---|---|---|
| Private developer testing | Ready | — |
| Small invited beta (tens of people) | **Conditional** | (1) Railway volume backup schedule on production; (2) owner completes real Google sign-in (`OWNER-ACCEPTANCE.md`); (3) decide config-as-code before 2026-12-01 (or set production's instance watch paths); (4) accept, or fix first, the move-day rail claim between towns without a station (§3), the one remaining item in a beta-blocking class; other known issues in §3 shared with testers. |
| Larger invited beta (hundreds) | Not yet | Paid or self-hosted routing and geocoding; daily model cap sized for the cohort; restore drill done once on production; PDF renderer in production. |
| Public launch | **No** | All of the above, plus: country reference beyond 69, legal pages approved (drafts only), a native-app decision (none exists; the PWA is not a native app), and a load test of single-instance SQLite. |
