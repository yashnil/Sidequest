/*
 * The final, end-to-end live validation of the frozen Iceland TripSkeleton
 * through the complete Phase 17 production path — base resolution, real
 * Nominatim geocoding, the skeleton-scoped on-demand routing matrix, real
 * planTrip(), real validation. Reuses the already-adopted compiled Iceland
 * region and trip from prior rounds (no recompilation).
 *
 * This calls the exact same real functions `planFromSkeletonForTrip()` calls
 * internally (`productionGeocodeLocality`, `productionRouteMatrix`,
 * `productionDestinationScope`, `productionSubregionGeometries`), inlined
 * only so each can be wrapped with a counter/timer for the diagnostics this
 * run reports — not a different code path, the same one, observed.
 *
 * ZERO ANTHROPIC CALLS — `createOpenProviders({maxModelCalls:0})`, the same
 * mechanism `planFromSkeletonForTrip()` itself always uses.
 *
 * Run with:
 *   npx tsx apps/web/scripts/iceland-production-hydration-final.ts
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
  let lastRoutingPoints = 0;
  const observedRouteMatrix = async (points: readonly { id: string; lat: number; lng: number }[]) => {
    routingCalls += 1;
    lastRoutingPoints = points.length;
    const t = performance.now();
    const out = await productionRouteMatrix(providers.routing, region.matrix.mode, points);
    routingMs += performance.now() - t;
    return out;
  };

  const destinationScope = productionDestinationScope(region.compiled);
  const subregionGeometries = productionSubregionGeometries(region.compiled);
  console.log('Destination scope:', JSON.stringify(destinationScope));

  const { planFromSkeleton, resolveAnchorPlace } = await import('../src/lib/planning/skeleton-adapter');

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
  console.log('Routing calls:', routingCalls, '- points requested:', lastRoutingPoints);
  console.log(`Bases resolved: ${result.baseResolutions.filter((r) => r.resolvedId).length}/${result.baseResolutions.length}`);

  // --- Reports --------------------------------------------------------------
  const baseReport = skeleton.bases.map((base: { id: string; name: string; nights: number }) => {
    const record = result.baseResolutions.find((r) => r.skeletonBaseId === base.id);
    return { skeletonBaseId: base.id, skeletonName: base.name, nights: base.nights, ...record };
  });

  const anchorReport: unknown[] = [];
  for (const day of skeleton.days as Array<{ dayNumber: number; anchors: Array<{ placeIndex: number; role: string }> }>) {
    for (const anchor of day.anchors) {
      const evidencePlace = (skeletonPacket.places as Array<{ index: number; name: string; lat: number; lng: number }>).find(
        (p) => p.index === anchor.placeIndex,
      );
      if (!evidencePlace) {
        anchorReport.push({ dayNumber: day.dayNumber, placeIndex: anchor.placeIndex, classification: 'no_evidence_entry' });
        continue;
      }
      const resolvedAnchor = resolveAnchorPlace(evidencePlace, board.candidates);
      const inMatrix = resolvedAnchor.place ? region.matrix.ids.includes(resolvedAnchor.place.id) : false;
      anchorReport.push({
        dayNumber: day.dayNumber,
        placeIndex: anchor.placeIndex,
        skeletonName: evidencePlace.name,
        role: anchor.role,
        resolvedPlaceId: resolvedAnchor.place?.id ?? null,
        resolvedPlaceName: resolvedAnchor.place ? (resolvedAnchor.place.names?.display ?? resolvedAnchor.place.name) : null,
        method: resolvedAnchor.confidence,
        inPrimaryMatrix: inMatrix,
        classification: resolvedAnchor.place ? 'resolved' : 'absent_from_production_evidence',
      });
    }
  }
  const anchorsResolved = anchorReport.filter((a) => (a as { resolvedPlaceId?: unknown }).resolvedPlaceId).length;
  console.log(`Anchors resolved: ${anchorsResolved}/${anchorReport.length}`);

  writeFileSync(path.join(OUT_DIR, 'base-resolution-report-final.json'), JSON.stringify(baseReport, null, 2));
  writeFileSync(path.join(OUT_DIR, 'anchor-resolution-report-final.json'), JSON.stringify(anchorReport, null, 2));
  writeFileSync(path.join(OUT_DIR, 'production-plan-result-final.json'), JSON.stringify(result, null, 2));
  if (result.ok) {
    writeFileSync(path.join(OUT_DIR, 'itinerary-final.json'), JSON.stringify(result.itinerary, null, 2));
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
    routingPointsRequested: lastRoutingPoints,
    routingMs: Math.round(routingMs),
    modelCalls: 0,
    timingsMs: timings,
    totalWallMs,
    outcome: result.ok ? 'itinerary' : 'repair_issue',
  };
  writeFileSync(path.join(OUT_DIR, 'diagnostics-final.json'), JSON.stringify(diagnostics, null, 2));

  console.log('\n=== OUTCOME:', result.ok ? 'PRODUCTION ITINERARY' : 'SkeletonRepairIssue', '===');
  console.log(JSON.stringify(diagnostics, null, 2));
  if (!result.ok) console.log(JSON.stringify(result.repairIssue, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
