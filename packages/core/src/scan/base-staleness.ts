import type { CompiledRegion } from '../schemas/compiled-region';
import { estimateLegMinutes, haversineKm } from '../travel/estimate';
import { highSpeedRailBackbone } from '../reality/jurisdictions';
import { chooseScanBases, SCAN_COMPILER_VERSION } from './assemble';
import type { ScanBaseProposal, ScanCandidateProposal, ScanTier } from './proposal';

/**
 * WOULD TODAY'S BASE RULE GIVE THIS STORED SCAN FEWER HOTELS?
 *
 * Bases are chosen once, when a scan is assembled (`chooseScanBases`), and an
 * existing trip keeps the bases it was built with: nothing re-plans a stored
 * trip underneath its traveller. When the rule improves — a compact island
 * used to get three hotels — the trip page may *offer* a rebuild, and this is
 * the cheap, provider-free check that decides whether to offer it.
 *
 * It re-asks the current rule from what the stored artifact already holds: the
 * proposed bases (every one, kept or not, is on `region.bases`), the places
 * with their duration and tier (tier is read back from the popularity score the
 * assembler wrote for it), and the stored travel-time matrix. The cap is the
 * stored base count, so the answer can only be "the same" or "fewer"; a stored
 * trip is never told it should have *more* moves. The night hint is recovered
 * approximately (it is only a small tie-breaking prior). Edges are left out:
 * they decide order, not how many bases earn a place.
 *
 * Null whenever the question does not apply: not a scan artifact, no stored
 * portfolio, a single base already, or a matrix that does not cover the bases.
 */
export interface ScanBaseUpgrade {
  /** Distinct places to sleep the stored trip was planned with. */
  storedBaseCount: number;
  /** Distinct places to sleep the current rule keeps for the same scan. */
  currentBaseCount: number;
  storedBaseNames: string[];
  currentBaseNames: string[];
}

function tierFromPopularity(popularity: number): ScanTier {
  if (popularity >= 0.7) return 'classic';
  if (popularity >= 0.35) return 'side_quest';
  return 'hidden_gem';
}

function nightsBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

export function scanBaseUpgrade(region: CompiledRegion): ScanBaseUpgrade | null {
  if (region.compilerVersion !== SCAN_COMPILER_VERSION) return null;
  const portfolio = region.basePortfolio;
  if (!portfolio || portfolio.bases.length === 0) return null;
  const storedIds = [...new Set(portfolio.bases.map((b) => b.baseId))];
  if (storedIds.length < 2) return null;

  const matrix = region.travelTimes;
  if (!matrix) return null;
  const index = new Map(matrix.ids.map((id, i) => [id, i] as const));
  if (!storedIds.every((id) => index.has(id))) return null;

  const pointAt = new Map<string, { lat: number; lng: number }>([...region.bases.map((b) => [b.id, b.coordinates] as const), ...region.places.flatMap((p) => (p.coordinates ? [[p.id, p.coordinates] as const] : []))]);
  const matrixMinutes = (a: string, b: string): number | null => {
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) return null;
    const value = matrix.minutes[i]?.[j];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  /* The assembler's own geography rule: on a car-free trip a long hop is public transport, never a walk. */
  const minutes = (a: string, b: string): number | null => {
    const measured = matrixMinutes(a, b);
    if (matrix.mode !== 'foot') return measured;
    const pa = pointAt.get(a);
    const pb = pointAt.get(b);
    if (!pa || !pb || haversineKm(pa, pb) <= 1.6) return measured;
    return estimateLegMinutes({ from: pa, to: pb, mode: 'rail', highSpeedRail: highSpeedRailBackbone(region.scope.countryCode) })?.minutes ?? measured;
  };

  const bases = region.bases
    .filter((b) => index.has(b.id))
    .map((b) => ({
      id: b.id,
      proposal: { key: b.id, name: b.name, locality: b.name, nightsHint: b.suggestedNights.max, why: '' } satisfies ScanBaseProposal,
    }));
  const places = region.places
    .filter((p) => index.has(p.id))
    .map((p) => ({
      id: p.id,
      proposal: { tier: tierFromPopularity(p.popularityScore), durationMinutes: p.typicalDurationMinutes } as Pick<ScanCandidateProposal, 'tier' | 'durationMinutes'> as ScanCandidateProposal,
    }));
  const first = portfolio.bases[0]!;
  const last = portfolio.bases[portfolio.bases.length - 1]!;
  const nights = nightsBetween(first.fromDate, last.toDate);

  const choice = chooseScanBases({ bases, places, minutes, nights, maxBaseChanges: storedIds.length - 1 });
  const currentIds = [...new Set(choice.kept.map((k) => k.id))];
  if (currentIds.length >= storedIds.length) return null;
  const nameOf = (id: string) => region.bases.find((b) => b.id === id)?.name ?? id;
  return {
    storedBaseCount: storedIds.length,
    currentBaseCount: currentIds.length,
    storedBaseNames: storedIds.map(nameOf),
    currentBaseNames: currentIds.map(nameOf),
  };
}
