# Sidequest — working rules

Sidequest composes a complete trip with a frontier model, then verifies, corrects, enriches and presents it. Product requirements live in `.claude-private/SIDEQUEST-PRODUCT-COMPLETION.md`; execution state in `.claude-private/SIDEQUEST-PRODUCT-CHECKLIST.md`; history in `.claude-private/PROGRESS.md`.

## Architecture rules

- **The model draft is the canonical itinerary content.** `apps/web/src/lib/planning/production-plan.ts#generateSidequestPlanForTrip` is the one normal generation path (Build my trip, Plan with smart defaults, Rebuild, Regenerate). Never route a user CTA through `build.ts#buildItinerary` — it is kept only for edit context and regression.
- **Research is optional, never a gate (Quality V1, `.claude-private/SIDEQUEST-QUALITY-V1.md`).** The normal flow is composer (where / when / who / anything fixed) → destination resolution → ONE adaptive interview → review → Build my trip. Compilation ("Explore experiences first" → Discovery Board) is a secondary path behind `SIDEQUEST_RESEARCH_PROVIDER`; composition needs only `ANTHROPIC_API_KEY` (or the fixture composer) and verification uses `planning/verification-providers.ts` (geocoder + router, never the research model). Nothing on the normal path may consult `SIDEQUEST_RESEARCH_PROVIDER`, and no environment-variable copy may reach a traveller.
- **The composition call reads one TravelerBrief.** `packages/core/src/interview/brief.ts#buildTravelerBrief` renders the profile, trip facts, bookings and board signals as sectioned XML with hard rules first and Sidequest's assumptions marked `[assumed]`; `composition.ts` holds the stable system prompt (role, quality contract, five behavioural examples, output contract). Every impact-bearing interview field must change the brief or be listed in `brief.test.ts` as not for composition.
- **Every build carries its own audit.** `planning/preservation.ts` (every draft anchor's fate; silent loss must be 0) and `planning/quality-audit.ts` (deterministic structural checks, never a taste oracle, never deletes) run on every generation and persist on `itinerary.package`. Generation budget: 120 s product, model deadline 100 s, verification gets the remainder and returns DEGRADED COMPLETE rather than waiting.
- **Evidence verifies; it is never a world allow-list.** The composition call (`composition.ts`) receives traveller and trip context only — never the POI catalog, coordinates, hours, provenance or matrices. The reconciler (`reconcile.ts`) resolves only what the draft references.
- **Unknown ≠ false.** Missing geocoder, routing, hours or weather evidence lowers confidence (`partially_verified`/`unverified`, `unmeasured` legs) and never removes content. Only affirmative evidence corrects, with the smallest change.
- **No silent model-anchor loss.** Every draft anchor ends in exactly one `AnchorDispositionCode` on `itinerary.package.anchors`, and every non-scheduled one is explained on `itinerary.unscheduled`.
- **One model call per generation.** No automatic retries, no repair model, no evaluator model. `skeleton-repair*.ts` stay unwired.
- **Live World V1 (`.claude-private/SIDEQUEST-LIVE-WORLD-V1.md`).** One capability registry (`apps/web/src/lib/providers/capabilities.mjs`, import-free, shared with `npm run doctor`) says what is real, fixture or off. Place resolution order: persisted identity → board → compiled → places provider → geocoder → unresolved; provider refs persist on `package.anchors[].identity`. Valhalla is the routing backbone; Google Routes/traffic/transit are explicit opt-ins (`SIDEQUEST_ROUTES_PROVIDER=google`, `SIDEQUEST_TRAFFIC_PROVIDER=google`, `SIDEQUEST_TRANSIT_PROVIDER=google`) because `.claude-private/BLOCKER-google-terms.md` forbids persisting Google durations, polylines and business names — Google display names are matched, never stored. Every measured leg carries `basis` (static / traffic_aware / scheduled / estimated), `provider`, `measuredAt` and, when a direct route answered, an encoded `geometry`; nothing static is ever called live. Booked facts enter the composition task before the one model call and are verified deterministically after. Day edits (move, reorder, duration, custom stop, must-keep) and "Fix this day" are local and never re-measure a leg silently (`not_remeasured_after_edit`). Discovery (stays, food) is a traveller-pressed server action for display only; live room prices and availability are never shown. Renders never call a provider.
- **Travel intelligence is deterministic and provider-free.** `apps/web/src/lib/intelligence/build.ts#buildTravelIntelligence` is a pure function of the persisted itinerary, draft, profile, booked items and readiness profile; it never calls a model or a provider. Booked facts (`booked-reconcile.ts#applyBookedFacts`) are applied over the pristine itinerary at load time and are never moved by the planner. Rules: unknown ≠ false, missing ≠ contradicted, stale ≠ current, model knowledge ≠ current legal fact, provider failure ≠ physical impossibility. Only `official_current` sources may confirm entry/visa/health/advisory claims (`packages/core/src/intelligence/claims.ts#CONFIRMING_AUTHORITY`). Static road routing is never labelled live traffic; a flight, ferry or guide transfer the router cannot route is plausible, never impossible. Spec: `.claude-private/SIDEQUEST-TRAVEL-INTELLIGENCE-V1.md`.

## Development rules

- Debug with saved fixtures, never paid calls: `SIDEQUEST_COMPOSER_PROVIDER=fixture`, `SIDEQUEST_COMPILER_PROVIDER=fixture`, the saved Iceland replay under `apps/web/src/lib/planning/acceptance/fixtures/iceland/`. Today mode on a fixed clock: `SIDEQUEST_FIXTURE_NOW=<ISO>` (honoured only with the fixture composer; `npx playwright test -c playwright.today.config.ts`). Live acceptance artifacts and the browser walker live under `.claude-private/artifacts/quality-v1/`; `apps/web/scripts/direct-baseline.mjs` and `dump-trip.mjs` are the two dev tools for a live comparison.
- Never broad-`pkill`. Never commit, push, deploy or merge unless explicitly asked.
- Keep `apps/web/src/lib/providers/switches.ts` import-free.

## Verification commands

```
npm run typecheck
npm run lint
npm run test                       # full vitest
npx vitest run apps/web/src/lib/planning   # composition, reconciler, acceptance shapes, Iceland replay, product flow
npm run build
npx playwright test e2e/canonical-plan.spec.ts e2e/itinerary.spec.ts e2e/trip-hub.spec.ts e2e/live-world.spec.ts --project=desktop
npx playwright test -c playwright.today.config.ts   # Today mode on the fixture clock
git diff --check
```
