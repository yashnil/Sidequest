import type { RoutingProvider, RoutingMatrixResult, RouteConfirmationResult } from '@sidequest/compiler';
import type { RoutingCoverage } from './routing-coverage';

/**
 * THE ROUTING HIERARCHY, AS ONE PROVIDER.
 *
 *   local Valhalla, when its declared coverage holds every point
 *   → the global router (openrouteservice), when configured
 *   → nothing: the pair is reported unmeasured at once
 *
 * The local router is never asked about points outside its coverage, so a
 * regional tile build cannot burn the verification deadline on requests it
 * will predictably refuse. A pair outside every provider's reach is reported
 * `insufficient_evidence` — nobody said "no route", nobody was asked — and
 * the reconciler then estimates from geometry.
 */
export function createCompositeRouting(input: { local: RoutingProvider | null; localCoverage: RoutingCoverage; global: RoutingProvider | null }): RoutingProvider | null {
  const { local, localCoverage, global } = input;
  if (!local && !global) return null;
  if (local && !global && !localCoverage.declared) return local;
  const name = [local ? `${local.name}${localCoverage.declared ? ` (${localCoverage.label})` : ''}` : null, global?.name ?? null].filter(Boolean).join(' → ');
  const pick = (points: readonly { lat: number; lng: number }[]): RoutingProvider | null => {
    if (local && localCoverage.coversAll(points)) return local;
    if (global) return global;
    return null;
  };
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
        const ids = points.map((p) => p.id);
        return {
          ids,
          minutes: points.map((a) => points.map((b) => (a.id === b.id ? 0 : Number.NaN))),
          km: points.map((a) => points.map((b) => (a.id === b.id ? 0 : Number.NaN))),
          provenance: { kind: 'measured', note: 'No configured router covers these points; nothing was asked.' },
          failedPairs: points.flatMap((a) => points.filter((b) => b.id !== a.id).map((b) => ({ from: a.id, to: b.id, reason: 'insufficient_evidence' as const }))),
          calls: 0,
          elements: 0,
          reasonCounts: { insufficient_evidence: points.length * Math.max(0, points.length - 1) },
        };
      }
      if (!provider.supportedModes().includes(mode)) {
        const other = provider === local ? global : local;
        if (other && other.supportedModes().includes(mode) && (other !== local || localCoverage.coversAll(points))) return other.matrix({ points, mode, maxElements });
      }
      return provider.matrix({ points, mode, maxElements });
    },
    async route({ from, to, mode }): Promise<RouteConfirmationResult> {
      const provider = pick([from, to]);
      if (!provider?.route) return { found: false, minutes: null, km: null, reason: 'insufficient_evidence' };
      return provider.route({ from, to, mode });
    },
  };
}
