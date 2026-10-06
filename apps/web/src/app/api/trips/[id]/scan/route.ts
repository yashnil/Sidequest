import { NextResponse } from 'next/server';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { travellerScanView } from '@/lib/discovery-scan/view';

/**
 * V1 CONVERGENCE — THE DISCOVERY SCAN SCREEN POLLS A ROUTE, NOT A SERVER ACTION.
 *
 * Same reasoning as `progress/route.ts`: a tab's server actions run one at a
 * time, so a poll made through one would queue behind whatever else the page
 * is doing. Owner-only (a foreign or malformed id is a plain 404, so the URL is
 * not an oracle), never cached, and the body is `TravellerScanView` — stage
 * words, real counts, elapsed seconds, typed failure copy and a reference.
 * Nothing about providers, models or configuration leaves through here.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  const refusal = await tripAccessRefusal(id);
  if (refusal) return NextResponse.json({ error: 'not_found' }, { status: 404, headers: { 'cache-control': 'no-store' } });
  return NextResponse.json(travellerScanView(id), { headers: { 'cache-control': 'no-store' } });
}
