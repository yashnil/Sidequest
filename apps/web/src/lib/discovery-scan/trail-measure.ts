import { MAX_TRAIL_STAGES, type MeasuredStage, type ScanProposal } from '@sidequest/core';
import { computeOrsTrailStage, type OrsHttp } from '../providers/openrouteservice';

/**
 * 2026-11 (point-to-point trekking) — A TRAIL STAGE'S DISTANCE AND CLIMB, MEASURED WHERE POSSIBLE.
 *
 * A walking day is judged on how far it goes and how much it climbs. The
 * proposal's own figures are travel knowledge; a hiking router's are a
 * measurement. For each placed one-way walk (start and end both on the map),
 * at most `MAX_TRAIL_STAGES` of them, one `foot-hiking` request with
 * elevation, cached for the static-route lifetime under a directional key
 * (ascent is not symmetric). Any failure leaves that stage on the proposal's
 * figures, labelled as such downstream (`distanceBasis`); a rate limit stops
 * the batch rather than burning the remaining requests. Never throws.
 */

export interface TrailMeasureCache {
  read(key: string): MeasuredStage | null;
  write(key: string, value: MeasuredStage): void;
}

export function trailCacheKey(from: { lat: number; lng: number }, to: { lat: number; lng: number }): string {
  const r = (n: number) => n.toFixed(4);
  return `ors-trail|foot-hiking|${r(from.lat)},${r(from.lng)}|${r(to.lat)},${r(to.lng)}`;
}

export async function measureTrailStages(
  proposal: Pick<ScanProposal, 'candidates'>,
  positionOf: (key: string) => { lat: number; lng: number } | null,
  deps: { http?: OrsHttp; cache?: TrailMeasureCache; deadline?: () => boolean } = {},
): Promise<{ measured: Map<string, MeasuredStage>; calls: number; failures: number }> {
  const measured = new Map<string, MeasuredStage>();
  let calls = 0;
  let failures = 0;
  const stages = proposal.candidates
    .filter((c) => c.walk?.shape === 'point_to_point')
    .map((c) => ({ key: c.key, stage: c.walk?.stage ?? 1000, from: positionOf(c.key), to: positionOf(`${c.key}#end`) }))
    .filter((s): s is { key: string; stage: number; from: { lat: number; lng: number }; to: { lat: number; lng: number } } => s.from !== null && s.to !== null)
    .sort((a, b) => a.stage - b.stage)
    .slice(0, MAX_TRAIL_STAGES);
  for (const stage of stages) {
    if (deps.deadline?.()) break;
    const key = trailCacheKey(stage.from, stage.to);
    const cached = deps.cache?.read(key);
    if (cached) {
      measured.set(stage.key, cached);
      continue;
    }
    calls += 1;
    const result = await computeOrsTrailStage({ from: stage.from, to: stage.to }, deps.http ?? {});
    if (!result.found || result.km === null) {
      failures += 1;
      if (result.reason === 'rate_limited') break;
      continue;
    }
    /* A route with no elevation answer still measured the distance; the climb then stays the proposal's (unknown is not flat). */
    if (result.ascentM === null) continue;
    const value = { km: result.km, ascentM: result.ascentM };
    measured.set(stage.key, value);
    deps.cache?.write(key, value);
  }
  return { measured, calls, failures };
}
