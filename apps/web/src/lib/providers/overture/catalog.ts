import 'server-only';
import { z } from 'zod';
import type { SourceRelease } from '@sidequest/core';
import { USER_AGENT } from '../nominatim';

/**
 * RELEASE DISCOVERY, AND WHY IT IS NOT A CONSTANT.
 *
 * The open place catalogue publishes roughly monthly. Hard-coding one release
 * would mean the product silently ages, and re-resolving on every request would
 * mean two compilations of the same trip a fortnight apart are built from
 * different worlds and cannot be compared.
 *
 * So: discovery is a real lookup, the answer is **pinned** for the whole of one
 * pack build, the pin is written onto the pack, and moving to a newer release is
 * an explicit refresh. Old packs are never mutated, which is what keeps an old
 * compiled region reproducible from its own inputs.
 *
 * Nothing here runs on a page render. The catalogue is consulted when a pack is
 * built, and the answer is cached for a day.
 */

const DEFAULT_CATALOG_URL = 'https://stac.overturemaps.org/catalog.json';
export const CATALOG_NAME = 'overture';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_DOCUMENT_BYTES = 4_000_000;

/**
 * Only these hosts may be reached by the catalogue client.
 *
 * A STAC catalogue is a graph of links, and following an arbitrary `href` out of
 * a document somebody else controls is a server-side request forgery with extra
 * steps. Every URL this module resolves is checked against the allowlist before
 * it is fetched, and a link that points elsewhere is dropped with a reason
 * rather than followed.
 */
const ALLOWED_HOSTS = new Set([
  'stac.overturemaps.org',
  'overturemaps-us-west-2.s3.us-west-2.amazonaws.com',
  'overturemaps-us-west-2.s3.amazonaws.com',
  'overturemapswestus2.blob.core.windows.net',
]);

export class CatalogError extends Error {
  readonly code:
    | 'not_configured'
    | 'unreachable'
    | 'malformed'
    | 'schema_incompatible'
    | 'rejected_host';

  constructor(code: CatalogError['code'], message: string) {
    super(message);
    this.name = 'CatalogError';
    this.code = code;
  }
}

export function catalogUrl(): string {
  const configured = process.env.SIDEQUEST_PLACE_CATALOG_URL?.trim();
  if (!configured) return DEFAULT_CATALOG_URL;
  assertAllowedHost(configured);
  return configured;
}

/** Re-exported from the import-free switch module. See `providers/switches.ts`. */
export { isPlaceBackboneEnabled } from '../switches';

/**
 * A release the operator has pinned by hand.
 *
 * Two uses, both real: reproducing an old compilation exactly, and holding a
 * known-good release while a new one is evaluated. When set, discovery is
 * skipped entirely rather than performed and overridden.
 */
export function pinnedReleaseId(): string | undefined {
  const configured = process.env.SIDEQUEST_PLACE_RELEASE?.trim();
  return configured && /^[\w.-]{1,40}$/.test(configured) ? configured : undefined;
}

function assertAllowedHost(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CatalogError('rejected_host', 'That is not a URL we can read.');
  }
  if (parsed.protocol !== 'https:') {
    throw new CatalogError('rejected_host', 'The data catalogue must be read over HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new CatalogError('rejected_host', 'A catalogue URL may not carry credentials.');
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new CatalogError('rejected_host', 'That host is not one of our data sources.');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// STAC documents
// ---------------------------------------------------------------------------

const linkSchema = z.object({
  rel: z.string(),
  href: z.string(),
  title: z.string().optional(),
  latest: z.boolean().optional(),
});

const rootCatalogSchema = z.object({
  type: z.string().optional(),
  links: z.array(linkSchema).default([]),
  latest: z.string().optional(),
});

const releaseCatalogSchema = z.object({
  id: z.string().optional(),
  links: z.array(linkSchema).default([]),
  'release:version': z.string().optional(),
  'schema:version': z.string().nullable().optional(),
});

const collectionSchema = z.object({
  links: z.array(linkSchema).default([]),
});

const assetSchema = z.object({
  href: z.string(),
  type: z.string().optional(),
  alternate: z
    .record(z.string(), z.object({ href: z.string() }))
    .optional(),
});

const itemSchema = z.object({
  bbox: z.array(z.number()).min(4),
  assets: z.record(z.string(), assetSchema).default({}),
  properties: z.record(z.string(), z.unknown()).default({}),
});

export interface CatalogFile {
  /** Anonymous HTTPS URL to one parquet part file. */
  url: string;
  /** `[west, south, east, north]`, from the STAC item. */
  bbox: [number, number, number, number];
  rows?: number;
  rowGroups?: number;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  cache?: {
    read: (key: string) => unknown;
    write: (key: string, value: unknown, ttlMs: number) => void;
  };
}

/** Release catalogues change once a month; a day is plenty and costs one fetch. */
const RELEASE_TTL_MS = 24 * 60 * 60 * 1000;
/** File lists are immutable for a given release, so they may be held far longer. */
const FILE_LIST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function readJson(url: string, options: FetchOptions): Promise<unknown> {
  const parsed = assertAllowedHost(url);
  const doFetch = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(parsed.toString(), {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch {
    throw new CatalogError('unreachable', 'The data catalogue did not answer.');
  }
  if (!response.ok) {
    throw new CatalogError('unreachable', 'The data catalogue did not answer.');
  }
  const text = await response.text();
  if (text.length > MAX_DOCUMENT_BYTES) {
    throw new CatalogError('malformed', 'A catalogue document was larger than we will read.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CatalogError('malformed', 'A catalogue document was not readable JSON.');
  }
}

/**
 * Resolve a relative STAC `href` against its document, then check the host.
 *
 * Both halves matter. STAC is relative-linked throughout, so resolution is
 * required; and a document that returns an absolute link to somewhere else is
 * exactly what the allowlist exists for.
 */
function resolveLink(base: string, href: string): string {
  const resolved = new URL(href, base).toString();
  assertAllowedHost(resolved);
  return resolved;
}

/**
 * The newest release this catalogue offers, or the one an operator pinned.
 *
 * `latest` on the root document is used when present, and the `latest`-flagged
 * child link when it is not, because a catalogue is entitled to publish either
 * and a client that insists on one shape breaks on the other.
 */
export async function latestRelease(
  options: FetchOptions = {},
): Promise<SourceRelease> {
  const pinned = pinnedReleaseId();
  const root = catalogUrl();

  if (pinned) {
    return {
      catalog: CATALOG_NAME,
      releaseId: pinned,
      resolvedAt: new Date().toISOString(),
      catalogUrl: root,
    };
  }

  const cacheKey = `overture|release|${root}`;
  const cached = options.cache?.read(cacheKey);
  if (cached && typeof cached === 'object' && 'releaseId' in (cached as object)) {
    return cached as SourceRelease;
  }

  const document = rootCatalogSchema.parse(await readJson(root, options));
  const flagged = document.links.find((link) => link.rel === 'child' && link.latest === true);
  const releaseId =
    document.latest ??
    (flagged ? releaseIdFromHref(flagged.href) : undefined) ??
    releaseIdFromHref(
      [...document.links]
        .filter((link) => link.rel === 'child')
        .map((link) => link.href)
        .sort()
        .at(-1) ?? '',
    );

  if (!releaseId) {
    throw new CatalogError('malformed', 'The data catalogue did not name a release.');
  }

  const releaseUrl = resolveLink(root, `./${releaseId}/catalog.json`);
  const release = releaseCatalogSchema.parse(await readJson(releaseUrl, options));
  const schemaVersion = release['schema:version'] ?? undefined;

  const result: SourceRelease = {
    catalog: CATALOG_NAME,
    releaseId: release['release:version'] ?? release.id ?? releaseId,
    ...(schemaVersion ? { schemaVersion } : {}),
    resolvedAt: new Date().toISOString(),
    catalogUrl: root,
  };
  options.cache?.write(cacheKey, result, RELEASE_TTL_MS);
  return result;
}

function releaseIdFromHref(href: string): string | undefined {
  const match = /(?:^|\/)([\w.-]+)\/catalog\.json$/.exec(href);
  return match?.[1];
}

/**
 * Every part file in one theme of one release, with its bounding box.
 *
 * This is the first and cheapest pruning step: a destination touches one or two
 * of sixteen place files, and knowing which without listing a bucket or scanning
 * a footer is the difference between a bounded read and a global one.
 */
export async function themeFiles(input: {
  release: SourceRelease;
  theme: string;
  type: string;
  options?: FetchOptions;
}): Promise<CatalogFile[]> {
  const options = input.options ?? {};
  const root = input.release.catalogUrl ?? catalogUrl();
  const cacheKey = `overture|files|${input.release.releaseId}|${input.theme}/${input.type}`;
  const cached = options.cache?.read(cacheKey);
  if (Array.isArray(cached)) return cached as CatalogFile[];

  const collectionUrl = resolveLink(
    root,
    `./${input.release.releaseId}/${input.theme}/${input.type}/collection.json`,
  );
  const collection = collectionSchema.parse(await readJson(collectionUrl, options));
  const itemLinks = collection.links.filter((link) => link.rel === 'item');

  const files: CatalogFile[] = [];
  for (const link of itemLinks) {
    const itemUrl = resolveLink(collectionUrl, link.href);
    const item = itemSchema.parse(await readJson(itemUrl, options));
    const href = preferredAsset(item.assets);
    if (!href) continue;
    const [west, south, east, north] = item.bbox;
    if (
      west === undefined ||
      south === undefined ||
      east === undefined ||
      north === undefined ||
      !Number.isFinite(west) ||
      !Number.isFinite(south) ||
      !Number.isFinite(east) ||
      !Number.isFinite(north)
    ) {
      continue;
    }
    files.push({
      url: href,
      bbox: [west, south, east, north],
      ...(typeof item.properties['table:row_count'] === 'number'
        ? { rows: item.properties['table:row_count'] as number }
        : {}),
      ...(typeof item.properties['table:row_group_count'] === 'number'
        ? { rowGroups: item.properties['table:row_group_count'] as number }
        : {}),
    });
  }

  options.cache?.write(cacheKey, files, FILE_LIST_TTL_MS);
  return files;
}

/**
 * The asset to read, preferring the primary host and refusing anything else.
 *
 * A STAC item advertises several mirrors and several protocols. `s3://` cannot
 * be read anonymously by a browser-grade HTTP client, and a host outside the
 * allowlist is not read at all — so the choice is made here, once, rather than
 * being an ordering accident at the call site.
 */
function preferredAsset(assets: Record<string, z.infer<typeof assetSchema>>): string | undefined {
  const candidates: string[] = [];
  for (const asset of Object.values(assets)) {
    candidates.push(asset.href);
    for (const alternate of Object.values(asset.alternate ?? {})) {
      candidates.push(alternate.href);
    }
  }
  for (const candidate of candidates) {
    if (!candidate.startsWith('https://')) continue;
    if (!candidate.endsWith('.parquet')) continue;
    try {
      assertAllowedHost(candidate);
    } catch {
      continue;
    }
    return candidate;
  }
  return undefined;
}

/** Whether a file's bounding box overlaps the ground we care about. */
export function fileIntersects(
  file: CatalogFile,
  box: { west: number; south: number; east: number; north: number },
): boolean {
  const [west, south, east, north] = file.bbox;
  return !(west > box.east || east < box.west || south > box.north || north < box.south);
}
