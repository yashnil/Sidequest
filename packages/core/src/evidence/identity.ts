import { contentDigestSchema, type ContentDigest } from '../schemas/evidence-store';
import type { FactPath } from '../schemas/source-fact';

/**
 * IDENTITY, AS PURE FUNCTIONS.
 *
 * Everything a cache key is built from lives here, in one file, so that "does
 * this field change the key" is a question with an answer somebody can read
 * rather than a property of six call sites. `identity.test.ts` asserts that every
 * field of every key input actually changes the key — a cache key that silently
 * ignores an input is a collision waiting for the traveller it will mislead.
 *
 * Two hashes, for two different jobs, and conflating them would be a mistake:
 *
 * - **Content digests are SHA-256** and are computed where `node:crypto` exists,
 *   because they are the thing that decides whether two documents are the same
 *   document. This file validates and compares them; it does not compute them.
 * - **Cache keys are FNV-1a** over a canonical string, because they are lookup
 *   identities inside our own database rather than a security boundary, and this
 *   package is deliberately free of Node built-ins.
 */

// ---------------------------------------------------------------------------
// The lookup hash
// ---------------------------------------------------------------------------

/**
 * FNV-1a, twice, with different offset bases.
 *
 * Two passes concatenated rather than one: 32 bits collide at around 77 000
 * entries by the birthday bound, and this store holds cache keys where a
 * collision would serve one page's extraction for another's. 64 bits pushes that
 * past anything a development store will hold, and the algorithm stays a
 * four-line function anybody can check.
 */
export function stableHash(input: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x811c9dc5) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Content digests
// ---------------------------------------------------------------------------

/** Digest algorithms this build understands. Anything else is unusable. */
export const SUPPORTED_DIGEST_ALGORITHMS = ['sha256'] as const;
export type DigestAlgorithm = (typeof SUPPORTED_DIGEST_ALGORITHMS)[number];

/**
 * Whether a stored digest can be compared against a fresh one.
 *
 * The distinction between *unusable* and *non-matching* is load-bearing. A digest
 * this build cannot verify means "re-read that page"; treating it as a mismatch
 * would be the same outcome by accident, and treating it as a match would serve
 * evidence we cannot confirm is the evidence we think it is.
 */
export function isUsableDigest(value: string | undefined | null): value is ContentDigest {
  if (!value) return false;
  if (!contentDigestSchema.safeParse(value).success) return false;
  const algorithm = value.slice(0, value.indexOf(':'));
  return (SUPPORTED_DIGEST_ALGORITHMS as readonly string[]).includes(algorithm);
}

/**
 * The bytes a digest is taken over.
 *
 * Not the raw response and not just the text: the *envelope*, so that a document
 * read to its ceiling can never share an identity with the whole page. A
 * truncated read is different evidence, and an extraction taken from one must not
 * be reused as though it covered the source.
 */
export function representationEnvelope(input: {
  text: string;
  structuredData: readonly unknown[];
  truncated: boolean;
  mimeType: string;
}): string {
  let structured: string;
  try {
    structured = JSON.stringify(input.structuredData);
  } catch {
    // Circular or otherwise unserialisable JSON-LD is not evidence; it
    // contributes a constant, so the envelope stays total.
    structured = '[unserialisable]';
  }
  return [
    'sidequest-representation/1',
    `mime:${input.mimeType.toLowerCase()}`,
    `truncated:${input.truncated ? '1' : '0'}`,
    `text:${input.text}`,
    `jsonld:${structured}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// URL canonicalisation
// ---------------------------------------------------------------------------

/**
 * Query parameters that never select a representation.
 *
 * A closed list, and deliberately short. The tempting rule — "drop unknown query
 * parameters" — merges a Tuesday timetable with a Sunday one, an adult ticket
 * price with a child's, and a Japanese page with its English translation. Those
 * are different pages, and a cache that says otherwise is worse than no cache.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'gbraid',
  'wbraid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  '_ga',
  '_gl',
]);

/**
 * Query keys whose *values* must never be persisted.
 *
 * A URL somebody hands us can carry a session token or a signed link. The key is
 * kept — dropping it would merge two genuinely different resources — and the
 * value is replaced, so nothing secret reaches a row, a log, or a cache key.
 */
const SECRET_PARAMS = new Set([
  'token',
  'access_token',
  'id_token',
  'refresh_token',
  'key',
  'apikey',
  'api_key',
  'auth',
  'authorization',
  'password',
  'passwd',
  'pwd',
  'secret',
  'signature',
  'sig',
  'session',
  'sessionid',
  'sid',
]);

export const REDACTED_PARAM_VALUE = 'redacted';

export interface CanonicalUrl {
  /** Scheme + host + non-default port, lowercased. */
  origin: string;
  /** Registrable host, lowercased and punycode-normalised. */
  host: string;
  /** The canonical form: sorted query, no fragment, secrets redacted. */
  url: string;
  /** Tracking parameters actually removed, for the audit. */
  droppedParams: string[];
  /** Parameters whose values were replaced before storage. */
  redactedParams: string[];
  /** Things a reviewer should know: mixed scripts, punycode, unusual port. */
  warnings: string[];
}

/**
 * Canonicalise conservatively.
 *
 * Everything here is a normalisation that provably cannot change which
 * representation the server returns. Anything that might is left alone, because
 * the failure mode of over-normalising is silent and the failure mode of
 * under-normalising is a duplicate row.
 *
 * Throws nothing: a URL that will not parse comes back as `null`, and every
 * caller already has a rejection path for that.
 */
export function canonicalizeUrl(raw: string): CanonicalUrl | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const warnings: string[] = [];

  /**
   * Credentials never survive canonicalisation.
   *
   * `assertSafeUrl` already refuses to fetch one, and this is the second half of
   * that guarantee: even a URL that arrives here by another path cannot leave a
   * username or password in a stored row.
   */
  if (url.username !== '' || url.password !== '') {
    warnings.push('Credentials in the URL were removed before it was stored.');
    url.username = '';
    url.password = '';
  }

  // `URL` already applies IDNA to `hostname`; the checks below are about what
  // that produced rather than about doing it ourselves.
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.includes('xn--')) {
    warnings.push('This host is an internationalised domain name.');
  }
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(host)) {
    warnings.push('This host carries non-ASCII characters.');
  }
  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    warnings.push(`This URL uses port ${url.port}.`);
  }

  const dropped: string[] = [];
  const redacted: string[] = [];
  const params: [string, string][] = [];
  for (const [key, value] of url.searchParams.entries()) {
    const lower = key.toLowerCase();
    if (TRACKING_PARAMS.has(lower)) {
      dropped.push(key);
      continue;
    }
    if (SECRET_PARAMS.has(lower)) {
      redacted.push(key);
      params.push([key, REDACTED_PARAM_VALUE]);
      continue;
    }
    params.push([key, value]);
  }
  // Sorted so two orderings of the same query are one cache entry. Sorted by key
  // then value, so repeated keys keep a deterministic order too.
  params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

  // `URL` already blanks a default port, so this only carries a non-default one.
  const origin = `${url.protocol}//${host}${url.port ? `:${url.port}` : ''}`;
  // Duplicate slashes collapse; a bare path becomes `/`. Neither changes which
  // resource a server returns, and both are common accidents in published links.
  const path = url.pathname.replace(/\/{2,}/g, '/') || '/';
  const query = params.length > 0
    ? `?${params.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')}`
    : '';

  return {
    origin,
    host,
    url: `${origin}${path}${query}`,
    droppedParams: dropped,
    redactedParams: redacted,
    warnings,
  };
}

/** A stable, readable id for a source. Derived from the canonical URL, never random. */
export function sourceIdFor(canonical: CanonicalUrl): string {
  return `src-${canonical.host}-${stableHash(canonical.url)}`;
}

/**
 * Whether two hosts are close enough that a `rel="canonical"` between them can be
 * believed.
 *
 * Same registrable-ish suffix only: `www.museum.org` and `museum.org` yes,
 * `museum.org` and `museum-tickets.example` no. A canonical link is text an
 * attacker can write, so following one across origins is how a cache learns that
 * somebody else's page is the authority for a museum.
 */
export function isSameSite(a: string, b: string): boolean {
  if (a === b) return true;
  const strip = (host: string): string => host.replace(/^www\./, '');
  const left = strip(a);
  const right = strip(b);
  if (left === right) return true;
  return left.endsWith(`.${right}`) || right.endsWith(`.${left}`);
}

// ---------------------------------------------------------------------------
// Subject identity
// ---------------------------------------------------------------------------

/**
 * The identity of the thing evidence is about, independent of any trip.
 *
 * A trip-local place id would make every claim trip-scoped, which is the bug this
 * whole phase exists to fix. So a subject is named by what it *is*: a normalised
 * name and where it sits, rounded to about eleven metres — close enough that two
 * compilations of the same museum agree, far enough apart that two neighbouring
 * restaurants do not.
 *
 * `architecture.test.ts` fails if a traveller-ish field ever reaches this
 * function's inputs.
 */
export function subjectKeyFor(input: {
  name: string;
  coordinates: { lat: number; lng: number };
  /** Optional stable external id — a GERS id or an OSM element. Preferred when present. */
  externalId?: string;
}): string {
  if (input.externalId && input.externalId.trim().length > 0) {
    return `subj:ext:${normaliseName(input.externalId)}`;
  }
  const lat = input.coordinates.lat.toFixed(4);
  const lng = input.coordinates.lng.toFixed(4);
  return `subj:geo:${normaliseName(input.name)}@${lat},${lng}`;
}

/**
 * A name reduced to what two records about one place would agree on.
 *
 * Diacritics folded, punctuation dropped, case flattened, whitespace collapsed.
 * Deliberately not a fuzzy match: this is an identity, and "close enough" here
 * would merge two places.
 */
export function normaliseName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// Cache keys
// ---------------------------------------------------------------------------

export interface DiscoveryKeyInput {
  subjectKey: string;
  /** Which facts we are looking for a publisher of. Sorted before hashing. */
  wantedPaths: readonly FactPath[];
  /** Locale requirement, where one applies. */
  locale?: string;
  provider: string;
  providerVersion: string;
}

/**
 * The key for "who publishes this".
 *
 * Keyed on the *subject*, not on the destination: a museum and the ticket office
 * that shares its domain are different subjects and get different searches, and
 * two trips to the same museum share one. Keyed on the wanted paths too, because
 * "find me somewhere that publishes their hours" and "find me somewhere that
 * publishes their prices" are different questions with different right answers.
 */
export function discoveryKeyFor(input: DiscoveryKeyInput): string {
  const canonical = [
    'discovery/1',
    input.subjectKey,
    `paths:${[...input.wantedPaths].sort().join(',')}`,
    `locale:${(input.locale ?? 'any').toLowerCase()}`,
    `provider:${input.provider}@${input.providerVersion}`,
  ].join('\n');
  return `disc-${stableHash(canonical)}`;
}

export interface ExtractionKeyInput {
  operation: string;
  contentDigests: readonly string[];
  schemaVersion: string;
  promptVersion: string;
  modelId: string;
  parserVersion: string;
  wantedPaths: readonly FactPath[];
  /**
   * Who the extraction is *about*.
   *
   * One page can cover several things — a park authority publishing six trails,
   * a museum complex listing its wings — and "what does this document say about
   * the summit trail" is a different question from "what does it say about the
   * visitor centre". Without this, the first answer would be served for the
   * second, which is the propagation defect the phase brief names: a closure
   * affecting one trail must not close the whole park.
   */
  subjectKey?: string;
}

/**
 * The key for a model extraction.
 *
 * Every input that could change the answer is in it, and the requested paths are
 * the one people forget: the same page asked about opening hours and asked about
 * admission price is not the same call, and a key that omitted them would serve
 * the first answer for the second question.
 */
export function extractionKeyFor(input: ExtractionKeyInput): string {
  const canonical = [
    'extraction/1',
    `op:${input.operation}`,
    `docs:${[...input.contentDigests].sort().join(',')}`,
    `schema:${input.schemaVersion}`,
    `prompt:${input.promptVersion}`,
    `model:${input.modelId}`,
    `parser:${input.parserVersion}`,
    `paths:${[...input.wantedPaths].sort().join(',')}`,
    `subject:${input.subjectKey ?? 'any'}`,
  ].join('\n');
  return `extr-${stableHash(canonical)}`;
}

/** The key one running operation is claimed under, so two builds coalesce. */
export function operationKeyFor(kind: string, subject: string): string {
  return `${kind}:${stableHash(subject)}`;
}

/**
 * Whether a stored document may be reused for a request we would make.
 *
 * `Vary` is the whole content of this function. A response that varies on a
 * header we do not pin was negotiated on something we cannot reproduce, so
 * reusing it would risk serving one language's page as another's. `Vary: *` is
 * never reusable, by definition.
 */
export function isVaryCompatible(vary: string | undefined, pinnedHeaders: readonly string[]): boolean {
  if (!vary) return true;
  const fields = vary
    .split(',')
    .map((field) => field.trim().toLowerCase())
    .filter((field) => field.length > 0);
  if (fields.includes('*')) return false;
  const pinned = new Set(pinnedHeaders.map((header) => header.toLowerCase()));
  return fields.every((field) => pinned.has(field));
}
