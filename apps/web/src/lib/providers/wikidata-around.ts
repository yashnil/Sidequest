import 'server-only';
import { z } from 'zod';
import { providerUserAgent } from '../net/user-agent';
import type { OverpassElement } from './overpass';

/**
 * PRODUCTION PASS — NOTABLE PLACES AROUND A POINT, FROM WIKIDATA.
 *
 * The open-data scan (`discovery-scan/open-data-proposal.ts`) asks Overpass
 * for `wikidata`-tagged map objects. The public Overpass instances are
 * volunteer-run and throttle: a 30-trip evaluation on 2026-10-25 had every
 * scan after the third fail because overpass-api.de answered 406 and two
 * mirrors timed out, while one mirror served only its own country. A single
 * Wikidata Query Service request answers the same question — what notable,
 * coordinate-bearing things are near here, and how much has been written
 * about each — in about a second, from a different operator.
 *
 * The answer is turned into elements of the shape the map path already reads,
 * with *tags derived from the item's own type* (P31) through one curated table,
 * so ranking, dedupe, the kind table and every guard in the proposer apply
 * unchanged. An item whose type is not in the table is left out — never
 * guessed. Licence: CC0 (structured data), no attribution obligation; it is
 * still credited as a source.
 *
 * Sitelink counts come back in the same answer, which is the attention signal
 * the proposer ranks by.
 */

const ENDPOINT = 'https://query.wikidata.org/sparql';
const REQUEST_TIMEOUT_MS = 25_000;
/*
 * Generous on purpose: the answer is ordered by sitelinks, and in a metropolis
 * the first few hundred rows are its own wards and suburbs (a live Tokyo query:
 * 50 of 67 typed rows were cities). Rows are small; 1,500 is still one fast
 * response, and the proposer caps the pool.
 */
const RESULT_LIMIT = 1500;

/**
 * Wikidata class → the OpenStreetMap tags the proposer's kind table reads.
 * Only classes whose meaning is unambiguous for a traveller; extend by adding
 * a row, never by guessing at runtime.
 */
export const WIKIDATA_CLASS_TAGS: Readonly<Record<string, Record<string, string>>> = {
  Q33506: { tourism: 'museum' },
  Q207694: { tourism: 'museum' },
  Q1007870: { tourism: 'gallery' },
  Q23413: { historic: 'castle' },
  Q16560: { historic: 'castle' },
  Q1785071: { historic: 'fort' },
  Q57821: { historic: 'fort' },
  Q16970: { amenity: 'place_of_worship', religion: 'christian' },
  Q2977: { amenity: 'place_of_worship', religion: 'christian' },
  /* A monastery's religion is not in the class; the religious-site kind is the honest reading. */
  Q44613: { amenity: 'place_of_worship' },
  Q32815: { amenity: 'place_of_worship', religion: 'muslim' },
  Q44539: { amenity: 'place_of_worship', religion: 'buddhist' },
  Q5393308: { amenity: 'place_of_worship', religion: 'buddhist' },
  Q845945: { amenity: 'place_of_worship', religion: 'shinto' },
  Q839954: { historic: 'archaeological_site' },
  Q109607: { historic: 'ruins' },
  Q4989906: { historic: 'monument' },
  Q22698: { leisure: 'park' },
  Q1107656: { leisure: 'garden' },
  Q167346: { leisure: 'garden' },
  Q46169: { leisure: 'nature_reserve' },
  Q179049: { leisure: 'nature_reserve' },
  Q473972: { leisure: 'nature_reserve' },
  Q15243209: { tourism: 'attraction' },
  Q8502: { natural: 'peak' },
  Q8072: { natural: 'volcano' },
  Q34038: { natural: 'waterfall' },
  Q23397: { natural: 'water', water: 'lake' },
  Q40080: { natural: 'beach' },
  Q35509: { natural: 'cave_entrance' },
  Q35666: { natural: 'glacier' },
  Q177380: { natural: 'hot_spring' },
  Q43501: { tourism: 'zoo' },
  Q2281788: { tourism: 'aquarium' },
  Q194195: { tourism: 'theme_park' },
  Q2416723: { tourism: 'theme_park' },
  Q1440300: { tourism: 'viewpoint' },
  Q570116: { tourism: 'attraction' },
  Q12518: { tourism: 'attraction' },
  Q174782: { tourism: 'attraction' },
  Q330284: { amenity: 'marketplace' },
  Q37654: { amenity: 'marketplace' },
  Q515: { place: 'city' },
  Q1549591: { place: 'city' },
  Q1637706: { place: 'city' },
  Q3957: { place: 'town' },
  Q532: { place: 'village' },
};

/** When an item has several known classes, the more specific travel meaning wins (a castle that is also a museum is a castle). */
const CLASS_PRIORITY = Object.keys(WIKIDATA_CLASS_TAGS);

const bindingSchema = z.object({
  item: z.object({ value: z.string() }),
  coord: z.object({ value: z.string() }),
  sitelinks: z.object({ value: z.string() }),
  classes: z.object({ value: z.string() }).optional(),
  label: z.object({ value: z.string() }).optional(),
  population: z.object({ value: z.string() }).optional(),
  countries: z.object({ value: z.string() }).optional(),
});
const responseSchema = z.object({ results: z.object({ bindings: z.array(bindingSchema) }) });

export interface WikidataAroundResult {
  elements: OverpassElement[];
  /** Sitelink counts by item id, for every element returned. */
  sitelinks: Map<string, number>;
}

/**
 * The query. Types are *not* filtered in SPARQL: a `VALUES` join on P31 made a
 * dense city (Paris, Tokyo) time out at 25 s, where returning every type and
 * filtering against `WIKIDATA_CLASS_TAGS` here answered in about a second.
 * The notability floor keeps the answer small.
 */
export function sparqlAround(center: { lat: number; lng: number }, radiusKm: number, minSitelinks: number): string {
  return `SELECT ?item ?coord ?sitelinks ?label ?population (GROUP_CONCAT(DISTINCT ?c; separator=",") AS ?classes) (GROUP_CONCAT(DISTINCT ?iso; separator=",") AS ?countries) WHERE {
  SERVICE wikibase:around { ?item wdt:P625 ?coord . bd:serviceParam wikibase:center "Point(${center.lng.toFixed(5)} ${center.lat.toFixed(5)})"^^geo:wktLiteral . bd:serviceParam wikibase:radius "${Math.max(1, Math.round(radiusKm))}" . }
  ?item wikibase:sitelinks ?sitelinks .
  FILTER(?sitelinks >= ${minSitelinks})
  ?item wdt:P31 ?c .
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
  OPTIONAL { ?item wdt:P1082 ?population . }
  OPTIONAL { ?item wdt:P17 ?country . ?country wdt:P297 ?iso . }
} GROUP BY ?item ?coord ?sitelinks ?label ?population ORDER BY DESC(?sitelinks) LIMIT ${RESULT_LIMIT}`;
}

/** Parse "Point(lng lat)". */
function pointOf(wkt: string): { lat: number; lng: number } | null {
  const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(wkt);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** The answer as map-shaped elements. Pure, so the mapping is testable without the network. */
export function elementsFromBindings(bindings: readonly z.infer<typeof bindingSchema>[]): WikidataAroundResult {
  const elements: OverpassElement[] = [];
  const sitelinks = new Map<string, number>();
  const seen = new Set<string>();
  bindings.forEach((b, i) => {
    const id = b.item.value.split('/').pop() ?? '';
    if (!/^Q\d+$/.test(id) || seen.has(id)) return;
    const point = pointOf(b.coord.value);
    const label = b.label?.value?.trim();
    if (!point || !label) return;
    const classes = (b.classes?.value ?? '').split(',').map((c) => c.split('/').pop() ?? '').filter(Boolean);
    const known = CLASS_PRIORITY.find((q) => classes.includes(q));
    if (!known) return;
    seen.add(id);
    const count = Number(b.sitelinks.value);
    if (Number.isFinite(count)) sitelinks.set(id, count);
    const population = b.population?.value ? Math.round(Number(b.population.value)) : null;
    /* The countries Wikidata states the item is in (P17 → ISO 3166-1); absent when it states none, which is unknown, never "elsewhere". */
    const countries = (b.countries?.value ?? '').split(',').map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
    elements.push({
      type: 'node',
      /* A synthetic, stable numeric id from the item number; the element's own `wikidata` tag is the identity everything dedupes on. */
      id: Number(id.slice(1)) || i + 1,
      lat: point.lat,
      lon: point.lng,
      tags: { ...WIKIDATA_CLASS_TAGS[known]!, name: label, wikidata: id, 'source:sidequest': 'wikidata', ...(population && population > 0 ? { population: String(population) } : {}), ...(countries.length > 0 ? { 'sidequest:countries': countries.join(',') } : {}) },
    } as OverpassElement);
  });
  return { elements, sitelinks };
}

export async function fetchWikidataAround(
  center: { lat: number; lng: number },
  radiusKm: number,
  options: { minSitelinks?: number; fetchImpl?: typeof fetch; deadlineMs?: number } = {},
): Promise<WikidataAroundResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const query = sparqlAround(center, radiusKm, options.minSitelinks ?? 8);
  const url = new URL(ENDPOINT);
  url.searchParams.set('query', query);
  url.searchParams.set('format', 'json');
  const remaining = options.deadlineMs ? Math.max(1_000, options.deadlineMs - Date.now()) : REQUEST_TIMEOUT_MS;
  const ask = () =>
    doFetch(url, {
      headers: { 'user-agent': providerUserAgent(), accept: 'application/sparql-results+json' },
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remaining)),
    });
  let response = await ask();
  /* One polite retry on "too many requests", after the wait the service asks for (capped); never a loop. */
  if (response.status === 429) {
    const wait = Math.min(5_000, Math.max(1_000, Number(response.headers.get('retry-after') ?? '2') * 1_000));
    await new Promise((resolve) => setTimeout(resolve, wait));
    response = await ask();
  }
  if (!response.ok) throw new Error(`Wikidata query service answered ${response.status}`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Wikidata query service answer was not readable');
  return elementsFromBindings(parsed.data.results.bindings);
}
