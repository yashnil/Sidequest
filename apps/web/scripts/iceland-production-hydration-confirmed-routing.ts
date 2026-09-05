/*
 * THE LIVE VALIDATION OF THE ROUTING-EVIDENCE CONTRACT FIX (matrix
 * `not_found` is no longer unconditionally authoritative — a mandatory
 * relocation/departure leg the matrix cannot answer earns one bounded
 * direct `/route` confirmation) AGAINST THE CONTROLLED LOCAL VALHALLA
 * INSTANCE, FOR THE FROZEN ICELAND SKELETON.
 *
 * Exercises the exact real production path: TripSkeleton ->
 * planFromSkeletonForTrip()'s own assembly -> resolveSkeletonBase() ->
 * real Nominatim geocoding -> assessGeographicScope() ->
 * rankGeocoderCandidates() -> Phase A (mandatory base legs) ->
 * confirmMandatoryLeg() (direct-route confirmation for consequential matrix
 * gaps) -> Phase B (bounded per-day legs) -> the TravelLegLedger ->
 * assessRelocationFeasibility() / assessDepartureClosure() -> real
 * planTrip() -> real validation. Calls the same real functions
 * `planFromSkeletonForTrip()` calls internally (`productionGeocodeLocality`,
 * `productionRouteMatrix`, `productionConfirmRoute`,
 * `productionDestinationScope`), inlined only so each call can be logged for
 * this run's diagnostics — not a different code path, the same one,
 * observed. NOT the benchmark hydrator.
 *
 * ZERO ANTHROPIC CALLS — `createOpenProviders({maxModelCalls:0})`, the same
 * mechanism `planFromSkeletonForTrip()` itself always uses. No skeleton
 * generation, no skeleton repair, no research-model expansion, no model
 * corroboration, no evaluator anywhere in this script.
 *
 * Run with (from apps/web):
 *   npx tsx scripts/iceland-production-hydration-confirmed-routing.ts
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
const SUFFIX = 'confirmed-routing';

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
    productionConfirmRoute,
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

  interface RouteCallLog {
    callIndex: number;
    requestedPointIds: string[];
    requestedPointCount: number;
    requestedCellCount: number;
    latencyMs: number;
    result: Awaited<ReturnType<typeof productionRouteMatrix>>;
  }
  const routeCallLog: RouteCallLog[] = [];
  let routingMs = 0;
  const observedRouteMatrix = async (points: readonly { id: string; lat: number; lng: number }[]) => {
    const t = performance.now();
    const out = await productionRouteMatrix(providers.routing, region.matrix.mode, points);
    const elapsed = performance.now() - t;
    routingMs += elapsed;
    routeCallLog.push({
      callIndex: routeCallLog.length + 1,
      requestedPointIds: points.map((p) => p.id),
      requestedPointCount: points.length,
      requestedCellCount: points.length * points.length,
      latencyMs: Math.round(elapsed),
      result: out,
    });
    return out;
  };

  interface ConfirmCallLog {
    callIndex: number;
    from: { lat: number; lng: number };
    to: { lat: number; lng: number };
    latencyMs: number;
    result: Awaited<ReturnType<typeof productionConfirmRoute>>;
  }
  const confirmCallLog: ConfirmCallLog[] = [];
  let confirmMs = 0;
  const observedConfirmRoute = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
    const t = performance.now();
    const out = await productionConfirmRoute(providers.routing, region.matrix.mode, from, to);
    const elapsed = performance.now() - t;
    confirmMs += elapsed;
    confirmCallLog.push({ callIndex: confirmCallLog.length + 1, from, to, latencyMs: Math.round(elapsed), result: out });
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
      confirmRoute: observedConfirmRoute,
      destinationScope,
      subregionGeometries,
    },
  });
  mark('adapterAndPlanTripMs', tAdapter);

  console.log('Geocoder calls:', geocoderCalls, 'queries:', geocoderQueries.join(' | '));
  console.log('Routing (matrix) calls:', routeCallLog.length, '- point counts:', routeCallLog.map((c) => c.requestedPointCount).join(', '));
  console.log('Direct route confirmation calls:', confirmCallLog.length);
  console.log(`Bases resolved: ${result.baseResolutions.filter((r) => r.resolvedId).length}/${result.baseResolutions.length}`);

  // --- Base resolution report -------------------------------------------------
  const baseReport = skeleton.bases.map((base: { id: string; name: string; nights: number }) => {
    const record = result.baseResolutions.find((r) => r.skeletonBaseId === base.id);
    return { skeletonBaseId: base.id, skeletonName: base.name, nights: base.nights, ...record };
  });

  // --- Anchor classification --------------------------------------------------
  const anchorUnroutableIds = new Set(
    result.ok ? result.deviations.filter((d) => d.kind === 'anchor_unroutable').map((d) => d.replacementPlaceId) : [],
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

  // --- Reconstruct a merged ledger view from every real routeMatrix call, for
  // --- per-leg reporting — mirrors the adapter's own internal merge, read-only. --
  interface MergedLedger {
    ids: string[];
    minutes: Map<string, number>;
    km: Map<string, number>;
    failures: Map<string, { reason: string; fromCall: number }>;
  }
  const merged: MergedLedger = { ids: [], minutes: new Map(), km: new Map(), failures: new Map() };
  const pairKey = (a: string, b: string) => `${a}=>${b}`;
  for (const call of routeCallLog) {
    if (!call.result) continue;
    for (const id of call.result.ids) if (!merged.ids.includes(id)) merged.ids.push(id);
    for (let i = 0; i < call.result.ids.length; i += 1) {
      for (let j = 0; j < call.result.ids.length; j += 1) {
        const from = call.result.ids[i]!;
        const to = call.result.ids[j]!;
        const minutes = call.result.minutes[i]?.[j];
        const km = call.result.km[i]?.[j];
        if (typeof minutes === 'number' && Number.isFinite(minutes)) merged.minutes.set(pairKey(from, to), minutes);
        if (typeof km === 'number' && Number.isFinite(km)) merged.km.set(pairKey(from, to), km);
      }
    }
    for (const fp of call.result.failedPairs ?? []) {
      merged.failures.set(pairKey(fp.fromId, fp.toId), { reason: fp.reason, fromCall: call.callIndex });
    }
  }

  function legEvidence(fromId: string | null, toId: string | null) {
    if (!fromId || !toId) return { primaryMatrix: false, ledgerMinutes: null, ledgerKm: null, reason: null as string | null, source: 'unresolved_identity' };
    const primaryLeg = tryLeg(region.matrix, fromId, toId);
    const ledgerMinutes = merged.minutes.get(pairKey(fromId, toId)) ?? merged.minutes.get(pairKey(toId, fromId)) ?? null;
    const ledgerKm = merged.km.get(pairKey(fromId, toId)) ?? merged.km.get(pairKey(toId, fromId)) ?? null;
    const reason = merged.failures.get(pairKey(fromId, toId))?.reason ?? merged.failures.get(pairKey(toId, fromId))?.reason ?? null;
    return {
      primaryMatrix: primaryLeg !== null,
      primaryMinutes: primaryLeg?.minutes ?? null,
      primaryKm: primaryLeg?.km ?? null,
      ledgerMinutes,
      ledgerKm,
      reason,
    };
  }

  // Coordinates for a resolved base identity, for matching it against the
  // direct-confirmation call log (logged by coordinates, not ids) — from
  // the Discovery Board for a board-resolved base, or from the winning
  // geocoder candidate's own coordinates for a geocoder-resolved one.
  function coordinatesFor(resolvedId: string | null): { lat: number; lng: number } | null {
    if (!resolvedId) return null;
    const boardMatch = board.candidates.find((c) => c.place.id === resolvedId);
    if (boardMatch) return boardMatch.place.coordinates;
    for (const b of baseReport as Array<{ resolvedId?: string | null; candidates?: Array<{ selected?: boolean; coordinates: { lat: number; lng: number } }> | null }>) {
      if (b.resolvedId === resolvedId && b.candidates) {
        const selected = b.candidates.find((c) => c.selected);
        if (selected) return selected.coordinates;
      }
    }
    return null;
  }
  function confirmationFor(fromId: string | null, toId: string | null): ConfirmCallLog | null {
    const fromCoord = coordinatesFor(fromId);
    const toCoord = coordinatesFor(toId);
    if (!fromCoord || !toCoord) return null;
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    return (
      confirmCallLog.find(
        (c) => close(c.from.lat, fromCoord.lat) && close(c.from.lng, fromCoord.lng) && close(c.to.lat, toCoord.lat) && close(c.to.lng, toCoord.lng),
      ) ?? null
    );
  }

  const ceiling = region.matrix.mode === 'car' ? profile.transport.maxDailyDriveMinutes : profile.transport.maxDailyTransportMinutes;
  const mandatoryLegs = [];
  for (let i = 0; i < baseReport.length - 1; i += 1) {
    const from = baseReport[i];
    const to = baseReport[i + 1];
    const evidence = legEvidence(from?.resolvedId ?? null, to?.resolvedId ?? null);
    const matrixMeasuredMinutes = evidence.primaryMinutes ?? evidence.ledgerMinutes ?? null;
    const matrixOutcome =
      matrixMeasuredMinutes !== null
        ? 'measured'
        : evidence.reason === 'not_found'
          ? 'authoritative_no_route'
          : evidence.reason
            ? `unavailable (${evidence.reason})`
            : 'unavailable_or_unclassified';

    const confirmation = confirmationFor(from?.resolvedId ?? null, to?.resolvedId ?? null);
    const finalMinutes = matrixMeasuredMinutes ?? confirmation?.result?.minutes ?? null;
    const finalKm = matrixMeasuredMinutes !== null ? (evidence.primaryKm ?? evidence.ledgerKm) : (confirmation?.result?.km ?? null);

    let finalEvidenceClassification: string;
    if (matrixMeasuredMinutes !== null) finalEvidenceClassification = 'matrix_measured';
    else if (confirmation?.result?.found) finalEvidenceClassification = 'direct_route_confirmed';
    else if (confirmation && !confirmation.result?.found && confirmation.result?.reason === 'not_found') finalEvidenceClassification = 'authoritative_no_route';
    else if (confirmation) finalEvidenceClassification = `evidence_unavailable (${confirmation.result?.reason ?? 'unknown'})`;
    else finalEvidenceClassification = 'evidence_unavailable (no confirmation attempted)';

    mandatoryLegs.push({
      fromBase: from?.skeletonName,
      fromId: from?.resolvedId ?? null,
      toBase: to?.skeletonName,
      toId: to?.resolvedId ?? null,
      matrixOutcome,
      directConfirmationInvoked: confirmation !== null,
      directRouteOutcome: confirmation
        ? confirmation.result?.found
          ? 'found'
          : `not_found_or_unavailable (${confirmation.result?.reason ?? 'unknown'})`
        : null,
      directRouteMinutes: confirmation?.result?.minutes ?? null,
      directRouteKm: confirmation?.result?.km ?? null,
      directRouteLatencyMs: confirmation?.latencyMs ?? null,
      measuredMinutes: finalMinutes,
      measuredKm: finalKm,
      finalEvidenceClassification,
      hardCeilingMinutes: ceiling,
      feasible: finalMinutes === null ? null : finalMinutes <= ceiling,
    });
  }

  // --- Provider diagnostics summary -------------------------------------------
  let totalCellsAttempted = 0;
  let totalSuccessfulCells = 0;
  let totalNoRouteCells = 0;
  let totalUnavailableCells = 0;
  const reasonCounts: Record<string, number> = {};
  for (const call of routeCallLog) {
    if (!call.result) continue;
    for (const row of call.result.minutes) for (const v of row) if (Number.isFinite(v) && v !== 0) totalSuccessfulCells += 1;
    for (const fp of call.result.failedPairs ?? []) {
      totalCellsAttempted += 1;
      reasonCounts[fp.reason] = (reasonCounts[fp.reason] ?? 0) + 1;
      if (fp.reason === 'not_found') totalNoRouteCells += 1;
      else totalUnavailableCells += 1;
    }
  }
  totalCellsAttempted += totalSuccessfulCells;

  const routingReport = {
    totalRoutingRequests: routeCallLog.length,
    largestRequestPointCount: routeCallLog.length > 0 ? Math.max(...routeCallLog.map((c) => c.requestedPointCount)) : 0,
    totalCellsAcrossAllRequests: routeCallLog.reduce((sum, c) => sum + c.requestedCellCount, 0),
    totalCellsAttempted,
    totalSuccessfulCells,
    totalNoRouteCells,
    totalUnavailableCells,
    reasonCounts,
    perCall: routeCallLog.map((c) => ({
      callIndex: c.callIndex,
      requestedPointCount: c.requestedPointCount,
      requestedCellCount: c.requestedCellCount,
      latencyMs: c.latencyMs,
      returnedPointCount: c.result?.ids.length ?? 0,
      failedPairCount: c.result?.failedPairs?.length ?? 0,
      requestedPointIds: c.requestedPointIds,
    })),
    comparisonToPriorDesign: {
      priorDesignPointCount: 21,
      priorDesignCellCount: 441,
      thisRunLargestRequestPointCount: routeCallLog.length > 0 ? Math.max(...routeCallLog.map((c) => c.requestedPointCount)) : 0,
      thisRunTotalCellsAcrossAllRequests: routeCallLog.reduce((sum, c) => sum + c.requestedCellCount, 0),
    },
  };

  writeFileSync(path.join(OUT_DIR, `base-resolution-report-${SUFFIX}.json`), JSON.stringify(baseReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `anchor-resolution-report-${SUFFIX}.json`), JSON.stringify(anchorReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `mandatory-legs-report-${SUFFIX}.json`), JSON.stringify(mandatoryLegs, null, 2));
  writeFileSync(path.join(OUT_DIR, `routing-diagnostics-${SUFFIX}.json`), JSON.stringify(routingReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `confirm-route-calls-${SUFFIX}.json`), JSON.stringify(confirmCallLog, null, 2));
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
    matrixRoutingCalls: routeCallLog.length,
    matrixRoutingMs: Math.round(routingMs),
    directConfirmationCalls: confirmCallLog.length,
    directConfirmationMs: Math.round(confirmMs),
    modelCalls: 0,
    timingsMs: timings,
    totalWallMs,
    outcome: result.ok ? 'itinerary' : 'repair_issue',
    repairIssueKind: result.ok ? null : result.repairIssue.kind,
    deviationKinds: result.ok ? result.deviations.map((d) => d.kind) : [],
  };
  writeFileSync(path.join(OUT_DIR, `diagnostics-${SUFFIX}.json`), JSON.stringify(diagnostics, null, 2));

  console.log('\n=== OUTCOME:', result.ok ? 'PRODUCTION ITINERARY' : 'SkeletonRepairIssue', '===');
  console.log(JSON.stringify(diagnostics, null, 2));
  if (!result.ok) console.log(JSON.stringify(result.repairIssue, null, 2));
  console.log('\n=== BASE RESOLUTIONS ===');
  console.log(JSON.stringify(baseReport, null, 2));
  console.log('\n=== MANDATORY LEGS (PHASE A) ===');
  console.log(JSON.stringify(mandatoryLegs, null, 2));
  console.log('\n=== ROUTING DIAGNOSTICS ===');
  console.log(JSON.stringify(routingReport, null, 2));
  console.log('\n=== DIRECT ROUTE CONFIRMATION CALLS ===');
  console.log(JSON.stringify(confirmCallLog, null, 2));
  if (!result.ok) {
    console.log('\n=== DEVIATIONS: none — plan did not reach ok ===');
  } else {
    console.log('\n=== DEVIATIONS ===');
    console.log(JSON.stringify(result.deviations, null, 2));
  }
  console.log('\nAnthropic calls: 0');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
