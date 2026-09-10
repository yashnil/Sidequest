import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';

/**
 * IS THIS PROCESS SERVING, AND CAN IT REACH ITS DATABASE?
 *
 * SHIP V1 §13. A deployment platform needs one cheap URL it can probe to decide
 * whether a machine is healthy, and every platform that restarts an unhealthy
 * machine needs the answer to be about *this* process rather than about the
 * internet: so the check is a `SELECT 1` against the local database and nothing
 * else. No provider is called, no model is called, nothing is written.
 *
 * The database is not incidental to liveness here. Persistence is a file on a
 * mounted volume; a container that comes up with the volume missing serves
 * perfectly and loses every trip somebody makes, which is the failure this
 * endpoint exists to catch. Unreachable is a 503, because a platform's health
 * check acts on the status code.
 *
 * It answers with two words and no detail. A health endpoint is the most
 * requested URL on any deployment and the least authenticated, so it says
 * nothing about versions, providers, configuration or contents — a probe learns
 * whether to route traffic here, and an unwelcome visitor learns nothing.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    getDb().prepare('SELECT 1').get();
    return NextResponse.json({ ok: true, database: 'ready' }, { status: 200, headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json({ ok: false, database: 'unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}
