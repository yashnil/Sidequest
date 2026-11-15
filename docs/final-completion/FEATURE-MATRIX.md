# Sidequest — feature matrix against the original specification

Source of truth for "what the product does", reconciled against `sidequest_master_prompt.md`
(§4, §6–9, §20, §25–26) and the code on `feat/trip-experience-release-pass`. States:

- **Verified** — working, with unit tests and a browser spec or a recorded live run
- **Limited** — working, with an explicit, stated limit
- **Unverified** — implemented, with no test aimed at it
- **Missing** — not built
- **External** — blocked by a dependency outside the code (credential, service, decision)

| Capability | State | Evidence | Limit / gap |
|---|---|---|---|
| Mode 1 — I know where I want to go | Verified | `app/(product)/page.tsx`, `trips/new/`, `e2e/composer.spec.ts`, `e2e/intake.spec.ts` | — |
| Mode 2 — help me choose | Limited | `decide/advisor-actions.ts`, `packages/atlas` (~36.8k destinations), `e2e/decide.spec.ts`, benchmark harness | Niche requests can rank weak estimators; question selection is CPU-heavy (~100 ms/step) |
| Mode 3 — optimise my existing plan | Limited (final pass) | `/improve`, `packages/core/src/plan-check/{parse,critique}.ts`, `lib/plan-check/resolve.ts`, `e2e/plan-check.spec.ts` | Deterministic, zero model calls; per-place nights do not yet carry into the built trip (no contract field), party defaults to two adults |
| Natural-language input | Verified | `lib/destinations/interpretation.ts`, `advisor/parse.ts`, `e2e/destination-semantics.spec.ts` | — |
| Adaptive questionnaire | Verified | `trips/[id]/questionnaire`, `advisor/interview-policy.ts`, `e2e/interview*.spec.ts` | — |
| Persistent traveller profile | Limited | `(product)/profile/actions.ts`, `e2e/accounts.spec.ts` | No spec aimed at the profile page itself |
| Party, diet, accessibility | Limited | `trips/[id]/party`, `packages/core/src/party/traveler.ts`, brief `<party>` | Days over a traveller's limit are stated, not always repaired (eval v3) |
| Discovery scan | Limited | `lib/discovery-scan/run.ts`, open-data fallback, `e2e/discovery-scan.spec.ts` | Model proposal varies run to run; open-data fallback needs `SIDEQUEST_POI_PROVIDER=overpass` |
| Discovery Board, Auto-pick, hide, must-do | Limited | `planner-autopick.ts`, `e2e/must-do.spec.ts`, `e2e/board-integrity.spec.ts` | "Hide every place" spec is intermittent (races the background compile) |
| Itinerary generation (planner-first) | Verified | `structure-planner.ts`, `production-plan.ts`, `e2e/itinerary.spec.ts`, `e2e/build-lifecycle.spec.ts` | — |
| Degraded routing keeps the trip | Verified (final pass) | `providers/openrouteservice.ts` quota breaker, `planning/routing-evidence.ts`, `package.planning.routing` | A thin board still uses the labelled model fallback |
| Route order and topology | Limited | `route/spatial-order.ts` (incl. move-day backtracks, final pass), `travel/feasibility.ts` | A point no router reaches stays a labelled straight-line estimate |
| Bases and stays | Limited | `scan/stay-objective.ts`, `scan/base-footprint.ts` (final pass) | A town keeps one base by archetype even at a region's edge |
| Trails and treks | Limited | `scan/trail-stages.ts`, `discovery-scan/trail-measure.ts` | An over-long stage with no bed on the way is flagged, not split |
| Time zones | Verified (final pass) | `packages/core/src/time/zone-lookup.ts` (IANA boundaries), sky timing, ICS | Within-day calendar items use the day's base zone |
| Meals | Limited | `food/meal-rank.ts`, `e2e/food.spec.ts` | Restaurant hours are rarely known and never implied |
| Weather and seasonality | Limited | `e2e/weather.spec.ts`, BEST_TIME, `atlas/seasonality.ts` | Forecast only inside the horizon; climate normals beyond |
| Safety and advisories | Limited | advisory freshness, `access/constraints.ts`, fixture access data per country | Access data covers the countries with fixture rows |
| Budget | Limited | `packages/core/src/intelligence/budget.ts` (booked / derived / style-band / unknown; per person; includes/excludes) | Price evidence is thin; ranges, never quotes |
| Lodging suggestions | Limited | `itinerary/lodging-actions.ts` | No live prices or availability (by design) |
| Booking guidance | Limited | booking links, `booking-ownership.test.ts`, staging spec | Links and checklists only; no transactions |
| Editing, undo, versions | Verified | `e2e/plan-edit.spec.ts`, `e2e/plan-versions.spec.ts`, staging spec | — |
| Save, reopen, share | Verified | `share-actions.ts`, `e2e/share.spec.ts`, `share-privacy.test.ts` | — |
| Prepare and packing | Verified | `trips/[id]/pack`, `e2e/v9-pack.spec.ts` | — |
| Maps | Limited | `e2e/maps/`, `e2e/map-itinerary.spec.ts` | Parks keep circular extents |
| Today mode | Verified | `e2e/v9-today.spec.ts` on a fixture clock | Verified only on a fixture clock |
| Calendar (ICS, feed) | Verified | `execution/calendar-events.ts`, TZID/VTIMEZONE, staging spec | — |
| PDF (compact and complete) | External | `(print)/trips/[id]/guide`, `services/pdf-renderer`, staging runs | Needs the renderer service and `RENDERER_SECRET` |
| Responsive web | Verified | `e2e/viewports.spec.ts`, desktop/mobile/tablet suites | Mobile LCP ~3.5 s; hydration warning #418 not located |
| PWA installability and offline | Limited | `app/manifest.ts`, `public/trip-offline-sw.js`, `e2e/v9-cross-device.spec.ts` | No real-device install test |
| Native iOS / Android apps | Missing | no `apps/mobile` | Future deliverable — path below |
| Feedback-based learning | Limited (final pass) | `preference/apply.ts`, `region.ts#boardFor` | Learned taste fills unstated interests only; no learned ranking model |
| Data layer | External | `lib/db/client.ts` (SQLite) | Supabase/Postgres move not made; single-instance deployment |
| Accounts and auth | External | `api/auth/google/*` | Google OAuth only; needs Google credentials per deployment |

## Native apps — the concrete path (not in this release)

The original specification asks for iOS and Android apps. Shipping a half-built native shell
would be worse than an excellent installable web app, so this release ships the PWA and the
native apps are a separate deliverable:

1. `apps/mobile` — Expo (Expo Router), consuming `packages/core` for schemas, formatting and
   the execution state graph (already pure and provider-free).
2. A read API over the existing server: `GET /api/trips/:id` (itinerary + package), the
   calendar feed and the offline snapshot already exist as server routes; add token auth for
   a device session (`auth_sessions` already models sessions).
3. First screens: trip list, Today (the state graph's day), day timeline, map (react-native-maps
   or MapLibre Native), Pack checklist; planning stays on the web.
4. Offline: persist the same snapshot the service worker caches (`OfflineSnapshot`) with
   `expo-file-system`.
5. EAS builds for both stores; push notifications later through the recheck observations.

## External dependencies to release

- Production routing: openrouteservice's public API has a daily quota; production scale needs a
  paid ORS plan or a self-hosted router (Valhalla is already the backbone inside its coverage).
- Geocoding: public Nominatim (1 request/s, cached) is fine for evaluation; production needs a
  self-hosted or licensed geocoder.
- PDF renderer service and its secret on each environment.
- Google OAuth credentials per environment.
