# Sidequest — creative reinvention, report (2026-10-25)

**Direction: Survey Atlas.** A trip is a survey of a place. Two grounds — survey paper with a hairline grid for reading and deciding, the night atlas for the place itself — and one vocabulary: numbered specimens shared by list and map, ruled rows instead of cards, mono margin figures and a live coordinate bar, photographs as whole uncropped prints, flare reserved for "in your trip" and the action that moves the trip on. Chosen after three rendered concepts on real Lisbon data (`prototypes/`, shots `prototypes/shots/{a,b,c}`): A *Living Atlas* became the stage, B *Folio* the photography, C *Survey Journal* the system. Vocabulary: `DIRECTION.md`. References: `research/references.md` (18 sites studied, 55 real screenshots).

## What was rebuilt (structure, not paint)
| Surface | Before | After |
|---|---|---|
| Maps in trips | OpenFreeMap stock "positron" street style under SVG marks | Sidequest's own cartography (`atlas/atlas-style.ts`, survey + night grounds, terrain relief) and a new interactive `AtlasMap`: `<button>` numbered pins, lines by evidence (solid measured / dashed estimated / dotted unmeasured / glacier boat-rail), fly-to focus, route draw-on, live coordinate bar + scale, cooperative gestures, zoom/fit buttons, SVG fallback while loading or without WebGL |
| Discovery Board | Tall identical cards in two columns, small sticky map | Full-height night **stage** map with numbered specimens + a **register** of compact ruled rows; the lead of each group is a whole-photo print; hovering a row flies the map and raises a print of the place; phone: the map is a window at the top, register below, action bar at the thumb |
| Itinerary | Hero card band + stacked day cards + small sticky map | A **cover**: the whole route on the night atlas, the destination set large, a day strip whose pins carry their day numbers. **Days**: each opens on a giant numeral and the theme as a headline; the timeline is a route **thread** whose leg segments carry their evidence and whose flare stop pins match the map; a full-height journey map flies to the day being read and draws its route. **Map view**: the same atlas, full height, overview / explore / day modes. **Phone**: a "Map · day N" button opens the day's atlas in a native modal dialog. Signature experiences became an asymmetric spread of prints (I · II · III) |
| Onboarding | Rectangular option-card grids, a "trip so far" side card | One question per screen: giant faint numeral, display headline, a live map that redraws from the answer being considered (reach draws a ring, transport changes line style), interests as a typographic word index, pace as day-strip scales, lettered ruled rows, a budget axis, square toggles; mono pager |
| Home | Globe + pills + feature list | Globe as stage with a typed-line destination form, a right-edge index of example journeys (still labelled "Example shape"), a live camera bar, masked headline rises; below: one ruled sheet of real UI fragments and the evidence legend; designed no-WebGL still |
| Scan | Night ground with dots | Survey-night grid, boxed real counters (never a %), ruled stage register, numbered pins rising as places are placed |
| Saved trips | Database cards | A collection: the next trip as a cover with a countdown and its real route plot, every trip a numbered catalogue entry with a deterministic stamp drawn from its own coordinates |
| Today | Card stack | A departure board: night block, next place large, "Leave by" as the largest figure, ruled day |
| Shared surfaces | Rounded cards, pills | `Panel`/`.card` are square sheets with an ink top rule; badges square; survey grid ground on board, hub and onboarding |

## Functional fixes found by looking at real data
- **No photographs on any new board** — two causes: scanned places never carried their Wikidata id (now carried from open-data rows and Nominatim `extratags.wikidata`), and Wikimedia Commons moved thumbnails to `thumb.wikimedia.org`, which the licence gate refused (now approved only under `/wikipedia/commons/`; refusals from the old rule revalidate at once instead of in 90 days). Also: logos/emblems/flags are never a picture of a place; lookups are paced and stop at Commons' first "too many requests".
- **Lisbon/Lisboa** resolves straight to Portugal: English-name exact matches count as exact, a city and its same-named district collapse, and a tenfold-prominent namesake settles the question (Portland still asks; Florence, ~9×, still asks — see Compromises).
- Hydration mismatches on every SVG map (float coordinates) — rounded.
- Hidden per-day basemaps created ~6 WebGL contexts per itinerary — basemaps now start only when visible.
- Phone overflow at 390 px from a non-wrapping figures line — fixed.

## Verification
Unit: 8,493 passed, 1 skipped (577 files). Typecheck 0 errors; lint 0 errors (129 warnings, mostly console use in scripts); build exit 0; `git diff --check` clean. Playwright desktop **253/253**; mobile **244 passed, 9 desktop-only skipped, 0 failed**; Today config 4/4. Screenshot rounds: `rounds/r1`–`r6`, `rounds/onboarding/{before,r1,r2,r3}`, `rounds/collection/{before,r1,r2,r3,final}`; real-data walks `before/real`, `after/real`; side by side in `compare.html`.

## Compromises and what still looks generic
- The atlas stage, cover, journey map and phone map sheet have **no e2e coverage**: the browser suite runs without a tile service (now pinned explicitly), so it drives the SVG fallback. They were verified with browser scripts against real data.
- Saved-trip catalogue entries are still an equal three-column grid; stamps of trips without coordinates look alike.
- Plan / Book / Prepare are deliberately quiet reading views; they inherited the sheet language but were not re-composed.
- Board copy on open-data boards is thin ("One of the established names here…") because nothing better is known without the model; the design cannot hide that.
- Home's "how it works" sheet is static; a scroll-driven sequence would sell it better.
- Florence still asks "which one" (~9× population, under the tenfold rule shared with Portland) — a product threshold decision.
- Wikimedia asks for a contact in the User-Agent; set `SIDEQUEST_CONTACT_URL` before real traffic or photos will throttle.
- Model-backed flows (research proposal, composition fallback) are **unverified**: the local Anthropic key is dead; every browser journey here used the open-data path.

---

# Completion pass — Journey Explorer, Plan/Book/Prepare, collection, real journeys (2026-10-25/26)

## Journey Explorer (new)
`lib/journey/model.ts` turns the persisted itinerary into a journey: stops, bases, moves and legs, each leg carrying **time** (measured / estimated / unknown) and **shape** (routed polyline / straight chord) as separate facts, with `shapeSource`, a distance basis and `disconnected` (flights, long ferries). `components/journey/` renders it with MapLibre over the Survey Atlas style:
- **Lines by evidence and mode:** solid = the router's own polyline; dashed = straight chord between two known places ("the time is known; the way is not"); dotted = not measured; flights are arcs. Colour by mode, explained in a Key.
- **Scales:** whole trip → stay → day, with a breadcrumb; a day strip at trip scale.
- **Selection is shared with the timeline:** pin → row (scrolled into view, `data-selected`), row → camera, ribbon stop/leg → card. Pins are real buttons in the tab order.
- **3D terrain** (optional): AWS Terrain Tiles (terrarium, open data), exaggeration 1.35, the relief actually under the view reported in words ("Relief here: 0–230 m … Flat ground — 3D adds little").
- **Replay My Day:** play / pause / previous / next / speed (1×, 2×, ½×) / exit. A routed leg is drawn along its polyline with the camera following the head; a straight or unknown leg is never animated as travelled ("straight line, not the route"). Reduced motion: nothing autoplays, the traveller steps.
- Frames: sticky beside Days (desktop), full in Map, a native dialog on phones (tap a stop → the dialog closes on that row).

**Routing sources:** local Valhalla (`SIDEQUEST_ROUTES_URL`, Iceland extract only here) for measured times and road shapes; openrouteservice needs a free `OPENROUTESERVICE_API_KEY` (owner action, not configured); Google is opt-in and never stored. Without a router, legs are Sidequest's own estimates, labelled, drawn as chords.

## Fixes found by driving real trips
- **A walk wore a car's measurement.** A driving trip's matrix is the car profile; a 2 km city walk borrowed the car cell and shipped as "Walk · 6 min measured" (19 km/h). A cross-profile cell is now refused; the walk gets a walking estimate (`reconcile.ts`, `cross-profile-leg.test.ts`).
- **Day legs had no road shape.** Only base moves got a direct route. Each measured drive in a day now earns one memoized `/route` request on the trip's profile (≤24 per build, deadline-aware); only the shape is taken — the time stays the matrix's. Reykjavík: 11 of 11 drives now carry Valhalla geometry.
- **"≈35 min driving"** counted estimated walks as driving — only estimated drives count now.
- **Open-data scans (no model):**
  - *Wrong country*: Switzerland slept in Como. Wikidata rows now carry their P17 countries; a row placed only in other countries is dropped, a row stating none is kept (unknown ≠ elsewhere).
  - *A destination in parts searched the ocean*: "Lisbon and the Azores" was looked up around its union centre in the Atlantic and failed. Each part is now searched around its own centre, every pool cut gives each part its share, each part gets a base, and places are "in" their part, never in the whole phrase.
  - *Root cause of the empty islands:* `liveOpenDataDeps` memoized the first box's Wikidata answer and handed it to every later box. One answer per box now (`open-data-live-deps.test.ts`).
- **A whole-day move failed the build.** The planner's "too thin" test and the draft validator both refused an empty middle day, even when it was the day of a base move — the trip fell to the model and, with the model unavailable, failed. A day whose transfer leaves no window, and a draft day that really changes base, are travel days now (a day that only *claims* to move is still refused).
- **"Drive to Azores · 1,555 min, estimated."** No road estimate is made past 900 km straight line (`MAX_GEO_ESTIMATE_DRIVE_KM`), from the estimator or the scan's own estimated cell: the leg is "Travel to Azores — not measured" with an allowance.
- UI: replay controls no longer sit over the ribbon; the sticky map ends above the floating Ask button (which covered Exit); a leg card no longer lingers at trip scale; replay names its step ("Step 5 of 9 · Grótta").

## Plan / Book / Prepare, Saved trips, Home (agents)
- **Plan/Book/Prepare** (`hub/views/`, `styles/hub-views.css`): view heads with boxed figures; a proportional sequence strip of beds; the transport register draws each leg's own line style; a food rhythm table; budget ranges on one shared scale; Book as a deadline rail with "Book next" as the one flare block; Prepare as a now / before / closer / done rail. Every test id kept. Shots `rounds/hub-views/{before,r1,r2,r3,final}`.
- **Saved trips** (`components/collection/`): an asymmetric collection — the trips ahead as editorial entries (7/5 then 5/7), ideas/past as a ruled catalogue index; plates drawn only from persisted facts (numbered bases in order with a "straight line" scale bar, or a ledger mark of letterforms, months, nights and party when nothing is placed). Shots `rounds/collection-2/`.
- **Home "how it works"** is a scroll-directed sequence (type → answer → pins land → chosen → order draws → a day), complete as a still without JS or with reduced motion, no layout shift, no new library.
- **Grounded descriptions** (`open-data-description.ts`, `wikidata-details.ts`): board copy from what Wikidata states (description, inception, heritage, architect), never invented. **Ambiguity:** Florence→Italy, Paris→France, Bali→Indonesia resolve; Portland, Georgia, Cambridge, Kingston, Valencia, Santiago, Alexandria ask.

## Real journeys (dev server, open data, no model)
| Journey | Result |
|---|---|
| Lisbon | planner build, explorer + 3D + replay verified (`journeys/lisbon-drive`) |
| Reykjavík (Iceland) | planner build, Valhalla-measured times and road shapes on every drive; replay draws the road (`journeys/reykjavik-routed`) |
| Japan | walk passed end to end (`journeys/japan`) |
| Switzerland | scan now sleeps in Zug and Lausanne (was Como); planner build with 2 bases (`journeys/switzerland-2`) |
| Lisbon and the Azores | was a failed scan; now 2 bases, island places on the board, planner build, the crossing an honest unmeasured leg drawn dotted (`journeys/lisbon-azores-explorer`) |
| Iceland (whole country, one board) | **still fails without the model**: from two bases the planner cannot reach enough within the daily travel limit to fill a middle day, falls back to composition, and the key is dead. Not fixed here (planner design). |

## Verification
Final run after every change in this pass (fresh `npm run build`):
- `npm run typecheck`, `npm run lint`: clean (0 errors).
- `npm run test`: 586 files, **8,566 passed**, 1 skipped, 0 failed.
- Maps suite (`playwright.maps.config.ts`, real MapLibre, controlled tiles): **8 passed**, 6 skipped (mobile duplicates / desktop-only by design).
- Playwright desktop: **253 passed**. Mobile: **244 passed**, 9 skipped. Today (fixture clock): **4 passed**.
- `git diff --check`: clean.

## Limitations
- **Model-backed paths are unverified**: the local Anthropic key is dead (401). Every journey above used open data and the deterministic planner.
- A country-scale board that the planner cannot fill fails the build when the model is unavailable (Iceland). Two honest ways forward: let the planner ship a stated free day, or loosen the daily travel limit for a stay change — a product decision.
- Routed shapes exist only where a router answers: local Valhalla covers Iceland only; elsewhere legs are estimates drawn as chords until an `OPENROUTESERVICE_API_KEY` is set.
- Open-data scans of country-scale or multi-part destinations take 95–140 s live (Wikidata + Overpass, per part); the walker's 90 s board wait was exceeded.
- The Azores have no Wikidata "town" class match (Portuguese municipalities), so the island base is the part itself, placed at its geocoded centre.
- A whole-day transfer with no router holds a 120-minute allowance; it is labelled unmeasured, but the allowance understates a flight day.
- Terrain tiles in the map test suite are synthetic (test harness only); the real 3D path was verified against AWS tiles in a browser script, not in CI.

## Polish pass (2026-10-26)
Owner direction: make every screen clearer and more delightful for a first-time user, keep the Field Atlas identity, and use the "First Light" logo.
- **Logo:** "First Light" (a sun over a ridge) replaces the S-route in the header, the favicon, the Apple and Android icons and the manifest. The geometry is in `components/brand/SidequestMark.tsx`. The concepts canvas is a private artifact.
- **Home:**
  - The hero leads for every visitor; returning trips follow it.
  - The how-it-works sequence pins one panel (step + stage) that fits the window. Steps change with a numeral roll and a caption hand-off; the stage plays on the clock, not the scroll wheel (`advance`/`targetFor`, tested). There is a clickable rail.
  - All copy is plain ("Live demo", "Finding places · 3 of 6", "5 picked · 1 skipped").
- **Globe start-up:**
  - The WebGL probe released no context. With the board and day maps open too, a later visit could find none left, and the hero stayed on its still until a reload. All three probes now release the context.
  - The hero retries twice and starts once the style has loaded, without waiting for every tile. It rebuilds on a lost context and wakes on a back-forward restore.
  - Verified: 5 cold visits and 6 returns after the map pages all went live.
- **Maps (`AtlasMap`, `JourneyMap`):**
  - Ready on style load, not first-tile load: the trip cover was black for 11–15 s on a cold dev load and could cross the 15 s failure line.
  - The coordinate/zoom strips are now a scale bar and a "3D view" note. The camera numbers are on `data-camera`, and the e2e reads that.
  - Pins that overlap fan out (a ring, or a sunflower for large groups). The base stays put and the coordinates are untouched.
  - Invisible pin footprints make town labels give way.
  - The base is drawn once.
- **Agents (screenshots in `rounds/start-2`, `rounds/board-3`, `rounds/hub-4`):**
  - Setup: example chips, Enter to continue, "Your trip so far", human dates, a quiet disabled Continue (now global in `ui.tsx`). On a phone the question comes first.
  - /decide: tactile cards.
  - Trips: no jargon, the cover isn't listed twice, a real empty state.
  - Profile and sign-in: tightened.
  - Board: a step trail, fact chips, action hierarchy, a provenance chip, a sticky action bar, a friendly readiness card with stat tiles, richer cards, jump pills, include all/clear per group.
  - Trip hub: a cover map that reads as a map, stat tiles, day cards, a compact day rail, a lighter Book, a deduplicated Plan, a folded Prepare.
  - Today before the trip: a countdown, a day-1 preview and the next three actions.
- **Bug found:** local set-up readiness items shared one id and one tick (`preflight:readiness:local_setup`), so ticking one ticked all, and every row read "Set this up before you fly." Each item is now keyed by its title (`packages/core/src/execution/preflight.ts`, tested).
- **Remaining:**
  - The trip cover's "Typical day" tile reads its numbers from the planner's headline sentence, falling back to a median. The planner should store the figures.
  - Day cards on Days are still dense.
  - The phone filter panel on the board is tall.
  - Share and Calendar stay inside "More".

### Polish pass verification (fresh `npm run build`, idle machine)
- `npm run typecheck`: clean. `npm run lint`: 0 errors (128 warnings, all pre-existing). `git diff --check`: clean.
- `npm run test`: 588 files, **8,584 passed**, 1 skipped, 0 failed.
- Maps suite: **8 passed**, 6 skipped. Playwright desktop: **253 passed**. Mobile: **244 passed**, 9 skipped. Today: **4 passed**.
- An earlier run under heavy load had 8 desktop timeouts (all 49 tests in those files pass alone) and one real phone bug (DayRail widened the layout to 972 px), fixed above. The maps suite proves the real MapLibre maps render with controlled tiles; it is not run against live tile servers.
