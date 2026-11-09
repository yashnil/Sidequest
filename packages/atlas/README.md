# @sidequest/atlas — the global destination atlas

"Help me choose" ranks the world, not a hand-written list. This package is where
the world comes from: an **offline pipeline** (`build/`) that turns open
geographic and travel data into one compact artifact (`data/atlas.json.gz`), and
a **loader** (`src/load.ts`) the server reads once per process. The runtime that
decodes and queries it is pure and lives in `@sidequest/core`
(`packages/core/src/atlas/`).

Nothing is downloaded at request time and nothing at start-up. The product's
knowledge of the world ships with the product; a rebuild is a new commit.

## What is in the artifact

`data/manifest.json` is the authoritative description of a build: counts by
kind and world region, every estimator's fitted weights and held-out agreement,
the sources with their licences, the advisory snapshot date. In short:

| | |
|---|---|
| Rows | ~36,800 destinations + 34 scope-only areas (continents and their sections) |
| From travel guides | ~29,000 Wikivoyage destinations (cities, regions, parks, rural areas, countries, routes) |
| From data alone | ~7,800 notable places no guide covers yet (national parks, ranges, islands, ski areas…) |
| Curated | The 234 editorial entries (`packages/core/src/advisor/catalog/regions/`) replace their derived twins and keep their hierarchy |
| Per row | Identity (Wikidata QID, aliases), country, travel hierarchy, centre and extent, 24 experience scores, monthly climate where people stay and on the high ground, sea temperature, nearest airports, cost, nights, difficulty, remoteness, familiarity, getting around, who it suits, index terms, a 96-d meaning vector |
| Size | 10.5 MB (`atlas.json.gz`) + 6.0 MB (`embeddings.json.gz`, optional) |

**Measured, estimated, editorial.** Coordinates, countries, hierarchy, climate
normals, elevation, sea temperature, airport distances, price levels and
sitelink counts are measured or published facts. What a derived destination
*offers*, how hard it is, how long it carries and who it suits are **estimates**,
made in `build/06-assemble.mjs` by models fitted to the curated catalog's
editorial labels and reported with their held-out error. Every record carries
`basis` per group of fields and a `confidence`; the scorer discounts a thin
reading rather than trusting or discarding it, and every card says which kind of
reading it is.

## Pipeline

Raw downloads and intermediates live in `.atlas-cache/` (git-ignored, ~7 GB).
Each stage is a pure function of the files before it and can be re-run alone.

| Stage | Reads | Writes | Time |
|---|---|---|---|
| `01-wikivoyage.mjs` | Wikivoyage dump (132 MB bz2) + page_props | `wikivoyage.ndjson`, redirects | ~30 s |
| `02-wikidata.mjs` | Wikidata Query Service, 150 items a query, cached per batch | `entities.ndjson` | ~10 min first time |
| `03-features.mjs` | Wikidata Query Service, one query per feature class (ids verified by label on every run) | `features.ndjson` (~62k notable features) | ~8 min first time |
| `dump-curated.harness.ts` | the curated catalog and price levels (TypeScript) | `curated.json` | 1 s |
| `04-candidates.mjs` | all of the above + OurAirports | `candidates.ndjson`, `points.ndjson` | ~30 s |
| `05-rasters.py` | CHELSA V2.1 normals (36 files, 6 GB), ETOPO 2022, NOAA OISST | `rasters.ndjson` | ~3 min |
| `07-embeddings.py` | guide text + potion-base-8M static embeddings | `embeddings.json` | ~70 s |
| `06-assemble.mjs` | candidates, rasters, embeddings, advisories | `data/atlas.json.gz`, `data/embeddings.json.gz`, `data/manifest.json` | ~6 s |

```sh
# one-time downloads: see the URL list in docs/global-destinations/REPORT.md §3
node packages/atlas/build/01-wikivoyage.mjs
node packages/atlas/build/02-wikidata.mjs
node packages/atlas/build/03-features.mjs
npx vitest run --config vitest.harness.config.ts packages/atlas/build/dump-curated.harness.ts
node packages/atlas/build/04-candidates.mjs
python3 -I packages/atlas/build/05-rasters.py --points .atlas-cache/work/points.ndjson --out .atlas-cache/work/rasters.ndjson
python3 -I packages/atlas/build/07-embeddings.py --no-eval      # must follow every stage-04 run
node packages/atlas/build/06-assemble.mjs
```

**Incremental updates.** Stages 02 and 03 cache every answer, so a rerun asks
only for what is missing. Advisories refresh on their own
(`node packages/atlas/build/advisories.mjs && node packages/atlas/build/06-assemble.mjs`).
A new Wikivoyage dump needs 01 → 04 → 05 → 07 → 06 (about ten minutes). The
embedding matrix is row-aligned with the candidates; stage 06 ships it only when
its digest matches and the atlas runs on the lexical index alone otherwise.

Python 3.12 with numpy, scipy, netCDF4 and h5py is needed for stages 05 and 07
only. Nothing in the product depends on Python.

## Runtime

```ts
import { loadAtlas } from '@sidequest/atlas';
const { atlas } = loadAtlas()!;          // ~250 ms once; null (with a reason) if the file is missing
atlas.candidates({ … });                 // one pass over every row → the few hundred worth scoring
atlas.findPlaces('trekking in the Karakoram, not Hunza');   // names with roles: scope, similar, avoid, origin
```

- `SIDEQUEST_ATLAS_PATH` — where the artifact is, when not beside this package.
- `SIDEQUEST_ATLAS_EMBEDDINGS=off` — run without the meaning channel.
- If the artifact cannot be loaded the advisor falls back to the curated catalog
  alone and says so on the shortlist (`apps/web/src/lib/atlas/world.ts`).

## Tests and evaluation

- `src/atlas.test.ts` — the shipped artifact, no mocks: coverage, identity,
  hierarchy, name reading, scoping, activity seasons, provenance, advisories.
- `packages/core/src/atlas/*.test.ts` — the season model, the embedding
  tokeniser (held to the Python build).
- `src/benchmark.harness.ts` — 147 traveller requests, old recommender against
  new, scored on location, climate feasibility, price level and distance.
  Writes `docs/global-destinations/benchmark/`.
  `npx vitest run --config vitest.harness.config.ts packages/atlas/src/benchmark.harness.ts`
- `src/explore.harness.ts` — print shortlists for any request:
  `ATLAS_Q="Diving.|Skiing in August." npx vitest run --config vitest.harness.config.ts packages/atlas/src/explore.harness.ts --disable-console-intercept`

Sources, licences and attribution: `build/sources.json` (copied into the
manifest) and `docs/global-destinations/REPORT.md`.
