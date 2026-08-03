import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
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
  if (!offered || offered !== expected) {
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
  const target = resolve(process.cwd(), requested);
  if (!target.startsWith(resolve(process.cwd()))) {
    return NextResponse.json({ error: 'That source is outside the project.' }, { status: 400 });
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
