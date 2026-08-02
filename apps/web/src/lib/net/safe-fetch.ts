import 'server-only';
import { providerUserAgent } from './user-agent';
import { BlockList, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { LookupAddress } from 'node:dns';

/**
 * THE ONLY WAY SIDEQUEST FETCHES A URL IT DID NOT WRITE ITSELF.
 *
 * `openmeteo.ts` talks to two hard-coded hostnames and needs none of this. This
 * file exists for the other case: a page found by a search, on a host chosen by
 * somebody else, fetched by a server that sits inside a private network with a
 * cloud metadata endpoint one hop away.
 *
 * Built on `node:https` rather than `fetch` for two reasons, both of which are
 * load-bearing rather than stylistic:
 *
 * 1. **Connect-by-validated-address.** `fetch` resolves DNS itself, so the
 *    familiar "resolve, check the address, then fetch the hostname" pattern is a
 *    time-of-check/time-of-use hole: the second resolution can return a
 *    different answer. A custom `lookup` validates *the address the socket will
 *    actually use*, which closes DNS rebinding rather than describing it.
 *
 * 2. **Decompression we control.** undici inflates gzip and brotli inside the
 *    client, so `zlib`'s `maxOutputLength` never applies to a `fetch` response
 *    and a 10 KB body that expands to 4 GB is unbounded. Here the decompressor
 *    is ours and the ceiling is enforced on the decompressed stream.
 *
 * Everything this returns is **untrusted evidence**. It is never executed, never
 * rendered as markup, and never allowed to carry an instruction to a model.
 */

// ---------------------------------------------------------------------------
// The address blocklist
// ---------------------------------------------------------------------------

/**
 * Built from the IANA special-purpose address registries rather than from the
 * shorter list that circulates in blog posts — that one routinely omits CGNAT
 * `100.64/10`, `fc00::/7` and the IPv4-mapped range, each of which is a complete
 * bypass on its own.
 */
const BLOCKED = new BlockList();

for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, and the cloud metadata endpoint
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
] as const) {
  BLOCKED.addSubnet(address, prefix, 'ipv4');
}

for (const [address, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentation
  ['64:ff9b::', 96], // NAT64 — embeds IPv4, so 64:ff9b::a9fe:a9fe is 169.254.169.254
  ['2002::', 16], // 6to4 — also embeds IPv4
] as const) {
  BLOCKED.addSubnet(address, prefix, 'ipv6');
}

/**
 * Hostnames that resolve to a metadata service.
 *
 * Belt and braces with the address check above, and neither is redundant: a
 * hostname deny-list is bypassed by using the raw IP, and an address deny-list
 * is bypassed by a name that resolves inside a VPC to something that looks
 * public. Both, or neither is worth having.
 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;

  // `::ffff:127.0.0.1` is loopback wearing an IPv6 hat. Node's BlockList already
  // matches an IPv4 rule against the mapped form, but the explicit unwrap keeps
  // that guarantee from depending on a runtime detail.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1]) return isBlockedAddress(mapped[1]);

  return BLOCKED.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

export class UnsafeUrlError extends Error {
  readonly code:
    | 'bad_url'
    | 'scheme_not_allowed'
    | 'credentials_in_url'
    | 'hostname_blocked'
    | 'address_blocked'
    | 'port_not_allowed'
    | 'too_many_redirects'
    | 'content_type_not_allowed'
    | 'response_too_large'
    | 'robots_disallowed'
    | 'request_failed';

  constructor(code: UnsafeUrlError['code'], message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
    this.code = code;
  }
}

/**
 * Validators a previous read left behind, for a conditional request.
 *
 * Sent as `If-None-Match` and `If-Modified-Since`. RFC 9110 evaluates the ETag
 * first and falls back to the date only if it does not match, so sending both is
 * correct rather than redundant.
 *
 * What comes back — a `304` — proves the publisher says the *representation* has
 * not changed. It proves nothing about whether anything the page says is still
 * true, which is why the store advances a "last checked" clock on a 304 and never
 * a "content observed" one.
 */
export interface ConditionalValidators {
  etag?: string;
  lastModified?: string;
}

export interface SafeFetchOptions {
  /**
   * HTTP is off by default. A page worth quoting as evidence publishes over
   * HTTPS; allowing plaintext by default would mean accepting a fact that
   * anything on the path could have written.
   */
  allowHttp?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Injected so tests can drive resolution without a network. */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * Ask the server whether anything changed, instead of asking for the body.
   *
   * When these are supplied a `304` is a legitimate, successful outcome and the
   * caller must handle it — `status` is 304, `body` is empty, and `notModified`
   * is true.
   */
  validators?: ConditionalValidators;
}

/**
 * Headers we send on every request, and therefore the only ones a `Vary` may
 * name if a stored response is to be reusable.
 *
 * Exported so the reuse decision and the request are built from one list. A
 * response that varies on anything else was negotiated on something we cannot
 * reproduce, and reusing it would risk serving one language's page as another's.
 */
export const PINNED_REQUEST_HEADERS = ['accept', 'accept-encoding', 'user-agent'] as const;

/**
 * The longest validator we will echo back.
 *
 * An ETag is attacker-controlled text that we put into a request header. Node
 * rejects CR/LF in header values outright, which closes injection; the cap and
 * the control-character strip close the rest — an absurdly long or invisible
 * validator is a denial-of-service and a log-poisoning vector rather than a
 * cache hint.
 */
const MAX_VALIDATOR_CHARS = 256;

export function sanitiseValidator(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0 || cleaned.length > MAX_VALIDATOR_CHARS) return undefined;
  return cleaned;
}

export const DEFAULT_MAX_BYTES = 2_000_000;
export const DEFAULT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_REDIRECTS = 3;

/** Text we can extract a fact from. Anything else is rejected before the body is read. */
const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
  'application/ld+json',
];

export function assertSafeUrl(raw: string, options: SafeFetchOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('bad_url', 'That is not a URL we can read.');
  }

  const httpAllowed = options.allowHttp === true;
  if (url.protocol !== 'https:' && !(httpAllowed && url.protocol === 'http:')) {
    throw new UnsafeUrlError(
      'scheme_not_allowed',
      `Only https is allowed here, not "${url.protocol}".`,
    );
  }

  // `http://legit.example@169.254.169.254/` reads as a link to legit.example and
  // connects to the metadata service.
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeUrlError('credentials_in_url', 'A URL with credentials in it is not fetched.');
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost')) {
    throw new UnsafeUrlError('hostname_blocked', 'That hostname is not fetched.');
  }

  // A literal address skips DNS entirely, so it is checked here as well as in
  // the lookup hook. Decimal and octal forms (`http://2852039166/`) are handled
  // because `URL` leaves them alone and `isIP` then rejects them as non-IP,
  // which sends them down the DNS path where the resolved address is checked.
  if (isIP(hostname) !== 0 && isBlockedAddress(hostname)) {
    throw new UnsafeUrlError('address_blocked', 'That address is not fetched.');
  }

  if (url.port !== '' && url.port !== '80' && url.port !== '443') {
    throw new UnsafeUrlError('port_not_allowed', 'Only the default web ports are fetched.');
  }

  return url;
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

/**
 * What a custom `lookup` must hand back, for each of the two shapes Node asks
 * for. Extracted so the contract is testable without a socket — the version that
 * only answered the single-address shape failed every real connection while
 * every SSRF test still passed.
 */
export function lookupAnswer(
  addresses: readonly string[],
  wantsAll: boolean,
): string | { address: string; family: 4 | 6 }[] {
  if (wantsAll) {
    return addresses.map((address) => ({
      address,
      family: (isIP(address) === 6 ? 6 : 4) as 4 | 6,
    }));
  }
  return addresses[0] ?? '';
}

/** What the response said about caching and change detection. */
export interface ResponseMetadata {
  etag?: string;
  weakEtag: boolean;
  lastModified?: string;
  cacheControl?: string;
  vary?: string;
}

export interface SafeFetchResult {
  /** The URL actually read, after any redirects. */
  finalUrl: string;
  status: number;
  contentType: string;
  /** Decoded text, capped. Never markup that anything will render. */
  body: string;
  bytesRead: number;
  /** True when the ceiling stopped the read. The caller must not treat it as whole. */
  truncated: boolean;
  /** SHA-256 of `body`, so a later run can notice the page changed. */
  contentHash: string;
  redirects: string[];
  /**
   * True when the server answered a conditional request with `304`.
   *
   * `body` is empty and carries no meaning; the caller must reuse the stored
   * representation rather than treating this as an empty page.
   */
  notModified: boolean;
  metadata: ResponseMetadata;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
      if (error) return reject(error);
      resolve(addresses.map((entry) => entry.address));
    });
  });
}

/**
 * Fetch one URL, once, with every hop validated.
 *
 * Redirects are followed by hand rather than by the client, because a client
 * that follows them re-does its own resolution and undoes every check above in
 * a single hop. Each `Location` is re-validated from scratch.
 */
export async function safeFetch(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const redirects: string[] = [];
  let current = raw;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = assertSafeUrl(current, options);
    const response = await requestOnce(url, options);

    if (response.location !== undefined && response.status >= 300 && response.status < 400) {
      if (hop === maxRedirects) {
        throw new UnsafeUrlError(
          'too_many_redirects',
          `That page redirected more than ${maxRedirects} times, so we stopped.`,
        );
      }
      // Resolved against the current URL so a relative Location works, and then
      // put through the whole check again — including the address check.
      current = new URL(response.location, url).toString();
      redirects.push(current);
      continue;
    }

    return {
      finalUrl: url.toString(),
      status: response.status,
      contentType: response.contentType,
      body: response.body,
      bytesRead: response.bytesRead,
      truncated: response.truncated,
      contentHash: createHash('sha256').update(response.body).digest('hex'),
      redirects,
      notModified: response.status === 304,
      metadata: response.metadata,
    };
  }

  throw new UnsafeUrlError('too_many_redirects', 'That page redirected too many times.');
}

interface RawResponse {
  status: number;
  contentType: string;
  location?: string;
  body: string;
  bytesRead: number;
  truncated: boolean;
  metadata: ResponseMetadata;
}

function requestOnce(url: URL, options: SafeFetchOptions): Promise<RawResponse> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const resolve = options.resolve ?? defaultResolve;

  return new Promise<RawResponse>((settle, fail) => {
    /**
     * The hook that actually stops SSRF.
     *
     * The socket asks for an address; we resolve, reject every answer that is
     * private, and hand back one we have checked. There is no window between the
     * check and the connection for a second DNS answer to slip through.
     */
    const lookup: RequestOptions['lookup'] = (hostname, opts, callback) => {
      resolve(hostname)
        .then((addresses) => {
          const safe = addresses.filter((address) => !isBlockedAddress(address));
          if (addresses.length === 0) {
            callback(new UnsafeUrlError('address_blocked', 'That hostname does not resolve.'), '', 4);
            return;
          }
          if (safe.length === 0 || safe.length !== addresses.length) {
            // Partial safety is not safety: a name that resolves to one public
            // and one private address is a rebinding attempt, not a fallback.
            callback(
              new UnsafeUrlError('address_blocked', 'That hostname resolves to a blocked address.'),
              '',
              4,
            );
            return;
          }
          const chosen = safe[0]!;
          const family = isIP(chosen) === 6 ? 6 : 4;

          /**
           * Two callback shapes, and getting it wrong fails every real fetch.
           *
           * Node's socket layer calls a custom `lookup` with `{ all: true }` and
           * then expects an **array** of `{ address, family }`. Answering with
           * the three-argument single-address form hands it `undefined` where it
           * expects a list, and it throws `Invalid IP address: undefined` from
           * inside the connect path — surfacing here as a generic transport
           * failure with no hint of the real cause.
           *
           * Every SSRF test in this file injects its own `resolve` and asserts a
           * rejection, so none of them ever reached a successful connection, and
           * this went unnoticed until a live compilation refused all thirty-one
           * of its official pages. The check that matters — validating the
           * address the socket will actually use — is unchanged.
           */
          const answer = lookupAnswer(safe, (opts as { all?: boolean } | undefined)?.all === true);
          if (Array.isArray(answer)) {
            callback(null, answer as unknown as string, family);
            return;
          }
          callback(null, answer, family);
        })
        .catch((error: unknown) => {
          callback(error instanceof Error ? error : new Error('DNS lookup failed'), '', 4);
        });
    };

    /**
     * The conditional headers, sanitised.
     *
     * A validator is text somebody else wrote and we are putting it back into a
     * request header, so it goes through `sanitiseValidator` first. A validator
     * that does not survive that is dropped rather than sent — the cost is one
     * unconditional fetch, and the alternative is trusting a hostile string with
     * our request line.
     */
    const conditional: Record<string, string> = {};
    const etag = sanitiseValidator(options.validators?.etag);
    const lastModified = sanitiseValidator(options.validators?.lastModified);
    if (etag) conditional['if-none-match'] = etag;
    if (lastModified) conditional['if-modified-since'] = lastModified;

    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup,
        headers: {
          // Identifies the application, as several open data policies require.
          'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
          accept: ALLOWED_CONTENT_TYPES.join(', '),
          'accept-encoding': 'gzip, deflate, br',
          ...conditional,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        const contentType = String(res.headers['content-type'] ?? '').split(';')[0]?.trim() ?? '';
        const metadata = readMetadata(res.headers);

        if (status >= 300 && status < 400 && typeof location === 'string') {
          res.resume(); // Drain, so the socket is released.
          settle({
            status,
            contentType,
            location,
            body: '',
            bytesRead: 0,
            truncated: false,
            metadata,
          });
          return;
        }

        /**
         * Not Modified: the whole point of sending validators.
         *
         * RFC 9110 forbids a body here and requires the representation metadata
         * a 200 would carry, so this drains the socket and returns the refreshed
         * validators. It is a *success*, and the caller reuses what it already
         * holds rather than treating an empty body as an empty page.
         */
        if (status === 304) {
          res.resume();
          settle({ status, contentType, body: '', bytesRead: 0, truncated: false, metadata });
          return;
        }

        // Content type is checked before a single byte of body is read, so a
        // 40 MB video or a PDF costs one header exchange rather than a download.
        if (contentType !== '' && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
          res.destroy();
          fail(
            new UnsafeUrlError(
              'content_type_not_allowed',
              `We only read text pages, and that one is "${contentType}".`,
            ),
          );
          return;
        }

        // A declared length over the ceiling is rejected up front; the real
        // enforcement is the counter below, because the header can lie.
        const declared = Number(res.headers['content-length'] ?? '0');
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          fail(new UnsafeUrlError('response_too_large', 'That page is too large to read.'));
          return;
        }

        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const decompressor =
          encoding === 'gzip'
            ? createGunzip({ maxOutputLength: maxBytes })
            : encoding === 'deflate'
              ? createInflate({ maxOutputLength: maxBytes })
              : encoding === 'br'
                ? createBrotliDecompress({ maxOutputLength: maxBytes })
                : null;

        const source = decompressor ? res.pipe(decompressor) : res;
        const chunks: Buffer[] = [];
        let bytesRead = 0;
        let truncated = false;

        source.on('data', (chunk: Buffer) => {
          bytesRead += chunk.length;
          if (bytesRead > maxBytes) {
            truncated = true;
            const keep = chunk.subarray(0, Math.max(0, chunk.length - (bytesRead - maxBytes)));
            if (keep.length > 0) chunks.push(keep);
            res.destroy();
            source.removeAllListeners('data');
            settle({
              status,
              contentType,
              body: Buffer.concat(chunks).toString('utf8'),
              bytesRead: maxBytes,
              truncated,
              metadata,
            });
            return;
          }
          chunks.push(chunk);
        });

        source.on('end', () => {
          settle({
            status,
            contentType,
            body: Buffer.concat(chunks).toString('utf8'),
            bytesRead,
            truncated,
            metadata,
          });
        });

        source.on('error', (error: Error) => {
          // zlib's own ceiling fires here as ERR_BUFFER_TOO_LARGE.
          fail(new UnsafeUrlError('response_too_large', error.message));
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new UnsafeUrlError('request_failed', 'That page took too long to answer.'));
    });

    req.on('error', (error: Error) => {
      /**
       * The underlying cause is kept, and it is not decoration.
       *
       * Every transport failure used to collapse into one sentence, which made a
       * TLS handshake failure, a refused connection and a blocked address
       * indistinguishable in a log — and a live evaluation spent an afternoon on
       * "that page was not safe to read" when the real answer was a socket
       * error. The traveller still sees the sentence; an operator can see why.
       */
      fail(
        error instanceof UnsafeUrlError
          ? error
          : Object.assign(
              new UnsafeUrlError('request_failed', 'We could not read that page.'),
              { cause: error },
            ),
      );
    });

    req.end();
  });
}

/**
 * The caching metadata a response carried.
 *
 * Every value is sanitised on the way in, because all of it is attacker-supplied
 * text that will be stored, echoed back on a later request, and shown in a
 * diagnostic panel. A weak ETag is recorded as weak rather than normalised away:
 * `W/"x"` means *semantically equivalent*, so a 304 against one may not be read
 * as "the bytes are identical".
 */
function readMetadata(headers: Record<string, string | string[] | undefined>): ResponseMetadata {
  const first = (name: string): string | undefined => {
    const value = headers[name];
    return sanitiseValidator(Array.isArray(value) ? value[0] : value);
  };
  const rawEtag = first('etag');
  return {
    ...(rawEtag ? { etag: rawEtag } : {}),
    weakEtag: rawEtag?.startsWith('W/') === true,
    ...(first('last-modified') ? { lastModified: first('last-modified')! } : {}),
    ...(first('cache-control') ? { cacheControl: first('cache-control')! } : {}),
    ...(first('vary') ? { vary: first('vary')! } : {}),
  };
}

export const DEFAULT_USER_AGENT = providerUserAgent('reading an official page on a traveller\u2019s behalf');

// ---------------------------------------------------------------------------
// robots
// ---------------------------------------------------------------------------

/**
 * The narrowest robots.txt reader that is honest.
 *
 * It understands `User-agent`, `Disallow` and `Allow` for the groups that apply
 * to us, longest-match-wins as the standard specifies. It does not understand
 * crawl-delay or sitemaps, because we fetch single pages on a person's behalf
 * rather than crawling — and it fails **closed** on a malformed file, which is
 * the opposite of what a crawler would want and the right answer for us.
 */
export function isAllowedByRobots(robotsTxt: string, path: string, agent = 'Sidequest'): boolean {
  const lines = robotsTxt.split(/\r?\n/);
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let current: (typeof groups)[number] | null = null;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if (field === 'disallow' || field === 'allow') {
      if (!current) continue;
      lastWasAgent = false;
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }

  const lowerAgent = agent.toLowerCase();
  const specific = groups.find((group) =>
    group.agents.some((candidate) => candidate !== '*' && lowerAgent.includes(candidate)),
  );
  const wildcard = groups.find((group) => group.agents.includes('*'));
  const group = specific ?? wildcard;
  if (!group) return true;

  let verdict = true;
  let bestLength = -1;
  for (const rule of group.rules) {
    // An empty Disallow means "nothing is disallowed" and matches nothing.
    if (rule.path === '') continue;
    if (!path.startsWith(rule.path)) continue;
    if (rule.path.length > bestLength) {
      bestLength = rule.path.length;
      verdict = rule.allow;
    }
  }
  return verdict;
}

/**
 * Fetch a page only if its host's robots.txt permits it.
 *
 * A robots.txt that cannot be fetched is treated as permissive, which is what
 * the standard says and what every well-behaved client does — a missing file is
 * the normal case for most of the web. A robots.txt that *is* fetched and says
 * no is final.
 */
export async function fetchIfAllowed(
  raw: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult & { robotsAllowed: boolean }> {
  const url = assertSafeUrl(raw, options);
  let robotsAllowed = true;

  try {
    const robots = await safeFetch(`${url.origin}/robots.txt`, {
      ...options,
      maxBytes: 256_000,
      /**
       * The page's validators belong to the page, not to robots.txt.
       *
       * Forwarding them would send one resource's ETag as a condition on
       * another, which a strict server answers with a 304 — and we would read an
       * empty robots.txt as permissive. Two different resources, two different
       * conditions, so this one asks unconditionally.
       */
      validators: undefined,
    });
    if (robots.status >= 200 && robots.status < 300) {
      robotsAllowed = isAllowedByRobots(robots.body, `${url.pathname}${url.search}`);
    }
  } catch {
    // No robots.txt, or it could not be read. Permissive, per the standard.
  }

  if (!robotsAllowed) {
    throw new UnsafeUrlError('robots_disallowed', 'That site asks us not to read that page.');
  }

  const result = await safeFetch(raw, options);
  return { ...result, robotsAllowed };
}

// ---------------------------------------------------------------------------
// Turning a page into evidence
// ---------------------------------------------------------------------------

/**
 * Readable text from HTML, with everything executable removed.
 *
 * Deliberately not a DOM. We never render this, never execute it, and never
 * need its structure — we need sentences a model can quote a fact out of. A
 * regex strip is the smallest thing that does that, and it cannot be tricked
 * into running anything because nothing here evaluates.
 *
 * `script`, `style`, `template` and `noscript` bodies go entirely, so an
 * injected instruction hidden in a script tag never reaches a prompt. Comments
 * go too: `<!-- ignore previous instructions -->` is the classic carrier.
 */
export function extractReadableText(html: string, maxChars = 20_000): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|template|noscript|svg|iframe|object)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // Bidi and zero-width characters are how an invisible instruction is
    // smuggled past a human reviewer. They carry no meaning in evidence.
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[truncated]` : text;
}
