import { NextResponse } from 'next/server';
import { currentUserId } from '@/lib/auth/session';
import { exportOwnerData } from '@/lib/db/data-rights-repository';
import { guardAction, presentedSessionToken } from '@/lib/net/caller';

/**
 * PRODUCTION PASS — "DOWNLOAD MY DATA".
 *
 * Everything the asker owns, as one JSON file: the signed-in account and its
 * trips, plus the unclaimed trips the presented browser cookie made — the same
 * ownership rule as every trip door (`lib/net/trip-access.ts`). Credentials
 * (owner tokens, share tokens, session and feed hashes) are left out.
 *
 * A GET so the browser can save it as a file. Cross-site, it is harmless: a
 * forged navigation downloads the victim's own data to the victim's own
 * browser, and no cross-origin script can read the response. Never cached.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const limited = await guardAction('data_rights');
  if (limited) return NextResponse.json({ ok: false, error: limited }, { status: 429, headers: { 'cache-control': 'no-store' } });
  const userId = await currentUserId();
  const ownerToken = await presentedSessionToken();
  const now = new Date();
  const body = exportOwnerData({ userId, ownerToken }, now);
  const filename = `sidequest-data-${now.toISOString().slice(0, 10)}.json`;
  return new NextResponse(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}
