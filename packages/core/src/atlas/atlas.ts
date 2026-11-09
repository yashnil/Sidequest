import { DESTINATION_KINDS, EXPERIENCES, WORLD_REGIONS, type CatalogDestination, type DestinationKind, type Experience, type WorldRegion } from '../advisor/catalog/schema';
import { advisorKm } from '../advisor/origin';
import { destinationFromCatalog, type CandidateQuery, type DestinationCostEvidence, type Destination, type DestinationWorld, type MeasuredClimate, type NearbyAirport } from '../advisor/destination';
import { atlasStem, atlasTokens, foldPlaceName } from './lexical';
import { AMBIGUOUS_LOWER, COUNTRY_ACRONYMS, DEMONYMS, NEVER_ALONE, ORDINARY_WORDS, REGION_ADJECTIVES } from '../naming/place-words';
import { decodeEmbeddingTable, decodeInt8Matrix, embedQuery, type EmbeddingTable, type RawEmbeddingTable } from './embed';
import { ACTIVITIES, EXPERIENCE_ACTIVITY, seasonModel, type ClimatePoint } from './seasonality';

/**
 * THE GLOBAL DESTINATION ATLAS, IN MEMORY.
 *
 * Tens of thousands of destinations cannot each be a hand-written object, and
 * they cannot each be read closely for every request. So the atlas is a
 * columnar artifact (built offline — `packages/atlas/build`) decoded once into
 * typed arrays, and it answers three questions fast:
 *
 * 1. **Candidates.** One pass over every row: is it in scope, does it offer
 *    what was asked, is it in season for that, do the words of the request
 *    appear in its guide, does it resemble the place they named? The few
 *    hundred best go to the detailed scorer. Nothing here is a verdict — the
 *    pass exists so the careful reading is spent where it can matter, and the
 *    pool is deliberately much larger than any shortlist.
 * 2. **Identity.** A row by id; a row's ancestors; whether two rows are the
 *    same ground.
 * 3. **Names.** Which places a sentence mentions, and in what role: a scope
 *    ("in the Karakoram"), a comparison ("like the Dolomites"), a refusal
 *    ("not Bali") or a starting point ("from Delhi").
 *
 * The curated catalog is part of the atlas, not beside it: each curated entry
 * replaces the derived row for the same place and keeps that row's hierarchy,
 * and the measured climate the atlas sampled is laid beside its editorial
 * reading. There is one world.
 *
 * Pure: no I/O. The loader (`@sidequest/atlas`) reads the file and hands the
 * parsed object here.
 */

export interface AtlasArtifact {
  format: number;
  version: string;
  builtAt: string;
  experiences: string[];
  kinds: string[];
  worldRegions: string[];
  n: number;
  ids: string[];
  names: string[];
  contexts: string[];
  resolveAs: string[];
  qids: string[];
  wv: string[];
  countries: string[];
  lat: number[];
  lng: number[];
  radiusKm: number[];
  parent: string;
  aliases: Record<string, string[]>;
  /** For a region nothing is filed under (the Alps, Patagonia): the rows of the regions it spans. */
  members?: Record<string, number[]>;
  pitch: string[];
  highlights: string[][];
  bases: string[][];
  exp: string;
  nights: string;
  kind: string;
  region: string;
  flags: string;
  confidence: string;
  substance: string;
  familiarity: string;
  crowds: string;
  remoteness: string;
  easiest: string;
  typical: string;
  cost: string;
  costBasis: string;
  costSpread: string;
  reach: string;
  car: string;
  transit: string;
  family: string;
  lowMobility: string;
  lodging: string;
  clim: string;
  coastKm: string;
  high: { rows: string; data: string };
  sea: { rows: string; data: string };
  airportTable: [string, string, number][];
  airportRef: string;
  airportKm: string;
  terms: { vocab: string[]; offsets: string; ids: string; weights: string };
  advisories: {
    source: string;
    asOf: string | null;
    levels: Record<string, { level: number; asOf: string }>;
    fetchedAt?: string;
    countries?: Record<string, CountryAdvisory>;
    rows?: Record<string, AreaWarning>;
  };
  landmass?: string;
  cloud?: string;
  waves?: { rows: string; data: string };
  roomUsd?: string;
  priceYears?: Record<string, [number, number]>;
  curated: Record<string, { cloud?: number[]; waves?: number[]; advisory?: AreaWarning; landmass?: number; airports: NearbyAirport[]; twin?: number; base?: number[]; high?: number[]; coastKm?: number; sst?: number[] }>;
  /** A digest of the row ids in order; an embedding matrix is attached only when it was built for these rows. */
  rowsDigest?: string;
}

/** The optional semantic channel: a document vector per row and the token table a query is embedded with. */
export interface AtlasEmbeddings extends RawEmbeddingTable {
  rows: number;
  rowsDigest: string;
  /** base64 of int8, `rows × dim`. */
  docs: string;
  docScale: number;
}

const FLAG_SCOPE = 1;
const FLAG_TWIN = 2;
const FLAG_DATA_ONLY = 4;
/** The row's coordinates contradict what it is (a mountain resort in mid-ocean). Kept for its name, never offered. */
const FLAG_SUSPECT_LOCATION = 8;
const NO_DATA = -32768;
const CLIMATE_WIDTH = 37;
const ACTIVITY_COUNT = ACTIVITIES.length;

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}
const int16 = (base64: string): Int16Array => {
  const bytes = bytesOf(base64);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
};
const int32 = (base64: string): Int32Array => {
  const bytes = bytesOf(base64);
  return new Int32Array(bytes.buffer, 0, bytes.length >> 2);
};
const uint16 = (base64: string): Uint16Array => {
  const bytes = bytesOf(base64);
  return new Uint16Array(bytes.buffer, 0, bytes.length >> 1);
};
const uint32 = (base64: string): Uint32Array => {
  const bytes = bytesOf(base64);
  return new Uint32Array(bytes.buffer, 0, bytes.length >> 2);
};

const RAD = Math.PI / 180;
function kmBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLng = (bLng - aLng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function climatePoint(values: ArrayLike<number>, offset: number): ClimatePoint | null {
  if (values[offset + 1] === NO_DATA) return null;
  const tmax: number[] = [];
  const tmin: number[] = [];
  const pr: number[] = [];
  for (let month = 0; month < 12; month += 1) {
    tmax.push(values[offset + 1 + month]! / 10);
    tmin.push(values[offset + 13 + month]! / 10);
    pr.push(values[offset + 25 + month]!);
  }
  return { elevM: values[offset]!, tmax, tmin, pr };
}

const CAR = ['unknown', 'unnecessary', 'helpful', 'essential'] as const;
const TRANSIT = ['unknown', 'good', 'limited', 'poor'] as const;

/** How long an advisory snapshot is trusted to exclude a place. After that it is a caution with its date. */
export const ADVISORY_FRESH_DAYS = 180;

/** What a meaning-only match counts for beside a word-for-word one. */
const SEMANTIC_SHARE = 0.6;

/** Below this, a row is too thin to be offered on its own; it can still be reached by name or as part of a named area. */
export const SUBSTANCE_FLOOR = 0.22;
const SUBSTANCE_FLOOR_IN_SCOPE = 0.1;

interface CountryAdvisory {
  /** The strictest level any authority gives the whole country; 0 when none does. */
  level: number;
  source?: string;
  asOf?: string;
  url?: string;
  label?: string;
  whole?: { source: string; label: string; url: string; updatedAt: string }[];
  parts?: { source: string; level: number; url: string }[];
}

interface AreaWarning {
  level: number;
  /** Named as an exception to a warning covering the rest of the country. */
  exempt: boolean;
  area?: string | null;
  source?: string;
  label?: string;
  text?: string;
  url?: string;
  asOf?: string;
}

/** Stored in tenths of a metre; 255 is sea ice. */
const waveHeight = (value: number): number => (value === 255 ? Number.NaN : value / 10);

export type PlaceRole = 'scope' | 'similar' | 'avoid' | 'origin';

export interface PlaceMention {
  /** The destination id (curated id where a curated entry stands for the place). */
  id: string;
  /** Every wide record that answers to exactly this name — one place filed more than once. Always includes `id`. */
  ids: string[];
  name: string;
  role: PlaceRole;
  start: number;
  end: number;
  /** ISO code when the place is a country. */
  country: string | null;
  center: { lat: number; lng: number };
  /** True when the place is wide enough to look inside (a country, a range, a region) rather than a single town. */
  wide: boolean;
}

const SIMILAR_CUE = /(?:\blike|similar to|alternatives? to|reminiscent of|answer to|version of|rivals?|rivall?ing|feel of|vibe of|such as|equivalent of|as good as)\s+(?:the\s+)?$/;
const AVOID_CUE = /(?:\bnot|\bno|except|but not|other than|instead of|skip|skipping|avoid|avoiding|beyond|besides|done|been to|visited|seen|than|outside(?: of)?|anywhere but|without going to|tired of|bored of)\s+(?:the\s+)?$/;
const ORIGIN_CUE = /(?:\bfrom|out of|based in|live in|living in|leaving|departing|(?:flight|flights|drive|train|hours?) of)\s+(?:the\s+)?$/;
const JOIN_CUE = /^(?:\s*(?:,|and|or|&|\/)\s*(?:the\s+)?)+$/;


interface NameTarget {
  /** Row index, or −(curated index + 1). */
  ref: number;
  primary: boolean;
}

export interface AtlasOptions {
  /** The moment advisories are judged fresh against. */
  now?: Date;
}

export class Atlas implements DestinationWorld {
  readonly version: string;
  readonly builtAt: string;
  readonly rows: number;
  /** Destinations that can be recommended: every non-scope row with a measured climate, with curated entries counted once. */
  readonly size: number;

  private readonly raw: AtlasArtifact;
  private readonly exp: Uint8Array;
  private readonly parent: Int32Array;
  private readonly flags: Uint8Array;
  private readonly kind: Uint8Array;
  private readonly region: Uint8Array;
  private readonly substance: Uint8Array;
  private readonly confidence: Uint8Array;
  private readonly clim: Int16Array;
  private readonly coast: Int16Array;
  private readonly highOf = new Map<number, number>();
  private readonly highData: Int16Array;
  private readonly seaOf = new Map<number, number>();
  private readonly seaData: Int16Array;
  private readonly termOffsets: Uint32Array;
  private readonly termIds: Uint32Array;
  private readonly termWeights: Uint8Array;
  private readonly vocab = new Map<string, number>();
  private postings: Map<number, { rows: Uint32Array; weights: Uint8Array }> | null = null;
  private readonly idToRow = new Map<string, number>();
  private readonly rowCache: (Destination | undefined)[];
  private readonly curatedList: Destination[] = [];
  private readonly curatedById = new Map<string, Destination>();
  private readonly curatedOfRow = new Map<number, Destination>();
  private readonly twinRowOfCurated = new Map<string, number>();
  private readonly curatedIdOfTwinRow = new Map<number, string>();
  private seasonTable: Uint8Array | null = null;
  private names: Map<string, NameTarget[]> | null = null;
  private readonly advisoryFresh: boolean;
  private readonly cloudCol: Uint8Array | null;
  private readonly waveData: Uint8Array | null;
  private readonly waveOf = new Map<number, number>();
  private skiAreas: { rows: number[][]; grid: Map<string, number[]> } | null = null;
  private readonly landmassCol: Uint16Array | null;
  private readonly roomUsd: Uint16Array | null;
  private readonly countryRow = new Map<string, number>();

  constructor(raw: AtlasArtifact, curated: readonly CatalogDestination[], options: AtlasOptions = {}) {
    if (raw.format !== 1) throw new Error(`unsupported atlas format ${raw.format}`);
    if (raw.experiences.join() !== EXPERIENCES.join()) throw new Error('the atlas was built for a different experience vocabulary');
    this.raw = raw;
    this.version = raw.version;
    this.builtAt = raw.builtAt;
    this.rows = raw.n;
    this.exp = bytesOf(raw.exp);
    this.parent = int32(raw.parent);
    this.flags = bytesOf(raw.flags);
    this.kind = bytesOf(raw.kind);
    this.region = bytesOf(raw.region);
    this.substance = bytesOf(raw.substance);
    this.confidence = bytesOf(raw.confidence);
    this.clim = int16(raw.clim);
    this.coast = int16(raw.coastKm);
    int32(raw.high.rows).forEach((row, index) => this.highOf.set(row, index));
    this.highData = int16(raw.high.data);
    int32(raw.sea.rows).forEach((row, index) => this.seaOf.set(row, index));
    this.seaData = int16(raw.sea.data);
    this.termOffsets = uint32(raw.terms.offsets);
    this.termIds = uint32(raw.terms.ids);
    this.termWeights = bytesOf(raw.terms.weights);
    raw.terms.vocab.forEach((term, id) => this.vocab.set(term, id));
    raw.ids.forEach((id, row) => this.idToRow.set(id, row));
    this.rowCache = new Array<Destination | undefined>(raw.n);
    const now = options.now ?? new Date();
    const snapshot = Date.parse(raw.advisories.fetchedAt ?? raw.builtAt);
    this.cloudCol = raw.cloud ? bytesOf(raw.cloud) : null;
    this.waveData = raw.waves ? bytesOf(raw.waves.data) : null;
    if (raw.waves) uint32(raw.waves.rows).forEach((row, index) => this.waveOf.set(row, index));
    this.landmassCol = raw.landmass ? uint16(raw.landmass) : null;
    this.roomUsd = raw.roomUsd ? uint16(raw.roomUsd) : null;
    this.advisoryFresh = Number.isFinite(snapshot) && now.getTime() - snapshot <= ADVISORY_FRESH_DAYS * 86_400_000;

    for (let row = 0; row < raw.n; row += 1) {
      if (DESTINATION_KINDS[this.kind[row]!] === 'country' && !(this.flags[row]! & FLAG_SCOPE)) {
        const iso = raw.countries[row];
        if (iso && !iso.includes(',')) this.countryRow.set(iso, row);
      }
    }

    /* Curated entries take the place of their derived twin and keep its hierarchy. */
    for (const entry of curated) {
      const extra = raw.curated[entry.id];
      if (extra?.twin !== undefined) {
        this.twinRowOfCurated.set(entry.id, extra.twin);
        this.curatedIdOfTwinRow.set(extra.twin, entry.id);
      }
    }
    for (const entry of curated) {
      const extra = raw.curated[entry.id];
      const twin = extra?.twin;
      let measured: MeasuredClimate | null = null;
      if (extra?.base) {
        const base = climatePoint(extra.base, 0);
        if (base) measured = { base, high: extra.high ? climatePoint(extra.high, 0) : null, sst: extra.sst ? extra.sst.map((value) => value / 10) : null, coastKm: extra.coastKm ?? null, cloud: extra.cloud ?? null, waves: extra.waves ? extra.waves.map(waveHeight) : null };
      }
      const destination = destinationFromCatalog(entry, {
        measured,
        parents: twin !== undefined ? this.parentIds(twin) : [],
        aliases: twin !== undefined ? [...(raw.aliases[String(twin)] ?? []), raw.names[twin]!].filter((name) => name !== entry.name) : [],
        airports: extra?.airports ?? [],
        advisory: this.advisoryFor(entry.countries[0] ?? null, extra?.advisory),
        landmass: extra?.landmass ?? (twin !== undefined ? this.landmassOf(twin) : null),
        costEvidence: twin !== undefined ? this.costEvidenceOf(twin) : null,
      });
      this.curatedList.push(destination);
      this.curatedById.set(entry.id, destination);
      if (twin !== undefined) this.curatedOfRow.set(twin, destination);
    }

    let recommendable = this.curatedList.length;
    for (let row = 0; row < raw.n; row += 1) if (this.offerable(row)) recommendable += 1;
    this.size = recommendable;
  }

  /** A row that can be recommended on its own: a real destination with a measured climate that no curated entry already stands for. */
  private offerable(row: number): boolean {
    return (this.flags[row]! & (FLAG_SCOPE | FLAG_TWIN | FLAG_SUSPECT_LOCATION)) === 0 && this.clim[row * CLIMATE_WIDTH + 1] !== NO_DATA;
  }

  /**
   * Joins the separately licensed ski-area file, in memory. The file stays its
   * own ODbL database: nothing derived from it is written into the atlas. A
   * lift-served area within reach raises what a place offers for snow sports,
   * and that is what candidate retrieval reads.
   */
  attachSkiAreas(rows: readonly (readonly number[])[]): void {
    const grid = new Map<string, number[]>();
    rows.forEach((row, index) => {
      const key = `${Math.floor(row[0]!)}:${Math.floor(row[1]!)}`;
      const list = grid.get(key);
      if (list) list.push(index);
      else grid.set(key, [index]);
    });
    this.skiAreas = { rows: rows as number[][], grid };
    this.rowCache.fill(undefined);
    const width = EXPERIENCES.length;
    const snow = EXPERIENCES.indexOf('winter_snow');
    for (let row = 0; row < this.raw.n; row += 1) {
      const area = this.skiAreaNear(this.raw.lat[row]!, this.raw.lng[row]!, this.raw.radiusKm[row]!);
      if (!area) continue;
      /* A hill with a lift is some skiing; real vertical and lift counts are what make a ski trip. */
      const offer = Math.round((1 + 2 * Math.min(1, (0.6 * area.verticalM) / 1000 + (0.4 * area.lifts) / 25)) * 10);
      this.exp[row * width + snow] = Math.max(this.exp[row * width + snow]!, offer);
    }
    for (const entry of this.curatedList) entry.skiArea = this.skiAreaNear(entry.center.lat, entry.center.lng, entry.radiusKm);
  }

  /** Undefined when no ski file is attached (unknown); null when one is and nothing lift-served is in reach. */
  private skiAreaNear(lat: number, lng: number, radiusKm: number): Destination['skiArea'] {
    if (!this.skiAreas) return undefined;
    const reach = Math.max(15, Math.min(120, radiusKm));
    const latSpan = Math.ceil(reach / 111);
    const span = Math.ceil(reach / 111 / Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
    let best: NonNullable<Destination['skiArea']> | null = null;
    for (let a = Math.floor(lat) - latSpan; a <= Math.floor(lat) + latSpan; a += 1) {
      for (let b = Math.floor(lng) - span; b <= Math.floor(lng) + span; b += 1) {
        for (const index of this.skiAreas.grid.get(`${a}:${b}`) ?? []) {
          const area = this.skiAreas.rows[index]!;
          const km = advisorKm({ lat, lng }, { lat: area[0]!, lng: area[1]! });
          if (km > reach) continue;
          if (!best || area[3]! > best.verticalM) best = { lifts: area[2]!, verticalM: area[3]!, km: Math.round(km) };
        }
      }
    }
    return best;
  }

  private landmassOf(row: number): number | null {
    return this.landmassCol ? this.landmassCol[row]! || null : null;
  }

  private costEvidenceOf(row: number): DestinationCostEvidence | null {
    const room = this.roomUsd?.[row] ?? 0;
    if (room === 0) return null;
    const spread = 1 + this.u8('costSpread')[row]! / 100;
    const round = (value: number) => (value >= 100 ? Math.round(value / 10) * 10 : Math.round(value / 5) * 5 || 5);
    return { roomUsd: [round(room / spread), round(room * spread)], basis: this.u8('costBasis')[row] === 2 ? 'historical_observation' : 'model_estimate', years: this.raw.priceYears?.[String(row)] ?? null };
  }

  /**
   * The advice that applies to one place. The strictest authority's do-not-travel
   * that actually covers it decides; a warning for part of the country that could
   * not be placed stays on the card as a caution with the authority named.
   */
  private advisoryFor(iso: string | null, warning?: AreaWarning): Destination['advisory'] {
    if (!iso) return null;
    const stale = (level: number) => (level >= 4 && !this.advisoryFresh ? 3 : level);
    const country = this.raw.advisories.countries?.[iso];
    if (!country) {
      const entry = this.raw.advisories.levels[iso];
      if (!entry) return null;
      return { level: stale(entry.level), asOf: entry.asOf, source: `The ${this.raw.advisories.source}` };
    }
    const asOf = (this.raw.advisories.fetchedAt ?? this.raw.builtAt).slice(0, 10);
    const parts = country.parts && !country.whole ? { parts: country.parts } : {};
    const whole = country.whole?.[0];
    if (whole && !warning?.exempt) return { level: stale(4), asOf: whole.updatedAt ?? asOf, source: whole.source, url: whole.url };
    if (warning && warning.level >= 3 && warning.source && warning.level >= country.level) {
      return { level: stale(warning.level), asOf: warning.asOf ?? asOf, source: warning.source, area: warning.area ?? null, ...(warning.url ? { url: warning.url } : {}), ...parts };
    }
    if (country.level === 0 && !country.parts) return null;
    return { level: Math.min(stale(country.level), 3), asOf: country.asOf ?? asOf, source: country.source ?? country.parts?.[0]?.source ?? 'A government', ...(country.url ? { url: country.url } : {}), ...parts };
  }

  /** The id a row answers to: the curated entry's where one stands for it. */
  private idOfRow(row: number): string {
    return this.curatedIdOfTwinRow.get(row) ?? this.raw.ids[row]!;
  }

  private parentIds(row: number): string[] {
    const out: string[] = [];
    let current = this.parent[row]!;
    for (let hop = 0; hop < 14 && current >= 0; hop += 1) {
      out.push(this.idOfRow(current));
      current = this.parent[current]!;
    }
    return out;
  }

  private measuredOf(row: number): MeasuredClimate | null {
    const base = climatePoint(this.clim, row * CLIMATE_WIDTH);
    if (!base) return null;
    const highIndex = this.highOf.get(row);
    const seaIndex = this.seaOf.get(row);
    const sst: number[] | null = seaIndex === undefined ? null : Array.from({ length: 12 }, (_, month) => this.seaData[seaIndex * 12 + month]! / 10);
    return {
      base,
      high: highIndex === undefined ? null : climatePoint(this.highData, highIndex * CLIMATE_WIDTH),
      sst,
      cloud: this.cloudCol && this.cloudCol[row * 12] !== 255 ? Array.from(this.cloudCol.subarray(row * 12, row * 12 + 12)) : null,
      waves: this.waveData && this.waveOf.has(row) ? Array.from(this.waveData.subarray(this.waveOf.get(row)! * 12, this.waveOf.get(row)! * 12 + 12)).map(waveHeight) : null,
      coastKm: this.coast[row]! < 0 ? null : this.coast[row]!,
    };
  }

  private u8(column: keyof AtlasArtifact): Uint8Array {
    const cache = this.columns;
    let held = cache.get(column);
    if (!held) {
      held = bytesOf(this.raw[column] as string);
      cache.set(column, held);
    }
    return held;
  }
  private readonly columns = new Map<keyof AtlasArtifact, Uint8Array>();
  private airportRef: Int32Array | null = null;
  private airportKm: Uint16Array | null = null;

  private airportsOf(row: number): NearbyAirport[] {
    this.airportRef ??= int32(this.raw.airportRef);
    this.airportKm ??= uint16(this.raw.airportKm);
    const out: NearbyAirport[] = [];
    for (let slot = 0; slot < 3; slot += 1) {
      const ref = this.airportRef[row * 3 + slot]!;
      if (ref < 0) continue;
      const [iata, name, large] = this.raw.airportTable[ref]!;
      out.push({ iata, name, km: this.airportKm[row * 3 + slot]!, size: large ? 'large' : 'medium' });
    }
    return out;
  }

  /** The destination record of a row, built on first use and kept. */
  private destinationOfRow(row: number): Destination {
    const curated = this.curatedOfRow.get(row);
    if (curated) return curated;
    const held = this.rowCache[row];
    if (held) return held;
    const raw = this.raw;
    const measured = this.measuredOf(row);
    const experiences: Partial<Record<Experience, number>> = {};
    for (let e = 0; e < EXPERIENCES.length; e += 1) {
      const value = this.exp[row * EXPERIENCES.length + e]! / 10;
      if (value >= 0.3) experiences[EXPERIENCES[e]!] = value;
    }
    const tenth = (column: keyof AtlasArtifact) => this.u8(column)[row]! / 10;
    const optional = (column: keyof AtlasArtifact) => (this.u8(column)[row] === 255 ? null : this.u8(column)[row]! / 10);
    const nights = this.u8('nights');
    const lodging = this.u8('lodging')[row]!;
    const airports = this.airportsOf(row);
    const countries = raw.countries[row] ? raw.countries[row]!.split(',') : [];
    const confidence = this.confidence[row]! / 100;
    const substance = this.substance[row]! / 100;
    const costRaw = this.u8('cost')[row]!;
    const remoteness = tenth('remoteness');
    const nearest = airports[0];
    const dataOnly = (this.flags[row]! & FLAG_DATA_ONLY) !== 0;
    const tradeoffs: string[] = [];
    if (nearest && nearest.km > 200) tradeoffs.push(`About ${Math.round(nearest.km / 10) * 10} km from the nearest airport with scheduled flights.`);
    if (dataOnly) tradeoffs.push('No open travel guide covers it yet: expect to do more of the planning yourself.');
    else if (confidence < 0.5) tradeoffs.push('Little is written about it in open travel guides — expect to plan more yourself.');
    if (substance < 0.45 && tradeoffs.length < 3) tradeoffs.push('A small place: likely one part of a wider trip rather than the whole of one.');
    if (remoteness >= 2 && tradeoffs.length < 3) tradeoffs.push('Remote: few services once you are there.');
    if (costRaw >= 34 && tradeoffs.length < 3) tradeoffs.push('Prices run high by world standards.');
    const highC = measured ? measured.base.tmax.map((value) => Math.round(value)) : new Array<number>(12).fill(20);
    const wet = measured ? measured.base.pr.map((mm) => (mm <= 30 ? 0 : mm <= 90 ? 1 : mm <= 200 ? 2 : 3)) : new Array<number>(12).fill(1);
    const title = raw.wv[row];
    const qid = raw.qids[row];
    const destination: Destination = {
      id: raw.ids[row]!,
      name: raw.names[row]!,
      context: raw.contexts[row]!,
      kind: (DESTINATION_KINDS[this.kind[row]!] ?? 'travel_region') as DestinationKind,
      countries,
      worldRegion: (WORLD_REGIONS[this.region[row]!] ?? 'western_europe') as WorldRegion,
      center: { lat: raw.lat[row]!, lng: raw.lng[row]! },
      radiusKm: raw.radiusKm[row]!,
      resolveAs: raw.resolveAs[row]!,
      ...(qid ? { wikidataId: qid } : {}),
      bases: raw.bases[row] ?? [],
      nights: { min: nights[row * 3]!, ideal: nights[row * 3 + 1]!, max: nights[row * 3 + 2]! },
      experiences,
      highlights: raw.highlights[row] ?? [],
      pitch: raw.pitch[row]!,
      highC,
      wet,
      cost: costRaw === 0 ? 2.5 : costRaw / 10,
      lodging: lodging & 8 ? { simple: (lodging & 1) !== 0, comfortable: (lodging & 2) !== 0, luxury: (lodging & 4) !== 0 } : null,
      challenge: { easiest: tenth('easiest'), typical: tenth('typical') },
      remoteness,
      crowds: tenth('crowds'),
      familiarity: tenth('familiarity'),
      access: {
        airports: airports.map((airport) => airport.iata),
        reach: tenth('reach'),
        car: CAR[this.u8('car')[row]!] ?? 'unknown',
        transit: TRANSIT[this.u8('transit')[row]!] ?? 'unknown',
        note: this.gettingAroundNote(CAR[this.u8('car')[row]!] ?? 'unknown', TRANSIT[this.u8('transit')[row]!] ?? 'unknown'),
      },
      family: optional('family'),
      lowMobility: optional('lowMobility'),
      tradeoffs: tradeoffs.slice(0, 3),
      cautions: [],
      evidence: {
        basis: 'open_data',
        asOf: raw.builtAt.slice(0, 7),
        references: [title ? `Wikivoyage: ${title}` : `Wikidata: ${qid}`, ...(measured ? ['CHELSA climate normals 1981–2010'] : [])],
      },
      origin: 'atlas',
      measured,
      confidence,
      substance,
      parents: this.parentIds(row),
      aliases: raw.aliases[String(row)] ?? [],
      airports,
      basis: { experiences: 'estimated', climate: measured ? 'measured' : 'estimated', cost: 'estimated', logistics: 'estimated' },
      advisory: this.advisoryFor(countries[0] ?? null, countries.length === 1 ? raw.advisories.rows?.[String(row)] : undefined),
      landmass: this.landmassOf(row),
      costEvidence: this.costEvidenceOf(row),
      skiArea: this.skiAreaNear(this.raw.lat[row]!, this.raw.lng[row]!, this.raw.radiusKm[row]!),
    };
    this.rowCache[row] = destination;
    return destination;
  }

  private gettingAroundNote(car: (typeof CAR)[number], transit: (typeof TRANSIT)[number]): string {
    if (car === 'unknown') return 'How to get around is not covered in the open guides we read — check before you commit.';
    const carWords = { unnecessary: 'No car needed', helpful: 'A car helps', essential: 'You will want a car' }[car];
    const transitWords = { good: 'public transport is good', limited: 'public transport exists but is limited', poor: 'there is little public transport', unknown: 'public transport is unconfirmed' }[transit];
    return `${carWords}; ${transitWords} (read from its travel guide, not verified).`;
  }

  byId(id: string): Destination | null {
    const curated = this.curatedById.get(id);
    if (curated) return curated;
    const row = this.idToRow.get(id);
    return row === undefined ? null : this.destinationOfRow(row);
  }

  /** Whether a row lies inside a scope row: by the travel hierarchy, by country, or by the scope's own extent. */
  private rowWithin(row: number, scope: ScopeTarget): boolean {
    if (scope.country) return (this.raw.countries[row] ?? '').split(',').includes(scope.country);
    if (scope.row !== null) {
      let current = row;
      for (let hop = 0; hop < 14 && current >= 0; hop += 1) {
        if (current === scope.row || scope.members?.has(current)) return true;
        current = this.parent[current]!;
      }
      /* A region defined by the regions it spans is exactly those regions. */
      if (scope.members) return false;
      /* A region with places filed under it is exactly those places; its circle would take in the neighbours. */
      if (this.childrenOf(scope.row) >= 3) return false;
      /* A continent or a wide section of one is a list of countries, not a circle. */
      if (this.flags[scope.row]! & FLAG_SCOPE) return false;
    }
    if (scope.only && !(this.raw.countries[row] ?? '').split(',').includes(scope.only)) return false;
    return kmBetween(this.raw.lat[row]!, this.raw.lng[row]!, scope.lat, scope.lng) <= Math.max(25, scope.radiusKm * 1.15);
  }

  private scopeTarget(id: string): ScopeTarget | null {
    const destination = this.byId(id);
    if (!destination) return null;
    const row = this.idToRow.get(id) ?? this.twinRowOfCurated.get(id) ?? null;
    const country = destination.kind === 'country' && destination.countries.length === 1 ? destination.countries[0]! : null;
    const members = row !== null ? this.raw.members?.[String(row)] : undefined;
    const scopeOnly = row !== null && (this.flags[row]! & FLAG_SCOPE) !== 0;
    /* A continent or a section of one is its countries: the codes of every country filed under it. */
    let countries: Set<string> | null = null;
    if (scopeOnly) {
      countries = new Set<string>();
      for (const [iso, countryRow] of this.countryRow) {
        let current = this.parent[countryRow]!;
        for (let hop = 0; hop < 8 && current >= 0; hop += 1) {
          if (current === row) {
            countries.add(iso);
            break;
          }
          current = this.parent[current]!;
        }
      }
    }
    /* A named area that lies in one country does not spill over its border, however its circle is drawn. */
    const only = !country && !scopeOnly && destination.countries.length === 1 ? destination.countries[0]! : null;
    return { row, country, lat: destination.center.lat, lng: destination.center.lng, radiusKm: destination.radiusKm, members: members && members.length > 0 ? new Set(members) : null, countries, only };
  }

  /** Suitability of every activity in every month for every row, 0–255, built on first use. */
  private seasons(): Uint8Array {
    if (this.seasonTable) return this.seasonTable;
    const table = new Uint8Array(this.rows * ACTIVITY_COUNT * 12);
    for (let row = 0; row < this.rows; row += 1) {
      if (!this.offerable(row)) continue;
      const measured = this.measuredOf(row);
      if (!measured) continue;
      const model = seasonModel({ lat: this.raw.lat[row]!, base: measured.base, high: measured.high, sst: measured.sst, coastKm: measured.coastKm }, this.raw.lng[row]!);
      for (let a = 0; a < ACTIVITY_COUNT; a += 1) {
        const fit = model.fit[ACTIVITIES[a]!];
        for (let month = 0; month < 12; month += 1) table[(row * ACTIVITY_COUNT + a) * 12 + month] = Math.round(fit[month]!.value * 255);
      }
    }
    this.seasonTable = table;
    return table;
  }

  private postingsFor(termId: number): { rows: Uint32Array; weights: Uint8Array } | null {
    if (!this.postings) {
      const counts = new Map<number, number>();
      for (const id of this.termIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      const built = new Map<number, { rows: Uint32Array; weights: Uint8Array; fill: number }>();
      for (const [id, count] of counts) built.set(id, { rows: new Uint32Array(count), weights: new Uint8Array(count), fill: 0 });
      for (let row = 0; row < this.rows; row += 1) {
        for (let at = this.termOffsets[row]!; at < this.termOffsets[row + 1]!; at += 1) {
          const slot = built.get(this.termIds[at]!)!;
          slot.rows[slot.fill] = row;
          slot.weights[slot.fill] = this.termWeights[at]!;
          slot.fill += 1;
        }
      }
      this.postings = built;
    }
    return this.postings.get(termId) ?? null;
  }

  /**
   * How much each row's guide talks about the words of a request, 0–1.
   * Normalised by what a row matching every term strongly would score, so one
   * shared word is a weak mention and three are a strong one.
   */
  lexicalScores(terms: readonly string[]): Float32Array | null {
    const ids = [...new Set(terms.flatMap((term) => atlasTokens(term)))].map((term) => this.vocab.get(term)).filter((id): id is number => id !== undefined);
    if (ids.length === 0) return null;
    const scores = new Float32Array(this.rows);
    let ceiling = 0;
    for (const id of ids) {
      const list = this.postingsFor(id);
      if (!list) continue;
      let top = 0;
      for (let index = 0; index < list.rows.length; index += 1) {
        const weight = list.weights[index]!;
        scores[list.rows[index]!]! += weight;
        if (weight > top) top = weight;
      }
      /* A term's contribution saturates at a strong (not the single strongest) mention of it. */
      ceiling += Math.min(top, 110);
    }
    if (ceiling === 0) return null;
    for (let row = 0; row < this.rows; row += 1) if (scores[row]! > 0) scores[row] = Math.min(1, scores[row]! / ceiling);
    return scores;
  }

  private embedding: { table: EmbeddingTable; docs: Int8Array; dim: number } | null = null;

  /**
   * Attaches the semantic channel. Refused (returning the reason) when the
   * matrix was built for different rows — a misaligned matrix would give one
   * place another's meaning, which is worse than having none.
   */
  attachEmbeddings(raw: AtlasEmbeddings): string | null {
    if (raw.rows !== this.rows || (this.raw.rowsDigest && raw.rowsDigest !== this.raw.rowsDigest)) return 'embeddings were built for a different atlas';
    this.embedding = { table: decodeEmbeddingTable(raw), docs: decodeInt8Matrix(raw.docs, raw.rows, raw.dim), dim: raw.dim };
    return null;
  }

  get hasEmbeddings(): boolean {
    return this.embedding !== null;
  }

  /**
   * How close each row's guide is in meaning to a phrase, 0–1.
   *
   * Cosine against every row, then standardised **per query**: a static
   * model's cosines sit in a narrow band whose level depends on the words, so
   * a fixed threshold means nothing. What counts is how far a row stands above
   * the crowd for this phrase — 1.5 standard deviations is a faint echo, four
   * is as close as it gets.
   */
  semanticScores(phrase: string): Float32Array | null {
    const held = this.embedding;
    if (!held) return null;
    const query = embedQuery(phrase, held.table);
    if (!query) return null;
    const { docs, dim } = held;
    const scores = new Float32Array(this.rows);
    let sum = 0;
    let squares = 0;
    let counted = 0;
    for (let row = 0; row < this.rows; row += 1) {
      const base = row * dim;
      let dot = 0;
      let norm = 0;
      for (let k = 0; k < dim; k += 1) {
        const value = docs[base + k]!;
        dot += value * query[k]!;
        norm += value * value;
      }
      if (norm === 0) continue;
      const cosine = dot / Math.sqrt(norm);
      scores[row] = cosine;
      sum += cosine;
      squares += cosine * cosine;
      counted += 1;
    }
    if (counted < 2) return null;
    const mean = sum / counted;
    const deviation = Math.sqrt(Math.max(1e-9, squares / counted - mean * mean));
    for (let row = 0; row < this.rows; row += 1) scores[row] = scores[row] === 0 ? 0 : Math.min(1, Math.max(0, ((scores[row]! - mean) / deviation - 1.5) / 2.5));
    return scores;
  }

  /**
   * How much each row's guide speaks to the request's own words, 0–1: the
   * lexical index first (it finds the decisive rare word — "puffins" — that an
   * averaged vector dilutes), the meaning channel beside it at a discount (it
   * finds "remote monasteries and high passes" where no guide uses those
   * words). Measured in `docs/global-destinations`: lexical is far better at
   * finding a place, the embedding better at ranking by experience; neither
   * replaces the other.
   */
  private mentions(terms: readonly string[], phrase: string | undefined): Float32Array | null {
    const lexical = terms.length > 0 ? this.lexicalScores(terms) : null;
    const semantic = phrase && phrase.trim().length >= 4 ? this.semanticScores(phrase) : null;
    if (!semantic) return lexical;
    if (!lexical) {
      for (let row = 0; row < this.rows; row += 1) semantic[row] = semantic[row]! * SEMANTIC_SHARE;
      return semantic;
    }
    for (let row = 0; row < this.rows; row += 1) lexical[row] = Math.max(lexical[row]!, SEMANTIC_SHARE * semantic[row]!, Math.min(1, 0.8 * lexical[row]! + 0.35 * semantic[row]!));
    return lexical;
  }

  candidates(query: CandidateQuery): Destination[] {
    const raw = this.raw;
    const scopes = query.within ? query.within.map((id) => this.scopeTarget(id)).filter((scope): scope is ScopeTarget => scope !== null) : null;
    const regionSet = query.regions ? new Set(query.regions.map((region) => WORLD_REGIONS.indexOf(region))) : null;
    const countrySet = query.countries ? new Set(query.countries) : null;
    const floor = Math.round((scopes && scopes.length > 0 ? SUBSTANCE_FLOOR_IN_SCOPE : SUBSTANCE_FLOOR) * 100);
    const wantIndex: number[] = [];
    const wantWeight: number[] = [];
    for (const [experience, weight] of Object.entries(query.wants) as [Experience, number][]) {
      if (weight <= 0) continue;
      wantIndex.push(EXPERIENCES.indexOf(experience));
      wantWeight.push(weight);
    }
    const target = query.similarTo ? this.byId(query.similarTo) : null;
    const targetVector = target ? EXPERIENCES.map((experience) => target.experiences[experience] ?? 0) : null;
    const targetNorm = targetVector ? Math.sqrt(targetVector.reduce((sum, value) => sum + value * value, 0)) : 0;
    const mention = query.terms.length > 0 || query.phrase ? this.mentions(query.terms, query.phrase) : null;
    const months = query.months && query.months.length < 12 ? query.months : null;
    const seasons = months ? this.seasons() : null;
    const activityOf = wantIndex.map((index) => ACTIVITIES.indexOf(EXPERIENCE_ACTIVITY[EXPERIENCES[index]!]));
    const anyActivity = ACTIVITIES.indexOf('any');
    const width = EXPERIENCES.length;

    const inScope = (row: number): boolean => {
      if (regionSet && !regionSet.has(this.region[row]!)) return false;
      if (countrySet) {
        const codes = raw.countries[row];
        if (!codes || !codes.split(',').some((code) => countrySet.has(code))) return false;
      }
      if (scopes && scopes.length > 0 && !scopes.some((scope) => this.rowWithin(row, scope))) return false;
      return true;
    };

    const scored: { row: number; value: number }[] = [];
    for (let row = 0; row < this.rows; row += 1) {
      if (!this.offerable(row) || this.substance[row]! < floor) continue;
      if (query.excluded.has(raw.ids[row]!) || !inScope(row)) continue;
      const base = row * width;
      let relevance = 0.5;
      if (wantIndex.length > 0) {
        let asked = 0;
        for (let k = 0; k < wantIndex.length; k += 1) asked += wantWeight[k]! * (this.exp[base + wantIndex[k]!]! / 30);
        relevance = asked;
      }
      if (targetVector) {
        let dot = 0;
        let norm = 0;
        for (let e = 0; e < width; e += 1) {
          const value = this.exp[base + e]! / 10;
          dot += value * targetVector[e]!;
          norm += value * value;
        }
        const similar = norm === 0 || targetNorm === 0 ? 0 : dot / (Math.sqrt(norm) * targetNorm);
        relevance = wantIndex.length > 0 ? 0.5 * relevance + 0.5 * similar : similar;
      }
      if (mention) {
        const said = mention[row]!;
        relevance = wantIndex.length > 0 || targetVector ? 0.7 * relevance + 0.3 * said : said;
      }
      let value = relevance * (0.55 + 0.45 * (this.substance[row]! / 100)) * (0.75 + 0.25 * (this.confidence[row]! / 100));
      if (seasons && months) {
        /* The season of what they would do there: each wanted experience's activity, weighted by want and by offer. */
        let best = 0;
        for (const month of months) {
          let total = 0;
          let weight = 0;
          for (let k = 0; k < wantIndex.length; k += 1) {
            const share = wantWeight[k]! * (this.exp[base + wantIndex[k]!]! / 30);
            if (share <= 0) continue;
            total += share * seasons[(row * ACTIVITY_COUNT + activityOf[k]!) * 12 + month - 1]!;
            weight += share;
          }
          const fit = weight > 0 ? total / weight / 255 : seasons[(row * ACTIVITY_COUNT + anyActivity) * 12 + month - 1]! / 255;
          if (fit > best) best = fit;
        }
        value *= 0.2 + 0.8 * best;
      }
      if (value > 0) scored.push({ row, value });
    }
    scored.sort((a, b) => b.value - a.value || a.row - b.row);
    const chosen = new Set<number>();
    for (const entry of scored.slice(0, query.limit)) chosen.add(entry.row);
    /* The strongest mentions are always read closely, whatever else the first pass thought of them. */
    if (mention) {
      const said = scored.filter((entry) => mention[entry.row]! >= 0.34).sort((a, b) => mention[b.row]! - mention[a.row]!);
      for (const entry of said.slice(0, 80)) chosen.add(entry.row);
    }

    for (const id of query.include ?? []) {
      const row = this.idToRow.get(id);
      if (row !== undefined && this.offerable(row) && !query.excluded.has(id) && inScope(row)) chosen.add(row);
    }

    const out: Destination[] = [];
    for (const destination of this.curatedList) {
      if (query.excluded.has(destination.id)) continue;
      if (regionSet && !regionSet.has(WORLD_REGIONS.indexOf(destination.worldRegion))) continue;
      if (countrySet && !destination.countries.some((code) => countrySet.has(code))) continue;
      if (scopes && scopes.length > 0) {
        const twin = this.twinRowOfCurated.get(destination.id);
        const inside = scopes.some((scope) => {
          if (twin !== undefined && this.rowWithin(twin, scope)) return true;
          if (scope.country) return destination.countries.includes(scope.country);
          if (scope.countries) return destination.countries.some((code) => scope.countries!.has(code));
          if (twin !== undefined || scope.members) return false;
          if (scope.only && !destination.countries.includes(scope.only)) return false;
          return kmBetween(destination.center.lat, destination.center.lng, scope.lat, scope.lng) <= Math.max(25, scope.radiusKm * 1.15);
        });
        if (!inside) continue;
      }
      const twin = this.twinRowOfCurated.get(destination.id);
      out.push(mention && twin !== undefined ? { ...destination, mention: mention[twin]! } : mention ? { ...destination, mention: 0 } : destination);
    }
    for (const row of chosen) {
      const destination = this.destinationOfRow(row);
      out.push(mention ? { ...destination, mention: mention[row]! } : destination);
    }
    return out;
  }

  private nameIndex(): Map<string, NameTarget[]> {
    if (this.names) return this.names;
    const index = new Map<string, NameTarget[]>();
    const add = (name: string, ref: number, primary: boolean) => {
      const key = foldPlaceName(name);
      if (key.length < 3 || key.length > 48) return;
      const list = index.get(key);
      if (!list) index.set(key, [{ ref, primary }]);
      else {
        const held = list.find((entry) => entry.ref === ref);
        if (!held) list.push({ ref, primary });
        /* Reached as a nickname first and as its own name second: it is its own name. */
        else if (primary) held.primary = true;
      }
    };
    /*
     * A place answers to its name without the furniture: "Kilimanjaro" for
     * "Mount Kilimanjaro", "Kakadu" for "Kakadu National Park", "Dolomites" for
     * "The Dolomites". Only when what is left is still distinctive.
     */
    const bare = (name: string): string | null => {
      const stripped = name
        .replace(/^(the|mount|mt\.?|lake|isle of|island of|gulf of|bay of)\s+/i, '')
        .replace(/\s+(national park|nature reserve|game reserve|national reserve|wildlife sanctuary|biosphere reserve|conservation area|marine park|region|valley|mountains?|islands?|archipelago|peninsula|desert|highlands|plateau|massif|range)$/i, '')
        .trim();
      const key = foldPlaceName(stripped);
      /* What is left must still be a name: not an ordinary word, not a direction, not an ocean ("Atlantic Region" is not "the Atlantic"). */
      if (stripped === name || key.length < 5 || ORDINARY_WORDS.has(key) || NEVER_ALONE.has(key) || /^(atlantic|pacific|indian|arctic|mediterranean|caribbean|baltic|alpine|coastal|central|great|grand|national|royal|upper|lower|inner|outer)$/.test(key)) return null;
      return stripped;
    };
    /* The name without its furniture is as much the place's own name as the full one. */
    const addAll = (name: string, ref: number, primary: boolean) => {
      add(name, ref, primary);
      const short = bare(name);
      if (short) add(short, ref, primary);
    };
    this.curatedList.forEach((destination, at) => {
      addAll(destination.name, -(at + 1), true);
      /* "Kruger & Sabi Sand" answers to "Kruger"; "Japanese Alps: Kamikochi & Takayama" to "Japanese Alps". */
      const head = destination.name.split(/\s*(?:&|:|,| and )\s*/)[0]!;
      if (head !== destination.name && head.length >= 5) addAll(head, -(at + 1), false);
      /* And to whatever its derived twin is called: the guide's own title and aliases. */
      const twin = this.twinRowOfCurated.get(destination.id);
      if (twin !== undefined) {
        addAll(this.raw.names[twin]!, -(at + 1), true);
        for (const alias of this.raw.aliases[String(twin)] ?? []) add(alias, -(at + 1), false);
      }
    });
    for (let row = 0; row < this.rows; row += 1) {
      if (this.flags[row]! & FLAG_TWIN) continue;
      addAll(this.raw.names[row]!, row, true);
      const title = this.raw.wv[row];
      if (title && title !== this.raw.names[row]) add(title, row, true);
      for (const alias of this.raw.aliases[String(row)] ?? []) add(alias, row, false);
    }
    this.names = index;
    return index;
  }

  private prefixes: Map<string, number[]> | null = null;
  /** Wide places by the first two words of a longer name. */
  private prefixIndex(): Map<string, number[]> {
    if (this.prefixes) return this.prefixes;
    const index = new Map<string, number[]>();
    for (let row = 0; row < this.rows; row += 1) {
      if (this.flags[row]! & FLAG_TWIN) continue;
      const kind = DESTINATION_KINDS[this.kind[row]!];
      if (kind === 'city' || kind === 'town' || kind === 'route') continue;
      const words = foldPlaceName(this.raw.names[row]!).split(' ');
      if (words.length < 3) continue;
      const key = `${words[0]} ${words[1]}`;
      const list = index.get(key);
      if (list) list.push(row);
      else index.set(key, [row]);
    }
    this.prefixes = index;
    return index;
  }

  private childCounts: Uint16Array | null = null;
  /** How many rows are filed directly under each row. */
  private childrenOf(row: number): number {
    if (!this.childCounts) {
      const counts = new Uint16Array(this.rows);
      for (let child = 0; child < this.rows; child += 1) {
        const parent = this.parent[child]!;
        if (parent >= 0 && counts[parent]! < 65535) counts[parent]! += 1;
      }
      this.childCounts = counts;
    }
    return this.childCounts[row]!;
  }

  /** The ISO code a curated entry stands for, when its derived twin is the country's own row. */
  private curatedCountry(at: number): string | null {
    const destination = this.curatedList[at]!;
    const twin = this.twinRowOfCurated.get(destination.id);
    if (twin === undefined || DESTINATION_KINDS[this.kind[twin]!] !== 'country') return null;
    const iso = this.raw.countries[twin];
    return iso && !iso.includes(',') ? iso : null;
  }

  private refProminence(target: NameTarget): number {
    /* A curated entry is a major destination by construction; where it stands for a whole country it reads as one. */
    if (target.ref < 0) return (this.curatedCountry(-target.ref - 1) ? 6.5 : 5.5) + (target.primary ? 1.5 : 0);
    const row = target.ref;
    const kind = DESTINATION_KINDS[this.kind[row]!];
    const scope = (this.flags[row]! & FLAG_SCOPE) !== 0;
    const wide = scope ? 3 : kind === 'country' ? 3.5 : kind === 'city' ? 1.2 : kind === 'town' ? 0.4 : kind === 'route' ? -1 : 2;
    return wide + this.u8('familiarity')[row]! / 10 + this.substance[row]! / 100 + (target.primary ? 1.5 : 0);
  }

  /** The best-known place a name refers to, or null. */
  resolveName(name: string): Destination | null {
    const targets = this.nameIndex().get(foldPlaceName(name));
    if (!targets || targets.length === 0) return null;
    const best = [...targets].sort((a, b) => this.refProminence(b) - this.refProminence(a))[0]!;
    return best.ref < 0 ? this.curatedList[-best.ref - 1]! : this.destinationOfRow(best.ref);
  }

  /**
   * The places a sentence names, longest name first, each with the role its
   * surrounding words give it. A lower-case word that is also an English word
   * ("nice", "bath", "turkey") is a word; a lower-case name is accepted only
   * for a place prominent enough that a traveller plainly means it.
   */
  findPlaces(text: string): PlaceMention[] {
    const index = this.nameIndex();
    const words: { text: string; start: number; end: number }[] = [];
    for (const match of text.matchAll(/[\p{L}][\p{L}'’.-]*/gu)) words.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    const taken = new Array<boolean>(words.length).fill(false);
    const found: PlaceMention[] = [];
    const roleAt = (start: number, previous: PlaceMention | null): PlaceRole => {
      const before = text.slice(Math.max(0, start - 48), start).toLowerCase();
      if (previous && JOIN_CUE.test(text.slice(previous.end, start).toLowerCase())) return previous.role;
      if (ORIGIN_CUE.test(before)) return 'origin';
      if (SIMILAR_CUE.test(before)) return 'similar';
      if (AVOID_CUE.test(before)) return 'avoid';
      return 'scope';
    };
    for (let size = 4; size >= 1; size -= 1) {
      for (let at = 0; at + size <= words.length; at += 1) {
        if (taken.slice(at, at + size).some(Boolean)) continue;
        const slice = words.slice(at, at + size);
        const phrase = text.slice(slice[0]!.start, slice[size - 1]!.end);
        const key = foldPlaceName(phrase);
        let targets = index.get(key);
        let demonym: string | null = null;
        if (size === 1) {
          const word = slice[0]!.text;
          const before = text.slice(Math.max(0, slice[0]!.start - 16), slice[0]!.start).toLowerCase();
          /* "South American", "Latin American": the region tables read those; "American" alone is the United States. */
          const compound = /\b(south|latin|central|north|eastern|western|southern|northern)\s+$/.test(before);
          const acronym = COUNTRY_ACRONYMS[word];
          const iso = acronym ?? (compound ? undefined : DEMONYMS[key]);
          const row = iso ? this.countryRow.get(iso) : undefined;
          if (row !== undefined && (acronym || !targets)) {
            targets = [{ ref: row, primary: true }];
            demonym = iso!;
          } else if (REGION_ADJECTIVES[key] && (!targets || key === 'amazon')) {
            const named = index.get(foldPlaceName(REGION_ADJECTIVES[key]!));
            if (named) {
              targets = named;
              demonym = key;
            }
          }
          if (!demonym && (NEVER_ALONE.has(key) || NEVER_ALONE.has(atlasStem(key)))) continue;
        }
        /* "Red Sea" names no record; "Red Sea Coast" does. Two capitalised words may stand for a longer name that starts with them. */
        if (!targets && size === 2 && slice.every((word) => /^\p{Lu}/u.test(word.text))) targets = this.prefixIndex().get(key)?.map((ref) => ({ ref, primary: false }));
        if (!targets) continue;
        const capitalised = /^\p{Lu}/u.test(slice[0]!.text);
        const best = [...targets].sort((a, b) => this.refProminence(b) - this.refProminence(a))[0]!;
        const prominence = this.refProminence(best);
        if (!demonym) {
          if (!capitalised) {
            if (size === 1 && (AMBIGUOUS_LOWER.has(key) || AMBIGUOUS_LOWER.has(atlasStem(key)) || key.length < 4)) continue;
            /* In lower case only a place's own name counts, and only for a place prominent enough to be plainly meant. */
            if (!best.primary || prominence < 6) continue;
          } else if (size === 1) {
            if (key.length < 4 && prominence < 5.5) continue;
            /* A capital letter proves little for one word: an alias must belong to a place a traveller would plainly mean. */
            if (!best.primary && prominence < 6.5) continue;
            const opensSentence = slice[0]!.start === 0 || /[.!?:]\s*$/.test(text.slice(Math.max(0, slice[0]!.start - 3), slice[0]!.start));
            /* An ordinary word with a capital because it opens the sentence. "China beyond Beijing…" is still China. */
            if (opensSentence && ORDINARY_WORDS.has(key)) continue;
          }
        }
        const destination = best.ref < 0 ? this.curatedList[-best.ref - 1]! : this.destinationOfRow(best.ref);
        /* A route reached through a nickname ("the Amazon" for a river voyage) is a poor reading; let the shorter name try. */
        if (destination.kind === 'route' && !best.primary) continue;
        const scope = best.ref >= 0 && (this.flags[best.ref]! & FLAG_SCOPE) !== 0;
        /* A route is a line on a map: it can be resembled or ruled out, never searched inside. */
        const wide = destination.kind !== 'route' && (scope || destination.kind === 'country' || destination.radiusKm >= 30 || ['travel_region', 'mountain_range', 'island_group', 'desert', 'coast', 'country_circuit', 'lake_district'].includes(destination.kind));
        for (let k = at; k < at + size; k += 1) taken[k] = true;
        const sameName = wide
          ? targets
              .filter((target) => target.primary && target !== best)
              .map((target) => (target.ref < 0 ? this.curatedList[-target.ref - 1]! : this.destinationOfRow(target.ref)))
              .filter((other) => other.kind !== 'route' && other.kind !== 'city' && other.kind !== 'town' && (other.radiusKm >= 30 || other.kind === 'country'))
              .map((other) => other.id)
          : [];
        found.push({
          id: destination.id,
          ids: [...new Set([destination.id, ...sameName])],
          name: destination.name,
          role: 'scope',
          start: slice[0]!.start,
          end: slice[size - 1]!.end,
          country: best.ref < 0 ? this.curatedCountry(-best.ref - 1) : destination.kind === 'country' && destination.countries.length === 1 ? destination.countries[0]! : null,
          center: destination.center,
          wide,
        });
      }
    }
    found.sort((a, b) => a.start - b.start);
    let previous: PlaceMention | null = null;
    for (const mention of found) {
      mention.role = roleAt(mention.start, previous);
      previous = mention;
    }
    return found;
  }

  /**
   * Builds the tables the first request would otherwise wait for: the
   * activity-by-month table for every row, the lexical postings and the name
   * index. A second or two of work, done once; the loader calls it off the
   * request path so no traveller's first question pays for it.
   */
  warm(): void {
    this.seasons();
    this.postingsFor(0);
    this.nameIndex();
    this.prefixIndex();
  }

  /** A spread of real destination centres for the world map: the most substantial rows, thinned evenly. */
  samplePoints(limit: number): { id: string; lat: number; lng: number }[] {
    const rows: number[] = [];
    for (let row = 0; row < this.rows; row += 1) if (this.offerable(row) && this.substance[row]! >= 45) rows.push(row);
    const step = Math.max(1, Math.floor(rows.length / Math.max(1, limit - this.curatedList.length)));
    const out = this.curatedList.map((destination) => ({ id: destination.id, lat: destination.center.lat, lng: destination.center.lng }));
    for (let at = 0; at < rows.length && out.length < limit; at += step) out.push({ id: this.raw.ids[rows[at]!]!, lat: this.raw.lat[rows[at]!]!, lng: this.raw.lng[rows[at]!]! });
    return out;
  }

  /** Counts for the read-out and the evaluation: how the world is covered. */
  coverage(): { destinations: number; curated: number; countries: number; byKind: Record<string, number>; byWorldRegion: Record<string, number> } {
    const byKind: Record<string, number> = {};
    const byWorldRegion: Record<string, number> = {};
    const countries = new Set<string>();
    const count = (kind: string, region: string, codes: readonly string[]) => {
      byKind[kind] = (byKind[kind] ?? 0) + 1;
      byWorldRegion[region] = (byWorldRegion[region] ?? 0) + 1;
      for (const code of codes) countries.add(code);
    };
    for (const destination of this.curatedList) count(destination.kind, destination.worldRegion, destination.countries);
    for (let row = 0; row < this.rows; row += 1) {
      if (!this.offerable(row)) continue;
      count(DESTINATION_KINDS[this.kind[row]!] ?? 'travel_region', WORLD_REGIONS[this.region[row]!] ?? 'unknown', this.raw.countries[row] ? this.raw.countries[row]!.split(',') : []);
    }
    return { destinations: this.size, curated: this.curatedList.length, countries: countries.size, byKind, byWorldRegion };
  }

  /** Every offerable destination, for evaluations that must look at the whole world. Not for request paths. */
  all(): Destination[] {
    const out = [...this.curatedList];
    for (let row = 0; row < this.rows; row += 1) if (this.offerable(row)) out.push(this.destinationOfRow(row));
    return out;
  }

  /** The ids of every row inside a named area, for evaluations. */
  curatedDestinations(): readonly Destination[] {
    return this.curatedList;
  }
}

interface ScopeTarget {
  row: number | null;
  country: string | null;
  lat: number;
  lng: number;
  radiusKm: number;
  members: Set<number> | null;
  /** For a continent-scale scope: the countries filed under it. */
  countries: Set<string> | null;
  /** For an area inside one country: that country. */
  only: string | null;
}
