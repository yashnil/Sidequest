'use server';

import { revalidatePath } from 'next/cache';
import { getTrip } from '@/lib/db/repository';
import { scanView } from '@/lib/db/scan-repository';
import { startDiscoveryScan } from '@/lib/discovery-scan/run';
import { scanFailureCopy, travellerScanView, type ScanFailureCopy, type TravellerScanView } from '@/lib/discovery-scan/view';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { callerKey, guardAction } from '@/lib/net/caller';

/**
 * V1 CONVERGENCE — "FIND PLACES FOR MY TRIP".
 *
 * Starts the Discovery scan (or attaches to the one already running) and
 * answers in milliseconds: the scan itself runs after the response and writes
 * its stages to the scan row, which the discover page polls through
 * `/api/trips/[id]/scan`. Owner-only, fenced per caller like every other
 * press that can spend, and a press while a scan runs is free — it is the same
 * scan. A refusal comes back as the traveller's sentence and, where a cause is
 * known, the typed failure copy; never a provider name or an environment
 * variable.
 */

export type StartScanActionResult =
  | { ok: true; started: boolean; view: TravellerScanView }
  | { ok: false; error: string; failure?: ScanFailureCopy };

const TRIP_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function startDiscoveryScanAction(tripId: string, options: { autoBuild?: boolean } = {}): Promise<StartScanActionResult> {
  if (typeof tripId !== 'string' || !TRIP_ID.test(tripId)) return { ok: false, error: 'We could not find that trip any more.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  if (!getTrip(tripId)) return { ok: false, error: 'We could not find that trip any more.' };

  /* A press while a scan runs is the same scan: attach before the fence, which only charges new work. */
  if (scanView(tripId).state === 'running') return { ok: true, started: false, view: travellerScanView(tripId) };

  const fence = await guardAction('scan_start');
  if (fence) return { ok: false, error: fence };
  const caller = await callerKey();
  try {
    const result = startDiscoveryScan(tripId, { autoBuild: options.autoBuild === true, caller: caller ?? 'discover_scan_action' });
    if (result.failure) {
      const failure = scanFailureCopy(result.failure.cause);
      console.warn('Discovery scan refused before it started', { tripId, cause: result.failure.cause });
      return { ok: false, error: failure.message, failure };
    }
    revalidatePath(`/trips/${tripId}/discover`);
    return { ok: true, started: result.started, view: travellerScanView(tripId) };
  } catch (error) {
    console.error('Discovery scan could not be started', { tripId, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    const failure = scanFailureCopy('internal_generation_error');
    return { ok: false, error: failure.message, failure };
  }
}
