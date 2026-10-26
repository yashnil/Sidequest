# Creative reinvention — task ledger (2026-10-25)

Direction: **Survey Atlas** (`DIRECTION.md`). Everything uncommitted on `main`.

| # | Milestone | State | Evidence |
|---|---|---|---|
| 1 | Reference research | done | `research/references.md`, 55 shots in `research/shots/` |
| 2 | Creative prototypes (3 concepts, real Lisbon data) | done | `prototypes/{a-living-atlas,b-folio,c-survey}.html`, shots `prototypes/shots/{a,b,c}` |
| 3 | Design-system selection | done | `DIRECTION.md`; primitives in `app/globals.css` (Survey Atlas block) |
| 4 | Maps: own cartography + interactive atlas | done | `components/atlas/` (style, `AtlasMap`, model + tests); default trip basemap `sidequest:survey` |
| 5 | Discovery Board rebuilt (stage map + specimen register + prints) | done | `DiscoveryBoardView.tsx`, `board/BoardStage.tsx`; `rounds/r4`, `r5` |
| 6 | Itinerary rebuilt (cover, journey days, route thread, map view, phone map sheet, signature spread) | done | `ItineraryView.tsx`, `hub/{CoverStage,DayFocus,DayMapSheet,MapWorkspace,SignatureExperiences,AtlasBand,DayRail}.tsx`; `rounds/r2`–`r6` |
| 7 | Onboarding rebuilt (one question per screen, live map context) | done (agent) | `rounds/onboarding/{before,r1,r2,r3}` |
| 8 | Home, scan screen, saved trips | done (agents) | `rounds/collection/`, `rounds/collection-2/` |
| 9 | Real photography on boards (Commons thumbnail host fix, logo rule, pacing, scan carries Wikidata ids) | done | gate + repository tests |
| 10 | Lisbon/Lisboa disambiguation | done (agent) | `semantics-corpus.test.ts` Lisbon block |
| 11 | Responsive + a11y checks | done | 390px overflow checks; dialog focus + Escape; pins are buttons; reduced-motion replay |
| 12 | Full regression (vitest, build, Playwright desktop + mobile) | pending | |
| 13 | Final critique + before/after | pending | |
| 14 | Journey Explorer (2D/3D, scales, shared selection, Replay My Day) | done | `lib/journey/`, `components/journey/`; `journeys/` |
| 15 | Real interactive-map test config with controlled tiles | done | `playwright.maps.config.ts`, `e2e/maps/` (fallback suite kept) |
| 16 | Plan / Book / Prepare restructure | done (agent) | `hub/views/`; `rounds/hub-views/` |
| 17 | Grounded open-data descriptions + ambiguity | done (agent) | `open-data-description.ts`, `wikidata-details.ts`, semantics corpus |
| 18 | Real journeys (Lisbon, Reykjavík, Japan, Switzerland, Lisbon+Azores, Iceland) | done; Iceland country board still fails without the model | REPORT "Real journeys" |
