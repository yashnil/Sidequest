import { NextResponse } from 'next/server';
import { readinessReport } from '@/lib/readiness/report';

/**
 * IS THIS DEPLOYMENT ABLE TO DO THE JOB — NOT MERELY ABLE TO ANSWER.
 *
 * STAGING PARITY §7. `/api/health` returned 200 on the deployment where a
 * traveller typed "Japan" and was shown the empty world, because the database
 * opened and that was all it claimed to check. Liveness is what a platform's
 * restart policy needs; it is not what an operator needs, and conflating the two
 * is how a green dashboard sits above a broken product.
 *
 * So this is the second answer, and the two do not compete: `/api/health` stays
 * narrow and fast for the healthcheck, and this one says what the deployment can
 * actually do. Three rules:
 *
 * - **Every capability the primary product needs has a row.** Present and
 *   degraded are different words, and a capability that is absent says which
 *   variable would provide it.
 * - **Configured is not working (V1 convergence).** A capability that can be
 *   asked cheaply and for free is asked — cached, bounded, never per request —
 *   and reports `working`, `degraded` or `failing`; one that cannot be asked
 *   without spending or abusing a volunteer service says `configured_unverified`.
 *   See `lib/readiness/report.ts`.
 * - **No secret, and no value.** Whether a credential is set, never any part of
 *   it; the database is reported by *class* rather than by path, because a path is
 *   infrastructure detail an unauthenticated URL should not hand out.
 * - **`ready` is about the primary flow only.** Compose a trip, place a
 *   destination, keep it. Media, live routing and places are enrichment: their
 *   absence is `degraded`, never `not ready`, because the product is honest and
 *   useful without them and saying otherwise would make the signal useless.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const report = await readinessReport();
  return NextResponse.json(report, { status: report.ready ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
