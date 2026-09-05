/*
 * OFFLINE ACCEPTANCE REPLAY — THE ASSIGNMENT/CLUSTERING FIX, AGAINST THE
 * PERSISTED ICELAND CHECKPOINT. ZERO LIVE PROVIDER CALLS, ZERO ANTHROPIC.
 *
 * Every geocode/matrix/confirm/findNearbyLocalities call `planFromSkeleton()`
 * makes is answered from `checkpoint-route-geometry-remediation-live.json`
 * (written incrementally by the prior live run, before that run's own
 * unrelated planTrip() crash) — a real, already-paid-for record of what the
 * live providers actually said, replayed rather than re-requested. Only the
 * region/board/trip context comes from a fresh read (local DB + compiled
 * region, no network) — exactly the same offline reconstruction
 * `resolveTripRegion`/`boardFor` already do for every other script in this
 * arc.
 *
 * Run with (from apps/web):
 *   npx tsx scripts/iceland-offline-replay-scheduling-fix.ts
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const SKELETON_PATH = path.join(REPO_ROOT, '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/trip-skeleton.json');
const PACKET_PATH = path.join(REPO_ROOT, '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/skeleton-evidence-packet.json');
const OUT_DIR = path.join(REPO_ROOT, '.claude-private/benchmark/iceland-production-hydration-2026-08-29');
const CHECKPOINT_PATH = path.join(OUT_DIR, 'checkpoint-route-geometry-remediation-live.json');
const TRIP_ID = '64bc0495-370f-42ad-950d-12d1c0a10317';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

interface CallLogEntry {
  seq: number;
  kind: 'geocode' | 'matrix' | 'confirm' | 'findNearbyLocalities' | 'overpassDiagnosticProbe';
  input: unknown;
  output: unknown;
}

async function main() {
  const head = execSync('git rev-parse HEAD').toString().trim();
  const diffHashBefore = sha256(execSync('git diff HEAD').toString());
  const skeletonRaw = readFileSync(SKELETON_PATH, 'utf8');
  const skeletonShaBefore = sha256(skeletonRaw);
  const skeleton = JSON.parse(skeletonRaw);
  const skeletonPacket = JSON.parse(readFileSync(PACKET_PATH, 'utf8'));
  const checkpoint = JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf8')) as { callLog: CallLogEntry[] };
  const log = checkpoint.callLog;

  console.log('=== OFFLINE REPLAY — NO LIVE PROVIDER CALLS, NO ANTHROPIC ===');
  console.log('HEAD', head, '| diff sha256', diffHashBefore, '| skeleton sha256', skeletonShaBefore);
  console.log('Replaying from checkpoint:', CHECKPOINT_PATH, '-', log.length, 'recorded calls');

  const { getTrip, getProfile } = await import('../src/lib/db/repository');
  const { getIntent } = await import('../src/lib/db/compiler-repository');
  const trip = getTrip(TRIP_ID);
  if (!trip) throw new Error(`Trip ${TRIP_ID} not found.`);
  const intent = getIntent(TRIP_ID);
  if (!intent?.selectedCompiledRegionId) throw new Error(`Trip ${TRIP_ID} has no adopted compiled region.`);
  const profile = getProfile(TRIP_ID);
  if (!profile) throw new Error(`Trip ${TRIP_ID} has no saved profile.`);

  const { resolveTripRegion, boardFor } = await import('../src/lib/region');
  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) throw new Error(`Region resolution failed: ${resolved.error}`);
  const region = resolved.context;
  const board = boardFor(trip, profile, region);
  console.log('Region', region.region.name, '- board size', board.candidates.length);

  // --- Replay wrappers: every answer comes from the checkpoint's own real ---
  // --- record. A request this exact replay makes that the checkpoint has no
  // --- matching entry for is reported honestly (never invented, never
  // --- silently substituted with a live call). -------------------------------
  const unmatchedRequests: { kind: string; input: unknown }[] = [];

  const geocodeEntries = log.filter((e) => e.kind === 'geocode');
  const replayGeocode = async (query: string) => {
    const match = geocodeEntries.find((e) => (e.input as { query: string }).query === query);
    if (!match) {
      unmatchedRequests.push({ kind: 'geocode', input: { query } });
      return [];
    }
    return match.output as unknown[];
  };

  const matrixEntries = log.filter((e) => e.kind === 'matrix');
  const replayRouteMatrix = async (points: readonly { id: string; lat: number; lng: number }[]) => {
    const requestedIds = [...points.map((p) => p.id)].sort();
    const match = matrixEntries.find((e) => {
      const ids = [...(e.input as { pointIds: string[] }).pointIds].sort();
      return ids.length === requestedIds.length && ids.every((id, i) => id === requestedIds[i]);
    });
    if (!match) {
      unmatchedRequests.push({ kind: 'matrix', input: { pointIds: requestedIds } });
      return null;
    }
    return match.output as { ids: string[]; minutes: number[][]; km: number[][]; failedPairs?: unknown[] };
  };

  const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  const confirmEntries = log.filter((e) => e.kind === 'confirm');
  const replayConfirmRoute = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
    const match = confirmEntries.find((e) => {
      const input = e.input as { from: { lat: number; lng: number }; to: { lat: number; lng: number } };
      return close(input.from.lat, from.lat) && close(input.from.lng, from.lng) && close(input.to.lat, to.lat) && close(input.to.lng, to.lng);
    });
    if (!match) {
      unmatchedRequests.push({ kind: 'confirm', input: { from, to } });
      return null;
    }
    return match.output as { found: boolean; minutes: number | null; km: number | null; reason?: string; geometry?: { lat: number; lng: number }[] };
  };

  const findNearbyEntries = log.filter((e) => e.kind === 'findNearbyLocalities');
  const replayFindNearbyLocalities = async (point: { lat: number; lng: number }, radiusKm: number) => {
    const match = findNearbyEntries.find((e) => {
      const input = e.input as { point: { lat: number; lng: number }; radiusKm: number };
      return close(input.point.lat, point.lat) && close(input.point.lng, point.lng) && input.radiusKm === radiusKm;
    });
    if (!match) {
      unmatchedRequests.push({ kind: 'findNearbyLocalities', input: { point, radiusKm } });
      return [];
    }
    return match.output as unknown[];
  };

  const { productionDestinationScope, productionSubregionGeometries } = await import('../src/lib/planning/skeleton-orchestrator');
  const { planFromSkeleton } = await import('../src/lib/planning/skeleton-adapter');

  console.log('\n=== RUNNING planFromSkeleton() ENTIRELY FROM REPLAYED EVIDENCE ===');
  const wallStart = performance.now();
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
      geocodeLocality: replayGeocode,
      routeMatrix: replayRouteMatrix,
      confirmRoute: replayConfirmRoute,
      findNearbyLocalities: replayFindNearbyLocalities,
      destinationScope: productionDestinationScope(region.compiled),
      subregionGeometries: productionSubregionGeometries(region.compiled),
    },
  });
  const wallMs = Math.round(performance.now() - wallStart);

  console.log('resultOk:', result.ok, '| wall ms:', wallMs, '| unmatched (live-required) requests:', unmatchedRequests.length);
  if (unmatchedRequests.length > 0) {
    console.log('UNMATCHED REQUESTS (this offline replay could not answer from the checkpoint alone):');
    console.log(JSON.stringify(unmatchedRequests, null, 2));
  }

  if (!result.ok) {
    console.log('\n=== REPLAY DID NOT PRODUCE A FEASIBLE ROUTE ===');
    console.log(JSON.stringify(result.repairIssue, null, 2));
    writeFileSync(path.join(OUT_DIR, 'offline-replay-result.json'), JSON.stringify(result, null, 2));
    writeFileSync(path.join(OUT_DIR, 'offline-replay-unmatched-requests.json'), JSON.stringify(unmatchedRequests, null, 2));
    return;
  }

  console.log('\n=== ITINERARY (offline replay) ===');
  const dayBaseSeq: string[] = [];
  let totalScheduledStops = 0;
  for (const day of result.itinerary.days) {
    if (dayBaseSeq[dayBaseSeq.length - 1] !== day.baseId) dayBaseSeq.push(day.baseId);
    const realItems = day.items.filter((item) => item.title && item.title !== 'Free time' && item.title !== 'Dinner' && item.title !== 'Lunch' && !item.title.startsWith('Drive to'));
    totalScheduledStops += realItems.length;
    console.log(`  ${day.date} (${day.baseId}): ${day.items.length} items -`, day.items.map((i) => i.title ?? i.placeId).join(' | '));
  }
  console.log('Base sequence:', dayBaseSeq.join(' -> '));
  console.log('Days:', result.itinerary.days.length, '| real (non-free-time/meal/drive) stops:', totalScheduledStops);
  console.log('Readiness level:', result.readiness.level, '| funnel:', JSON.stringify(result.readiness.funnel));
  console.log('Deviations:', result.deviations.map((d) => d.kind).join(', '));

  writeFileSync(path.join(OUT_DIR, 'offline-replay-result.json'), JSON.stringify(result, null, 2));
  writeFileSync(path.join(OUT_DIR, 'offline-replay-unmatched-requests.json'), JSON.stringify(unmatchedRequests, null, 2));

  const skeletonShaAfter = sha256(readFileSync(SKELETON_PATH, 'utf8'));
  const diffHashAfter = sha256(execSync('git diff HEAD').toString());
  console.log('\ndiff sha256 (after)', diffHashAfter, '| skeleton sha256 (after)', skeletonShaAfter);
  console.log('diffUnchanged:', diffHashBefore === diffHashAfter, '| skeletonUnchanged:', skeletonShaBefore === skeletonShaAfter);
  console.log('\nAnthropic calls: 0. Live provider calls: 0 (all replayed from checkpoint).');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
