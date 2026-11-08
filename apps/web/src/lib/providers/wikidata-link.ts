import 'server-only';
import { z } from 'zod';
import { haversineKm } from '@sidequest/core';

/**
 * GIVING A PLACED STOP ITS WIKIDATA IDENTITY, SO IT CAN HAVE A PHOTOGRAPH.
 *
 * Trip imagery is looked up by Wikidata item (`imagery-repository.ts`), and a
 * stop a places provider or a geocoder placed usually arrives without one — a
 * live Adirondacks trip had one item among thirty stops, so every photograph
 * frame on the itinerary was the empty graphic.
 *
 * One query for the whole scan: every name goes through Wikidata's own entity
 * search, and an item is accepted only when **its own coordinate** (P625) lies
 * within `maxKm` of where the stop was placed and its label is the same name.
 * That is the same evidence the catalog's QIDs are verified with — a name alone
 * never makes an identity, and a same-named place in another valley never does.
 * Pure parts (`sparqlFor`, `pickMatches`) are exported for tests; the fetch is
 * deadline-bounded and a failure is simply no links.
 */

const ENDPOINT = 'https://query.wikidata.org/sparql';
/* Runs beside the matrix measurement; it must never be what the scan waits on. */
const REQUEST_TIMEOUT_MS = 8_000;
/** Names per request; a scan proposes about thirty. */
const MAX_NAMES = 60;

export interface LinkSubject {
  key: string;
  name: string;
  coordinates: { lat: number; lng: number };
}

export interface LinkCandidate {
  name: string;
  item: string;
  label: string;
  coordinates: { lat: number; lng: number };
}

function literal(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').trim()}"`;
}

export function sparqlFor(names: readonly string[]): string {
  return `SELECT ?name ?item ?label ?coord WHERE {
  VALUES ?name { ${names.map(literal).join(' ')} }
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:endpoint "www.wikidata.org"; wikibase:api "EntitySearch"; mwapi:search ?name; mwapi:language "en"; mwapi:limit "8" .
    ?item wikibase:apiOutputItem mwapi:item .
  }
  ?item wdt:P625 ?coord .
  OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = "en") }
}`;
}

/** Lower-case, accents and punctuation gone, and the generic words a proposal adds ("the", "trail", "viewpoint") kept — they are part of a name. */
export function normalizedName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^the /, '')
    .trim();
}

/** The same name: equal once normalised, or one is the other plus a trailing type word ("Mirror Lake" ↔ "Mirror Lake Park"). */
export function sameName(a: string, b: string): boolean {
  const x = normalizedName(a);
  const y = normalizedName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.split(' ').length < 2) return false;
  return long.startsWith(`${short} `) && long.split(' ').length - short.split(' ').length <= 1;
}

function pointOf(wkt: string): { lat: number; lng: number } | null {
  const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(wkt);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

const GENERIC_TAIL = /\s+(museum|summit|lookout|overlook|viewpoint|trailhead|trail|hike|walk|scenic drive|drive|cruise|boat trip|tour|village|old town|historic district|state park|park)$/i;

/** The names worth searching for a subject: as proposed, and without a generic tail ("Fort William Henry Museum" → "Fort William Henry"). */
export function searchNames(name: string): string[] {
  const trimmed = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = trimmed.replace(/^the\s+/i, '').replace(GENERIC_TAIL, '').trim();
  return [...new Set([trimmed, stripped].filter((n) => n.length >= 3))];
}

/** Every word of the shorter name (two or more words) is in the longer one. Weaker than `sameName`, so it is held to a tighter radius. */
function wordsContained(a: string, b: string): boolean {
  const x = normalizedName(a).split(' ').filter(Boolean);
  const y = normalizedName(b).split(' ').filter(Boolean);
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && short.every((word) => long.includes(word));
}
const CONTAINED_MAX_KM = 1.5;

/** For each subject, the nearest same-named item within `maxKm`; none when nothing qualifies. */
export function pickMatches(subjects: readonly LinkSubject[], candidates: readonly LinkCandidate[], maxKm: number): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const subject of subjects) {
    let best: { item: string; km: number } | null = null;
    const names = searchNames(subject.name);
    for (const candidate of candidates) {
      if (!names.includes(candidate.name) || taken.has(candidate.item)) continue;
      const km = haversineKm(subject.coordinates, candidate.coordinates);
      const same = names.some((n) => sameName(n, candidate.label));
      if (!same && !(wordsContained(subject.name, candidate.label) && km <= CONTAINED_MAX_KM)) continue;
      if (km > maxKm) continue;
      if (!best || km < best.km) best = { item: candidate.item, km };
    }
    if (best) {
      out.set(subject.key, best.item);
      taken.add(best.item);
    }
  }
  return out;
}

const bindingSchema = z.object({
  name: z.object({ value: z.string() }),
  item: z.object({ value: z.string() }),
  label: z.object({ value: z.string() }).optional(),
  coord: z.object({ value: z.string() }),
});
const responseSchema = z.object({ results: z.object({ bindings: z.array(bindingSchema) }) });

export function candidatesFrom(bindings: readonly z.infer<typeof bindingSchema>[]): LinkCandidate[] {
  const out: LinkCandidate[] = [];
  for (const b of bindings) {
    const item = b.item.value.split('/').pop() ?? '';
    const coordinates = pointOf(b.coord.value);
    if (!/^Q\d+$/.test(item) || !coordinates) continue;
    out.push({ name: b.name.value, item, label: b.label?.value ?? '', coordinates });
  }
  return out;
}

export async function linkWikidataIds(
  subjects: readonly LinkSubject[],
  options: { maxKm?: number; fetchImpl?: typeof fetch; userAgent: string; timeoutMs?: number },
): Promise<Map<string, string>> {
  const usable = subjects.filter((s) => s.name.trim().length >= 3).slice(0, MAX_NAMES);
  if (usable.length === 0) return new Map();
  const doFetch = options.fetchImpl ?? fetch;
  const url = new URL(ENDPOINT);
  url.searchParams.set('query', sparqlFor([...new Set(usable.flatMap((s) => searchNames(s.name)))].slice(0, MAX_NAMES * 2)));
  url.searchParams.set('format', 'json');
  const response = await doFetch(url, {
    headers: { 'user-agent': options.userAgent, accept: 'application/sparql-results+json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Wikidata query service answered ${response.status}`);
  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error('Wikidata query service answer was not readable');
  return pickMatches(usable, candidatesFrom(parsed.data.results.bindings), options.maxKm ?? 5);
}
