import 'server-only';
import { isCompositionModelConfigured, isFixtureComposer, isPoiProviderEnabled } from '../providers/switches';
import { composerKnownRejected } from '../readiness/probe-cache';
import type { BuildFailureCause } from '../planning/build-failure';

/**
 * V1 CONVERGENCE — CAN A DISCOVERY SCAN RUN HERE, ASKED WITHOUT STARTING ONE.
 *
 * Split out of `run.ts` so a page render (the interview's review, the discover
 * page's scan screen) can ask it without importing the scan's providers —
 * `render-purity.architecture.test.ts` holds that line. Environment reads only.
 */

/** The fixture switches the scan honours: the fixture composer, or the fixture compiler. */
export function fixtureScan(): boolean {
  return isFixtureComposer() || process.env.SIDEQUEST_COMPILER_PROVIDER?.trim() === 'fixture';
}

/**
 * Whether the open-data proposal (`open-data-proposal.ts`) can stand in for the
 * model on this deployment: the fixture switches (recorded answer), or the map
 * data service switched on (`SIDEQUEST_POI_PROVIDER=overpass`, the same opt-in
 * the scan's food step reads). Environment only.
 */
export function openDataProposalAvailable(): boolean {
  return fixtureScan() || isPoiProviderEnabled();
}

/**
 * Whether a scan can run at all on this deployment, without starting one.
 *
 * Refused only when *neither* proposer can work: no usable model (none
 * configured, or a fresh cached probe verdict that the vendor rejected the
 * key) and no open-data fallback. A cached verdict only — a render never makes
 * a request, and a cold cache is not evidence the key is dead.
 */
export function scanPreflight(): { ok: true } | { ok: false; cause: BuildFailureCause } {
  if (fixtureScan()) return { ok: true };
  if (openDataProposalAvailable()) return { ok: true };
  if (!isCompositionModelConfigured()) return { ok: false, cause: 'composer_not_configured' };
  if (composerKnownRejected()) return { ok: false, cause: 'provider_auth_failure' };
  return { ok: true };
}
