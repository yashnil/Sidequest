/*
 * THE FINAL LIVE VALIDATION OF THE CURRENT TripSkeleton -> PRODUCTION
 * PLANNER PATH, AFTER THIS ROUND'S DETERMINISTIC CANDIDATE-RANKING FIX.
 *
 * Exercises the exact real production path: TripSkeleton ->
 * planFromSkeletonForTrip()'s own assembly -> resolveSkeletonBase() ->
 * deterministic Nominatim geocoding -> assessGeographicScope() ->
 * rankGeocoderCandidates() -> the skeleton-scoped on-demand routing seam ->
 * assessRelocationFeasibility() -> real planTrip() -> real validation.
 * Calls the same real functions `planFromSkeletonForTrip()` calls internally
 * (`productionGeocodeLocality`, `productionRouteMatrix`,
 * `productionDestinationScope`), inlined only so each can be wrapped with a
 * counter/timer for this run's diagnostics — not a different code path, the
 * same one, observed. NOT the benchmark hydrator.
 *
 * ZERO ANTHROPIC CALLS — `createOpenProviders({maxModelCalls:0})`, the same
 * mechanism `planFromSkeletonForTrip()` itself always uses. No skeleton
 * generation, no skeleton repair, no research-model expansion, no model
 * corroboration, no evaluator is invoked anywhere in this script.
 *
 * Run with:
 *   npx tsx apps/web/scripts/iceland-production-hydration-post-ranking.ts
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKELETON_PATH = path.join(
  REPO_ROOT,
  '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/trip-skeleton.json',
);
const PACKET_PATH = path.join(
  REPO_ROOT,
  '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/skeleton-evidence-packet.json',
);
const OUT_DIR = path.join(REPO_ROOT, '.claude-private/benchmark/iceland-production-hydration-2026-08-29');
const TRIP_ID = '64bc0495-370f-42ad-950d-12d1c0a10317';
const SUFFIX = 'post-ranking';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  const wallStart = performance.now();
  const timings: Record<string, number> = {};
  const mark = (label: string, startedAt: number) => {
    timings[label] = Math.round(performance.now() - startedAt);
  };

  const head = execSync('git rev-parse HEAD').toString().trim();
  const diffHashBefore = sha256(execSync('git diff HEAD').toString());
  const skeletonRaw = readFileSync(SKELETON_PATH, 'utf8');
  const skeletonShaBefore = sha256(skeletonRaw);
  const skeleton = JSON.parse(skeletonRaw);
  const skeletonPacket = JSON.parse(readFileSync(PACKET_PATH, 'utf8'));

  console.log('HEAD', head);
  console.log('diff sha256 (before)', diffHashBefore);
  console.log('skeleton sha256 (before)', skeletonShaBefore);

  const { getTrip, getProfile } = await import('../src/lib/db/repository');
  const { getIntent } = await import('../src/lib/db/compiler-repository');
  const trip = getTrip(TRIP_ID);
  if (!trip) throw new Error(`Trip ${TRIP_ID} not found.`);
  const intent = getIntent(TRIP_ID);
  if (!intent?.selectedCompiledRegionId) throw new Error(`Trip ${TRIP_ID} has no adopted compiled region.`);
  const profile = getProfile(TRIP_ID);
  if (!profile) throw new Error(`Trip ${TRIP_ID} has no saved profile.`);
  console.log('Reusing trip', TRIP_ID, 'compiled region', intent.selectedCompiledRegionId);

  const tContext = performance.now();
  const { resolveTripRegion, boardFor } = await import('../src/lib/region');
  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) throw new Error(`Region resolution failed: ${resolved.error}`);
  const region = resolved.context;
  const board = boardFor(trip, profile, region);
  mark('contextAssemblyMs', tContext);
  console.log('Region', region.region.name, '- board size', board.candidates.length, '- compiled bases', region.compiled.bases.length);
  console.log('Primary matrix points:', region.matrix.ids.length, '- mode:', region.matrix.mode);

  const {
    productionGeocodeLocality,
    productionRouteMatrix,
    productionDestinationScope,
    productionSubregionGeometries,
  } = await import('../src/lib/planning/skeleton-orchestrator');
  const { createOpenProviders } = await import('../src/lib/providers/live');
  const { providers } = createOpenProviders({ maxModelCalls: 0 });

  let geocoderCalls = 0;
  let geocoderMs = 0;
  const geocoderQueries: string[] = [];
  const observedGeocoder = async (query: string) => {
    geocoderCalls += 1;
    geocoderQueries.push(query);
    const t = performance.now();
    const out = await productionGeocodeLocality(query);
    geocoderMs += performance.now() - t;
    return out;
  };

  let routingCalls = 0;
  let routingMs = 0;
  let lastRoutingPoints: readonly { id: string; lat: number; lng: number }[] = [];
  let lastRoutingResult: Awaited<ReturnType<typeof productionRouteMatrix>> = null;
  const observedRouteMatrix = async (points: readonly { id: string; lat: number; lng: number }[]) => {
    routingCalls += 1;
    lastRoutingPoints = points;
    const t = performance.now();
    const out = await productionRouteMatrix(providers.routing, region.matrix.mode, points);
    routingMs += performance.now() - t;
    lastRoutingResult = out;
    return out;
  };

  const destinationScope = productionDestinationScope(region.compiled);
  const subregionGeometries = productionSubregionGeometries(region.compiled);
  console.log('Destination scope:', JSON.stringify(destinationScope));

  const { planFromSkeleton, resolveAnchorPlace } = await import('../src/lib/planning/skeleton-adapter');
  const { tryLeg } = await import('@sidequest/geo');

  const tAdapter = performance.now();
  const result = await planFromSkeleton({
    skeleton,
    skeletonPacket,
    context: {
      tripId: TRIP_ID,
      basics: trip.basics,
      profile,
      region: region.region,
      candidates: board.candidates,
      matrix: region.matrix,
      ...(region.transit ? { transit: region.transit } : {}),
      scheduledNetwork: region.scheduledNetwork,
      access: region.access,
      hours: region.hours,
      weather: region.weather,
      ...(region.food ? { food: region.food } : {}),
      now: new Date(),
      baseId: region.baseId,
      compiledBases: region.compiled.bases,
      geocodeLocality: observedGeocoder,
      routeMatrix: observedRouteMatrix,
      destinationScope,
      subregionGeometries,
    },
  });
  mark('adapterAndPlanTripMs', tAdapter);

  console.log('Geocoder calls:', geocoderCalls, 'queries:', geocoderQueries.join(' | '));
  console.log('Routing calls:', routingCalls, '- points requested:', lastRoutingPoints.length);
  console.log(`Bases resolved: ${result.baseResolutions.filter((r) => r.resolvedId).length}/${result.baseResolutions.length}`);

  // --- Base resolution report, with full candidate ranking diagnostics ------
  const baseReport = skeleton.bases.map((base: { id: string; name: string; nights: number }) => {
    const record = result.baseResolutions.find((r) => r.skeletonBaseId === base.id);
    return { skeletonBaseId: base.id, skeletonName: base.name, nights: base.nights, ...record };
  });

  // --- Anchor classification -------------------------------------------------
  const anchorUnroutableIds = new Set(
    result.ok
      ? result.deviations.filter((d) => d.kind === 'anchor_unroutable').map((d) => d.replacementPlaceId)
      : [],
  );
  const anchorReport: unknown[] = [];
  for (const day of skeleton.days as Array<{ dayNumber: number; anchors: Array<{ placeIndex: number; role: string }> }>) {
    for (const anchor of day.anchors) {
      const evidencePlace = (skeletonPacket.places as Array<{ index: number; name: string; lat: number; lng: number }>).find(
        (p) => p.index === anchor.placeIndex,
      );
      if (!evidencePlace) {
        anchorReport.push({ dayNumber: day.dayNumber, placeIndex: anchor.placeIndex, classification: 'absent_from_evidence' });
        continue;
      }
      const resolvedAnchor = resolveAnchorPlace(evidencePlace, board.candidates);
      const inMatrix = resolvedAnchor.place ? region.matrix.ids.includes(resolvedAnchor.place.id) : false;
      let classification: string;
      if (!resolvedAnchor.place) classification = 'absent_from_evidence';
      else if (resolvedAnchor.place.id && anchorUnroutableIds.has(resolvedAnchor.place.id)) classification = 'unroutable';
      else classification = 'resolved';
      anchorReport.push({
        dayNumber: day.dayNumber,
        placeIndex: anchor.placeIndex,
        skeletonName: evidencePlace.name,
        role: anchor.role,
        resolvedPlaceId: resolvedAnchor.place?.id ?? null,
        resolvedPlaceName: resolvedAnchor.place ? (resolvedAnchor.place.names?.display ?? resolvedAnchor.place.name) : null,
        method: resolvedAnchor.confidence,
        inPrimaryMatrix: inMatrix,
        classification,
      });
    }
  }
  const anchorsResolved = anchorReport.filter((a) => (a as { classification?: string }).classification === 'resolved').length;
  console.log(`Anchors resolved: ${anchorsResolved}/${anchorReport.length}`);

  // --- Routing matrix report --------------------------------------------------
  const fallback = lastRoutingResult;
  const fallbackIds: readonly string[] = fallback ? fallback.ids : [];
  const unresolvedPairs: { fromId: string; toId: string }[] = [];
  if (fallback) {
    for (let i = 0; i < fallback.ids.length; i += 1) {
      for (let j = 0; j < fallback.ids.length; j += 1) {
        if (i === j) continue;
        const forward = fallback.minutes[i]?.[j];
        const backward = fallback.minutes[j]?.[i];
        const forwardFinite = typeof forward === 'number' && Number.isFinite(forward);
        const backwardFinite = typeof backward === 'number' && Number.isFinite(backward);
        if (!forwardFinite && !backwardFinite) unresolvedPairs.push({ fromId: fallback.ids[i]!, toId: fallback.ids[j]! });
      }
    }
  }
  const pointsAbsentFromPrimaryMatrix = lastRoutingPoints.filter((p) => !region.matrix.ids.includes(p.id)).map((p) => p.id);
  const pointsAbsentButInFallback = pointsAbsentFromPrimaryMatrix.filter((id) => fallbackIds.includes(id));

  const routingReport = {
    primaryMatrixPointCount: region.matrix.ids.length,
    fallbackMatrixPointCount: fallbackIds.length,
    fallbackMatrixIds: fallbackIds,
    routingProviderCalls: routingCalls,
    routingLatencyMs: Math.round(routingMs),
    pointsRequestedFromFallback: lastRoutingPoints.map((p) => p.id),
    pointsAbsentFromPrimaryMatrix,
    pointsAbsentFromPrimaryButPresentInFallback: pointsAbsentButInFallback,
    unresolvedPairsInFallback: unresolvedPairs,
  };

  // --- Relocation feasibility, every consecutive overnight leg ---------------
  function measuredMinutesKm(fromId: string, toId: string): { minutes: number | null; km: number | null; source: string } {
    if (fallback) {
      const fromIndex = fallback.ids.indexOf(fromId);
      const toIndex = fallback.ids.indexOf(toId);
      if (fromIndex >= 0 && toIndex >= 0) {
        const minutes = fallback.minutes[fromIndex]?.[toIndex];
        const km = fallback.km[fromIndex]?.[toIndex];
        if (typeof minutes === 'number' && Number.isFinite(minutes)) {
          return { minutes, km: typeof km === 'number' && Number.isFinite(km) ? km : null, source: 'fallback_matrix' };
        }
      }
    }
    const leg = tryLeg(region.matrix, fromId, toId);
    if (leg) return { minutes: leg.minutes, km: leg.km, source: 'primary_matrix' };
    return { minutes: null, km: null, source: 'unmeasured' };
  }
  const ceiling =
    region.matrix.mode === 'car' ? profile.transport.maxDailyDriveMinutes : profile.transport.maxDailyTransportMinutes;
  const relocationReport = [];
  for (let i = 0; i < baseReport.length - 1; i += 1) {
    const from = baseReport[i];
    const to = baseReport[i + 1];
    if (!from?.resolvedId || !to?.resolvedId) {
      relocationReport.push({
        fromBase: from?.skeletonName,
        toBase: to?.skeletonName,
        skipped: true,
        reason: 'one or both bases did not resolve to a real identity',
      });
      continue;
    }
    const { minutes, km, source } = measuredMinutesKm(from.resolvedId, to.resolvedId);
    relocationReport.push({
      fromBase: from.skeletonName,
      fromId: from.resolvedId,
      toBase: to.skeletonName,
      toId: to.resolvedId,
      measuredMinutes: minutes,
      measuredKm: km,
      evidenceSource: source,
      mode: region.matrix.mode,
      hardCeilingMinutes: ceiling,
      pass: minutes === null ? null : minutes <= ceiling,
    });
  }

  writeFileSync(path.join(OUT_DIR, `base-resolution-report-${SUFFIX}.json`), JSON.stringify(baseReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `anchor-resolution-report-${SUFFIX}.json`), JSON.stringify(anchorReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `routing-report-${SUFFIX}.json`), JSON.stringify(routingReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `relocation-report-${SUFFIX}.json`), JSON.stringify(relocationReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `production-plan-result-${SUFFIX}.json`), JSON.stringify(result, null, 2));
  if (result.ok) {
    writeFileSync(path.join(OUT_DIR, `itinerary-${SUFFIX}.json`), JSON.stringify(result.itinerary, null, 2));
  }

  const totalWallMs = Math.round(performance.now() - wallStart);
  const skeletonShaAfter = sha256(readFileSync(SKELETON_PATH, 'utf8'));
  const diffHashAfter = sha256(execSync('git diff HEAD').toString());

  const diagnostics = {
    head,
    diffHashBefore,
    diffHashAfter,
    diffUnchanged: diffHashBefore === diffHashAfter,
    skeletonShaBefore,
    skeletonShaAfter,
    skeletonUnchanged: skeletonShaBefore === skeletonShaAfter,
    tripId: TRIP_ID,
    compiledRegionId: intent.selectedCompiledRegionId,
    matrixMode: region.matrix.mode,
    primaryMatrixPoints: region.matrix.ids.length,
    boardSize: board.candidates.length,
    compiledBasesCount: region.compiled.bases.length,
    destinationScope,
    basesResolved: `${result.baseResolutions.filter((r) => r.resolvedId).length}/${result.baseResolutions.length}`,
    anchorsResolved: `${anchorsResolved}/${anchorReport.length}`,
    geocoderCalls,
    geocoderMs: Math.round(geocoderMs),
    geocoderQueries,
    routingCalls,
    routingPointsRequested: lastRoutingPoints.length,
    routingMs: Math.round(routingMs),
    modelCalls: 0,
    timingsMs: timings,
    totalWallMs,
    outcome: result.ok ? 'itinerary' : 'repair_issue',
  };
  writeFileSync(path.join(OUT_DIR, `diagnostics-${SUFFIX}.json`), JSON.stringify(diagnostics, null, 2));

  console.log('\n=== OUTCOME:', result.ok ? 'PRODUCTION ITINERARY' : 'SkeletonRepairIssue', '===');
  console.log(JSON.stringify(diagnostics, null, 2));
  if (!result.ok) console.log(JSON.stringify(result.repairIssue, null, 2));
  console.log('\n=== BASE RESOLUTIONS ===');
  console.log(JSON.stringify(baseReport, null, 2));
  console.log('\n=== RELOCATION REPORT ===');
  console.log(JSON.stringify(relocationReport, null, 2));
  console.log('\n=== ROUTING REPORT ===');
  console.log(JSON.stringify(routingReport, null, 2));
  console.log('\nAnthropic calls: 0');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
