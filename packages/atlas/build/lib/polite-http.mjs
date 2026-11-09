/**
 * ONE WAY TO ASK AN OPEN-DATA SERVICE FOR SOMETHING, POLITELY.
 *
 * Shared by the evidence stages (09-ski, 10-wildlife). Every request carries the
 * build's User-Agent, has a deadline, and backs off when the service says it is
 * busy. Nothing here knows about any particular source.
 *
 * Two rules learned the hard way in this pipeline (REPORT.md §3):
 *  - a download that "succeeded" may be truncated, so `downloadVerified` checks
 *    the byte count against the size the server (or the caller) declared and
 *    refuses the file otherwise;
 *  - a rate-limit page is not JSON, so `politeJson` treats an unparseable body
 *    as "ask again later", never as an answer.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const UA = 'SidequestAtlasBuild/0.1 (open-data research)';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A stable file name for a request: the cache is keyed by what was asked. */
export function requestKey(url) {
  return createHash('sha1').update(url).digest('hex');
}

/**
 * GET a JSON document. Retries on network failure, 5xx and unparseable bodies
 * with growing pauses; on 429/503 it calls `onBusy(attempt)` (so a crawler can
 * slow every worker, not only this one) and honours `Retry-After`.
 * Returns the parsed body, or throws after `retries` attempts. A 4xx other than
 * 429 is the caller's mistake and throws at once.
 */
export async function politeJson(url, { timeoutMs = 60_000, retries = 6, onBusy = null, accept = 'application/json' } = {}) {
  let lastProblem = 'no attempt';
  for (let attempt = 0; attempt < retries; attempt += 1) {
    let response = null;
    try {
      response = await fetch(url, { headers: { 'user-agent': UA, accept }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastProblem = `network: ${error?.cause?.code ?? error?.name ?? 'error'}`;
    }
    if (response) {
      if (response.ok) {
        const text = await response.text().catch(() => null);
        if (text !== null) {
          try {
            return JSON.parse(text);
          } catch {
            lastProblem = `unparseable body (${text.length} bytes)`;
          }
        } else lastProblem = 'body read failed';
      } else if (response.status === 429 || response.status === 503) {
        lastProblem = `HTTP ${response.status}`;
        const retryAfter = Number(response.headers.get('retry-after'));
        if (onBusy) onBusy(attempt);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 600) * 1000 : 30_000 * (attempt + 1));
        continue;
      } else if (response.status >= 400 && response.status < 500) {
        throw new Error(`HTTP ${response.status} for ${url.slice(0, 200)}`);
      } else lastProblem = `HTTP ${response.status}`;
    }
    await sleep(Math.min(120_000, 3000 * 2 ** attempt));
  }
  throw new Error(`no answer (${lastProblem}) from ${url.slice(0, 200)}`);
}

/**
 * Download a file to `path` and prove it is whole.
 *
 * The body is streamed to `<path>.part`; the file is only renamed into place
 * when the number of bytes written equals `expectedBytes` (when the caller
 * knows it — e.g. from a published manifest) and equals the server's
 * `Content-Length` (when the server sent one and did not re-encode the body).
 * Returns `{ bytes, sha256, etag, lastModified }`.
 */
export async function downloadVerified(url, path, { expectedBytes = null, timeoutMs = 600_000 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const part = `${path}.part`;
  const response = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${url}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const counted = Readable.fromWeb(response.body).on('data', (chunk) => {
    bytes += chunk.length;
    hash.update(chunk);
  });
  await pipeline(counted, createWriteStream(part));
  const onDisk = statSync(part).size;
  /* fetch() decodes Content-Encoding, so Content-Length describes the wire, not the file, when the body was compressed. */
  const encoded = (response.headers.get('content-encoding') ?? 'identity') !== 'identity';
  const declared = Number(response.headers.get('content-length'));
  const problems = [];
  if (onDisk !== bytes) problems.push(`wrote ${onDisk} bytes of ${bytes} received`);
  if (!encoded && Number.isFinite(declared) && declared > 0 && declared !== bytes) problems.push(`server declared ${declared} bytes, received ${bytes}`);
  if (expectedBytes !== null && expectedBytes !== bytes) problems.push(`expected ${expectedBytes} bytes, received ${bytes}`);
  if (problems.length > 0) {
    if (existsSync(part)) unlinkSync(part);
    throw new Error(`download of ${url} is not whole: ${problems.join('; ')}`);
  }
  renameSync(part, path);
  return { bytes, sha256: hash.digest('hex'), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
}
