import type { ClimatePoint, Monthly } from '../atlas/seasonality';
import type { CatalogDestination, DestinationKind, Experience, WorldRegion } from './catalog/schema';

/**
 * ONE RECORD FOR EVERY PLACE THE ADVISOR CAN RECOMMEND.
 *
 * Until the global atlas, a destination was one of 234 hand-written entries and
 * the ranker read their fields directly. A destination can now come from three
 * places, and the ranker must not care which:
 *
 * - `editorial` — the curated catalog: a person's reading, with references;
 * - `atlas` — derived offline from open data (Wikivoyage, Wikidata, climate
 *   normals, terrain, airports, price levels) with no human in the loop;
 * - `research` — a place a model proposed for an unusual request, kept only
 *   because it resolved to a real, located entity, and ranked like any other.
 *
 * What differs between them is not the shape but **how much is known and how**.
 * So every record carries `confidence` (how much evidence stands behind its
 * experience scores and logistics), `basis` per group of fields (measured /
 * estimated / editorial / model), and `null` wherever a fact is simply not
 * known. The scorer shrinks a thinly evidenced reading toward a cautious prior
 * rather than trusting it or throwing the place away — the two failures the
 * brief names.
 */

export type DestinationOrigin = 'editorial' | 'atlas' | 'research';

/** How a group of fields was arrived at. Shown to the traveller in words, never as a field name. */
export type FieldBasis = 'measured' | 'estimated' | 'editorial' | 'model';

export interface MeasuredClimate {
  /** Thirty-year monthly normals where people stay. */
  base: ClimatePoint;
  /** The same on the highest ground inside the destination, when it stands well above the base. */
  high: ClimatePoint | null;
  /** Long-term mean sea-surface temperature of the nearest sea, °C. */
  sst: Monthly | null;
  /** Great-circle km to the sea; null when inland. */
  coastKm: number | null;
  /** Mean cloud cover by month, %, when held. */
  cloud?: Monthly | null;
  /** Mean significant wave height by month, m; NaN under sea ice. */
  waves?: Monthly | null;
}

export interface NearbyAirport {
  iata: string;
  name: string;
  km: number;
  /** `large` = intercontinental hub, `medium` = regional scheduled service. */
  size: 'large' | 'medium';
}

export interface Destination {
  /** Stable. A curated slug, `wv:<Wikivoyage title>` or `wd:<QID>`. */
  id: string;
  name: string;
  context: string;
  kind: DestinationKind;
  countries: string[];
  worldRegion: WorldRegion;
  center: { lat: number; lng: number };
  radiusKm: number;
  resolveAs: string;
  wikidataId?: string;
  bases: string[];
  nights: { min: number; ideal: number; max: number };
  /** 0–3 per experience; editorial integers or estimated fractions. */
  experiences: Partial<Record<Experience, number>>;
  highlights: string[];
  pitch: string;
  /** An editorial overall season curve, when a person wrote one. Never present for derived records. */
  season?: number[];
  /** Typical daytime high per month, °C. */
  highC: number[];
  /** Wetness per month, 0 dry … 3 very wet. */
  wet: number[];
  /** 1 budget-friendly … 4 expensive; fractional when estimated from a price level. */
  cost: number;
  lodging: { simple: boolean; comfortable: boolean; luxury: boolean } | null;
  challenge: { easiest: number; typical: number };
  remoteness: number;
  crowds: number;
  familiarity: number;
  access: {
    airports: string[];
    reach: number;
    car: 'unnecessary' | 'helpful' | 'essential' | 'unknown';
    transit: 'good' | 'limited' | 'poor' | 'unknown';
    note: string;
  };
  family: number | null;
  lowMobility: number | null;
  tradeoffs: string[];
  cautions: string[];
  evidence: { basis: 'sidequest_editorial' | 'open_data' | 'research_suggestion'; asOf: string; references: string[] };

  origin: DestinationOrigin;
  /** Measured climate and terrain, when the atlas has sampled this place. */
  measured: MeasuredClimate | null;
  /** 0–1: how much evidence stands behind the experience scores. An editorial reading is high, not certain. */
  confidence: number;
  /** 0–1: whether there is enough here for several days — places to sleep, things to do, a guide written about it. */
  substance: number;
  /** Ancestors in the travel hierarchy, nearest first, as destination ids. */
  parents: string[];
  aliases: string[];
  /** Nearest scheduled airports with distances, when computed. */
  airports: NearbyAirport[];
  /** How each group of fields was arrived at. */
  basis: { experiences: FieldBasis; climate: FieldBasis; cost: FieldBasis; logistics: FieldBasis };
  /**
   * The official advice that applies here, when any is held: the strictest
   * covering this place. `area` names the warned area when the warning is
   * regional. `parts` lists authorities that warn about *some* of the country
   * where it could not be established whether this place is inside — which is
   * never a statement that it is outside.
   */
  advisory: DestinationAdvisory | null;
  /** The nearest lift-served ski area, when one is within reach. Says lifts exist, not that they are running. */
  skiArea?: { lifts: number; verticalM: number; km: number } | null;
  /** The landmass it stands on, as an opaque number, when that is known. */
  landmass?: number | null;
  /** What a room costs here, as a range, when listings or a fitted estimate say. Never a current price. */
  costEvidence?: DestinationCostEvidence | null;
  /** How squarely its guide is about the specific things the request named, 0–1. Set per query. */
  namedMention?: number;
  /** Lexical relevance to words in the request that no structured field captured, 0–1. Set per query. */
  mention?: number;
}

/** How far to trust an editorial reading: high, and deliberately not 1 — nobody checked the prices. */
export const EDITORIAL_CONFIDENCE = 0.9;

export interface DestinationAdvisory {
  level: number;
  asOf: string;
  source: string;
  area?: string | null;
  url?: string;
  parts?: { source: string; level: number; url: string }[];
}

export interface DestinationCostEvidence {
  /** 80 % range for a mid-range double room, US dollars of the observation period. */
  roomUsd: [number, number];
  basis: 'historical_observation' | 'model_estimate';
  /** The years of the listings it rests on, when it rests on any of its own. */
  years: [number, number] | null;
}

export interface CatalogEnrichment {
  landmass?: number | null;
  costEvidence?: DestinationCostEvidence | null;
  measured?: MeasuredClimate | null;
  parents?: string[];
  aliases?: string[];
  airports?: NearbyAirport[];
  advisory?: Destination['advisory'];
}

/** A curated entry as a destination record, with whatever the atlas measured for it laid beside the editorial reading. */
export function destinationFromCatalog(entry: CatalogDestination, enrichment: CatalogEnrichment = {}): Destination {
  return {
    ...entry,
    countries: [...entry.countries],
    origin: 'editorial',
    measured: enrichment.measured ?? null,
    confidence: EDITORIAL_CONFIDENCE,
    substance: 1,
    parents: enrichment.parents ?? [],
    aliases: enrichment.aliases ?? [],
    airports: enrichment.airports ?? [],
    basis: { experiences: 'editorial', climate: enrichment.measured ? 'measured' : 'editorial', cost: 'editorial', logistics: 'editorial' },
    advisory: enrichment.advisory ?? null,
    landmass: enrichment.landmass ?? null,
    costEvidence: enrichment.costEvidence ?? null,
  };
}

const converted = new WeakMap<CatalogDestination, Destination>();

/**
 * Accepts either form, so tests and evaluations can keep passing plain catalog
 * entries. One record per entry, always the same object: the scorer keeps its
 * per-destination season model keyed on it.
 */
export function asDestination(entry: CatalogDestination | Destination): Destination {
  if ('origin' in entry) return entry;
  let held = converted.get(entry);
  if (!held) {
    held = destinationFromCatalog(entry);
    converted.set(entry, held);
  }
  return held;
}

/**
 * The places the advisor can choose among for one request.
 *
 * A world is asked for **candidates**, not handed over whole: with tens of
 * thousands of destinations the scorer's twelve-factor reading is spent on the
 * few hundred a cheap first pass could not rule out. A plain array is a world
 * too (`arrayWorld`), which is what the curated catalog and every unit test are.
 */
export interface DestinationWorld {
  version: string;
  size: number;
  candidates(query: CandidateQuery): Destination[];
  byId(id: string): Destination | null;
}

export interface CandidateQuery {
  /** Experience weights summing to one; empty when nothing was said. */
  wants: Partial<Record<Experience, number>>;
  /** Parts of the world in scope, or null for anywhere. */
  regions: readonly WorldRegion[] | null;
  countries: readonly string[] | null;
  /** Destination ids the request named as its geography ("in the Karakoram"). */
  within: readonly string[] | null;
  /** A destination to resemble ("like the Dolomites"), which is itself left out. */
  similarTo: string | null;
  /** Words from the request no structured field captured ("tea plantations"). */
  /** Specific things named in the request, scored apart from its other words. */
  named?: readonly string[];
  terms: readonly string[];
  /** The same words as a phrase, in the traveller's order, for the meaning channel. */
  phrase?: string;
  /** The months that count, for a cheap seasonal pre-filter; null when open. */
  months: readonly number[] | null;
  /** Ids never to return. */
  excluded: ReadonlySet<string>;
  /** How many candidates the detailed scorer will be given. */
  limit: number;
  /**
   * Destinations to read closely whatever the first pass thinks of them —
   * places a research model proposed for an unusual request. Being included is
   * not being recommended: they meet the same constraints and the same scorer.
   */
  include?: readonly string[];
}

export function arrayWorld(entries: readonly (CatalogDestination | Destination)[], version = 'array'): DestinationWorld {
  const all = entries.map(asDestination);
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  return { version, size: all.length, candidates: () => all, byId: (id) => byId.get(id) ?? null };
}
