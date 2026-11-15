# Final completion pass — what changed and how it was verified

Started from `f698960` (the build staging runs). Every item below is code on
`feat/trip-experience-release-pass`, each with tests. Nothing was pushed, so
staging still runs `f698960`.

| Commit | Change | Why (evidence) |
|---|---|---|
| `64b0039` | openrouteservice quota breaker (429 / quota 403 / `x-ratelimit-remaining: 0` hold the service shut until its announced reset; nothing is sent meanwhile). When a router was asked and mostly went quiet, the planner's plan ships instead of an unbound model composition; `package.planning.routing` records it and the overview says the times are estimates. | eval v3: quota exhausted → Tanzania fell back to composition, Zanzibar added, Serengeti days empty |
| `7f4334d` | Learned taste (post-trip feedback, refinements) fills interests the traveller left unstated, inside `boardFor`, so the board, Auto-pick and the planner rank with it. An answer given for this trip always wins. | The ledger fed only the model brief, which planner builds never read |
| `8a4f5b1` | Coordinate → IANA zone from the published boundaries (`@photostructure/tz-lookup`, CC0, offline) for sky timing, scan bases, forecast points, trail dusk, the destination envelope, calendar zones and booked places. A carried zone is a fallback and must fit the longitude. | eval v3: US default zone on Kauai → midnight sunsets; the guard only blanked the sky and the ICS kept the wrong zone |
| `8dc1595`, `a6f5f26` | A base placed far outside the trip's own footprint is unplaced with a reason (`scan/base-footprint.ts`); move-day backtracks are detected and corrected before legs are built, and a move-first day with a stop near the old base is no longer laid out move-first. | eval v3: "Tarangire area lodges" in Dar es Salaam; Kyrgyzstan Bishkek → Song-Kol → back to Osh Bazaar. The rule also catches a recorded Highlands base geocoded near Sheffield |
| `8c98b8b`, `df9ffb5` | Mode 3, "I already have a plan" (`/improve`): deterministic parse and critique (pace, hotel moves, route order, transport realism by country facts, labelled estimates), then "Plan this" creates an ordinary trip. Zero model calls. | The original spec's third entry mode did not exist |
| `5def1ba` | ESLint ignores agent worktrees | `npm run lint` failed whenever a worktree existed |

## Verification (on `df9ffb5`)

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run lint` | 0 errors, 150 warnings (pre-existing) |
| `npm run test` (on `a6f5f26`, before Mode 3) | 9,611 passed, 1 skipped, 0 failed |
| Mode 3 unit tests | 46 passed |
| `npm run build` | passes; `/improve` built |
| Desktop: canonical-plan, itinerary, trip-hub, live-world, plan-check, composer | 40 passed |
| Mobile: plan-check, composer, itinerary | 24 passed |
| Today mode (fixture clock) | 4 passed |

Not run in this pass: the full desktop/mobile browser suites, live staging scenarios (no push, so staging has none of this), and any live re-run of the eval-v3 scenarios. The degraded-routing and base-footprint fixes are proven by unit tests on synthetic and recorded data, not by a new live run.

## Still open

See `FEATURE-MATRIX.md` (states and external dependencies) and the eval-v3 report's unresolved list. The main remaining items: over-long trail stages with no bed on the way are flagged rather than split; days over a traveller's limit are stated rather than always repaired; native apps are a separate deliverable; production routing and geocoding need a paid plan or self-hosting.
