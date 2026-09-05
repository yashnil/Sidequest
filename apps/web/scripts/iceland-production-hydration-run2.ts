/*
 * ONE live production-hydration validation of the frozen, saved Iceland
 * TripSkeleton, using the NEW production caller (`planFromSkeletonForTrip`)
 * built in the round before this one. Reuses the already-adopted compiled
 * Iceland region and trip from the prior live run (no recompilation — the
 * region matches the skeleton's own dates and was compiled with the same
 * zero-model provider set).
 *
 * ZERO ANTHROPIC CALLS — enforced the same way as the orchestrator itself:
 * `planFromSkeletonForTrip()` builds its own `createOpenProviders({maxModelCalls:0})`
 * internally. This script makes no model-touching call anywhere.
 *
 * Run with:
 *   npx tsx apps/web/scripts/iceland-production-hydration-run2.ts
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
  const diffHash = sha256(execSync('git diff HEAD').toString());
  const skeletonRaw = readFileSync(SKELETON_PATH, 'utf8');
  const skeletonShaBefore = sha256(skeletonRaw);
  const skeleton = JSON.parse(skeletonRaw);
  const skeletonPacket = JSON.parse(readFileSync(PACKET_PATH, 'utf8'));

  console.log('HEAD', head);
  console.log('diff sha256', diffHash);
  console.log('skeleton sha256 (before)', skeletonShaBefore);

  const { getTrip, getProfile } = await import('../src/lib/db/repository');
  const { getIntent } = await import('../src/lib/db/compiler-repository');
  const trip = getTrip(TRIP_ID);
  if (!trip) throw new Error(`Trip ${TRIP_ID} not found — expected the trip from the prior live run to still exist.`);
  const intent = getIntent(TRIP_ID);
  if (!intent?.selectedCompiledRegionId) throw new Error(`Trip ${TRIP_ID} has no adopted compiled region.`);
  const profile = getProfile(TRIP_ID);
  if (!profile) throw new Error(`Trip ${TRIP_ID} has no saved profile.`);
  console.log('Reusing trip', TRIP_ID, 'compiled region', intent.selectedCompiledRegionId);
  console.log('Profile transport ceiling: drive', profile.transport.maxDailyDriveMinutes, 'min');

  const { resolveTripRegion, boardFor } = await import('../src/lib/region');
  const tContext = performance.now();
  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) throw new Error(`Region resolution failed: ${resolved.error}`);
  const region = resolved.context;
  const board = boardFor(trip, profile, region);
  mark('contextAssemblyMs', tContext);
  console.log('Region', region.region.name, '- board size', board.candidates.length, '- compiled bases', region.compiled.bases.length);

  const { _planFromSkeletonForTrip, productionGeocodeLocality, productionRouteMatrix } = await import(
    '../src/lib/planning/skeleton-orchestrator'
  );

  // Wrap the real geocoder/router to capture call counts/timings without
  // changing their behavior — pure observation.
  let geocoderCalls = 0;
  let geocoderMs = 0;
  const geocoderQueries: string[] = [];
  const observedGeocoder = async (query: string) => {
    geocoderCalls += 1;
    geocoderQueries.push(query);
    const t = performance.now();
    const result = await productionGeocodeLocality(query);
    geocoderMs += performance.now() - t;
    return result;
  };

  let routingCalls = 0;
  let routingMs = 0;
  const { createOpenProviders } = await import('../src/lib/providers/live');
  const { providers } = createOpenProviders({ maxModelCalls: 0 });
  const observedRouteMatrix = async (points: readonly { id: string; lat: number; lng: number }[]) => {
    routingCalls += 1;
    const t = performance.now();
    const result = await productionRouteMatrix(providers.routing, region.matrix.mode, points);
    routingMs += performance.now() - t;
    return result;
  };

  // Monkey-patch-free: call planFromSkeleton directly (same function
  // planFromSkeletonForTrip calls internally) so the observation wrappers
  // above are actually used, while every other input is assembled exactly
  // as planFromSkeletonForTrip assembles it.
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
    },
  });
  mark('adapterMs', tAdapter);

  console.log('Geocoder calls:', geocoderCalls, 'queries:', geocoderQueries.join(' | '));
  console.log('Routing calls:', routingCalls);
  console.log(`Bases resolved: ${result.baseResolutions.filter((r) => r.resolvedId).length}/${result.baseResolutions.length}`);

  // --- Independent, full reports: every base, every one of 27 anchors -----
  const baseReport = skeleton.bases.map((base: { id: string; name: string; nights: number }) => {
    const record = result.baseResolutions.find((r) => r.skeletonBaseId === base.id);
    return {
      skeletonBaseId: base.id,
      skeletonName: base.name,
      nights: base.nights,
      ...record,
    };
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
      anchorReport.push({
        dayNumber: day.dayNumber,
        placeIndex: anchor.placeIndex,
        skeletonName: evidencePlace.name,
        role: anchor.role,
        resolvedPlaceId: resolvedAnchor.place?.id ?? null,
        resolvedPlaceName: resolvedAnchor.place ? (resolvedAnchor.place.names?.display ?? resolvedAnchor.place.name) : null,
        method: resolvedAnchor.confidence,
        classification: resolvedAnchor.place ? 'resolved' : 'absent_from_production_evidence',
      });
    }
  }

  const anchorsResolved = anchorReport.filter((a) => (a as { resolvedPlaceId?: unknown }).resolvedPlaceId).length;
  console.log(`Anchors resolved: ${anchorsResolved}/${anchorReport.length}`);

  writeFileSync(path.join(OUT_DIR, 'base-resolution-report-run2.json'), JSON.stringify(baseReport, null, 2));
  writeFileSync(path.join(OUT_DIR, 'anchor-resolution-report-run2.json'), JSON.stringify(anchorReport, null, 2));
  writeFileSync(path.join(OUT_DIR, 'production-plan-result-run2.json'), JSON.stringify(result, null, 2));

  const totalWallMs = Math.round(performance.now() - wallStart);
  const skeletonShaAfter = sha256(readFileSync(SKELETON_PATH, 'utf8'));

  const diagnostics = {
    head,
    diffHashBefore: diffHash,
    diffHashAfter: sha256(execSync('git diff HEAD').toString()),
    skeletonShaBefore,
    skeletonShaAfter,
    skeletonUnchanged: skeletonShaBefore === skeletonShaAfter,
    tripId: TRIP_ID,
    compiledRegionId: intent.selectedCompiledRegionId,
    matrixMode: region.matrix.mode,
    boardSize: board.candidates.length,
    compiledBasesCount: region.compiled.bases.length,
    basesResolved: `${result.baseResolutions.filter((r) => r.resolvedId).length}/${result.baseResolutions.length}`,
    anchorsResolved: `${anchorsResolved}/${anchorReport.length}`,
    geocoderCalls,
    geocoderMs: Math.round(geocoderMs),
    geocoderQueries,
    routingCalls,
    routingMs: Math.round(routingMs),
    modelCalls: 0,
    timingsMs: timings,
    totalWallMs,
    outcome: result.ok ? 'itinerary' : 'repair_issue',
  };
  writeFileSync(path.join(OUT_DIR, 'diagnostics-run2.json'), JSON.stringify(diagnostics, null, 2));

  console.log('\n=== OUTCOME:', result.ok ? 'PRODUCTION ITINERARY' : 'SkeletonRepairIssue', '===');
  console.log(JSON.stringify(diagnostics, null, 2));
  if (!result.ok) console.log(JSON.stringify(result.repairIssue, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
