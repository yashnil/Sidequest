import 'server-only';
import { z } from 'zod';
import type { RawLicenceMetadata } from '@sidequest/core';
import { providerUserAgent } from '../net/user-agent';
import { requestSignal } from '../net/generation-deadline';
import { imageryMode } from '../providers/wikimedia';
import { focalFromCrop, MEDIA_CONTEXTS, type FocalPoint, type MediaContext } from './frame';
import {
  renditionUrl,
  selectAllContexts,
  withFocal,
  type MediaCandidate,
  type MediaSelection,
  type MediaSource,
  type MediaSubject,
} from './select';

/**
 * THE THIN FETCHER: THREE QUESTIONS TO WIKIMEDIA PER PLACE, THEN NOTHING.
 *
 * For one Wikidata item it asks:
 *
 *   1. the item's own statements — P18 (image), P948 (Wikivoyage banner),
 *      P8592 (aerial view);
 *   2. Commons file info (size, MIME, licence, author, categories) for those
 *      files, in one batched request;
 *   3. Commons files whose structured data says they depict the item
 *      (`haswbstatement:P180=Q…`), with the same file info, in one request.
 *
 * Then it downloads one 500 px rendition of each *selected* file (usually one
 * or two) to find a focal point with sharp's attention strategy. Never a
 * free-text search. Every judgement is in `select.ts`, which is pure.
 *
 * Etiquette (Wikimedia robot and User-Agent policies): sequential, one request
 * at a time, descriptive User-Agent, standard thumbnail widths only, and the
 * answer is stored (`repository.ts`) so a place is asked about once a month at
 * most. A 429 or 5xx ends the lookup as `provider_unavailable`, which is never
 * stored, so the next visit asks again.
 *
 * Reachable only from a server action or a script — never from a render
 * (`render-purity.architecture.test.ts` bans `fetch` on render paths).
 */

export const MEDIA_PROVIDER = 'wikimedia-commons/media-v1';

const WIKIDATA_ENDPOINT = 'https://www.wikidata.org/w/api.php';
const COMMONS_ENDPOINT = 'https://commons.wikimedia.org/w/api.php';
const REQUEST_TIMEOUT_MS = 8_000;
/** The file-info thumbnail width: small, standard, and the URL other standard widths are derived from. */
const INFO_THUMB_WIDTH = 330;
/** The rendition the focal point is measured on. */
const FOCAL_WIDTH = 500;
const MAX_IMAGE_BYTES = 2_000_000;
const DEPICTS_LIMIT = 12;
const STATED_PROPERTIES = ['P18', 'P948', 'P8592'] as const;
const EXTMETADATA_FIELDS = [
  'License',
  'LicenseShortName',
  'LicenseUrl',
  'Artist',
  'Credit',
  'Attribution',
  'AttributionRequired',
  'Restrictions',
  'NonFree',
  'DeletionReason',
  'Categories',
];

const USER_AGENT = providerUserAgent('destination imagery');

class Unavailable extends Error {}

const claimsSchema = z.object({
  entities: z
    .record(
      z.string(),
      z.object({
        missing: z.unknown().optional(),
        claims: z
          .record(
            z.string(),
            z.array(z.object({ rank: z.string().optional(), mainsnak: z.object({ snaktype: z.string().optional(), datavalue: z.object({ value: z.unknown() }).optional() }).optional() })),
          )
          .optional(),
      }),
    )
    .optional(),
});

const infoPagesSchema = z.object({
  query: z
    .object({
      normalized: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
      pages: z
        .record(
          z.string(),
          z.object({
            title: z.string().optional(),
            index: z.number().optional(),
            missing: z.unknown().optional(),
            coordinates: z.array(z.object({ lat: z.number(), lon: z.number(), globe: z.string().optional() })).optional(),
            imageinfo: z
              .array(
                z.object({
                  url: z.string().optional(),
                  descriptionurl: z.string().optional(),
                  thumburl: z.string().optional(),
                  width: z.number().optional(),
                  height: z.number().optional(),
                  mime: z.string().optional(),
                  extmetadata: z.record(z.string(), z.object({ value: z.unknown() }).partial()).optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export interface ResolveMediaOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  /** Measures a focal point on image bytes. Injected in tests; defaults to sharp's attention strategy. */
  focalOf?: (bytes: Uint8Array) => Promise<FocalPoint | null>;
  /** Skip downloading renditions for focal points (the coverage script uses this). */
  measureFocal?: boolean;
}

export interface ResolveMediaResult {
  selections: Record<MediaContext, MediaSelection>;
  calls: number;
}

/**
 * Every context for one place. Never throws: a failure is a typed "none".
 */
export async function resolveMedia(subject: MediaSubject, options: ResolveMediaOptions = {}): Promise<ResolveMediaResult> {
  const now = options.now ?? new Date();
  const mode = imageryMode();
  if (mode === 'off') return { selections: noneEverywhere(subject, 'disabled'), calls: 0 };
  if (mode === 'fixture') return { selections: fixtureMedia(subject, now), calls: 0 };
  return resolveMediaLive(subject, options);
}

/**
 * Process-wide pacing for the live client: one Wikimedia request at a time, at
 * least `MIN_INTERVAL_MS` apart. Commons answered a 1.1 s cadence of
 * unauthenticated searches with "too many requests" while fixtures were being
 * recorded, so the product leaves a full second between requests. An injected
 * `fetchImpl` (tests, the coverage script) brings its own pacing.
 */
const MIN_INTERVAL_MS = 1_000;
let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const pacedFetch: typeof fetch = (input, init) => {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fetch(input, init);
  });
  queue = run.catch(() => undefined);
  return run;
};

export async function resolveMediaLive(subject: MediaSubject, options: ResolveMediaOptions = {}): Promise<ResolveMediaResult> {
  const now = options.now ?? new Date();
  const doFetch = options.fetchImpl ?? pacedFetch;
  const budget = { calls: 0 };
  if (!/^Q\d+$/.test(subject.wikidataId)) return { selections: noneEverywhere(subject, 'no_identity'), calls: 0 };

  let candidates: MediaCandidate[];
  try {
    candidates = await collectCandidates(subject.wikidataId, doFetch, budget);
  } catch {
    return { selections: noneEverywhere(subject, 'provider_unavailable'), calls: budget.calls };
  }

  let selections = selectAllContexts(subject, candidates, { retrievedAt: now.toISOString(), provider: MEDIA_PROVIDER });

  if (options.measureFocal !== false) {
    const focalOf = options.focalOf ?? attentionFocal;
    const measured = new Map<string, FocalPoint | null>();
    for (const context of MEDIA_CONTEXTS) {
      const selection = selections[context];
      if (selection.status !== 'selected') continue;
      const title = selection.image.fileTitle;
      if (!measured.has(title)) {
        const candidate = candidates.find((entry) => entry.fileTitle === title);
        const url = candidate ? renditionUrl(candidate, FOCAL_WIDTH) : null;
        let focal: FocalPoint | null = null;
        if (url) {
          try {
            const bytes = await fetchImage(url, doFetch, budget);
            focal = bytes ? await focalOf(bytes) : null;
          } catch {
            focal = null;
          }
        }
        measured.set(title, focal);
      }
      selections = { ...selections, [context]: withFocal(selection, measured.get(title) ?? null) };
    }
  }
  return { selections, calls: budget.calls };
}

function noneEverywhere(subject: MediaSubject, reason: 'no_identity' | 'provider_unavailable' | 'disabled'): Record<MediaContext, MediaSelection> {
  const wikidataId = /^Q\d+$/.test(subject.wikidataId) ? subject.wikidataId : null;
  return Object.fromEntries(
    MEDIA_CONTEXTS.map((context): [MediaContext, MediaSelection] => [context, { status: 'none', version: 1, context, wikidataId, reason, rejected: [] }]),
  ) as Record<MediaContext, MediaSelection>;
}

/** The candidate pool: stated files first (in property order), then depicts files. */
export async function collectCandidates(qid: string, doFetch: typeof fetch, budget: { calls: number }): Promise<MediaCandidate[]> {
  const stated = await statedFiles(qid, doFetch, budget);
  const candidates: MediaCandidate[] = [];
  if (stated.length > 0) {
    const info = await fileInfoByTitles(stated.map((entry) => entry.title), doFetch, budget);
    for (const entry of stated) {
      const found = info.get(normaliseTitle(entry.title));
      if (found) candidates.push({ ...found, source: entry.source, order: entry.order });
    }
  }
  const depicts = await depictsFiles(qid, doFetch, budget);
  for (const entry of depicts) {
    if (candidates.some((existing) => existing.fileTitle === entry.fileTitle)) continue;
    candidates.push(entry);
  }
  return candidates;
}

function normaliseTitle(title: string): string {
  return title.replace(/_/g, ' ').replace(/^file:/i, 'File:').trim();
}

async function statedFiles(qid: string, doFetch: typeof fetch, budget: { calls: number }): Promise<{ title: string; source: MediaSource; order: number }[]> {
  const url = new URL(WIKIDATA_ENDPOINT);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', qid);
  url.searchParams.set('props', 'claims');
  url.searchParams.set('format', 'json');
  const parsed = claimsSchema.parse(await requestJson(url, doFetch, budget));
  const entity = parsed.entities?.[qid];
  if (!entity || entity.missing !== undefined) return [];
  const files: { title: string; source: MediaSource; order: number }[] = [];
  for (const property of STATED_PROPERTIES) {
    const claims = (entity.claims?.[property] ?? []).filter((claim) => claim.rank !== 'deprecated');
    /* Preferred-rank statements first, as the item's editors ordered them. */
    const ordered = [...claims.filter((claim) => claim.rank === 'preferred'), ...claims.filter((claim) => claim.rank !== 'preferred')];
    let order = 0;
    for (const claim of ordered) {
      const value = claim.mainsnak?.snaktype === 'value' ? claim.mainsnak.datavalue?.value : null;
      if (typeof value !== 'string' || !value.trim()) continue;
      files.push({ title: `File:${value.trim()}`, source: property, order });
      order += 1;
      if (order >= 2) break;
    }
  }
  return files;
}

function infoParams(url: URL): void {
  /* `coordinates`: where the file says it was taken, for the location cross-check in `select.ts`. */
  url.searchParams.set('prop', 'imageinfo|coordinates');
  url.searchParams.set('coprimary', 'all');
  url.searchParams.set('colimit', 'max');
  url.searchParams.set('iiprop', 'url|size|mime|extmetadata');
  url.searchParams.set('iiurlwidth', String(INFO_THUMB_WIDTH));
  url.searchParams.set('iiextmetadatafilter', EXTMETADATA_FIELDS.join('|'));
  url.searchParams.set('format', 'json');
}

async function fileInfoByTitles(titles: readonly string[], doFetch: typeof fetch, budget: { calls: number }): Promise<Map<string, Omit<MediaCandidate, 'source' | 'order'>>> {
  const url = new URL(COMMONS_ENDPOINT);
  url.searchParams.set('action', 'query');
  url.searchParams.set('titles', titles.slice(0, 20).join('|'));
  infoParams(url);
  const parsed = infoPagesSchema.parse(await requestJson(url, doFetch, budget));
  const byTitle = new Map<string, Omit<MediaCandidate, 'source' | 'order'>>();
  for (const page of Object.values(parsed.query?.pages ?? {})) {
    const candidate = pageToCandidate(page);
    if (candidate) byTitle.set(normaliseTitle(candidate.fileTitle), candidate);
  }
  return byTitle;
}

async function depictsFiles(qid: string, doFetch: typeof fetch, budget: { calls: number }): Promise<MediaCandidate[]> {
  const url = new URL(COMMONS_ENDPOINT);
  url.searchParams.set('action', 'query');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrnamespace', '6');
  url.searchParams.set('gsrsearch', `haswbstatement:P180=${qid} filemime:image/jpeg`);
  url.searchParams.set('gsrlimit', String(DEPICTS_LIMIT));
  infoParams(url);
  const parsed = infoPagesSchema.parse(await requestJson(url, doFetch, budget));
  const pages = Object.values(parsed.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out: MediaCandidate[] = [];
  for (const page of pages) {
    const candidate = pageToCandidate(page);
    if (candidate) out.push({ ...candidate, source: 'P180', order: out.length });
  }
  return out;
}

type InfoPage = NonNullable<NonNullable<z.infer<typeof infoPagesSchema>['query']>['pages']>[string];

/** Exported for tests: the candidates in one recorded file-info response, in listing order. */
export function candidatesFromInfoResponse(json: unknown, source: MediaSource): MediaCandidate[] {
  const parsed = infoPagesSchema.parse(json);
  const pages = Object.values(parsed.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return pages.flatMap((page) => {
    const candidate = pageToCandidate(page);
    return candidate ? [{ ...candidate, source, order: 0 }] : [];
  }).map((candidate, order) => ({ ...candidate, order }));
}

function pageToCandidate(page: InfoPage): Omit<MediaCandidate, 'source' | 'order'> | null {
  if (page.missing !== undefined || !page.title) return null;
  const info = page.imageinfo?.[0];
  if (!info?.url || !info.descriptionurl) return null;
  const meta = info.extmetadata ?? {};
  const read = (field: string): string | undefined => {
    const value = meta[field]?.value;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  };
  const metadata: RawLicenceMetadata = {};
  const assign = (key: keyof RawLicenceMetadata, field: string) => {
    const value = read(field);
    if (value !== undefined) (metadata as Record<string, string>)[key] = value;
  };
  assign('licenceShortName', 'LicenseShortName');
  assign('licence', 'License');
  assign('licenceUrl', 'LicenseUrl');
  assign('artist', 'Artist');
  assign('credit', 'Credit');
  assign('attribution', 'Attribution');
  assign('attributionRequired', 'AttributionRequired');
  assign('restrictions', 'Restrictions');
  assign('nonFree', 'NonFree');
  assign('deletionReason', 'DeletionReason');
  return {
    fileTitle: page.title,
    filePageUrl: info.descriptionurl,
    /* The API appends tracking parameters (`utm_source=…`) to file URLs; the file is the path. */
    originalUrl: withoutQuery(info.url),
    thumbUrl: info.thumburl ? withoutQuery(info.thumburl) : null,
    width: Math.trunc(info.width ?? 0),
    height: Math.trunc(info.height ?? 0),
    mediaType: info.mime ?? '',
    metadata,
    coordinates: (page.coordinates ?? []).filter((entry) => !entry.globe || entry.globe === 'earth').map((entry) => ({ lat: entry.lat, lng: entry.lon })),
    categories: (read('Categories') ?? '').split('|').map((entry) => entry.trim()).filter(Boolean),
  };
}

function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

async function requestJson(url: URL, doFetch: typeof fetch, budget: { calls: number }): Promise<unknown> {
  url.searchParams.set('origin', '*');
  budget.calls += 1;
  const response = await doFetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: requestSignal(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Unavailable(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Unavailable('unparseable');
  }
}

async function fetchImage(url: string, doFetch: typeof fetch, budget: { calls: number }): Promise<Uint8Array | null> {
  budget.calls += 1;
  const response = await doFetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'image/jpeg' }, signal: requestSignal(REQUEST_TIMEOUT_MS) });
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!response.ok || !type.startsWith('image/')) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const buffer = await response.arrayBuffer();
  return buffer.byteLength > MAX_IMAGE_BYTES ? null : new Uint8Array(buffer);
}

/**
 * sharp's attention strategy, asked for a square crop at the image's own short
 * edge — no rescaling, so the reported focal point is in the rendition's own
 * pixels. sharp is Next's own image dependency; when it cannot be loaded the
 * focal point is simply the centre, recorded as assumed.
 */
export async function attentionFocal(bytes: Uint8Array): Promise<FocalPoint | null> {
  try {
    const sharp = (await import('sharp')).default;
    const image = sharp(bytes, { failOn: 'error' });
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!(width > 0) || !(height > 0)) return null;
    const side = Math.min(width, height);
    const { info } = await image
      .resize({ width: side, height: side, fit: 'cover', position: sharp.strategy.attention })
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (typeof info.attentionX === 'number' && typeof info.attentionY === 'number') {
      return { x: Math.min(1, Math.max(0, info.attentionX / width)), y: Math.min(1, Math.max(0, info.attentionY / height)) };
    }
    return focalFromCrop({ width, height, cropWidth: side, cropHeight: side, left: Math.abs(info.cropOffsetLeft ?? 0), top: Math.abs(info.cropOffsetTop ?? 0) });
  } catch {
    return null;
  }
}

/**
 * Deterministic, offline, and still through both gates — so a fixture run can
 * never render something the live path could not legally have supplied. One
 * place in three has no photograph, because that is the page this product
 * actually shows.
 */
export function fixtureMedia(subject: MediaSubject, now: Date): Record<MediaContext, MediaSelection> {
  let seed = 0;
  for (const char of subject.wikidataId) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  if (seed % 3 === 0 || !/^Q\d+$/.test(subject.wikidataId)) {
    return selectAllContexts(subject, [], { retrievedAt: now.toISOString(), provider: MEDIA_PROVIDER });
  }
  const slug = `Fixture_${(seed % 97) + 1}.jpg`;
  const candidate: MediaCandidate = {
    fileTitle: `File:${slug.replace(/_/g, ' ')}`,
    source: 'P18',
    order: 0,
    filePageUrl: `https://commons.wikimedia.org/wiki/File:${slug}`,
    originalUrl: `https://upload.wikimedia.org/wikipedia/commons/f/ff/${slug}`,
    thumbUrl: `https://upload.wikimedia.org/wikipedia/commons/thumb/f/ff/${slug}/330px-${slug}`,
    width: 4000,
    height: 2667,
    mediaType: 'image/jpeg',
    metadata: { licenceShortName: seed % 2 === 0 ? 'CC BY-SA 4.0' : 'CC BY 4.0', artist: `Fixture contributor ${(seed % 97) + 1}`, attributionRequired: 'true' },
    categories: [],
    coordinates: [],
  };
  return selectAllContexts(subject, [candidate], { retrievedAt: now.toISOString(), provider: MEDIA_PROVIDER });
}
