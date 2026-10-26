# Visual technology research — "travel atlas" reinvention

Researched 2026-10-24. Versions come from `npm view` on that date. Gzip sizes come from bundlephobia, except MapLibre, which was measured from `node_modules`. Repo baseline: Next 16.3.4, React 19.2.8, `motion` 13.2.0, `maplibre-gl` 6.7.0 (vendored; it already loads the OpenFreeMap `positron` style).

## Verdicts

| Tech | Verdict | Version / license / gz size | Rationale |
|---|---|---|---|
| **MapLibre GL (globe + terrain + sky)** | **Adopt (the hero)** | 6.7.0, BSD-3, ~138 KB shared chunk (already shipped) | Real geography for zero new bytes. The 6.7 typings expose `setProjection`, `GlobeControl`, `setTerrain`, `setSky` with `atmosphere-blend`, and `line-gradient`. Globe arrived in v5 and terrain works on the globe. The route-drawing, `flyTo`, base and stop data already exist on this stack. A fake three.js globe would duplicate it and could never zoom down to the actual trailhead. |
| **Terrain: AWS Terrain Tiles (Terrarium)** | Adopt | Open data, no key; attribution via Joerd `attribution.md` ("Mapzen", plus per-source credits such as "3DEP data courtesy of the U.S. Geological Survey") | `raster-dem` source with `encoding: 'terrarium'`, URL `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`. Uses an S3 bucket directly, with no SLA. Proxy it through the app with caching if traffic grows. |
| Terrain: Mapterhorn (Protomaps) | Watch | Terrarium-encoded 512px PMTiles, `download.mapterhorn.com/planet.pmtiles`; licence and terms not stated on the announcement | Better resolution in Europe. Don't ship it until the data licence is published. |
| Terrain: MapTiler | Skip | Requires an API key and a paid plan at scale | Not needed. |
| **Basemap: OpenFreeMap** | Adopt (keep) | Free, keyless, commercial use OK, OSM data; attribution "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (MapLibre adds it) | Already in use. Its terms say the service is as-is and may be discontinued, so keep a fallback style URL. Restyle it (custom paper/ink palette JSON on top of the OpenMapTiles schema) rather than switching providers. |
| Basemap: Protomaps | Adopt as the fallback / self-host path | `@protomaps/basemaps` 5.7.2 and `pmtiles` 4.5.0, BSD-3 | The hosted API is non-commercial-free only (commercial use needs a GitHub sponsorship). Self-hosting one `.pmtiles` file on R2 or S3 behind a CDN is the robust long-term option and fits a single Railway node. |
| deck.gl `TripsLayer` | Skip | 9.4.0, MIT, `@deck.gl/geo-layers` alone ~234 KB gz | Timestamped path animation is overkill for at most dozens of legs per trip. MapLibre `line-gradient` with `lineMetrics: true`, stepping a `line-progress` cutoff in rAF (or a growing-coordinate GeoJSON plus dasharray), draws routes for 0 KB. Revisit only for thousands of animated paths. |
| three.js + R3F + Drei | **Skip for the hero; adopt narrowly later** | three 0.186.1 (~185 KB), `@react-three/fiber` 9.8.2 (~58 KB; peers React >=19 <19.4, OK), drei 10.7.9; all MIT | ~250 KB+ gz before Drei, and it duplicates MapLibre's globe. Only reach for it for a stylised, non-geographic object (for example a paper-craft 3D postcard on the landing page), client-only via `next/dynamic({ ssr:false })`. |
| `@react-three/postprocessing` | Skip | 3.2.2, MIT | Only relevant if R3F is adopted. Use CSS/SVG grain instead (below). |
| **Motion (`motion/react`)** | **Adopt (primary)** | 13.2.0 installed, MIT, ~45 KB full, ~5 KB core with `LazyMotion` + `m` | Layout animations (itinerary reorder, card-to-detail), `AnimatePresence` exits, `useScroll`/`useTransform` scroll-linked parallax, `useReducedMotion`, springs. Covers ~90% of the brief with one dependency already paid for. |
| GSAP | Adopt narrowly (marketing only) | 3.15.0, "Standard no-charge licence" (not OSI; Webflow made all plugins, including SplitText, ScrollTrigger and MorphSVG, free for commercial use; one exception bans building a competing visual animation tool); `@gsap/react` 2.1.2 (`useGSAP`); core ~27 KB gz | Worth it only for pinned, scrubbed scroll storytelling (ScrollTrigger `pin` + `scrub` timelines) and SplitText headline reveals, which Motion does awkwardly. Keep it out of the app routes. Load it on `/(marketing)` only. |
| Lenis | Skip (optionally adopt on the landing page only) | 1.3.27, MIT, ~5.5 KB | Honours `prefers-reduced-motion` by default and keeps native scroll (find-in-page and sticky work). Eased scrolling still feels sluggish for reading and fights MapLibre and inner scroll containers. Never on itinerary, hub or map routes. |
| **View Transitions / React `<ViewTransition>`** | **Adopt** | Ships in Next 16 App Router with **no config flag**: `node_modules/next/dist/docs/01-app/02-guides/view-transitions.md` says it "works in the App Router with no configuration" (React canary bundled), `import { ViewTransition } from 'react'`, and `<Link transitionTypes>` for directional slides | Shared-element morphs (trip card to trip hero, map thumbnail to full map), Suspense skeleton-to-content reveals. Fires only inside transitions or navigations. Unsupported browsers simply don't animate. Wrap the CSS in `@media (prefers-reduced-motion: no-preference)`. |
| Spline | Skip | `@splinetool/runtime` 2.0.111 (~279 KB gz plus scene files), proprietary editor; free tier watermarks | Heavy, opaque scenes and a generic "3D blob" look. Wrong for an atlas. |
| Magic UI | Adopt narrowly (as reference) | MIT, copy-paste, built on shadcn + Motion | Fine as a *starting point* for one or two primitives (marquee, number ticker, border beam). Used as-is it looks templated, so restyle it heavily. |
| Aceternity UI | Skip | Free components have no clearly published licence; Pro has a proprietary licence | Licence ambiguity plus the most recognisable "AI startup" look on the web. |
| "Animaster" | Not found | No web animation library by this name exists in npm or web search; "Animaster Studio" is a 3D/VFX studio on Fab.com | Likely a misremembered name (Anime.js? Motion?). Nothing to evaluate. |
| "Manus" | Not relevant | Manus (now part of Meta) is a general autonomous agent that can generate whole websites; its design claims come from vendor or sponsored pages | Not a library or a design system. It produces generic sites, not components for this codebase. Ignore. |

## Texture and grain (instead of shaders)
- Use an SVG `feTurbulence` noise as a CSS `background-image` data-URI on a fixed `::after` overlay (`mix-blend-mode: multiply`, opacity 0.04–0.08, `pointer-events:none`). It costs roughly 0 KB and nothing at runtime when static. Don't animate it on mobile.
- Paper and contour motifs: inline SVG contour lines (generated once from DEM tiles offline, or hand-drawn) as section dividers. Stamp-like route numerals in the mono face.
- MapLibre itself does the "atmosphere": `setSky({ 'sky-color', 'horizon-color', 'atmosphere-blend': ['interpolate',…zoom] })` plus a hillshade layer from the same DEM.

## Imagery
- **Wikimedia Commons: adopt (primary).** `apps/web/src/lib/providers/wikimedia.ts` already resolves images through Wikidata identifiers (P948 then P18 then P3451, never a free-text search) with structured licence evaluation. Keep it as the canonical source. Render the author and licence (CC BY-SA needs author, licence and a link) in a caption, and cache the thumbnails server-side.
- **Unsplash: adopt narrowly (marketing and hero fallback only).** You must hotlink `photo.urls.*`, ping `links.download_location` on "use", credit the photographer and Unsplash with links carrying `?utm_source=sidequest&utm_medium=referral`, and keep the key behind a server proxy. Searching by destination name brings back the wrong-place risk that the Wikimedia ladder exists to avoid, so use hand-picked photo IDs for marketing rather than a runtime search.
- **Pexels: skip.** It requires visible credit, has a default limit of 200 requests/hour and 20k/month, and bars AI-dataset use. It adds nothing over the two above.

## Fonts (all SIL OFL on Google Fonts, all available through `next/font/google`)
- **Display: Fraunces** (variable `opsz`, `SOFT`, `WONK` axes). A characterful "old atlas" serif that can go soft and warm at large sizes. Alternatives: **Instrument Serif** (condensed, editorial, a single weight) or **Gloock** (high-contrast).
- **UI and text: Bricolage Grotesque** (variable `opsz`/`wdth`, quirky but legible), or **Hanken Grotesk** for something calmer. Either is far more distinctive than Manrope.
- **Mono, for coordinates, elevations, times and leg minutes: JetBrains Mono** or **Geist Mono** (both OFL). Use tabular numerals throughout.
- Keep at most three families. Subset to `latin`/`latin-ext`, use `display: 'swap'`, and preload only the display face.

## Recommended stack
MapLibre 6.7 (globe, Terrarium terrain, sky, hillshade, `line-gradient` route draw) · OpenFreeMap with a custom style (Protomaps self-host as the fallback) · Motion 13 everywhere · React `<ViewTransition>` for route-level continuity · GSAP 3.15 + ScrollTrigger/SplitText on marketing routes only · CSS/SVG grain · Wikimedia (product) + curated Unsplash (marketing) · Fraunces / Bricolage Grotesque / JetBrains Mono. **No** R3F, deck.gl, Spline, Lenis or Aceternity in v1.

## Hero globe/map architecture (Next 16)
1. **Server component `<AtlasHero>`** renders the static layer first: a pre-rendered globe/region still (AVIF/WebP via `next/image`, `priority`, `sizes`), the headline and the CTA. That image *is* the LCP and the fallback. Generate it offline by screenshotting the same MapLibre style.
2. **Client island `<AtlasGlobe>`** loaded with `next/dynamic(() => import('./AtlasGlobe'), { ssr: false, loading: () => null })`. Mount it only when (a) the hero is in view (`IntersectionObserver`), (b) after `requestIdleCallback`, and (c) the capability gate passes: WebGL2 available (`canvas.getContext('webgl2')`), not `navigator.connection.saveData`, and `deviceMemory >= 4` or a desktop-width viewport.
3. On the map's `load` and first `idle`, cross-fade the canvas over the still (opacity transition, 400 ms). If initialisation throws or the WebGL context is lost, keep the still. No error UI.
4. **Choreography:** `setProjection({type:'globe'})` in `style.load` and a slow `easeTo` bearing rotation. On a scroll or step trigger, `flyTo` the destination's extent (reuse `map-camera.ts` framing), at zoom ≥ 9 `setTerrain({source:'dem', exaggeration:1.3})` with `pitch` ~60, then animate the route's `line-gradient` progress leg by leg as stops appear.
5. **Reduced motion** (`useReducedMotion()` / `matchMedia`): no auto-rotation, `jumpTo` instead of `flyTo`, routes drawn fully at once, `<ViewTransition>` CSS and GSAP scrubs disabled, and the static image is allowed to stand in for the globe entirely.
6. **Accessibility:** the canvas gets `aria-hidden`, cooperative gestures on touch (`cooperativeGestures: true`) so page scroll never gets trapped, and a text list of bases and stops beside or below the map as the real content. Pause rendering when off-screen or when `document.hidden`.
7. **Budget:** hero JS (excluding the already-shared MapLibre chunk) under 30 KB gz; no tile fetches before interaction intent on mobile; cap `maxPitch` and `pixelRatio` (≤ 2) on mobile.

## Risks
- **Keyless tile hosts** (OpenFreeMap, AWS S3) have no SLA. Mitigate with a fallback style, a static-image fallback and a later self-hosted PMTiles.
- **Terrain on the globe** costs GPU on low-end Android. Enable it only at high zoom, behind the capability gate.
- **GSAP licence** is proprietary "no-charge", not MIT. It is fine for this product, but note the clause banning competing animation tools, and that Webflow controls future terms.
- **`<ViewTransition>`** rides React canary features through Next. The API may shift; keep its use in a few wrapper components.
- Getting **Wikimedia attribution** right on every image is a legal requirement. The captions must survive the redesign.
- Designs copied from component kits look templated. Budget design time for a bespoke palette, type scale and map style rather than importing a look.

## Sources
- Next view transitions guide (local): `node_modules/next/dist/docs/01-app/02-guides/view-transitions.md`; Next `<Link transitionTypes>`: `.../03-api-reference/02-components/link.md`
- MapLibre globe example: https://maplibre.org/maplibre-gl-js/docs/examples/display-a-globe-with-a-vector-map/ · changelog: https://data.safetycli.com/changelogs/maplibre
- AWS Terrain Tiles: https://registry.opendata.aws/terrain-tiles · attribution: https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- Mapterhorn: https://protomaps.com/blog/mapterhorn-terrain/
- OpenFreeMap: https://openfreemap.org · Protomaps API terms: https://protomaps.com/api
- GSAP free: https://webflow.com/blog/gsap-becomes-free · licence: https://gsap.com/standard-license
- Lenis reduced motion: https://motion.dev/docs/lenis
- Unsplash API guidelines: https://help.unsplash.com/en/articles/2511245-unsplash-api-guidelines
- Pexels API: https://help.pexels.com/hc/en-us/articles/900005852323
- Aceternity licence: https://ui.aceternity.com/licence · Magic UI: https://designrevision.com/alternatives/magic-ui
- Manus: https://manus.im/blog/best-ai-agents
- Sizes: https://bundlephobia.com (three, @react-three/fiber, gsap, lenis, @splinetool/runtime, @deck.gl/geo-layers, motion)
