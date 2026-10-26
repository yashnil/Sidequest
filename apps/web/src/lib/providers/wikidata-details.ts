import 'server-only';
import { z } from 'zod';
import { providerUserAgent } from '../net/user-agent';
import { isWikidataId } from './wikidata';

/**
 * WHAT WIKIDATA SAYS A PLACE IS — ONE BATCHED QUERY FOR A WHOLE BOARD.
 *
 * The open-data scan used to describe every place by where it was listed
 * ("On Wikidata as a fort, about 7 km from Lisbon."), because it had asked the
 * knowledge base for nothing but coordinates and attention. The same item
 * carries a short English description written by its editors, an inception
 * date with its precision, its heritage designations, its architects and its
 * architectural style. One SPARQL request answers all of that for the whole
 * pool (at most `MAX_IDS` ids), after the pool is chosen and before the
 * proposal is written, so the board is described at scan time and a render
 * never asks anybody anything.
 *
 * Licence: CC0 1.0 (Wikidata structured data and descriptions). No
 * attribution obligation; credited as a source like the rest of the open-data
 * path. Wikipedia article text (CC BY-SA) is *not* fetched: only the article
 * URL is kept, so a surface that can show attribution could link it later.
 *
 * Never throws. A query that does not answer is "nothing known", never "nothing
 * true": the caller falls back to the plain category label.
 */

const ENDPOINT = 'https://query.wikidata.org/sparql';
const REQUEST_TIMEOUT_MS = 12_000;
export const MAX_DETAIL_IDS = 60;

export interface WikidataInception {
  /** Signed year (negative = BCE). */
  year: number;
  /** Wikibase time precision: 7 century, 8 decade, 9 year, 10 month, 11 day. */
  precision: number;
}

export interface WikidataPlaceDetails {
  id: string;
  /** The English description, as published (world-editable; sanitised by the reader). */
  description?: string;
  inception?: WikidataInception;
  /** P1435 labels, in English. */
  heritage: string[];
  /** P84 labels. */
  architects: string[];
  /** P149 labels. */
  styles: string[];
  /** P31 labels — what the item is an instance of. */
  instances: string[];
  /** English Wikipedia article URL, when one exists. Kept for attribution; no text is fetched. */
  article?: string;
}

/** The query. Every field is OPTIONAL and folded per item, so one row per id comes back. */
export function sparqlDetails(ids: readonly string[]): string {
  const values = ids.map((id) => `wd:${id}`).join(' ');
  return `SELECT ?item (SAMPLE(?desc) AS ?description) (SAMPLE(?art) AS ?article)
  (GROUP_CONCAT(DISTINCT ?inc; separator="|") AS ?inceptions)
  (GROUP_CONCAT(DISTINCT ?hl; separator="|") AS ?heritage)
  (GROUP_CONCAT(DISTINCT ?al; separator="|") AS ?architects)
  (GROUP_CONCAT(DISTINCT ?sl; separator="|") AS ?styles)
  (GROUP_CONCAT(DISTINCT ?il; separator="|") AS ?instances)
WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?item p:P571/psv:P571 ?incNode . ?incNode wikibase:timeValue ?t ; wikibase:timePrecision ?p . BIND(CONCAT(STR(?t), "/", STR(?p)) AS ?inc) }
  OPTIONAL { ?item wdt:P1435 ?h . ?h rdfs:label ?hl FILTER(LANG(?hl) = "en") }
  OPTIONAL { ?item wdt:P84 ?a . ?a rdfs:label ?al FILTER(LANG(?al) = "en") }
  OPTIONAL { ?item wdt:P149 ?s . ?s rdfs:label ?sl FILTER(LANG(?sl) = "en") }
  OPTIONAL { ?item wdt:P31 ?i . ?i rdfs:label ?il FILTER(LANG(?il) = "en") }
  OPTIONAL { ?art schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
} GROUP BY ?item`;
}

const value = z.object({ value: z.string() }).optional();
const bindingSchema = z.object({
  item: z.object({ value: z.string() }),
  description: value,
  article: value,
  inceptions: value,
  heritage: value,
  architects: value,
  styles: value,
  instances: value,
});
const responseSchema = z.object({ results: z.object({ bindings: z.array(z.unknown()) }) });

const list = (raw: string | undefined, limit = 6): string[] =>
  [...new Set((raw ?? '').split('|').map((s) => clean(s)).filter((s): s is string => s !== null))].slice(0, limit);

/** World-editable text, made safe to print: one line, no markup or links, bounded. */
function clean(raw: string | undefined, max = 200): string | null {
  if (!raw) return null;
  const text = [...raw].map((ch) => (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f || ch === '<' || ch === '>' ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  if (!text || /https?:\/\//i.test(text) || text.length > max) return null;
  return text;
}

/** The earliest inception the item states, at the precision it states it. */
export function parseInception(raw: string | undefined): WikidataInception | undefined {
  let best: WikidataInception | undefined;
  for (const entry of (raw ?? '').split('|')) {
    const m = /^([+-]?\d{1,6})-\d\d-\d\dT[^/]*\/(\d+)$/.exec(entry.trim());
    if (!m) continue;
    const year = Number(m[1]);
    const precision = Number(m[2]);
    if (!Number.isFinite(year) || !Number.isFinite(precision) || precision < 7 || year === 0) continue;
    if (!best || year < best.year) best = { year, precision };
  }
  return best;
}

/** Pure, so the reading is testable on a recorded answer. Rows whose id is malformed are skipped. */
export function detailsFromBindings(bindings: readonly unknown[]): Map<string, WikidataPlaceDetails> {
  const out = new Map<string, WikidataPlaceDetails>();
  for (const raw of bindings) {
    const parsed = bindingSchema.safeParse(raw);
    if (!parsed.success) continue;
    const b = parsed.data;
    const id = b.item.value.split('/').pop() ?? '';
    if (!isWikidataId(id) || out.has(id)) continue;
    const description = clean(b.description?.value);
    const inception = parseInception(b.inceptions?.value);
    const article = b.article?.value && /^https:\/\/en\.wikipedia\.org\/wiki\//.test(b.article.value) ? b.article.value : undefined;
    out.set(id, {
      id,
      ...(description ? { description } : {}),
      ...(inception ? { inception } : {}),
      heritage: list(b.heritage?.value),
      architects: list(b.architects?.value),
      styles: list(b.styles?.value),
      instances: list(b.instances?.value),
      ...(article ? { article } : {}),
    });
  }
  return out;
}

export interface WikidataDetailsOptions {
  fetchImpl?: typeof fetch;
  deadlineMs?: number;
  cache?: {
    read: (key: string) => Record<string, WikidataPlaceDetails> | null;
    write: (key: string, value: Record<string, WikidataPlaceDetails>) => void;
  };
}

/** One request for up to `MAX_DETAIL_IDS` items, cached by the sorted id set. Never throws. */
export async function fetchWikidataDetails(ids: readonly string[], options: WikidataDetailsOptions = {}): Promise<Map<string, WikidataPlaceDetails>> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter(isWikidataId))].slice(0, MAX_DETAIL_IDS).sort();
  if (wanted.length === 0) return new Map();
  const key = `wikidata-details|v1|${wanted.join(',')}`;
  const cached = options.cache?.read(key);
  if (cached) return new Map(Object.entries(cached));
  const remaining = options.deadlineMs ? options.deadlineMs - Date.now() : REQUEST_TIMEOUT_MS;
  if (remaining < 1_000) return new Map();
  const url = new URL(ENDPOINT);
  url.searchParams.set('query', sparqlDetails(wanted));
  url.searchParams.set('format', 'json');
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { 'user-agent': providerUserAgent(), accept: 'application/sparql-results+json' },
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
    });
    if (!response.ok) return new Map();
    const parsed = responseSchema.safeParse(await response.json());
    if (!parsed.success) return new Map();
    const details = detailsFromBindings(parsed.data.results.bindings);
    if (details.size > 0) options.cache?.write(key, Object.fromEntries(details));
    return details;
  } catch {
    return new Map();
  }
}
