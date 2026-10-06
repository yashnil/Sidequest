import type { RoutingProvider, RoutingMatrixResult, RouteConfirmationResult } from '@sidequest/compiler';
import type { RoutingCoverage } from './routing-coverage';

/**
 * THE ROUTING HIERARCHY, AS ONE PROVIDER — AND ONE THAT LEARNS.
 *
 *   local Valhalla, while it can answer for these coordinates
 *   → the global router (openrouteservice), when configured
 *   → nothing: the pair is reported unmeasured at once
 *
 * ## Why this learns (PRODUCTION LOCK V5 §18)
 *
 * A live Hong Kong build measured **0 of N legs**, and so did a Kyrgyzstan one.
 * The cause was not a broken router. The configured Valhalla was alive and
 * answering; it holds **Iceland tiles**, and `SIDEQUEST_ROUTES_COVERAGE` was
 * unset. Undeclared coverage means `coversAll()` returns true for every point,
 * so every leg was sent to a router that replied `error_code: 171` — "No
 * suitable edges near location" — and nothing anywhere drew the obvious
 * conclusion. Leg 34 was asked exactly as hopefully as leg 1, and the whole
 * verification budget went on requests that were refused before they were sent.
 *
 * Declaring coverage fixes that deployment. It does not fix the *class*: it asks
 * an operator to keep a bounding box in an environment variable in step with
 * whatever tiles somebody built, and a wrong or stale declaration fails exactly
 * as silently in the other direction.
 *
 * So coverage is now **evidence, not only configuration**. A `171` is a
 * statement about this router's reach, and one is enough: a trip is one region,
 * so a router that does not hold this coordinate does not hold the next one
 * either. The first coverage refusal latches the local router off *for this
 * build*, and everything falls through to the global router or to an honest
 * estimate. Nothing is cached beyond the build — a composite is created per
 * generation (`verification-providers.ts`), so a tile rebuild needs no reset.
 *
 * A pair outside every provider's reach is reported `insufficient_evidence` —
 * nobody said "no route", nobody was asked — and the reconciler then estimates
 * from geometry.
 */

/** What the local router has told us about its own reach during this build. */
interface LocalReach {
  /** True once the local router has refused a pair for being outside its tiles. */
  outOfCoverage: boolean;
  /** V6 §11 — true once the local router could not be reached at all. Same consequence: stop asking it. */
  unreachable: boolean;
  /** How many pairs it refused that way, for the log line and the diagnostics. */
  refusals: number;
}

/**
 * A pair the local router refused for coverage reasons is proof about the
 * router, so one is enough to stop asking it.
 *
 * Deliberately not a threshold. A threshold would mean "spend N round trips
 * establishing what the first one already said", and N round trips against a
 * router that cannot answer is precisely the failure this exists to end.
 */
const COVERAGE_STRIKES_BEFORE_FALLTHROUGH = 1;

export function createCompositeRouting(input: {
  local: RoutingProvider | null;
  localCoverage: RoutingCoverage;
  global: RoutingProvider | null;
  /**
   * V1 convergence — the readiness probe (`readiness/probe-cache.ts`) found the
   * local router unreachable within its TTL. The composite starts latched, so
   * the first build after a router dies does not pay a request timeout to
   * learn what the probe already knew. Only an affirmative "could not reach"
   * verdict sets this; an unprobed router is asked as before.
   */
  localKnownUnreachable?: boolean;
}): RoutingProvider | null {
  const { local, localCoverage, global } = input;
  if (!local && !global) return null;

  const reach: LocalReach = { outOfCoverage: false, unreachable: Boolean(input.localKnownUnreachable && local), refusals: 0 };
  /** The local router is out of the picture for the rest of this build, for either reason. */
  const localExhausted = () => reach.outOfCoverage || reach.unreachable;

  /**
   * Record what a local answer said about the local router's reach.
   *
   * Only an explicit `out_of_coverage` counts. A `not_found` is the router
   * answering "these two points have no road between them", which is evidence
   * about the ground and must never be read as evidence about coverage — that
   * confusion would silently disable a working router on the first genuine
   * island-to-mainland pair.
   */
  const noteLocalAnswer = (result: { failedPairs: readonly { reason: string }[] }): void => {
    const refusals = result.failedPairs.filter((pair) => pair.reason === 'out_of_coverage').length;
    const unreachable = result.failedPairs.filter((pair) => pair.reason === 'unreachable').length;
    if (refusals === 0 && unreachable === 0) return;
    reach.refusals += refusals;
    if (!reach.outOfCoverage && reach.refusals >= COVERAGE_STRIKES_BEFORE_FALLTHROUGH) {
      reach.outOfCoverage = true;
      console.warn('The local router does not cover this trip; falling through for the rest of this build', {
        provider: local?.name ?? 'local',
        declaredCoverage: localCoverage.label,
        refusals: reach.refusals,
        fallthrough: global?.name ?? 'none (estimates only)',
      });
    }
    /*
     * V6 §11 — A ROUTER THAT CANNOT BE REACHED IS NOT ASKED AGAIN.
     *
     * The adapter already retried the request once. A second pair failing the
     * same way would establish nothing the first did not, and a production
     * deployment pointed at a loopback router that did not exist spent the
     * whole verification budget establishing it twenty-three times.
     */
    if (!reach.unreachable && unreachable > 0) {
      reach.unreachable = true;
      console.warn('The local router could not be reached; falling through for the rest of this build', {
        provider: local?.name ?? 'local',
        unreachablePairs: unreachable,
        fallthrough: global?.name ?? 'none (estimates only)',
      });
    }
  };

  /* A local-only composite with no declared coverage still has to learn, so it can no longer be returned bare. */
  const name = [local ? `${local.name}${localCoverage.declared ? ` (${localCoverage.label})` : ''}` : null, global?.name ?? null].filter(Boolean).join(' → ');
  const localUsable = (points: readonly { lat: number; lng: number }[]): boolean =>
    local !== null && !localExhausted() && localCoverage.coversAll(points);
  const pick = (points: readonly { lat: number; lng: number }[]): RoutingProvider | null => {
    if (localUsable(points)) return local;
    if (global) return global;
    /*
     * Nothing else covers this. Falling back to a local router we have just
     * established cannot answer would be a request spent to be refused again,
     * so it is not attempted.
     */
    return null;
  };

  const unmeasured = (points: readonly { id: string }[], note: string): RoutingMatrixResult => ({
    ids: points.map((p) => p.id),
    minutes: points.map((a) => points.map((b) => (a.id === b.id ? 0 : Number.NaN))),
    km: points.map((a) => points.map((b) => (a.id === b.id ? 0 : Number.NaN))),
    /*
     * §19 — NOTHING HERE WAS MEASURED, SO IT MAY NOT SAY `measured`.
     *
     * This branch used to report `kind: 'measured'` for a matrix of `NaN`. The
     * note was honest and the field a consumer keys off was not, and consumers
     * do key off it: `reconcile.ts` names the source of a leg's duration from
     * this kind, and `coverage.ts` counts measured matrices with it. `estimated`
     * is the honest value — no cell in here came from a router — and every pair
     * is additionally an explicit gap below, so no number is readable at all.
     */
    provenance: { kind: 'estimated', note },
    failedPairs: points.flatMap((a) => points.filter((b) => b.id !== a.id).map((b) => ({ from: a.id, to: b.id, reason: 'insufficient_evidence' as const }))),
    calls: 0,
    elements: 0,
    reasonCounts: { insufficient_evidence: points.length * Math.max(0, points.length - 1) },
  });

  return {
    name,
    supportedModes() {
      const modes = new Set<string>();
      for (const p of [local, global]) if (p) for (const m of p.supportedModes()) modes.add(m);
      return [...modes] as ReturnType<RoutingProvider['supportedModes']>;
    },
    async matrix({ points, mode, maxElements }): Promise<RoutingMatrixResult> {
      const provider = pick(points);
      if (!provider) {
        return unmeasured(
          points,
          reach.unreachable
            ? 'The local router could not be reached and no global router is configured; nothing more was asked.'
            : reach.outOfCoverage
              ? 'The local router does not cover this trip and no global router is configured; nothing was asked.'
              : 'No configured router covers these points; nothing was asked.',
        );
      }
      if (!provider.supportedModes().includes(mode)) {
        const other = provider === local ? global : local;
        if (other && other.supportedModes().includes(mode) && (other !== local || localUsable(points))) {
          const result = await other.matrix({ points, mode, maxElements });
          if (other === local) noteLocalAnswer(result);
          return result;
        }
      }
      const result = await provider.matrix({ points, mode, maxElements });
      if (provider !== local) return result;
      noteLocalAnswer(result);
      /*
       * The local router has just told us it does not hold this region. Retry
       * once against the global router rather than returning a matrix of gaps
       * the traveller will read as "we could not time your trip": the refusal
       * cost one request, the answer is available, and this is the leg the whole
       * routing hierarchy exists to deliver.
       */
      if (localExhausted() && global && global.supportedModes().includes(mode)) {
        return global.matrix({ points, mode, maxElements });
      }
      return result;
    },
    async route({ from, to, mode }): Promise<RouteConfirmationResult> {
      const provider = pick([from, to]);
      if (!provider?.route) return { found: false, minutes: null, km: null, reason: 'insufficient_evidence' };
      const result = await provider.route({ from, to, mode });
      if (provider !== local) return result;
      if (result.found || (result.reason !== 'out_of_coverage' && result.reason !== 'unreachable')) return result;
      noteLocalAnswer({ failedPairs: [{ reason: result.reason }] });
      if (global?.route) return global.route({ from, to, mode });
      /* No global router: the honest answer is "nobody was able to say", not "no route". */
      return { found: false, minutes: null, km: null, reason: 'insufficient_evidence' };
    },
  };
}
