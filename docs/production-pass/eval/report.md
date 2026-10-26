# Sidequest live evaluation — open-data scan + planner, no model

Generated 2026-10-25T08:36:52.892Z from `results.json` (33 profiles). Environment: model: none (ANTHROPIC_API_KEY removed); geocoder: nominatim (public); poi: overpass (public, default endpoint rotation) + wikidata; routing: labelled estimates (no router configured).

## Aggregate

| Check | Pass rate |
| --- | --- |
| Board produced (scan ready) | 28/33 (85%) |
| Itinerary produced | 26/33 (79%) |
| Timeouts | 0/33 (0%) |
| Feasibility: feasible | 9/26 (35%) |
| Feasibility: feasible with cautions | 7/26 (27%) |
| Silent anchor loss = 0 | 26/26 (100%) |
| No empty day | 4/26 (15%) |
| No duplicate stop | 26/26 (100%) |
| Every stop in an expected country | 26/26 (100%) |
| No stop beyond scan reach | 26/26 (100%) |
| No zero-minute leg with distance | 26/26 (100%) |
| Car-free trip with no drive leg | 26/26 (100%) |
| No opening-hours conflict | 26/26 (100%) |
| No overpacked day (activities > slots+1) | 26/26 (100%) |
| No day overrunning its window by >30 min | 26/26 (100%) |
| Lunch on ≥ half the days | 20/26 (77%) |
| Dinner on ≥ half the days | 26/26 (100%) |
| Quality audit: no failed check | 9/26 (35%) |
| Budget estimate present | 26/26 (100%) |

Legs across all completed plans: measured 16, scheduled 0, geo_estimate 383, model_estimate 0, modelled 0, unknown 13, zeroWithDistance 0.

## Latency (seconds)

Over every run that reached the stage (failures included where the stage ran).

| Stage | n | p50 | p90 | p95 | max |
| --- | --- | --- | --- | --- | --- |
| resolve | 32 | 1.9 | 3.0 | 3.6 | 7.2 |
| scan_propose | 28 | 1.1 | 11.0 | 79.2 | 86.7 |
| scan_place | 28 | 0.0 | 0.0 | 0.0 | 0.0 |
| scan_time | 28 | 0.0 | 0.0 | 0.0 | 0.0 |
| scan_food | 28 | 0.0 | 0.0 | 0.0 | 0.0 |
| scan_assemble | 28 | 0.0 | 0.0 | 0.0 | 0.0 |
| scan_total | 32 | 1.1 | 11.0 | 79.3 | 86.8 |
| autopick | 29 | 0.0 | 0.1 | 0.1 | 0.3 |
| build | 29 | 2.2 | 3.0 | 3.3 | 3.9 |
| total | 33 | 5.3 | 15.5 | 86.3 | 90.8 |

Time to plan (completed trips only, n=26): p50 5.0 s, p90 12.5 s, p95 15.5 s.

## Per profile

| Profile | Outcome | Resolved as | Scan (cands/placed, groups failed) | Feasibility | Days | Stops/day | Max/mean travel min | Legs m/geo/unk | Wrong-country | Max km | Dups | Kinds | Lunch/Dinner days | Overpacked | Audit fails | Total s |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| switzerland-rail | failed @build: build: Your Discovery Board doesn’t have enough places to fill every day. Nothin | Switzerland (country, CH) | ready 22/22, 0/7 failed | – | – | – | – | – | – | – | – | – | – | – | – | 90.8 |
| zurich-carfree-short | complete | Zurich (settlement, CH) | ready 21/21, 0/6 failed | feasible_with_cautions | 3 | 2,3,1 | 120/70 | 0/8/1 | 0 | 11 | 0 | 4 | 1/2 | 0 | meals_present(warning) | 5.4 |
| zermatt-winter | complete | Zermatt (settlement, CH) | ready 18/18, 0/6 failed | feasible | 5 | 0,1,3,1,0 | 135/53 | 0/8/0 | 0 | 7 | 0 | 3 | 1/4 | 0 | 0 | 4.9 |
| iceland-ring | complete | Iceland (country, IS) | ready 40/40, 0/7 failed | unresolved_major_dependency | 13 | 0,1,2,1,1,1,1,1,1,1,2,2,0 | 255/149 | 0/25/0 | 0 | 138 | 0 | 6 | 8/12 | 0 | frequency_honoured(warning) | 4.4 |
| reykjavik-winter | complete | Reykjavik (settlement, IS) | ready 13/13, 0/6 failed | feasible_with_cautions | 5 | 0,2,2,2,0 | 65/20 | 0/7/1 | 0 | 4 | 0 | 4 | 3/4 | 0 | frequency_honoured(warning) | 3.9 |
| japan-family | failed @build: build: Your Discovery Board doesn’t have enough places to fill every day. Nothin | Japan (country, JP) | ready 40/40, 0/7 failed | – | – | – | – | – | – | – | – | – | – | – | – | 7.6 |
| tokyo-carfree | complete | Tokyo (country, JP) | ready 34/34, 0/7 failed | unresolved_major_dependency | 6 | 1,4,4,4,2,0 | 155/102 | 0/19/1 | 0 | 45 | 0 | 6 | 4/5 | 0 | frequency_honoured(warning) | 11.5 |
| kyoto-temples | complete | Kyoto (district, JP) | ready 18/18, 0/6 failed | feasible_with_cautions | 5 | 0,2,2,2,0 | 90/44 | 0/8/1 | 0 | 4 | 0 | 4 | 3/4 | 0 | 0 | 5.4 |
| kyrgyzstan-trek | complete | Kyrgyzstan (country, KG) | ready 32/32, 0/7 failed | unresolved_major_dependency | 13 | 0,1,1,1,2,2,1,1,1,1,1,2,0 | 290/137 | 0/24/0 | 0 | 147 | 0 | 5 | 7/12 | 0 | 0 | 4.7 |
| kenya-tanzania | failed @build: build: Your Discovery Board doesn’t have enough places to fill every day. Nothin | Kenya and Tanzania (country, KE/TZ) | ready 28/28, 0/7 failed | – | – | – | – | – | – | – | – | – | – | – | – | 5.9 |
| california-roadtrip | complete | California (region, US) | ready 19/19, 0/7 failed | feasible | 15 | 0,2,1,1,1,2,1,1,1,1,1,1,1,1,0 | 290/142 | 0/28/0 | 0 | 124 | 0 | 6 | 7/14 | 0 | frequency_honoured(warning) | 5.5 |
| mammoth-lakes | complete | ? (?, ?) | authored_region 0/0 | unresolved_major_dependency | 5 | 1,3,2,4,1 | 170/65 | 16/0/0 | 0 | – | 0 | 7 | 2/4 | 0 | frequency_honoured(warning) meals_present(warning) | 2.3 |
| paris-seniors | complete | Paris (settlement, FR) | ready 30/28, 0/6 failed | feasible_with_cautions | 6 | 0,2,2,2,2,0 | 85/45 | 0/10/2 | 0 | 6 | 0 | 5 | 4/5 | 0 | 0 | 15.5 |
| nyc-family | complete | New York (district, US) | ready 34/34, 0/6 failed | feasible | 6 | 0,3,3,3,3,0 | 145/49 | 0/14/0 | 0 | 12 | 0 | 5 | 4/5 | 0 | 0 | 5.3 |
| mexico-city-food | complete | Mexico City (district, MX) | ready 38/38, 0/7 failed | feasible_with_cautions | 7 | 0,3,3,3,3,3,0 | 150/84 | 0/16/4 | 0 | 19 | 0 | 6 | 5/6 | 0 | 0 | 12.5 |
| seoul-friends | complete | Seoul (district, KR) | ready 26/26, 0/6 failed | feasible | 6 | 1,2,4,4,4,1 | 150/79 | 0/20/0 | 0 | 12 | 0 | 5 | 3/5 | 0 | meals_present(warning) | 5.0 |
| istanbul-early-dep | complete | Istanbul (settlement, TR) | ready 23/22, 0/6 failed | feasible | 5 | 0,3,3,3,0 | 115/37 | 0/10/0 | 0 | 8 | 0 | 4 | 3/4 | 0 | 0 | 6.4 |
| scottish-highlands | complete | Scottish Highlands (district, GB) | ready 38/38, 0/7 failed | unresolved_major_dependency | 9 | 0,3,3,2,2,3,2,2,0 | 195/96 | 0/24/0 | 0 | 70 | 0 | 5 | 6/8 | 0 | frequency_honoured(warning) | 6.5 |
| faroe-islands | complete | Faroe Islands (country, FO) | ready 25/25, 0/7 failed | unresolved_major_dependency | 6 | 0,2,4,2,4,1 | 170/88 | 0/18/0 | 0 | 31 | 0 | 5 | 2/5 | 0 | meals_present(warning) | 4.8 |
| vienna-wheelchair | complete | Vienna (settlement, AT) | ready 30/30, 0/6 failed | feasible_with_cautions | 5 | 0,2,2,2,0 | 80/35 | 0/7/2 | 0 | 6 | 0 | 5 | 3/4 | 0 | 0 | 6.0 |
| nz-south-island | complete | South Island (region, NZ) | ready 14/14, 0/7 failed | unresolved_major_dependency | 16 | 0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0 | 180/111 | 0/28/0 | 0 | 67 | 0 | 5 | 10/15 | 0 | frequency_honoured(warning) | 4.5 |
| costa-rica-family | complete | Costa Rica (country, CR) | ready 35/34, 0/7 failed | feasible | 10 | 0,2,2,2,2,1,2,2,1,1 | 170/100 | 0/22/0 | 0 | 100 | 0 | 5 | 8/9 | 0 | meals_present(warning) | 3.8 |
| marrakech | complete | Marrakesh (settlement, MA) | ready 14/14, 0/6 failed | feasible | 5 | 0,3,3,3,1 | 65/35 | 0/12/0 | 0 | 2 | 0 | 3 | 3/4 | 0 | frequency_honoured(warning) meals_present(warning) | 4.9 |
| norway-fjords | complete | Norwegian fjords (region, NO) | ready 40/40, 0/7 failed | unresolved_major_dependency | 9 | 0,3,3,2,3,2,3,1,0 | 205/73 | 0/21/0 | 0 | 74 | 0 | 7 | 7/8 | 0 | frequency_honoured(warning) | 8.8 |
| lake-district-seniors | complete | Lake District (district, GB) | ready 32/32, 0/7 failed | unresolved_major_dependency | 6 | 0,2,2,2,1,0 | 110/54 | 0/11/0 | 0 | 47 | 0 | 4 | 4/5 | 0 | frequency_honoured(warning) | 5.8 |
| amalfi-carfree | complete | Amalfi Coast (settlement, IT) | ready 34/33, 0/7 failed | feasible | 6 | 0,2,2,2,1,0 | 150/82 | 0/10/0 | 0 | 52 | 0 | 3 | 4/5 | 0 | frequency_honoured(warning) | 4.9 |
| patagonia-long | failed @scan: scan failed: composer_not_configured | Patagonia (settlement, CO) | failed 0/0 | – | – | – | – | – | – | – | – | – | – | – | – | 79.0 |
| atacama | failed @scan: scan failed: composer_not_configured | Atacama Desert (district, CL) | failed 0/0 | – | – | – | – | – | – | – | – | – | – | – | – | 0.0 |
| alaska | failed @scan: scan failed: composer_not_configured | Alaska (country, US) | failed 0/0 | – | – | – | – | – | – | – | – | – | – | – | – | 0.0 |
| canadian-rockies | failed @scan: scan failed: composer_not_configured | the Canadian Rockies (district, CA) | failed 0/0 | – | – | – | – | – | – | – | – | – | – | – | – | 0.2 |
| rome-48h | complete | Rome (district, IT) | ready 25/25, 0/6 failed | feasible_with_cautions | 3 | 3,4,0 | 80/27 | 0/4/0 | 0 (+1?) | 2 | 0 | 3 | 1/2 | 0 | 0 | 4.3 |
| lisbon-short-solo | complete | Lisbon (settlement, PT) | ready 23/23, 0/6 failed | feasible | 4 | 1,4,4,1 | 125/64 | 0/12/0 | 0 | 6 | 0 | 4 | 2/3 | 0 | frequency_honoured(warning) meals_present(warning) | 3.9 |
| bali-friends | complete | Bali (subregion, ID) | ready 35/34, 0/7 failed | unresolved_major_dependency | 9 | 0,3,1,2,1,1,1,2,0 | 165/108 | 0/17/1 | 0 | 55 | 0 | 7 | 6/8 | 0 | frequency_honoured(warning) | 86.3 |


## Findings (lead, 2026-10-25)

**What changed between runs.** Run 1 (public Overpass only): 4/31 itineraries. Overpass's public instances were throttling (overpass-api.de 406/timeouts, two mirrors timing out, overpass.osm.ch answering *empty* outside Switzerland) and every request group waited 25 s per dead endpoint. After the production-pass fixes — Wikidata Query Service first (`providers/wikidata-around.ts`), Overpass merged only while thin, a process-wide endpoint cooldown, osm.ch out of the rotation, the bare-name prominence rule ("Rome" read Rome, Georgia) and the alias filter ("Bali" read Paris) — the same harness produced the table above.

**Remaining failures, by cause.**
- *Thin board for a whole country* (Switzerland 10 days, Japan, Kenya–Tanzania): the open-data pool is one box around one centre, so a country-scale trip gets too few places per base and the planner refuses rather than leave days empty. Needs per-part / per-base queries.
- *Broad wilderness regions* (Alaska, the Canadian Rockies, the Atacama): almost nothing above the notability floor within one radius of the centroid. Same fix.
- *Patagonia* resolves to a Colombian settlement: with no model, the region interpreter is unavailable and the gate accepts a same-named town weakly.

**Quality, read from the plans (not only the metrics).** Tokyo: geographically coherent days (Skytree → Sensō-ji → Ueno; a Kamakura day trip). Paris: Eiffel Tower, Orsay, Tuileries, Panthéon. Weak spots: meals are area-level placeholders whenever food data is unavailable (Overpass), some trips leave days thin while board places go unused, religious sites are over-represented for food-and-neighbourhood travellers (Wikidata sitelinks favour them), and every leg is a labelled distance estimate because no router key (`OPENROUTESERVICE_API_KEY`) is configured.

**Not measured here.** The model-proposed scan (the primary path) and model-composed builds: the Anthropic key is invalid, so no live model latency or quality exists for this pass.
