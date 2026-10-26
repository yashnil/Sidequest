# Sidequest — Field Atlas design system (production pass)

The identity in one line: **a topographic sheet with one route on it.** Night and bone grounds, contour lines as the only texture, and a single flare colour for the route, the waypoint and the action that moves the trip forward.

## Brand
- **Mark** — an S drawn as a route (two switchbacks, one stroke weight, round caps) whose last waypoint steps off the line: the detour. `components/brand/SidequestMark.tsx` holds the geometry once; `app/icon.tsx`, `app/apple-icon.tsx` and `public/brand/sidequest-mark*.svg` draw from it. Directions considered and rejected: `docs/production-pass/brand/` (a "detour bump" read as a heartbeat; an off-route arc was illegible at 16 px).
- **Wordmark** — Fraunces 600 with SOFT 100, tracking −0.025 em, mark at ~1.1 × cap height.

## Type
| Role | Face | Where |
|---|---|---|
| Voice | Fraunces (opsz, SOFT 100, WONK 0) | place names, headlines, the wordmark (`.font-display`, `display-*`, `type-title`) |
| Interface | Bricolage Grotesque (opsz) | every row a traveller scans |
| Figures | JetBrains Mono 500 | clock times, durations, distances, coordinates, eyebrows on night (`.type-figure`, `font-mono`) |

## Colour
Brand constants (both themes): `flare #ff5a1f` (fill only, night ink on it), `night #0d1a1f`, `bone #f1ebdf`, `glacier #7fd1e0`.
Semantic tokens keep their meanings (accent = the traveller's choices, pine = verified, amber = caution, clay = hard rule, slate = water/transit) and are retuned to the night/bone grounds; every text/surface pairing is measured by `app/globals.contrast.test.ts` in both themes.

## Texture
- `.paper-grain` — a near-invisible fractal grain (inline SVG turbulence), never a dot grid.
- `.topo` — the generated contour sheet (`scripts/generate-contours.mjs` → `public/brand/contours.svg`) as a mask over `currentColor`; tune with `--topo-opacity` / `--topo-size`. It is a texture and is never presented as a map of anywhere.
- Plates (place fallbacks, board cards) are cuts of the same sheet: contour **density = effort**, cut offset = visit length, a flare waypoint = quiet find.

## Shape and depth
Tighter radii (control 6 px, card 8, panel 10, plate 14), pill buttons, one hairline at ink/10 instead of stacked shadows. `buttonClass('accent')` is the flare action (Build my trip, Find places, Start); `primary` is ink; `secondary` is an outline.

## Motion (Motion for React)
- Every motion explains a change: the route drawing through a region, the "How it works" line tied to scroll, places appearing on the scan map as they are placed. Route changes do **not** animate: a `<ViewTransition>` crossfade was tried and removed because it changed navigation timing and dropped keyboard focus (three browser tests caught it).
- Auto-advancing content is pausable (the landing globe). `prefers-reduced-motion`: no camera flights, lines drawn whole.

## Maps
- **Night atlas style** (`components/landing/night-style.ts`): OpenFreeMap vectors + AWS Terrain Tiles hillshade, globe projection with atmosphere, five layers. Used by the landing globe and the scan map.
- Every point drawn is a real coordinate from the scan or the plan; example routes on the landing page are labelled "Example shape" and drawn as great-circle sketches, never roads.
- Attribution is always visible under a map and in the footer colophon.
