import 'server-only';
import { lastFactCheck } from '@/lib/db/execution-repository';

/** V9 §9 — when the last recheck ran for a trip, for the banner. Read-only. */
export function lastRecheckAt(tripId: string): string | null {
  return lastFactCheck(tripId)?.checkedAt ?? null;
}
