import 'server-only';
import { isCompositionModelConfigured, isFixtureComposer } from '../providers/switches';
import { productionFixtureRefusal } from '../providers/capabilities.mjs';
import { dailySpendGate } from '../compiler/daily-ceiling';
import { getTripDraft } from '../db/draft-repository';
import { getTrip } from '../db/repository';
import { DYNAMIC_REGION_ID, compiledRegionFor } from '../region';
import { composerKnownRejected } from '../readiness/probe-cache';
import { buildFailure, type BuildFailure } from './build-failure';

/**
 * V1 CONVERGENCE — CAN ANY BUILD PATH RUN, ASKED BEFORE ONE IS STARTED.
 *
 * The single source of truth for "should this press start a build". Every door
 * that would start one — Build my trip, Plan with smart defaults, Try build
 * again, Regenerate, the itinerary page's recovery — asks this first and, on a
 * refusal, shows the typed failure instead of starting a run that is certain to
 * fail. The interview's Build button and the landing page read it too, so
 * nobody invests in a whole interview on a deployment that cannot build.
 *
 * Today's paths, in order:
 *
 * 1. **Production fixture guard** — a fixture switch in production without
 *    `SIDEQUEST_FIXTURES=allow` refuses every build (`composer_not_configured`,
 *    variant `fixtures_refused`); the operator reason names the switches.
 * 2. **Re-verifying a saved draft** needs no model at all, so it passes here
 *    whatever the composer's state.
 * 3. **The fixture composer** (allowed) needs nothing else.
 * 4. **The composition model** needs its credential, a key the vendor has not
 *    rejected within the probe's TTL (cached verdict only — never a request
 *    from here), and today's model-call allowance.
 *
 * The lead's planner-first path (slice D) extends this function: a planner
 * build that needs no model call passes on its own terms (its coverage
 * requirements belong here, as one more path), and the model-composed
 * fallback keeps the checks in 4.
 *
 * Synchronous, cheap (environment, one ledger read, one draft lookup) and
 * provider-free, so a page render can call it.
 */
export type BuildPreflight =
  | { ok: true; path: 'stored_draft' | 'planner' | 'fixture_composer' | 'model_composer' }
  | { ok: false; failure: BuildFailure; /** Operator words for the log line; never shown to a traveller. */ operatorReason: string };

export interface BuildPreflightOptions {
  /** The caller key the run will be charged to (`net/caller#callerKey`); null/absent checks the shared pool only. */
  caller?: string | null;
  now?: Date;
  /** The build will re-verify the saved draft rather than compose (`retryPlanFor`). */
  reuseStoredDraft?: boolean;
  env?: Record<string, string | undefined>;
}

export function buildPreflight(tripId: string | null, options: BuildPreflightOptions = {}): BuildPreflight {
  const env = options.env ?? process.env;
  const guard = productionFixtureRefusal(env);
  if (guard.refused) {
    return {
      ok: false,
      failure: buildFailure('composer_not_configured', 'fixtures_refused'),
      operatorReason: `fixture switches in production without SIDEQUEST_FIXTURES=allow: ${guard.switches.join(', ')}`,
    };
  }
  if (tripId && options.reuseStoredDraft && safeHasDraft(tripId)) return { ok: true, path: 'stored_draft' };
  /* V1 — a trip with a Discovery Board is planned deterministically and needs no model at all. */
  if (tripId && env.SIDEQUEST_PLANNING_MODE?.trim() !== 'model' && safeHasBoard(tripId)) return { ok: true, path: 'planner' };
  if (isFixtureComposer()) return { ok: true, path: 'fixture_composer' };
  if (!isCompositionModelConfigured()) {
    return { ok: false, failure: buildFailure('composer_not_configured'), operatorReason: 'no composition model credential (ANTHROPIC_API_KEY) and no fixture composer' };
  }
  if (composerKnownRejected()) {
    return { ok: false, failure: buildFailure('provider_auth_failure'), operatorReason: 'the readiness probe saw the model API reject ANTHROPIC_API_KEY within its TTL' };
  }
  const allowance = dailySpendGate(options.now ?? new Date(), options.caller);
  if (!allowance.allowed) {
    /* The gate fails closed when its ledger is unreadable; that is our fault, not the day's limit, and it is worth retrying. */
    const ledgerUnreadable = /could not verify/i.test(allowance.message);
    return ledgerUnreadable
      ? { ok: false, failure: buildFailure('internal_generation_error'), operatorReason: 'the daily spend ledger could not be read' }
      : { ok: false, failure: buildFailure('provider_quota_or_limit', 'daily_allowance'), operatorReason: 'the daily model-call allowance (per caller or deployment) is spent' };
  }
  return { ok: true, path: 'model_composer' };
}

/**
 * The typed failure for a generation that returned `ok: false` without one.
 *
 * `generateSidequestPlanForTrip` attaches a `failure` wherever it knows the
 * cause. Where it does not (an early return that predates the taxonomy, such
 * as the in-run allowance reservation losing a race), the preflight is asked
 * again: if it now refuses, that refusal is the honest cause; otherwise the
 * failure is ours.
 */
export function failureForResult(result: { ok: boolean; failure?: BuildFailure }, tripId: string, options: BuildPreflightOptions = {}): BuildFailure {
  if (result.failure) return result.failure;
  const preflight = buildPreflight(tripId, options);
  return preflight.ok ? buildFailure('internal_generation_error') : preflight.failure;
}

/** Synchronous: an adopted scan or compiled region, or an authored region, without resolving or spending anything. */
function safeHasBoard(tripId: string): boolean {
  try {
    const trip = getTrip(tripId);
    if (!trip) return false;
    return trip.basics.regionId !== DYNAMIC_REGION_ID || compiledRegionFor(tripId) !== null;
  } catch {
    return false;
  }
}

function safeHasDraft(tripId: string): boolean {
  try {
    return getTripDraft(tripId) !== null;
  } catch {
    return false;
  }
}
