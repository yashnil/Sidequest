import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { destinationIndexRelease, destinationIndexSize } from '@/lib/db/destination-index-repository';
import { importDestinationIndex } from '@/lib/destinations/import';

/**
 * THE EXPLICIT RELEASE REFRESH.
 *
 * The destination index is deliberately not self-updating. A search index that
 * rebuilt itself on a schedule would mean two people planning the same trip a
 * fortnight apart are offered different destinations with nothing on screen to
 * say why — the same argument that makes region packs immutable and place
 * catalogue releases pinned.
 *
 * So refreshing is an operator action, it takes a release id, and it says what
 * it did. `GET` reports what is currently held, which is the honest answer to
 * "why is my dropdown empty".
 *
 * Guarded by a shared secret rather than by obscurity. Without
 * `SIDEQUEST_ADMIN_TOKEN` set, the write path is closed entirely — a deployment
 * that forgot to configure it fails shut, not open.
 */

export const dynamic = 'force-dynamic';

/** The scan script's output. A path rather than an upload: the file is ~44 MB. */
const DEFAULT_SOURCE = 'data/destination-divisions.ndjson';

/** Generous, and finite. The real scan output is around 44 MB. */
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;

function secretsMatch(offered: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(offered), digest(expected));
}

export async function GET(): Promise<NextResponse> {
  const release = destinationIndexRelease();
  return NextResponse.json({
    built: release !== null,
    release,
    entries: destinationIndexSize(),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const expected = process.env.SIDEQUEST_ADMIN_TOKEN?.trim();
  if (!expected) {
    return NextResponse.json(
      { error: 'Index refresh is not enabled on this deployment.' },
      { status: 404 },
    );
  }
  const offered = request.headers.get('x-sidequest-admin')?.trim();
  /*
   * Constant-time, and length-safe.
   *
   * `!==` on a secret leaks its prefix through timing, and `timingSafeEqual`
   * throws on a length mismatch — which would leak the length instead. Both
   * sides are hashed to a fixed width first, so neither the content nor the
   * length is observable.
   */
  if (!offered || !secretsMatch(offered, expected)) {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 401 });
  }

  const url = new URL(request.url);
  const requested = url.searchParams.get('source') ?? DEFAULT_SOURCE;
  /*
   * Path traversal is refused rather than sanitised.
   *
   * The caller is an operator, so there is no need to be forgiving about a
   * source outside the working tree — and "we normalised your path into
   * something else" is a worse failure than "no".
   */
  const root = resolve(process.cwd());
  const target = resolve(root, requested);
  /*
   * `relative` rather than `startsWith`.
   *
   * A prefix test says `/srv/app-secrets/x` is inside `/srv/app`, because it is
   * inside it as a *string*. The containment question is about path segments,
   * and `relative` is the function that answers it: anything outside begins with
   * `..`, and an absolute result means a different root entirely.
   */
  const inside = relative(root, target);
  if (inside.startsWith('..') || resolve(inside) === inside) {
    return NextResponse.json({ error: 'That source is outside the project.' }, { status: 400 });
  }

  /*
   * Size-checked before it is read.
   *
   * `readFile` on a path an operator chose is an unbounded allocation, and the
   * scan output is tens of megabytes — so the ceiling has to be generous and it
   * still has to exist, or one wrong path is an out-of-memory kill rather than
   * a 400.
   */
  try {
    const info = await stat(target);
    if (!info.isFile()) {
      return NextResponse.json({ error: 'That source is not a file.' }, { status: 400 });
    }
    if (info.size > MAX_SOURCE_BYTES) {
      return NextResponse.json(
        { error: `That source is larger than the ${MAX_SOURCE_BYTES} byte ceiling.` },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json({ error: `Could not read ${requested}.` }, { status: 400 });
  }

  const releaseId = url.searchParams.get('release')?.trim();
  if (!releaseId || !/^[\w.-]{1,40}$/.test(releaseId)) {
    return NextResponse.json({ error: 'A release id is required.' }, { status: 400 });
  }

  let ndjson: string;
  try {
    ndjson = await readFile(target, 'utf8');
  } catch {
    return NextResponse.json({ error: `Could not read ${requested}.` }, { status: 400 });
  }

  const outcome = importDestinationIndex({ ndjson, releaseId, now: new Date() });
  return NextResponse.json(outcome);
}
