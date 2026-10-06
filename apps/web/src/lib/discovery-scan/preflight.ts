import 'server-only';
import { isCompositionModelConfigured, isFixtureComposer } from '../providers/switches';
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

/** Whether a scan can run at all on this deployment, without starting one. */
export function scanPreflight(): { ok: true } | { ok: false; cause: BuildFailureCause } {
  if (fixtureScan()) return { ok: true };
  if (!isCompositionModelConfigured()) return { ok: false, cause: 'composer_not_configured' };
  return { ok: true };
}
