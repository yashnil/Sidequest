import 'server-only';
import { clearScanAutoBuild, scanView } from '../db/scan-repository';
import { buildPreflight } from '../planning/build-preflight';
import { startBuildRun } from '../planning/build-runs';
import { autoBuildKeyFor } from './view';

/**
 * V1 CONVERGENCE — "PLAN WITH SMART DEFAULTS" IS SCAN → PICKS → BUILD IN ONE PRESS.
 *
 * Called once, at the end of a scan that finished with a board. When the
 * traveller asked for the build to follow (`auto_build` on the scan row), the
 * build is started exactly as "Build my trip" starts one — through
 * `buildPreflight` and `startBuildRun` — under a key derived from the scan, so
 * a second call for the same scan attaches to the run rather than starting
 * another. The flag is consumed either way: a build the preflight refuses is
 * not retried behind the traveller's back; the board is simply shown, with its
 * own Build button and its own honest refusal.
 *
 * `startBuildRun` schedules its work with `after()`; called from inside the
 * scan's own `after()` callback that is a nested `after`, which Next supports,
 * and outside a request scope it runs detached on the same process.
 */
export function startAutoBuildAfterScan(tripId: string, scanId: string, caller: string | null): { started: boolean; refusedBecause?: string } {
  const view = scanView(tripId);
  if (!view.autoBuild || view.scanId !== scanId || view.state !== 'ready') return { started: false };
  try {
    const preflight = buildPreflight(tripId, { caller });
    if (!preflight.ok) {
      console.warn('Auto-build after scan refused by the preflight; the board is shown instead', { tripId, cause: preflight.failure.cause, reason: preflight.operatorReason });
      return { started: false, refusedBecause: preflight.failure.cause };
    }
    const run = startBuildRun({ tripId, buildKey: autoBuildKeyFor(scanId), caller: caller ?? 'scan_auto_build', mode: 'quick' });
    return { started: run.started };
  } catch (error) {
    console.error('Auto-build after scan could not be started', { tripId, message: error instanceof Error ? error.message.slice(0, 200) : 'unknown' });
    return { started: false, refusedBecause: 'internal_generation_error' };
  } finally {
    clearScanAutoBuild(tripId);
  }
}
