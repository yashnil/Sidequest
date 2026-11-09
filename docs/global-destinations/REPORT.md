# Global destination intelligence — implementation notes (2026-11-08)

"Help me choose" used to rank 234 hand-written destinations. It now ranks the
world: **36,635 recommendable destinations in 227 countries and territories**,
derived offline from open data, with the 234 curated entries kept as the
editorial layer of the same world. This document is the record of what was
built, from what, how it is evaluated, and where it is still weak.

Branch `feat/trip-experience-release-pass`. Baseline for every comparison:
commit `596ece1`.

---

## 1. Architecture

```
            OFFLINE (packages/atlas/build, ~10 min, no product dependency)
 Wikivoyage dump ─┐
 Wikidata (WDQS) ─┼─► 04 candidates ──► 05 rasters (CHELSA · ETOPO · OISST) ──► 06 assemble ──► atlas.json.gz (10.5 MB)
 OurAirports ─────┤        │                                                         ▲            embeddings.json.gz (6.0 MB)
 curated catalog ─┘        └────► 07 embeddings (static model) ───────────────────────┘            manifest.json
 price levels, advisories ──────────────────────────────────────────────────────────►

            REQUEST TIME (no download, no model by default)
 free text ─► parse.ts ──────────────► TripComposerAnswers (+ discovery: within / outside / similarTo / terms / phrase)
              │  └ Atlas.findPlaces: "in the Karakoram" (scope) · "like the Dolomites" (similar) · "not Bali" (avoid) · "from Delhi" (origin)
              ▼
 Atlas.candidates      one pass over all 36.8k rows: scope → offer·want → activity season → lexical + meaning match → resemblance
              ▼        ≈ 900 candidates (+ every curated entry in scope)
 score.ts              the twelve-factor reading, hard constraints, confidence discount, substance
              ▼
 select.ts             relevance floor · lead floor · same-ground suppression · MMR
              ▼
 advise.ts             words: why, when by activity, what is estimated, what is unverified
              ▼
 climate check (live, deadline 9 s, top six only)  ──►  stored AdvisorShortlist  ──►  screen
              ▼ (only when the list is weak — after it is already on screen)
 research.ts           one bounded model call proposes NAMES → resolved against the atlas or dropped → re-ranked by the same scorer
```

Design decisions and the reasons for them:

- **A shipped artifact, not a service.** The deployment is one Node process on
  Railway with SQLite. A columnar JSON file decoded into typed arrays (≈ 250 ms
  once, ≈ 80 MB resident with the embedding matrix) needs no new
  infrastructure, cannot be down, and makes a rebuild a reviewable commit.
  Tens of thousands of rows are four orders of magnitude below where a vector
  database earns its keep: a full scan with a season lookup is 3–5 ms.
- **One world.** Each curated entry *replaces* the derived row for the same
  place (216 of 234 have a twin, matched by Wikidata QID or name and distance)
  and inherits its hierarchy and its measured climate. There is no "catalog
  mode" and "atlas mode"; if the artifact is missing the world degrades to the
  curated rows and the shortlist says so.
- **Two stages.** The first pass exists so the careful reading is spent where
  it can matter; it is deliberately generous (900 of 36.8k) and never a
  verdict. Hard constraints are applied only by the detailed scorer.
- **Measured ≠ estimated ≠ editorial**, carried on every record
  (`origin`, `basis`, `confidence`, `substance`) and said on every card.
- **The model is not the optimiser.** No model call ranks, scores, filters or
  describes. The one optional call proposes names and nothing else.
- **One engine.** The previous recommender (`packages/core/src/recommend/`,
  `lib/destinations/recommend.ts`, `DecisionComposer`, `ShortlistView`, the old
  `/decide` actions — 24 files) is deleted. `/decide` and `/decide/[id]` keep
  their URLs; a session stored by the old engine loads with its answers and
  re-enters the interview. Guard tests that policed the old engine were
  re-pointed at the surviving one rather than removed.

Key files: `packages/core/src/atlas/{atlas,seasonality,lexical,embed}.ts`,
`packages/core/src/advisor/{destination,parse,score,select,advise,interview-policy}.ts`,
`packages/core/src/naming/place-words.ts`, `packages/atlas/{build,src}`,
`apps/web/src/lib/atlas/{world,research}.ts`,
`apps/web/src/app/(product)/decide/advisor-actions.ts`,
`apps/web/src/components/advisor/`.

## 2. Coverage and counts

| | |
|---|---|
| Rows in the artifact | 36,816 (34 are scope-only: continents and their sections) |
| Recommendable destinations | **36,635** (rows with a measured climate, curated counted once) |
| Countries and territories | 227 |
| From Wikivoyage guides | 28,978 |
| From Wikidata alone (no guide exists) | 7,804 |
| Curated (editorial) | 234 |
| With measured monthly climate | 36,616 of 36,782 (the rest are sea-centred specks with no land cell within 30 km) |
| With a separate high-country climate | 12,843 |
| With sea-surface temperature | 18,065 |
| With a published price level | 35,507 |

By kind: town 17,181 · travel region 4,287 · city 4,193 · national park 3,151 ·
island 2,322 · mountain range 1,655 · protected area 1,551 · island group 947 ·
lake 399 · route 371 · coast 238 · ski area 215 · country 207 · desert 99.

By world region (every one of the 24 has at least 186): Eastern North America
5,295 · Northern Europe 3,518 · Southern Europe 3,102 · East Asia 2,516 ·
Western North America 2,447 · South Asia 2,299 · Western Europe 2,287 ·
Southeast Asia 2,239 · Central & Eastern Europe 1,798 · Australia & NZ 1,761 ·
Northern South America 1,517 · Mexico & Central America 1,186 · West & Central
Africa 1,110 · Middle East 1,006 · Southern Africa 642 · Caucasus & Central
Asia 619 · Polar 558 · Southern South America 519 · Pacific Islands 490 · East
Africa 456 · North Africa 406 · Caribbean 372 · Alaska & Northern Canada 306 ·
Indian Ocean 186. Full tables, including destinations strong on each of the 24
experiences and good months per activity: `benchmark/coverage.md`.

The distribution follows where English-language open guides are densest
(North America and Europe hold 51 %). That is a property of the sources, and
it is the reason data-only rows exist: 7,804 places are in the atlas because
Wikidata knows them as a park, a range or an island, not because anyone wrote
a guide.

**A geographic entity is not a holiday.** Whether a row is a multi-day
destination is `substance` (0–1): the guide's status and length, things listed
to see and do (its own and its districts'), places to sleep, and whether a
country or region page lists it among its handful of cities or "other
destinations". Rows below 0.22 are not offered on their own (they are still
reachable inside a named area and by name); above it, substance scales the
score by at most 15 %, so it settles close calls and never lets fame outrank
fit. City districts, airports, phrasebooks and topics are not destinations.

## 3. Data sources and licensing

| Source | Used for | Licence | Access | Update | Cost |
|---|---|---|---|---|---|
| **Wikivoyage** (English) | Which places are destinations, the travel hierarchy, guide-text evidence, listed sights, first-sentence descriptions | CC BY-SA 4.0 — attribution shown on every shortlist and each card links its article | 132 MB dump, parsed in 30 s | twice monthly | free |
| **Wikidata** | Stable identity (QID), aliases, country, population, area, sitelinks; ~62,000 notable features in 68 classes | CC0 | Query Service: one query per class or per 150 items, cached | live | free; 60 s query limit |
| **CHELSA V2.1** 1981–2010 normals | Monthly mean daily max/min temperature and precipitation at 30″ | CC0 (per chelsa-climate.org; the files carry no licence attribute) | 36 NetCDF files, 6 GB, once | static | free |
| **ETOPO 2022** 60″ | Elevation, the highest ground in a destination, relief, land/sea mask | Public domain (NOAA NCEI) | one file, 478 MB | static | free |
| **NOAA OISST v2.1** 1991–2020 monthly mean | Sea-surface temperature of the nearest sea | Public domain (NOAA) | one file, 46 MB | static | free |
| **OurAirports** | Airports with scheduled service and an IATA code | Public domain | one CSV, 13 MB | nightly | free |
| **World Bank WDI** | Household-consumption price level by country | CC BY 4.0 | already in the repo | annual | free |
| **U.S. State Department advisories** | Country advisory level with its date | Public domain | one JSON request | continuous | free |
| **potion-base-8M** (model2vec) | Static embeddings: a 28k-token lookup table, no inference | MIT | 30 MB, once | static | free |
| **Open-Meteo** ERA5 archive (existing) | Live check of the six picks on screen only | CC BY 4.0, non-commercial free tier | per shortlist, cached 30 days | live | free tier |

Evaluated and not used: **WorldClim** (non-commercial licence), **TerraClimate**
(public domain and it carries snow-water equivalent, but its only host refused
connections for the whole session — the snowpack is modelled from CHELSA
instead), **Open-Meteo for bulk normals** (a 20-year archive read is ~500
weighted calls per point: 19 points a day on the free tier), **Overture/OSM
places** (the scan already uses them per destination; as a global offline layer
they add POI density, which the old recommender showed is not evidence of a
holiday), **OpenTripMap** (ODbL share-alike and a rate-limited API; Wikidata
covers the same notable features under CC0), **GeoNames/Natural Earth** (no
travel signal beyond what Wikidata and ETOPO give), **Google Places** (terms
forbid storing names — `BLOCKER-google-terms.md`).

Reliability notes found the hard way: `curl` reported success on a truncated
478 MB download (the sampler now refuses a NetCDF whose header disagrees with
its size); CHELSA's files are global with no fill over ocean, so land/sea comes
from ETOPO + OISST connectivity; CHELSA's day–night range collapses on small
islands (Honolulu's February high read 23.6 °C against a measured 27), so the
high and low are restored around the unchanged monthly mean where the range is
under 7 °C; several Wikidata class ids recalled from memory were wrong (a
"game reserve" id was a medieval judge), so every class id is verified by
label on every run.

## 4. Retrieval and ranking

**Identity and hierarchy.** A destination is `wv:<Wikivoyage title>`,
`wd:<QID>` or a curated slug, with its Wikidata item, aliases, country, extent
and its chain of ancestors from Wikivoyage's traveller-drawn `IsPartOf`
hierarchy. Regions nothing is filed under (the Alps, Patagonia) are defined by
the regions they list. Two records are the same ground when one is an ancestor
of the other, they share a QID, or one centre sits well inside the other's
extent — and the same ground is never offered twice (0 overlapping pairs across
the benchmark; the old system had 1).

**Reading the request.** The deterministic phrase table still reads when, how
long, budget, party, transport and interests. New: `Atlas.findPlaces` reads
the places a sentence names and the role the surrounding words give each —
a scope ("in the Karakoram", "Thai islands", "US national parks", "a Himalayan
trek"), a comparison ("like the Dolomites"), a refusal ("not Bali", "quieter
than Chamonix and Zermatt", "I have done Nepal") or an origin ("from Delhi").
A named place is never the answer itself. Ordinary words are not places
whatever their capital letter ("Desert trip…", "Nice beaches…"), and the
language tables this needs are data in `naming/place-words.ts`. What is left of
the request after filler and generic interest words — "tea plantations",
"karst", "orangutans" — is kept for retrieval.

**Candidate generation** (`Atlas.candidates`, one pass, 3–5 ms):

- *structured*: the traveller's experience weights against each row's 24
  estimated scores;
- *seasonal*: the activity-by-month table (§5) for the wanted activities in the
  wanted months;
- *lexical*: a BM25-style index of ~30 terms per guide (rare proper nouns and
  the subjects a guide keeps returning to);
- *semantic*: a 96-dimension static embedding of each guide against the
  request's own words;
- *geographic*: scope by hierarchy, by country, by members, or by extent;
- *resemblance*: cosine of experience profiles to a named place.

**Embeddings were adopted on evidence, as a second channel.** Measured on
1,500 known-item queries and against the curated labels
(`.atlas-cache/work/embeddings-eval.json`):

| | Recall@10 (find the place) | nDCG@10 (rank by experience) |
|---|---|---|
| Lexical | **0.58** | 0.39 |
| Static embedding, 96-d int8 | 0.12 | 0.60 |
| Fused, lexical dominant | 0.54 | **0.61** |

Lexical is far better at finding a place; the embedding is better at ranking
by experience and wins on phrasing no guide uses ("remote monasteries and high
passes"). Equal-weight fusion *hurt* recall (0.58 → 0.36), so the lexical score
leads and the meaning score is added at a discount. The static model needs no
inference runtime: a query is a tokeniser, a table lookup and an average
(0.03 ms), held to the Python build by a parity test.

**Detailed scoring** is the existing factor model — experience, season,
climate, duration, budget, adventure, reach, getting around, crowds, novelty,
group, resemblance — with these changes:

- *Uncertainty.* A derived reading is discounted by its confidence (half of it
  is always kept, the other half scales with evidence); an unknown suitability
  (children, mobility, getting around) counts as a cautious middle, never as a
  pass and never as an exclusion; a hard exclusion needs a reading somebody
  stands behind, so an *estimated* difficulty can lower a score but cannot rule
  a place out.
- *The request's words can lift a place, never sink one.*
- *Popularity is not a factor.* Sitelinks feed only `familiarity`, which counts
  only against a stated appetite for classics or for the unusual.
- *No geographic quota.* Diversity is MMR over experience profile and
  geography with a relevance floor; it removes repeats, it does not import
  weaker places for balance.
- *Nothing fits.* When no candidate clears the bar the closest are shown as a
  stretch with the constraint that holds them back, rather than an empty page.

**Safety.** A fresh "do not travel" advisory removes a country's destinations
(with the source and date in the read-out); once the snapshot is older than
180 days it is shown as a caution to check instead — stale ≠ current. "Reconsider
travel" is a line on the card.

**AI-assisted discovery** (`lib/atlas/research.ts`). At most one call per
shortlist, only when the deterministic list is weak (fewer than three picks, a
best score under 0.7, or a request made of words no interest holds), made
*after* the list is on screen, with a strict schema (names and countries only),
twenty seconds, no retry, cached thirty days, charged to the daily ledger. Each
name is resolved against the atlas — an invented place, or a real name in the
wrong country, is dropped — and the survivors join the candidates under the
same constraints and scorer. A pick that came from there says so.

## 5. Activity-specific seasonality

`packages/core/src/atlas/seasonality.ts` answers *this activity, this place,
this month* for fifteen activities from measured normals:

- climate **where people stay** — the base town of a region, not its geometric
  centre (the Big Island's centre is a 2,400 m saddle; its towns are on the
  coast) — and **at trekking altitude**, interpolated between the base and the
  highest ground with the destination's own lapse rate;
- a **modelled snowpack** (degree-day, run to equilibrium) at the base, on the
  high trails and at lift level; the high trails are placed on the highest
  ground that actually melts out, so a Patagonian ice cap is not called a trail;
- **sea-surface temperature** for swimming and diving, separately from the air;
- **rainfall** for the monsoon, the safari dry season, rainforest and road
  conditions; **day length** from latitude; tropical-cyclone basins as a
  historical likelihood.

A traveller's season at a place weights each wanted experience's activity by
how much they want it *and* how much the place offers it. Where a person wrote
an overall season curve it gates the answer: an editor's "avoid" holds, and an
editor's "best" cannot make a snowbound trail walkable. Every card carries the
sentence a single "in season" badge cannot: *"The high trails: usually
July–September. Walking and day hikes: usually April–October (from 1981–2010
climate normals)."* — always "usually".

What this fixed, from the benchmark: Tyrol and the Dolomites no longer count as
in season for March hiking; "Thai islands in August" answers with the Gulf
side (Ko Samui, Ko Pha-ngan) because the Andaman side's normals are in the
monsoon; "skiing in August" answers with Queenstown, Bariloche and Chilean
resorts; "beach in Europe in April" says plainly that the sea is cold
everywhere and offers the closest.

## 6. Real requests

Old system → new system, primary picks (° = read from open data). All from
`benchmark/comparison.md`, which has all 147.

| Request | 234-destination advisor | Global atlas |
|---|---|---|
| Budget trekking in the Karakoram in July | Cordillera Blanca · Transylvania · Issyk-Kul | Ladakh · Jammu and Kashmir° · Hunza Valley° |
| Volcanoes and beaches in Hawaii, February | Guadeloupe · Tenerife · Tongariro | Maui° · Oahu° · Kailua-Kona° |
| Spring cultural trip in Japan | Andalusia · Yucatán · Dakar | Kyoto & Nara · Tohoku° · Chugoku° |
| Remote hiking in Central Asia, August | Issyk-Kul · Kazbegi · Kaçkar | Issyk-Kul · Fann Mountains · Song-Kul & Naryn |
| Tropical islands in Indonesia, not Bali | Society Islands · Corsica · São Tomé | Komodo & Flores · Sumba · East Java° |
| Underrated European city, cheap, October | Porto · Lake Ohrid · Picos de Europa | Porto · Skopje° · Budapest° |
| Thai islands in August — which side? | Dalmatian Coast · Rio · Ningaloo | Ko Samui° · Pattaya° · Ko Pha-ngan° |
| Skiing in August | *(nothing)* | Queenstown & Wānaka · Svalbard · Bariloche |
| Like the Dolomites, less crowded, cheaper | Amalfi Coast · Banff · Great Barrier Reef | High Atlas · Rila & Pirin · Drakensberg |
| A classic Himalayan trek in October | High Atlas · Everest Region · Tenerife | Annapurna Region · Everest Region · Langtang Valley |
| China beyond Beijing and Shanghai | Amalfi Coast · Kyoto · Santa Fe | Yunnan · Xi'an° · Fujian° |
| Caves, karst and underground rivers | Amalfi Coast · Florida Keys · Buenos Aires | Moravian Karst° · Mole Creek Karst° · Jingxi° |
| Northern lights and dog sledding, February | Bernese Oberland · Niseko · Tromsø | Swedish Lapland · Tromsø · East Norway° |
| US national parks in October | Utah Canyon Country · Petra · Salta | Utah Canyon Country · Grand Canyon · Colorado° |

Unchanged where the old system was already right (Patagonia in January, an
August safari, a family beach trip): the curated entries still lead, which is
the intended behaviour of an editorial layer.

## 7. Before and after

147 requests (`packages/core/src/advisor/eval/benchmark/requests.ts`): the
brief's fourteen trip types in several phrasings, plus mountains, sea, wildlife,
cities, road trips, budget, distance, party, seasons that bite, and vague,
contradictory and niche requests. Each carries checks that are properties of
the world — where a pick is, whether the requested activity is feasible there
in those months by climate normals, the country's price level, the distance —
never a list of expected places. Both systems are scored against the same
ground truth. (The activity model is the product's own, applied to an activity
the request names: a consistent yardstick for both systems, not an independent
oracle.)

| | 234-destination advisor | Global atlas |
|---|---|---|
| Objective checks passed | 194 / 300 (65 %) | **270 / 300 (90 %)** |
| Requests passing every check | 46 / 131 | **104 / 131** |
| Requests answered with three picks | 142 | 144 |
| Requests answered with nothing | 1 | 0 |
| Requests improved / unchanged / worse | — | 66 / 80 / **1** |
| Distinct destinations recommended | 158 | 279 |
| Share of picks from open data | 0 % | 38 % |
| Overlapping pairs among primary picks | 1 | 0 |
| Named-destination recall (223 real places, famous and obscure) | 106 | **218** |
| Same answer on a second run | 147 / 147 | 147 / 147 |
| Same answer after rewording ("… Thanks!") | — | 147 / 147 |
| Derived picks carrying source, basis and caveat | — | 411 / 411 |

By trip type (checks passed, before → after): culture 20 → 32 of 32 · city
break 18 → 23 of 23 · road trip 11 → 15 of 15 · similar-to 11 → 15 of 15 ·
hiking 27 → 33 of 34 · trekking 11 → 18 of 21 · islands 8 → 15 of 18 · beach
9 → 14 of 16 · diving 2 → 5 of 5 · reach 9 → 12 of 12 · seasonality 11 → 17 of
23 · wildlife 6 → 9 of 12 · winter 5 → 7 of 10 · rainforest 4 → 5 of 6 · rail
4 → 4 of 6 · **safari 7 → 6 of 9**.

**The one regression** is "affordable self-drive safari in southern Africa":
Kruger stays first, but the new second and third picks (Zambia, Okavango–Chobe)
are derived rows whose *estimated* safari score is below the check's bar even
though both are real safari country. It is the estimator's weakest experience
(§9), not a wrong place.

**The existing 42-scenario evaluation** (curated entries only, measured
climate attached) passes 48 of 48 — the scorer's behaviour on the editorial
catalog is preserved.

**Blinded qualitative read.** See §7b.

## 7b. Blinded qualitative evaluation

The objective checks test properties; whether a list is *good advice* is a
judgement. Both systems' primary picks for all 147 requests were written as
anonymous lists X and Y in a seeded, per-request shuffled order
(`packages/atlas/build/blind-pairs.mjs` → `blind/blind.json`; the key was
withheld) and rated 1–5 by a separate model instance instructed to act as an
experienced travel advisor and to read nothing else (`blind/ratings.json`,
joined in `blind/summary.json`). **This is a model's judgement, not a human
panel**, and it rates names and contexts only — it cannot see seasons notes or
provenance.

| | Fit | Defensible | Variety | Preferred |
|---|---|---|---|---|
| 234-destination advisor | 2.50 | 2.66 | 2.92 | 31 of 147 |
| Global atlas | **3.50** | **3.35** | **3.31** | **97 of 147** |
| Tie | | | | 19 |

The rater described the pattern as bimodal: in most requests one list was on
the named geography and in season and the other was on the wrong continent.
Where the *old* list was preferred (31), the reasons fall into five groups, and
each is a real weakness of the new system:

1. **Whole countries offered as picks** ("Three weeks in Southeast Asia" →
   three countries; "somewhere warm and cheap in February" → the Philippines,
   Colombia). Defensible for a long trip, vaguer than a destination.
2. **Text-match noise when nothing structured was read.** "Spectacular scenery
   that works for a wheelchair user" returned Brighton, Narrabri and
   Watsonville — ordinary towns whose guides mention wheelchair access;
   "luxury resorts on a tight budget" and the misspelled request returned
   similarly arbitrary places. The old system's generic curated answers were
   better here.
3. **A curated classic displaced by a looser fit** (Maasai Mara by Rajasthan
   for a February safari; Tenerife dropped from winter-sun walking out of
   Manchester in favour of Phoenix and São Tomé; the Tour du Mont Blanc from
   hut-to-hut hiking in September).
4. **Same three places in a worse order** (several family and road-trip
   requests).
5. **A place no advisor would name** (Port Moresby for a snorkelling escape
   from Sydney).

Both systems were rated weak on: two nights from Paris (neither offered the
Loire or Burgundy), a cold Atlantic coast with seabirds, Atlantic islands for
winter hiking from Madrid, a wine region, autumn foliage, road cycling, and
orangutans — requests whose decisive word ("Atlantic", "wine", "foliage",
"cycling") is not an interest either system models.

## 8. Tests, latency and cost

**Tests added** (all against real data, no mocked atlas):

- `packages/atlas/src/atlas.test.ts` — 20 tests on the shipped artifact:
  coverage of every world region, every curated entry present once with its
  editorial reading intact, hierarchy, base-town climate, estimate/measurement
  labels, place-name roles, scopes, ruled-out places, activity seasons by
  measured climate, no repeated ground, provenance on every card, advisory
  freshness, build/runtime vocabulary parity.
- `packages/core/src/atlas/seasonality.test.ts` — 11 tests: ski ≠ hiking
  season, valley before high trails, two coasts of one country, sea vs air,
  the dry-season rule, snowpack, trek altitude, day length.
- `packages/core/src/atlas/embed.test.ts` — 68 tests holding the TypeScript
  tokeniser and query embedding to the Python build.
- `apps/web/src/lib/atlas/research.test.ts`, `world.test.ts`,
  `lib/destinations/advisor.test.ts` — an invented or misplaced suggestion is
  dropped; a suggestion cannot pass a hard constraint; research is not asked
  for a confident list; a missing artifact degrades to the curated catalog;
  a climate provider that errors, hangs or is off changes only the weather line.
- `apps/web/src/app/(product)/decide/advisor-actions.ownership.test.ts` — 27
  tests: every advisor action refuses a foreign or unowned session before the
  rate fence; start, build, refine, widen, imagery and the interview step are
  rate-limited.
- `apps/web/src/components/advisor/*.test.ts` — 41 tests on the interview
  sequencing, copy and static renders, including a guard that no client file
  names the catalog or the ranking.
- Guard tests re-pointed at the new engine: the ranking imports no model,
  provider, SDK or `fetch`; `packages/core/src/atlas` names no country.

**Latency** (one process, Apple silicon, no network; measured by the benchmark
harness over 147 requests):

| | |
|---|---|
| Artifact load (once per process) | 220–320 ms; +30 ms for embeddings |
| First request (builds the season table and the postings) | ≈ 0.8 s |
| Parse + rank, warm — p50 / p95 / max | **31 ms / 58 ms / 150 ms** |
| Old system, same requests — p50 / p95 | 1.2 ms / 3.9 ms |
| Interview step (server action; ~40 re-rankings on 160 candidates) | ≈ 0.3–0.6 s |
| Live climate check of the six picks | unchanged: 2.9 s p50, 9 s deadline, never blocks on failure |
| Resident memory for the atlas | ≈ 80 MB |

The interview moved from the browser to a server action because the browser can
no longer hold the world; the questions themselves remain client data, and the
scoring engine no longer ships in the client bundle.

**Cost.** Zero model calls and zero provider calls to produce a shortlist; the
only outward call is the existing climate check. Wider research is at most one
low-effort call (≤ 700 output tokens) per *weak* shortlist, cached for thirty
days, and off entirely without a credential or with
`SIDEQUEST_ADVISOR_RESEARCH=off`. A full rebuild costs nothing but about ten
minutes and 7 GB of temporary disk. Repository cost: 16.5 MB per rebuild.

**Failure behaviour.** Atlas file missing → curated catalog, stated. Embedding
file missing or misaligned → lexical retrieval only. Climate archive down, slow
or off → "unchecked" on the card. Research declined, failed or timed out → the
deterministic list unchanged. Interview step failing → the essentials are asked
locally and "Show me places now" still works. Advisory snapshot stale →
caution, not exclusion.

**Verification run on this branch:** see §11.

## 9. Limitations

Stated plainly, most important first.

1. **What a derived place offers is an estimate, and for some experiences a
   weak one.** Held-out agreement with the curated labels (correlation, and
   recall of "strong"): volcanoes 0.86 / 0.60 · glaciers 0.82 / 0.56 · high
   mountains 0.76 / 0.75 · coastal scenery 0.76 / 0.88 · beaches 0.75 / 0.75 ·
   diving 0.76 / 0.49 · snow 0.75 / 0.38 · city life 0.73 / 0.48 · day hiking
   0.62 / 0.85 — and at the other end **safari 0.44 / 0.00, rail 0.32 / 0.00,
   night skies 0.24 / 0.00, birding 0.35 / 0.02, scenic driving 0.22 / 0.04,
   hot springs 0.45 / 0.04**. For those six a derived row is almost never rated
   "strong"; the curated entries and the lexical channel carry them. The fix is
   better evidence (IUCN categories, rail lines, light-pollution rasters), not
   tuning. All numbers are in `data/manifest.json`.
2. **Generic interest plus specific words still leans generic.** "Remote
   monasteries and high passes in October" reads "monasteries" as culture and
   returns Santa Fe, Yunnan and the Amalfi Coast. The words lift matching
   places but do not outweigh a strong curated culture score. This is the case
   wider research exists for, and it needs a credential to help.
2b. **Requests with no structured interest fall back on text match, and that
   can be arbitrary.** A request about *who* is travelling rather than *what
   for* ("works for a wheelchair user") matched guides that mention the word.
   The blinded rater preferred the old system's generic answers on these
   (§7b). Whole countries also appear as picks more often than a careful
   advisor would offer them.
3. **Extents are circles.** A range's reach is a radius from an area or from
   notability; "the Karakoram" takes in Ladakh and part of Kashmir. Regions
   with real members (the Alps) are exact; the rest are approximate.
4. **Coverage follows English Wikivoyage.** 51 % of rows are in North America
   and Europe; East Africa has 456, the Indian Ocean 186. Places with no guide
   and under the Wikidata notability floors are absent.
5. **Climate is a normal, 1981–2010, at 1 km**, and CHELSA runs cold in some
   mountain basins in winter (Queenstown's July high reads 3 °C against 8) and
   wet on windward slopes. The snowpack is a model. Nothing here is a forecast;
   every sentence says "usually".
6. **Cost is the country's price level.** A national park in a cheap country
   reads cheap even where lodges are not. Mean absolute error against curated
   cost is 0.73 on a 1–4 scale.
7. **Other estimated fields** (MAE against curated, 0–3 scales): difficulty
   0.50, remoteness 0.76, crowds 0.78, familiarity 0.71, family suitability
   1.12, low-mobility 0.92; ideal nights ± 2. Shown as estimates; none can
   exclude a place.
8. **Advisories are one government's** (U.S. State Department), country-level
   only. In this snapshot they remove Uganda, among others, from the list.
9. **The sea mask** misses the heads of some narrow fjords and channels
   (Ushuaia, inner Sognefjord) and reads below-sea-level polders as sea.
10. **Five of 223 named places** are still not resolved by name (Mustang,
    Bwindi, Lopé, Salento, Cusco) — held under longer or accented titles.
11. **Research suggestions that are not in the atlas are dropped**, not
    enriched live. A real but unlisted place cannot enter the list.
12. **The question priors** in the interview are still assumptions.
13. **Verification gaps** — see §11.

## 10. Reproducing

```sh
# the baseline (at commit 596ece1, in a worktree, with this file and requests.ts copied in)
npx vitest run --config vitest.harness.config.ts packages/core/src/advisor/eval/benchmark/baseline-234.harness.ts
# the atlas (packages/atlas/README.md has the stages)
node packages/atlas/build/06-assemble.mjs
# the comparison, the coverage tables and the blinded pairs
npx vitest run --config vitest.harness.config.ts packages/atlas/src/benchmark.harness.ts
node packages/atlas/build/blind-pairs.mjs
# any request
ATLAS_Q="Diving.|Skiing in August." npx vitest run --config vitest.harness.config.ts packages/atlas/src/explore.harness.ts --disable-console-intercept
```

## 11. Verification on this branch

| Gate | Result |
|---|---|
| `npm run typecheck` (7 workspaces) | 0 errors |
| `npm run lint` | 0 errors, 129 warnings (128 before this work) |
| `npm run test` | **603 files, 8,904 passed, 1 skipped, 0 failed** on a quiet machine. A repeat while another process had the machine at a load average above 200 timed out one unrelated source-scanning test at its 5 s limit (`fixture-quarantine.test.ts`); it passes alone. |
| `npm run build` | succeeds; the client chunks contain neither the catalog text nor the ranking code |
| Playwright, desktop, whole suite | **255 / 255** (38 min) |
| Playwright, `e2e/decide.spec.ts`, desktop + mobile, final build | **18 / 18**, including the new test that asks for the Karakoram and checks the cards are in the right countries, marked as open data, and carry an activity season from climate normals |
| Playwright, `imagery.spec.ts` + `design-lab.spec.ts`, desktop + mobile | 18 / 18 |
| `git diff --check` | clean |
| Curated-only regression evaluation (42 scenarios) | 48 / 48 |
| Global benchmark | §7 |

Not run, and why:

- **The full mobile, maps, globe and Today browser configurations.** The whole
  desktop suite and the advisor specs on mobile were run; the rest touch code
  this work did not change.
- **A live research-model call.** The research step is exercised end to end
  with the fixture provider and against the real atlas (resolution, ranking,
  constraints, marking). No paid call was made, per the project rule to debug
  with fixtures; the first real call in production is the first real call.
- **Production.** Nothing was deployed and no production data was touched.

Two things the browser suite caught and that were fixed before this was
committed: the interview helper and one test waited a fixed number of loop
turns for a server round trip (now time-bounded), and the very first interview
step on a cold server paid for the atlas's lazily built tables (the atlas is now
warmed off the request path when it loads).

