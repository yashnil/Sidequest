import 'server-only';
import { providerUserAgent } from '../net/user-agent';
import { z } from 'zod';

/**
 * WIKIDATA, USED FOR EXACTLY ONE THING.
 *
 * OpenStreetMap elements frequently carry a `wikidata` tag. Wikidata items
 * frequently carry **P856, the official website**. That pair is a structured,
 * open, licence-clean path from a mapped object straight to the operator's own
 * domain — and it is the reason most subjects in a compilation never need a
 * billable web search to find out who publishes their opening hours.
 *
 * **Licence: CC0 1.0** for structured data in the main namespace, verified
 * against <https://www.wikidata.org/wiki/Wikidata:Licensing>. No attribution
 * obligation, no restriction on storage. It is still recorded as a source and
 * still ranked as `open_structured_database`, below every official voice: a
 * volunteer's copy of a museum's hours is not the museum.
 *
 * What this is **not** used for: hours, prices, closures. Those come from the
 * page P856 points at, or they stay unknown.
 *
 * Fifty ids per request is the documented ceiling for ordinary clients, so a
 * whole shortlist is one or two round trips.
 */

const WIKIDATA_ENDPOINT = 'https://www.wikidata.org/w/api.php';
const MAX_IDS_PER_REQUEST = 50;
const REQUEST_TIMEOUT_MS = 10_000;

const USER_AGENT = providerUserAgent('trip planning');

const claimValueSchema = z.object({
  mainsnak: z
    .object({
      snaktype: z.string().optional(),
      datavalue: z
        .object({
          value: z.unknown(),
        })
        .optional(),
    })
    .optional(),
  rank: z.string().optional(),
});

const entitySchema = z.object({
  id: z.string().optional(),
  missing: z.unknown().optional(),
  labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
  aliases: z.record(z.string(), z.array(z.object({ value: z.string() }))).optional(),
  claims: z.record(z.string(), z.array(claimValueSchema)).optional(),
});

const responseSchema = z.object({
  entities: z.record(z.string(), entitySchema).optional(),
});

export interface WikidataFacts {
  entityId: string;
  /** P856. The single most valuable field here. */
  officialWebsite?: string;
  label?: string;
  aliases: string[];
  /** P1435 — a heritage designation. Significance that is not popularity. */
  heritageDesignation: boolean;
}

export interface WikidataOptions {
  fetchImpl?: typeof fetch;
  cache?: {
    read: (key: string) => Record<string, WikidataFacts> | null;
    write: (key: string, value: Record<string, WikidataFacts>) => void;
  };
}

export function isWikidataId(value: string): boolean {
  return /^Q\d+$/.test(value.trim());
}

/**
 * Look up several entities at once.
 *
 * Failure is never fatal here and never throws: losing Wikidata costs some free
 * official URLs, which the search layer can replace at a price. A compilation
 * that fell over because a read-only API was slow would be a worse product than
 * one that spent a few more searches.
 */
export async function fetchWikidataFacts(
  ids: readonly string[],
  options: WikidataOptions = {},
): Promise<{ facts: Map<string, WikidataFacts>; calls: number; cacheHit: boolean }> {
  const unique = [...new Set(ids.filter(isWikidataId))].sort();
  const facts = new Map<string, WikidataFacts>();
  if (unique.length === 0) return { facts, calls: 0, cacheHit: false };

  const cacheKey = `wikidata|v1|${unique.join(',')}`;
  const cached = options.cache?.read(cacheKey);
  if (cached) {
    for (const [id, value] of Object.entries(cached)) facts.set(id, value);
    return { facts, calls: 0, cacheHit: true };
  }

  const doFetch = options.fetchImpl ?? fetch;
  let calls = 0;

  for (let offset = 0; offset < unique.length; offset += MAX_IDS_PER_REQUEST) {
    const batch = unique.slice(offset, offset + MAX_IDS_PER_REQUEST);
    const url = new URL(WIKIDATA_ENDPOINT);
    url.searchParams.set('action', 'wbgetentities');
    url.searchParams.set('ids', batch.join('|'));
    url.searchParams.set('props', 'labels|aliases|claims');
    url.searchParams.set('languages', 'en');
    url.searchParams.set('format', 'json');
    url.searchParams.set('origin', '*');

    try {
      calls += 1;
      const response = await doFetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) continue;

      for (const [id, entity] of Object.entries(parsed.data.entities ?? {})) {
        if (entity.missing !== undefined) continue;
        const website = firstStringClaim(entity.claims?.P856);
        facts.set(id, {
          entityId: id,
          ...(website ? { officialWebsite: website } : {}),
          ...(entity.labels?.en?.value ? { label: entity.labels.en.value } : {}),
          aliases: (entity.aliases?.en ?? []).slice(0, 6).map((alias) => alias.value),
          heritageDesignation: (entity.claims?.P1435?.length ?? 0) > 0,
        });
      }
    } catch {
      // A read-only lookup that did not answer is a missing free hint, not a
      // failure worth propagating.
    }
  }

  if (facts.size > 0) {
    options.cache?.write(cacheKey, Object.fromEntries(facts));
  }
  return { facts, calls, cacheHit: false };
}

/**
 * A string claim, only when it is actually a plain HTTP(S) URL.
 *
 * Wikidata is world-editable, so a P856 value is untrusted input arriving in a
 * field that will end up in an `href`. `javascript:` is refused here rather than
 * downstream, and the value is round-tripped through `URL` so a malformed one
 * cannot pass as a hostname.
 */
function firstStringClaim(claims: z.infer<typeof claimValueSchema>[] | undefined): string | undefined {
  for (const claim of claims ?? []) {
    if (claim.mainsnak?.snaktype !== 'value') continue;
    const value = claim.mainsnak.datavalue?.value;
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.username || url.password) continue;
      return url.toString();
    } catch {
      continue;
    }
  }
  return undefined;
}
