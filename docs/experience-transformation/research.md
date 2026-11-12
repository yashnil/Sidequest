# Experience transformation — research memos (2026-11-12)

Three web-research passes made before implementation. Sources are linked inline; anything marked *unverified* could not be confirmed from a primary source.

## 1. Destination and attraction photography

**Adopt now (free, commercially clean, cacheable): Wikimedia Commons through Wikidata.**

- Hero candidates, in order:
  - P948 Wikivoyage page banner ([P948](https://www.wikidata.org/wiki/Property:P948)). Its 7:1 crop is good for strips; for a 16:9 hero use the original file it was cut from.
  - P8592 aerial view ([P8592](https://www.wikidata.org/wiki/Property:P8592)), which is good for regions.
  - P18 image.
  - Commons files whose depicts statement (P180) is the destination's QID, found with `haswbstatement:P180=Q…` ([Help:Searching](https://commons.wikimedia.org/wiki/Help:Searching)).
- Commons API example: `action=query&generator=search&gsrnamespace=6&gsrsearch=haswbstatement:P180=Q…&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1920`. `extmetadata` carries the license and artist fields.
- Thumbnail widths: request only the standard sizes, 20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920 and 3840. Other widths now get a 429 ([Common thumbnail sizes](https://www.mediawiki.org/wiki/Common_thumbnail_sizes)).
- Etiquette and limits:
  - Downloads: at most 2 concurrent.
  - Action API without logging in: concurrency 1 and under 5 requests a second; honour Retry-After ([Robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy)).
  - A descriptive User-Agent with contact details is required ([UA policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy)).
  - So: fetch once and serve from our own cache.
- Share-alike: crop with CSS `object-position` from a stored focal point instead of saving a cropped derivative. Always show author, license and a link to the file page.
- Not now:
  - **Unsplash** requires hotlinking (no server cache), download pings and UTM credits ([API terms](https://unsplash.com/api-terms)).
  - **Pexels** is generic stock and weak for niche regions ([docs](https://www.pexels.com/api/documentation/)).
  - **Google Places photos** may not be stored ([policies](https://developers.google.com/maps/documentation/places/web-service/policies)).
  - **Flickr** commercial use needs a separate commercial key ([terms](https://www.flickr.com/help/terms/api)).
  - **Openverse** is a fallback only, and the license must be re-checked at the source ([docs](https://docs.openverse.org/api/reference/made_with_ov.html)).
- Automatic quality gate (design):
  - Accept only JPEG.
  - Heroes: original width ≥ 1920 and aspect 1.3–2.5.
  - Reject files whose titles or categories contain map, diagram, flag, coat of arms, logo, locator or plan.
  - Blur check from the variance of the Laplacian on a 500 px thumbnail (sharp).
  - Focal point from sharp's `strategy.attention`, applied as `object-position`.

## 2. Named accommodation

**Adopt now: Overture places (hotel categories) or OpenStreetMap lodging, with booking search links that carry the trip's dates. No prices.**

- **Overture** places are CDLA-Permissive-2.0, Apache-2.0 (Foursquare, with a NOTICE to carry over) or CC0 (AllThePlaces), and can be persisted ([attribution](https://docs.overturemaps.org/attribution/)). This reuses the existing Overture food pipeline.
- **OpenStreetMap:**
  - Tags: `tourism=hotel|guest_house|hostel|alpine_hut`, `stars`, `website`.
  - An onsen is `bath:type=onsen` ([tag](https://wiki.openstreetmap.org/wiki/Tag:bath:type%3Donsen)).
  - Keep OSM-derived rows separate from other sources (a collective database, not a merge), or the derivative becomes ODbL ([guideline](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)).
  - Amenities read from OSM are "mapped", never "verified".
- Booking search link: `https://www.booking.com/searchresults.html?ss=<name+town>&checkin=YYYY-MM-DD&checkout=YYYY-MM-DD&group_adults=N&no_rooms=1`. The parameters come from third-party documentation (*unverified* officially). A plain link needs no agreement.
- **Needs approval (signup, card or contract):**
  - **LiteAPI (Nuitée):** free signup, production unlocked with a card; real rates by latitude/longitude ([FAQ](https://docs.nuitee.com/docs/faq.md)). This is the best route to legitimate prices.
  - **Expedia Travel Creator** deep links.
  - **Booking.com Demand API:** needs a managed affiliate contract ([prerequisites](https://developers.booking.com/demand/docs/getting-started/prerequisites)).
  - **Rakuten Travel:** relevant for rural Japan; the terms could not be fetched (*unverified*).
- Dead or unsuitable:
  - **Amadeus Self-Service** portal is closing ([PhocusWire](https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers)).
  - **Tripadvisor** allows caching only of the location ID.
  - **Google Hotels** names can't be stored.

## 3. Dedicated PDF guide

- **Why today's output is bad:** `PrintButton.tsx` prints the live hub (`window.print()`). About 370 lines of `@media print` in `globals.css` (from line 1611) try to reshape screen grids. Chromium does not keep flex and grid content together across page breaks, and narrow columns at A4 width give one word per line. `PrintAppendix.tsx` prints raw map URLs.
- **Recommendation:** a dedicated print route rendered by headless Chromium (`playwright-core` with the headless shell).
  - Native CSS paged media. Chrome 131+ supports `@page` margin boxes with `counter(page)` / `counter(pages)` ([Chrome blog](https://developer.chrome.com/blog/print-margins)).
  - Named pages for section headers.
  - `break-before: page` per section, and day blocks with `break-inside: avoid` (never on a flex container).
- **Deployment:**
  - The production web image has no Chromium (Playwright is a devDependency; Railway uses Railpack).
  - A renderer needs a Dockerfile with `playwright install --with-deps --only-shell chromium` ([Railway guide](https://docs.railway.com/guides/playwright)), about 0.5–0.8 GB.
  - Ideally a separate service. **That is an infrastructure change and needs approval.**
- **Fonts:** fall back to Noto Serif JP and Noto Sans JP, with `lang` on place names. Wait for `document.fonts.ready` and image decode before rendering.
- **Time zones:** format with explicit `Intl.DateTimeFormat({ timeZone })` from each base, and set the renderer context's `timezoneId`.
- **Maps in print:** our own SVG — a d3-geo projection over pre-simplified Natural Earth (already an atlas source), persisted Valhalla/ORS leg geometry, numbered pins and attribution. Static-tile options were rejected on terms ([OpenFreeMap ToS](https://openfreemap.org/tos/), [OSM tile policy](https://wiki.openstreetmap.org/wiki/Tile_usage_policy)).
- **QR codes:** `uqr` (MIT, SVG output), plus a short redirect route. Never print raw URLs.
- **Alternatives considered:**
  - Typst is the runner-up.
  - @react-pdf is weak for CJK and has no variable fonts.
  - Paged.js is an upgrade path for per-day running headers.

## 4. Kumano Kodo ground truth (for evaluating the generated trip)

Source: Tanabe City Kumano Tourism Bureau ([difficulty table](https://tb-kumano.jp/en/?p=228), [model itineraries](https://www.tb-kumano.jp/en/?p=317)).

- **Stages:**
  - Takijiri→Takahara: 3.7 km, about 2 h.
  - Takahara→Chikatsuyu: about 9.3 km, about 3.5 h.
  - Chikatsuyu→Hongū: about 25 km, a long day.
  - **Hosshinmon-ōji→Hongū Taisha: 7 km, about 2 h, rating 2** — the family section.
  - Dainichi-goe (Hongū↔Yunomine): 3.5 km, 1 h 15 min.
  - Ogumotori-goe: about 14 km and about 1,260 m of ascent, rating 5.
- **Official trip lengths:** 3 days/2 nights (Highlight) to 6 days/5 nights (Takijiri→Nachi). The classic pilgrimage is 4 days/3 nights.
- **How the region works:** bus, foot and luggage shuttle. Official material never recommends driving.
  - Luggage shuttle: book through Kumano Travel at least 20 days ahead ([luggage](https://www.tb-kumano.jp/en/kumano-kodo/luggage-shuttle/)).
  - Stays: book about 6 months ahead for spring ([planning](https://www.tb-kumano.jp/en/?p=10810)).
  - Buses are infrequent and crowded in spring ([bus](https://www.tb-kumano.jp/en/?p=15951)).
- **Late March:**
  - The Kōyasan→Hongū bus runs only from April 1 to November 30 ([tb-kumano](https://tb-kumano.jp/en/?p=391)).
  - Days are short, so arrive at lodging between 15:00 and 17:00.
  - The Kawayu Sennin-buro river bath runs only December to February ([JNTO](https://www.japan.travel/en/spot/981/)).
- **The generated plan versus this:** 11 nights in Hongū is about double the longest official model, and about 1,382 km of driving is the opposite of how the region is travelled.
- **Advisor judgement for a family seeking rest, about 10 nights:**
  - Kumano for 4–5 nights across 2–3 stays: Kawayu or Yunomine for 3 nights, Katsuura or Nachi for 1, optionally Shirahama for 1.
  - Paired with Kyoto/Nara (likely sakura) and a Kōyasan temple stay.
  - Alternative for pure rest: Kinosaki Onsen ([JNTO](https://www.japan.travel/en/spot/2005/)).

## 5. Routing, trails and transit

- **openrouteservice** (free Standard plan): Directions 2,000/day, Matrix 500/day ([restrictions](https://giscience.github.io/openrouteservice/hosted-api-restrictions)).
  - `foot-hiking` with `elevation=true` gives ascent and descent; these are edge-based and run high.
  - `extra_info=traildifficulty` gives OSM sac_scale ([docs](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/extra-info/trail-difficulty)).
- **Valhalla pedestrian:** `max_hiking_difficulty` defaults to 1, which excludes mountain trails; Kumano needs 2–3 ([API reference](https://valhalla.github.io/valhalla/api/route/api-reference/)).
- **Named trail geometry:** available from OSM hiking relations via Overpass. For example, Nakahechi 17094646, Dainichi-goe 17130940 and Ogumotori-goe 17095001 (verified live).
- **Transit:**
  - Wakayama bus GTFS-JP feeds (meikobus, ryujinbus) are on gtfs-data.jp; per-feed licenses are *unverified*.
  - Self-hosted OpenTripPlanner on GTFS plus OSM is the clean path.
  - Transitous forbids commercial use ([terms](https://transitous.org/api/)).
  - Navitia: 5,000 requests a month, and no evidence of Japan coverage.
  - Rome2Rio: no evidence it takes new developers.
- **Point-to-point hikes as episodes:**
  - Start trailhead, end (usually the next lodging), and a return or onward leg (scheduled bus, taxi, or bags forwarded).
  - A luggage booking deadline.
  - Finish by 15:00–17:00.
  - Stage time from an official course time when one exists, otherwise a Tobler/Naismith estimate labelled as an estimate.
  - Never a car back to the trailhead unless the traveller is driving.
- **Always state as uncertain:** seasonal bus operation and timetables, luggage-shuttle availability, trail closures, sakura timing, and ascent figures.
