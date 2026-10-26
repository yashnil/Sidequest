# Creative reinvention: visual references

Researched 2026-10-25. This builds on `docs/production-pass/research/visual-tech.md`, which already covers the library versions, terrain, basemaps, fonts and the hero globe, so none of that is repeated here. Screenshots were captured with Playwright Chromium at 1440×900, plus a few at 390×844, and saved in `shots/`. Every description below is of a screenshot I actually opened. Where a site didn't render, I say so.

**What I could not see.** Resn never got past its preloader, even after 14 s with software GL. Active Theory reported "browser not supported" under SwiftShader, so it was re-shot in system Chrome with the GPU and rendered its scene. Google Earth showed a modal over the globe. Travel Next Level (Awwwards SOTD, Dec 2024) returned a 404. The NYT and WaPo pieces are paywalled and were not captured. The Pudding's homepage has no geographic piece. The Typeform template and Airbnb's host flow gave an error page and a login wall, so those shots were deleted. Cookie banners cover parts of the Aman, Mapbox and Al Jazeera shots.

## The references

| # | Site (shot) | What's memorable | Ideas for Sidequest |
|---|---|---|---|
| 1 | **activetheory.net** (`activetheory.png`) | Near-black teal field with a chrome, iridescent logo ribbon and ember particles. The only chrome is a pill nav ("WORK —— CONTACT"). Under SwiftShader it still drew a designed still image ("Your browser is not supported"), not a blank page. | Design the **WebGL fallback as a real still**, not an error. Keep the night product chrome to **one floating pill**. |
| 2 | **locomotive.ca** (`locomotive*.png`) | Full-bleed video with copper-coloured condensed serif ("Digital-first Design Agency") set at the bottom left. Nav is a plain comma list ("Work, Agency, Careers, Store"). On scroll, a single object (a 3D ring) sits on white with a hairline-ruled caption ("2018-2024 · The dynasty →"). | Write navigation as a **sentence**, not tabs. Present **one object, a hairline rule and a caption** instead of cards. |
| 3 | **resn.co.nz** (`resn.png`) | Not viewable: only the droplet preloader and progress line rendered. | — (the preloader itself is a long wait; avoid one) |
| 4 | **Apple AirPods Pro 3** (`apple-airpods*.png`) | A hero headline at about 64px with a single price/Buy pill bottom right. Once you scroll, a sticky sub-nav with an underlined active item appears ("Overview · Hearing Health · Tech Specs"), and each chapter opens with one huge sentence ("Take a closer look."). | **One sentence per chapter**, enormous, then the proof. Use a **sticky chapter bar** for the itinerary (Overview · Days · Map · Bookings). |
| 5 | **Airbnb search** (`airbnb-map*.png`) | Desktop is a list beside a large rounded map with price-pill markers. Mobile is a map-first layout with a draggable bottom sheet ("Over 1,000 homes") and pills that collide in dense areas. | The **map-first mobile bottom sheet** for the Discovery Board. Use **label pills as markers** (a minute count or a fit number, not a price). Cluster or offset pills so they don't overlap the way Airbnb's do. |
| 6 | **Google Earth web** (`google-earth.png`) | A globe on black with a mono status strip ("Camera: 22,252 km · 0°00′00.02″S"), a scale bar and round tool buttons. A product modal sat on top. | An **instrument strip** (camera altitude, coordinates, scale) as quiet chrome. |
| 7 | **Condé Nast Traveler** (`cntraveler*.png`) | High-contrast serif headlines, small spaced caps for category labels, and a featured story beside a "Places to go" list of thumbnail and headline rows. Heavy ads. | **Editorial row** (thumbnail, serif headline, caps kicker) for the trip list, instead of cards. |
| 8 | **Kinfolk** (`kinfolk*.png`) | A huge white field holding one cover, centred serif caps ("ISSUE 61 / THE PLAY ISSUE") and "Buy \| Read". | Treat a **trip as an issue**: a cover, a number and two verbs. |
| 9 | **Cereal archive** (`cereal*.png`) | Bone background, a six-column grid of photos of mixed aspect ratio, each with a catalogue number "(176-08)" and a small serif title. A faceted index at the top right (Categories / Search Terms / Year). "Sort by: Unsystematic". | **Saved places as a catalogue**: index numbers in mono, mixed aspect ratios, facets as typeset columns. |
| 10 | **Aman** (`aman*.png`) | A warm bone frame, a centred thin wordmark and spaced caps ("RITUALS of JOY") with an italic "of". Sections are big serif text paired with a muted photo. | Use **italic connective words** in display lines ("Five days *of* granite"). A **bone gutter frame** around full-bleed imagery. |
| 11 | **White Desert** (white-desert.com, `white-desert*.png`) | Antarctic aerial video with a giant condensed "ANTARCTICA" cropped at the bottom edge and an italic serif tagline. **Visible hairline column grid lines run through the whole page.** A vertical orange "How it works" tab sits on the edge. Per trade press, the site switches light/dark by Antarctic daylight hours (I didn't verify this). | **Show the grid** as survey lines. **Crop the destination name** at the bleed. Tie the **theme to the destination's real daylight** or local time. |
| 12 | **Hedwig** (Awwwards HM, Apr 2026, `hedwig*.png`) | Film photography, a hand-drawn ellipse around the wordmark, nav in the four corners. Scrolling reveals a chartreuse field with **scattered small photos, each with a roman-numeral caption** ("IV. The raw force of water. Hornopirén, Chile"). | **Scatter layout** for a saved collection. **Corner navigation** for full-screen map pages. |
| 13 | **GoShuin** (AE Studio, Awwwards nominee, Oct 2026, `goshuin*.png`) | A digital stamp book: a left page with a big serif title, a right page as a book cover ("Lift the cover to begin"), and halftone washi patterns. A **bottom pager reads "Page 01 / 14 · Every Stamp, A Memory"** with Previous/Next, and there's a **"Pause motion" button**. | **The passport pattern**, directly: each place visited gets a stamp. A **pager footer** for the interview ("Question 03 / 09 · Pace"). A visible **pause-motion control**. |
| 14 | **Felt** (`felt*.png`) | A **mono instrument bar across the top: "LAT 37.8093° N · LON 122.2758° W · BRG 042.3° · ZOOM 11.0 · CRS EPSG:4326" plus a scale bar.** It updates on scroll (11.0 → 11.6). Watercolour illustrated terrain with status pins, a serif headline, and floating comment cards on the map. | The **coordinate HUD strip**, driven by the actual camera. **Annotations float on the map**, not in a sidebar. |
| 15 | **SF Chronicle "49 Mile Scenic Route"** (Mapbox storytelling, `sfc-49mile*.png`) | A thick white route line over a pale green and blue map. The opening card is teal with the serif title. On scroll the camera **flies to each stop**, drawn as **an illustrated landmark icon** (Dragon's Gate, the Chronicle building), with a short caption card. On mobile the card docks to the bottom. | **Itinerary as a scrolled route**: one chapter per stop, `flyTo` on enter, an icon at the stop, the caption docked at the bottom on mobile. |
| 16 | **Codrops "The Wild Path"** (`storytelling-map*.png`) | Prose in the left column. A **sticky map at the right draws the route in teal as you read**, with the current town in bold and visited towns greyed. The map uses a cream land fill, a dashed road network and serif chapter heads ("REYKJANESTA / A Helping Hand"). | **Draw the route by scroll progress** (`line-gradient` cut-off). Bold the current place, grey the visited ones, dash the roads you haven't travelled. |
| 17 | **Huttrip** (map.huttrip.com, `huttrip*.png`) | A **contour topo basemap** with metre labels, a purple route and a red current marker. The side panel holds a photo, **three boxed stats (5.72 Distance · 2393 Uphill · −397 Downhill)** and an elevation profile chart. | A **day panel with boxed stats and an elevation or minutes profile** linked to the route. Contours as a *real* layer at zoom, not just texture. |
| 18 | **Al Jazeera "Saving the Nile"** (`aljazeera-nile*.png`) | Satellite imagery, a framed inset box around the delta, orange label tags on cities and a big stat callout ("40 million people live here"). | **Frame-and-callout** for a region: a box on the map plus one number. |
| 19 | Context only: **Black Tomato, Intrepid, Polarsteps, Pudding** | Black Tomato has condensed caps over drone video, but the screen is buried under pop-ups. Intrepid's trip page is a stack of white cards with a "1 night · Day 6" chip, which is *exactly the generic look to escape*. Polarsteps' scroll hero is a 3D phone tilting in, and the screenshot is blank because the content is canvas-driven. Pudding uses mono issue numbers ("#226 · OCT 2026"). | Use these as counter-examples: **don't stack chips in cards, and no pop-ups**. Borrow Pudding's **issue numbering**. |

## Pattern library

**(a) Map-led discovery (Discovery Board).**
- *Desktop:* full-bleed map with a list docked left at about 420px (Airbnb). Hovering a list row lifts its marker pill; selecting a marker scrolls the row into view and `flyTo`s with padding equal to the list width.
- *Mobile:* map first, with a three-detent bottom sheet (peek showing the count / half / full), as in Airbnb.
- *Focus transition:* when a place is selected, the camera eases in, other markers fade to 40 %, and a Felt-style floating annotation card opens beside the pin, not in a modal.
- *Markers:* pills that carry minutes from base or a fit number, offset when they collide.
- *Board grouping:* typeset category headings ("Must-see / Hidden / Side quests") act as filters that redraw the map. The groups are not tabs of cards.

**(b) Itinerary as journey.**
- *Desktop:* a sticky map on the right half, with prose and timeline on the left (Codrops).
- *Mobile:* the map stays on top and the chapter card docks at the bottom (SF Chronicle).
- *Per day:* each day is a chapter. On enter, the camera fits the day's legs, the day's leg segment draws by scroll progress, the base gets a stamp, and stops already passed go grey.
- *Day header:* a Huttrip-style panel with three boxed numbers (drive min · stops · elevation or effort) and a **minutes profile** (a horizontal bar of activity, travel and meal time) as the timeline.
- *Chrome:* Apple-style sticky chapter bar (Overview · Days · Map · Bookings). Unknown legs are drawn dashed with an honest "not measured" label.

**(c) One question at a time.** The best evidence found is GoShuin's page metaphor and pager ("01 / 14" plus Previous/Next and a dropdown of all pages). I found no Awwwards questionnaire I could verify. Concrete controls:
- *Pace:* a horizontal dial or slider whose track *is* a day timeline that fills with stops as you drag.
- *Detour tolerance:* a radius ring drawn on the actual destination map that grows from 15 min to 2 h, with places entering the ring as it grows.
- *Interests:* a typographic list in Fraunces, where tapping a word cycles its weight (avoid → once → often → core) instead of using checkboxes.
- *Budget:* three spaced serif words with an italic connective ("save *or* balance *or* splurge").

Each question takes the full viewport, with one sentence in display size (Apple) and the pager footer. Always keep the native input underneath for keyboard and screen readers.

**(d) Saved collection.**
- *Index view:* a Cereal-style catalogue with mono index numbers (`SQ-014-03`), mixed aspect ratios from Wikimedia images, and facets typeset as columns (Region / Kind / Year).
- *Scatter view:* Hedwig-style, with roman-numeral captions.
- *Passport view:* GoShuin-style. Each trip is a stamp generated from its own coordinates and its contour sheet, and each visited base adds a dated stamp.

## Ranked ideas for Sidequest

1. **Itinerary as a scrolled route** (SF Chronicle + Codrops): a sticky map, one chapter per day, the leg drawing as you scroll, and visited stops greyed.
2. **Map-first Discovery Board with a three-detent bottom sheet** on mobile and a docked list on desktop. Markers are minute or fit pills, and selection works as a focus transition rather than a modal.
3. **Coordinate HUD strip** driven by the real camera (Felt + Google Earth) in JetBrains Mono. It reads as "atlas", costs about nothing and makes every map screen look like an instrument.
4. **Day panel with boxed stats and a minutes profile** (Huttrip), so the timeline becomes a measured bar rather than a list of cards.
5. **Passport and stamp collection** for saved trips and places (GoShuin), plus a **catalogue index** view (Cereal).
6. **Interview as pages**: one display sentence, a pager footer ("03 / 09 · Pace") and spatial controls (a radius ring on the real map, a slider whose track is a day timeline).
7. **Visible survey grid**: hairline column rules through product pages (White Desert), so the grid replaces card borders.
8. **One object, a hairline rule and a caption** (Locomotive, Kinfolk) in place of rounded cards for bases, bookings and backups.
9. **Destination-true theme**: night or bone chosen by the destination's local daylight (the White Desert idea), with a visible **Pause motion** control (GoShuin).
10. **Designed WebGL fallback stills** (Active Theory), so a failed map never shows an empty box.

## Tech verdict

- **Motion (already installed): keep as the only animation library.** It covers layout/`layoutId` shared-element moves (board card → detail, day reorder), `useScroll` for driving chapters, springs for the bottom sheet, and `useReducedMotion`.
- **GSAP 3.15: don't add it.** The licence is GreenSock's "Standard no-charge licence". The npm README confirms it is "100% FREE including ALL of the bonus plugins like SplitText, MorphSVG… even for commercial use", but it is not OSI open source, and gsap.com's licence page didn't render for me to re-read its clauses. SplitText and ScrollTrigger would duplicate what Motion and an `IntersectionObserver` scrollama-style step already do, and running two animation engines doubles the reduced-motion plumbing.
- **Lenis: skip.** It is MIT and small, but it fights MapLibre wheel and gesture handling and inner scroll containers, and chapter scrollytelling works on native scroll.
- **R3F/drei: skip.** `@react-three/fiber` 9.8.2 peers React `>=19 <19.4`, so it's compatible, but it costs about 250 KB+ and duplicates MapLibre. Stamps and contours are SVG.
- **View Transitions:** don't wrap route changes. React `<ViewTransition>` around the product main region broke focus and timing in three e2e specs here and was removed. Use Motion `layoutId` for in-page continuity. Same-document `document.startViewTransition` is acceptable only for a self-contained swap, with focus moved explicitly afterwards.
- **MapLibre 6.7 (shipped; verified in its typings):** `line-gradient` with `lineMetrics: true` for scroll-drawn legs; a `line-dasharray` swap for unmeasured or estimated legs (animate the dash only outside reduced motion); `hillshade` with `hillshade-method` plus the **`color-relief`** layer type, which wasn't in the earlier research, for hypsometric tint from the same DEM; `terrain` and `sky` at high zoom only; a custom style recoloured to night/bone/flare/glacier; `flyTo` per chapter, and `jumpTo` under reduced motion.
- **Recommendation: no additional animation library.** Motion plus MapLibre's camera and paint properties plus CSS scroll-driven animations (progressive enhancement only) cover every idea above.

## Imagery sources

- **Wikimedia Commons (keep as primary).** Reuse follows each file's licence. Credit the author (not the uploader), name the licence, and link to it where the licence requires. ShareAlike applies only to derivatives such as crops or edits; plain display with credit doesn't trigger it. Commons allows hotlinking but discourages it, so cache through `next/image`. WMF gives no warranty on licence accuracy, so the existing structured licence check stays. Source: commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia.
- **Unsplash API (fallback/marketing only).** Requirements:
  - Hotlink `photo.urls.*` for *all* uses.
  - Ping `links.download_location` when a photo is "used".
  - Credit the photographer and Unsplash, linking with `?utm_source=sidequest&utm_medium=referral`.
  - Keep the key server-side.
  - Don't replicate Unsplash's core experience (no wallpaper apps or unofficial clients).

  Source: help.unsplash.com/en/articles/2511245.
- **Openverse (optional discovery aid, not a source of truth).** It's an index of CC works whose records include the licence URL, an attribution string and the source. Anonymous access is allowed with tight pagination; registering gives higher limits; scraping is barred. The licence is only as good as the upstream source, so re-verify on the origin page. openverse.org/terms returned 403 to my fetch, so these details come from Openverse's make.wordpress.org posts and API listings.

## Shots index

Strongest: `felt.png`, `sfc-49mile-s2.png`, `airbnb-map-mobile.png`, `goshuin.png`, `huttrip.png`, `storytelling-map-s3.png`. Also: `cereal-scroll.png`, `hedwig-scroll.png`, `white-desert.png`, `apple-airpods.png`, `locomotive-scroll.png`, `activetheory.png`, `aljazeera-nile-s1.png`, `google-earth.png`, `kinfolk.png`, `aman.png`, `intrepid-trip-s1.png` (counter-example).
