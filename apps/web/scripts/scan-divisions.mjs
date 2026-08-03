/**
 * Raw extraction of Overture Divisions into NDJSON.
 *
 * Deliberately dumb. This script knows about parquet, byte ranges and resuming;
 * it knows nothing about what Sidequest does with a destination. Every product
 * decision — what counts as travel-relevant, how a name is folded for matching,
 * what an entry's identity is — lives in TypeScript that has tests, and is
 * applied by the importer at `apps/web/src/lib/destinations/import.ts`.
 *
 * Why a separate script at all: reading the divisions layer is ~250 MB of range
 * requests over ~256 row groups, which is a background job measured in minutes,
 * not a request. It writes NDJSON and is resumable at row-group granularity, so
 * a killed process costs one row group rather than the whole scan.
 *
 * Usage:
 *   node apps/web/scripts/scan-divisions.mjs [--release <id>] [--out <path>]
 *
 * The output is an input to `POST /api/destinations/index`, which is the only
 * thing that writes the index.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { parquetMetadataAsync, parquetReadObjects } from 'hyparquet';

const CATALOG = 'https://stac.overturemaps.org/catalog.json';
const ALLOWED_HOSTS = new Set([
  'stac.overturemaps.org',
  'overturemaps-us-west-2.s3.us-west-2.amazonaws.com',
  'overturemaps-us-west-2.s3.amazonaws.com',
]);

/**
 * The subtypes worth offering as a destination.
 *
 * A "microhood" is not somewhere you plan a trip to, and 4.6 M rows of them
 * would drown every useful suggestion. Countries and regions are kept
 * unconditionally; the finer levels have to clear a prominence or population bar
 * so that the index stays a list of places people travel to rather than a
 * gazetteer.
 */
const KEEP_ALWAYS = new Set(['country', 'dependency', 'region', 'county']);

/**
 * Finer levels have to earn their row.
 *
 * Overture's `cartography.prominence` runs **low to high** — a hamlet with no
 * inhabitants scores 3, a national capital scores 77 — which is the opposite of
 * what the name suggests and cost this script one wasted scan. Either a real
 * population or real cartographic prominence is enough; neither is not.
 */
const NOTABILITY = {
  localadmin: { population: 20_000, prominence: 55 },
  locality: { population: 5_000, prominence: 55 },
  macrohood: { population: 50_000, prominence: 70 },
  neighborhood: { population: 100_000, prominence: 75 },
};

/**
 * Languages a suggestion may be typed in, beyond the local name and English.
 *
 * Capped and ordered rather than "all of them": Overture publishes ninety
 * translations for a capital city, which would make the index four times larger
 * for aliases nobody will ever type. `names.primary` is already the local form,
 * so the local script is covered before this list starts.
 */
const ALIAS_LANGUAGES = ['en', 'es', 'fr', 'de', 'ru', 'zh', 'ja', 'ar', 'pt', 'it'];
const MAX_ALIASES = 6;

const args = process.argv.slice(2);
function arg(name, fallback) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
}

const OUT = resolve(arg('out', 'data/destination-divisions.ndjson'));
const STATE = `${OUT}.state.json`;

function assertHost(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to read ${parsed.hostname}`);
  }
  return parsed.toString();
}

async function json(url) {
  const response = await fetch(assertHost(url), {
    headers: { accept: 'application/json', 'user-agent': userAgent() },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${response.status} from ${url}`);
  return response.json();
}

function userAgent() {
  return process.env.SIDEQUEST_FETCH_USER_AGENT ?? 'Sidequest/0.1 (destination index build)';
}

async function resolveRelease() {
  const pinned = arg('release', process.env.SIDEQUEST_PLACE_RELEASE);
  if (pinned) return pinned;
  const root = await json(CATALOG);
  if (!root.latest) throw new Error('The catalogue did not name a release.');
  return root.latest;
}

async function divisionFile(release) {
  const collectionUrl = `https://stac.overturemaps.org/${release}/divisions/division/collection.json`;
  const collection = await json(collectionUrl);
  const items = collection.links.filter((link) => link.rel === 'item');
  const files = [];
  for (const link of items) {
    const item = await json(new URL(link.href, collectionUrl).toString());
    for (const asset of Object.values(item.assets ?? {})) {
      const candidates = [asset.href, ...Object.values(asset.alternate ?? {}).map((a) => a.href)];
      const usable = candidates.find(
        (href) => href.startsWith('https://') && href.endsWith('.parquet') && ALLOWED_HOSTS.has(new URL(href).hostname),
      );
      if (usable) {
        files.push(usable);
        break;
      }
    }
  }
  if (files.length === 0) throw new Error('No readable division file in that release.');
  return files;
}

function byteSource(url, counters) {
  let length = 0;
  return {
    async init() {
      const head = await fetch(assertHost(url), {
        method: 'HEAD',
        headers: { 'user-agent': userAgent() },
        signal: AbortSignal.timeout(30_000),
      });
      length = Number(head.headers.get('content-length') ?? '0');
      if (!Number.isFinite(length) || length <= 0) throw new Error('No content length.');
      return length;
    },
    build() {
      return {
        byteLength: length,
        async slice(start, end) {
          const from = Math.max(0, Math.floor(start));
          const to = end === undefined ? length : Math.min(length, Math.floor(end));
          if (to <= from) return new ArrayBuffer(0);
          for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
              const response = await fetch(url, {
                headers: { 'user-agent': userAgent(), range: `bytes=${from}-${to - 1}` },
                signal: AbortSignal.timeout(60_000),
              });
              if (!response.ok && response.status !== 206) throw new Error(String(response.status));
              const buffer = await response.arrayBuffer();
              counters.bytes += buffer.byteLength;
              return buffer;
            } catch (error) {
              if (attempt === 3) throw error;
              await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
            }
          }
          throw new Error('unreachable');
        },
      };
    },
  };
}

const COMPRESSORS = { ZSTD: (input) => new Uint8Array(zstdDecompressSync(input)) };

/** Overture's `names.common` arrives as an array of {key,value} pairs. */
function commonNames(names) {
  const out = {};
  const raw = names?.common;
  if (!raw) return out;
  const pairs = Array.isArray(raw) ? raw : Object.entries(raw).map(([key, value]) => ({ key, value }));
  for (const pair of pairs) {
    const key = pair?.key ?? pair?.[0];
    const value = pair?.value ?? pair?.[1];
    if (typeof key === 'string' && typeof value === 'string') out[key] = value;
  }
  return out;
}

function notable(row) {
  const subtype = row.subtype;
  if (KEEP_ALWAYS.has(subtype)) return true;
  const bar = NOTABILITY[subtype];
  if (!bar) return false;
  const population = typeof row.population === 'number' ? row.population : 0;
  const prominence = typeof row.cartography?.prominence === 'number' ? row.cartography.prominence : 0;
  return population >= bar.population || prominence >= bar.prominence;
}

/** A crude fold, only to decide whether an alias adds anything the primary did not. */
function sameish(a, b) {
  const fold = (value) =>
    value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '');
  return fold(a) === fold(b);
}

function project(row) {
  const bbox = row.bbox ?? {};
  const { xmin, xmax, ymin, ymax } = bbox;
  if (![xmin, xmax, ymin, ymax].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const names = row.names ?? {};
  if (typeof names.primary !== 'string' || names.primary.length === 0) return null;

  const common = commonNames(names);
  const english = typeof common.en === 'string' ? common.en : undefined;

  const aliases = [];
  for (const language of ALIAS_LANGUAGES) {
    if (aliases.length >= MAX_ALIASES) break;
    const value = common[language];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (sameish(value, names.primary)) continue;
    if (aliases.some((existing) => sameish(existing, value))) continue;
    aliases.push(value);
  }

  const localTypeName =
    row.local_type && typeof row.local_type === 'object'
      ? (commonNames({ common: row.local_type }).en ?? undefined)
      : undefined;

  return {
    sourceId: row.id,
    subtype: row.subtype,
    class: typeof row.class === 'string' ? row.class : undefined,
    primaryName: names.primary,
    ...(english ? { englishName: english } : {}),
    aliases,
    ...(localTypeName ? { localType: localTypeName } : {}),
    ...(typeof row.country === 'string' ? { countryCode: row.country } : {}),
    ...(typeof row.region === 'string' ? { regionCode: row.region } : {}),
    ...(typeof row.parent_division_id === 'string' ? { parentId: row.parent_division_id } : {}),
    ...(typeof row.population === 'number' ? { population: row.population } : {}),
    ...(typeof row.cartography?.prominence === 'number' ? { prominence: row.cartography.prominence } : {}),
    ...(typeof row.wikidata === 'string' ? { wikidata: row.wikidata } : {}),
    bbox: { xmin, xmax, ymin, ymax },
  };
}

const COLUMNS = [
  'id',
  'subtype',
  'class',
  'names',
  'country',
  'region',
  'population',
  'cartography',
  'bbox',
  'wikidata',
  'parent_division_id',
  'local_type',
];

async function main() {
  const release = await resolveRelease();
  const files = await divisionFile(release);
  mkdirSync(dirname(OUT), { recursive: true });

  const previous = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null;
  const state =
    previous && previous.release === release && previous.files.join('|') === files.join('|')
      ? previous
      : { release, files, fileIndex: 0, group: 0, kept: 0, startedAt: new Date().toISOString() };

  if (state === previous) {
    process.stdout.write(`resuming ${release} at file ${state.fileIndex} group ${state.group} (${state.kept} kept)\n`);
  } else {
    writeFileSync(OUT, '');
    process.stdout.write(`scanning ${release}: ${files.length} file(s)\n`);
  }

  const counters = { bytes: 0 };

  for (let fileIndex = state.fileIndex; fileIndex < files.length; fileIndex += 1) {
    const url = files[fileIndex];
    const source = byteSource(url, counters);
    await source.init();
    const file = source.build();
    const metadata = await parquetMetadataAsync(file);

    const boundaries = [];
    let offset = 0;
    for (const group of metadata.row_groups) {
      const rows = Number(group.num_rows);
      boundaries.push({ start: offset, end: offset + rows });
      offset += rows;
    }

    const from = fileIndex === state.fileIndex ? state.group : 0;
    for (let index = from; index < boundaries.length; index += 1) {
      const { start, end } = boundaries[index];
      const batch = await parquetReadObjects({
        file,
        metadata,
        compressors: COMPRESSORS,
        rowStart: start,
        rowEnd: end,
        columns: COLUMNS,
      });

      const lines = [];
      for (const row of batch) {
        if (!notable(row)) continue;
        const projected = project(row);
        if (projected) lines.push(JSON.stringify(projected));
      }
      if (lines.length > 0) appendFileSync(OUT, `${lines.join('\n')}\n`);
      state.kept += lines.length;
      state.fileIndex = fileIndex;
      state.group = index + 1;
      writeFileSync(STATE, JSON.stringify(state));

      const pct = (((index + 1) / boundaries.length) * 100).toFixed(1);
      process.stdout.write(
        `[${pct}%] group ${index + 1}/${boundaries.length} · kept ${state.kept} · ${(counters.bytes / 1e6).toFixed(0)} MB\n`,
      );
    }
    state.group = 0;
  }

  writeFileSync(STATE, JSON.stringify({ ...state, done: true, finishedAt: new Date().toISOString() }));
  process.stdout.write(`done: ${state.kept} entries from release ${release} → ${OUT}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
