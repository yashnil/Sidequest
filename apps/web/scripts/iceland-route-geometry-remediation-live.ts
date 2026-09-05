/*
 * THE ONE LIVE ICELAND RUN — ROUTE-FOLLOWING CORRIDOR REMEDIATION +
 * PRODUCTION HYDRATION, AGAINST THE REAL CONTROLLED LOCAL VALHALLA INSTANCE,
 * REAL NOMINATIM, AND REAL (PUBLIC) OVERPASS. ZERO ANTHROPIC CALLS.
 *
 * Exercises the exact real production path, once: the frozen TripSkeleton ->
 * planFromSkeletonForTrip()'s own assembly -> resolveSkeletonBase() (real
 * Nominatim geocoding) -> assessRelocationFeasibility() (mandatory-leg
 * routing, then the corridor remedy tier — now route-following, not
 * straight-chord — when the board has nothing) -> Phase B (bounded per-day
 * legs) -> planTrip() -> real validation. Calls the same real functions
 * `planFromSkeletonForTrip()` calls internally, inlined only so every call
 * is logged for this run's diagnostics — not a different code path, the
 * same one, observed.
 *
 * `SIDEQUEST_POI_PROVIDER=overpass` is set for this process only (never
 * written to `.env.local`) so the newly-built bounded settlement search is
 * actually exercised — the load-bearing capability this run exists to test.
 *
 * `createOpenProviders({ maxModelCalls: 0 })` — the same mechanism every
 * prior script in this arc has used. No skeleton generation, no skeleton
 * repair, no model call anywhere in this script.
 *
 * Run with (from apps/web):
 *   npx tsx scripts/iceland-route-geometry-remediation-live.ts
 */
process.env.SIDEQUEST_POI_PROVIDER = 'overpass';

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
const TRIP_ID = '64bc0495-370f-42ad-950d-12d1c0a10317';
const SUFFIX = 'route-geometry-remediation-live';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const EARTH_RADIUS_KM = 6371.0088;
function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** Cumulative route length + the fraction-of-length nearest to `point` — observational only, mirrors relocation-corridor.ts's own math for reporting, never used to decide feasibility. */
function routeLengthKm(geometry: readonly { lat: number; lng: number }[]): number {
  let total = 0;
  for (let i = 0; i < geometry.length - 1; i += 1) total += haversineKm(geometry[i]!, geometry[i + 1]!);
  return total;
}
function nearestFractionAlongRoute(geometry: readonly { lat: number; lng: number }[], point: { lat: number; lng: number }): { fraction: number; distanceFromRouteKm: number } {
  const total = routeLengthKm(geometry);
  if (total <= 0 || geometry.length < 2) return { fraction: 0, distanceFromRouteKm: geometry[0] ? haversineKm(geometry[0], point) : Number.NaN };
  let travelled = 0;
  let best = { fraction: 0, distanceFromRouteKm: Number.POSITIVE_INFINITY };
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const a = geometry[i]!;
    const b = geometry[i + 1]!;
    const segLen = haversineKm(a, b);
    const steps = Math.max(1, Math.round(segLen / 2)); // sample every ~2km along this segment for a close approximation
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const candidate = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      const d = haversineKm(candidate, point);
      if (d < best.distanceFromRouteKm) {
        best = { fraction: (travelled + segLen * t) / total, distanceFromRouteKm: d };
      }
    }
    travelled += segLen;
  }
  return best;
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

  console.log('=== RUNTIME STATE ===');
  console.log('HEAD', head);
  console.log('diff sha256 (before)', diffHashBefore);
  console.log('skeleton sha256 (before)', skeletonShaBefore);
  console.log('SIDEQUEST_ROUTES_URL', process.env.SIDEQUEST_ROUTES_URL);
  console.log('SIDEQUEST_POI_PROVIDER (forced for this process)', process.env.SIDEQUEST_POI_PROVIDER);

  const { isPoiProviderEnabled } = await import('../src/lib/providers/switches');
  console.log('isPoiProviderEnabled()', isPoiProviderEnabled());

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
  console.log('Board candidates with relationship=base:', board.candidates.filter((c) => c.place.relationship === 'base').length);

  const {
    productionGeocodeLocality,
    productionRouteMatrix,
    productionConfirmRoute,
    productionFindNearbyLocalities,
    productionDestinationScope,
    productionSubregionGeometries,
  } = await import('../src/lib/planning/skeleton-orchestrator');
  const { fetchSettlements } = await import('../src/lib/providers/overpass');
  const { createOpenProviders } = await import('../src/lib/providers/live');
  const { providers } = createOpenProviders({ maxModelCalls: 0 });

  // --- A single, unified, chronological call log — every real provider call
  // --- this run makes, in the order it happens. -----------------------------
  interface CallLogEntry {
    seq: number;
    kind: 'geocode' | 'matrix' | 'confirm' | 'findNearbyLocalities' | 'overpassDiagnosticProbe';
    at: number;
    latencyMs: number;
    input: unknown;
    output: unknown;
  }
  const callLog: CallLogEntry[] = [];
  let seq = 0;

  /**
   * INCREMENTAL CHECKPOINT — WRITTEN AFTER EVERY REAL PROVIDER CALL, NEVER
   * ONLY AT THE END.
   *
   * The prior round's run proved the cost of not doing this: real Nominatim,
   * real Overpass and real Valhalla evidence for both remediated relocations
   * existed only in this process's own memory, and a downstream `planTrip()`
   * crash (unrelated to any of that evidence) discarded all of it, since
   * every `writeFileSync` in this script previously happened only after
   * `planFromSkeleton()` returned. Remediation itself (base resolution,
   * mandatory-leg measurement, route-geometry acquisition, corridor search,
   * candidate confirmation, night-donor accounting) is *entirely* real
   * provider calls this script's own wrappers already observe, and it all
   * completes before `planTrip()` is ever entered — so a checkpoint written
   * after each observed call, overwritten in place rather than accumulated,
   * is by construction always current as of the last real call made,
   * whatever runs afterward. This is a diagnostic-harness change only —
   * production planning is not touched, and `planFromSkeleton()` is still
   * called exactly once, exactly as before.
   */
  function writeCheckpoint(): void {
    writeFileSync(
      path.join(OUT_DIR, `checkpoint-${SUFFIX}.json`),
      JSON.stringify(
        {
          note:
            'Incremental checkpoint, overwritten after every real provider call this run makes. Current as of the last call below, regardless of what runs afterward (including planTrip(), which makes no provider calls of its own).',
          wallMsSinceStart: Math.round(performance.now() - wallStart),
          callsSoFar: callLog.length,
          callLog,
        },
        null,
        2,
      ),
    );
  }

  let geocoderCalls = 0;
  let geocoderMs = 0;
  const geocoderQueries: string[] = [];
  const observedGeocoder = async (query: string) => {
    geocoderCalls += 1;
    geocoderQueries.push(query);
    const t = performance.now();
    const out = await productionGeocodeLocality(query);
    const latencyMs = performance.now() - t;
    geocoderMs += latencyMs;
    seq += 1;
    callLog.push({ seq, kind: 'geocode', at: Math.round(t - wallStart), latencyMs: Math.round(latencyMs), input: { query }, output: out });
    writeCheckpoint();
    return out;
  };

  let matrixCalls = 0;
  let matrixMs = 0;
  const observedRouteMatrix = async (points: readonly { id: string; lat: number; lng: number }[]) => {
    matrixCalls += 1;
    const t = performance.now();
    const out = await productionRouteMatrix(providers.routing, region.matrix.mode, points);
    const latencyMs = performance.now() - t;
    matrixMs += latencyMs;
    seq += 1;
    callLog.push({ seq, kind: 'matrix', at: Math.round(t - wallStart), latencyMs: Math.round(latencyMs), input: { pointIds: points.map((p) => p.id) }, output: out });
    writeCheckpoint();
    return out;
  };

  let confirmCalls = 0;
  let confirmMs = 0;
  const observedConfirmRoute = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
    confirmCalls += 1;
    const t = performance.now();
    const out = await productionConfirmRoute(providers.routing, region.matrix.mode, from, to);
    const latencyMs = performance.now() - t;
    confirmMs += latencyMs;
    seq += 1;
    callLog.push({ seq, kind: 'confirm', at: Math.round(t - wallStart), latencyMs: Math.round(latencyMs), input: { from, to }, output: out });
    writeCheckpoint();
    return out;
  };

  // --- The settlement-search capability actually wired into remediation ----
  // --- (the real decision-making path), plus a side, diagnostic-only raw ----
  // --- Overpass probe at the same box, purely so this report can say for ----
  // --- certain whether a given answer came from Overpass or the reverse-----
  // --- geocode fallback, without altering what the algorithm itself used. --
  let searchCalls = 0;
  let searchMs = 0;
  let overpassProbeCalls = 0;
  let overpassProbeMs = 0;
  let overpassProbeElements = 0;
  let overpassProbeFailures = 0;
  const localityCoordinates = new Map<string, { lat: number; lng: number; entityType?: string; name: string }>();
  function boxAround(point: { lat: number; lng: number }, radiusKm: number) {
    const latSpan = radiusKm / 111;
    const lngSpan = radiusKm / (111 * Math.max(0.1, Math.cos((point.lat * Math.PI) / 180)));
    return { south: point.lat - latSpan, north: point.lat + latSpan, west: point.lng - lngSpan, east: point.lng + lngSpan };
  }
  const observedFindNearbyLocalities = async (point: { lat: number; lng: number }, radiusKm: number) => {
    searchCalls += 1;
    const t = performance.now();
    const out = await productionFindNearbyLocalities(point, radiusKm);
    const latencyMs = performance.now() - t;
    searchMs += latencyMs;
    for (const locality of out) localityCoordinates.set(locality.sourceId, { lat: locality.lat, lng: locality.lng, entityType: locality.entityType, name: locality.name });

    // Diagnostic-only raw Overpass probe, same box, never influencing the
    // value returned to the algorithm above.
    let probeElements: number | null = null;
    let probeError: string | null = null;
    const tProbe = performance.now();
    try {
      const probe = await fetchSettlements(boxAround(point, radiusKm), { limit: 20 });
      probeElements = probe.elements.length;
      overpassProbeElements += probeElements;
    } catch (error) {
      probeError = error instanceof Error ? error.message : String(error);
      overpassProbeFailures += 1;
    }
    const probeLatencyMs = performance.now() - tProbe;
    overpassProbeCalls += 1;
    overpassProbeMs += probeLatencyMs;
    seq += 1;
    callLog.push({
      seq,
      kind: 'overpassDiagnosticProbe',
      at: Math.round(tProbe - wallStart),
      latencyMs: Math.round(probeLatencyMs),
      input: { point, radiusKm },
      output: { elements: probeElements, error: probeError },
    });

    seq += 1;
    callLog.push({
      seq,
      kind: 'findNearbyLocalities',
      at: Math.round(t - wallStart),
      latencyMs: Math.round(latencyMs),
      input: { point, radiusKm },
      output: out,
      // attributedTo is an honest inference, not the algorithm's own record:
      // Overpass returns as many as MAX_SETTLEMENTS_PER_POINT (5); the
      // fallback returns at most 1. >1 result is conclusive Overpass;
      // exactly 0 or 1 is reported against the probe's own element count.
    } as CallLogEntry);
    writeCheckpoint();
    const attributedTo = out.length > 1 ? 'overpass' : probeElements !== null && probeElements > 0 ? 'overpass_or_fallback_ambiguous_both_nonempty' : probeElements === 0 ? 'fallback_reverse_geocode' : probeError ? 'fallback_reverse_geocode_overpass_probe_failed' : 'unknown';
    console.log(`  findNearbyLocalities(${point.lat.toFixed(4)},${point.lng.toFixed(4)}, r=${radiusKm}) -> ${out.length} result(s) [${out.map((l) => l.name).join(', ')}] | overpass probe: ${probeElements ?? `error: ${probeError}`} elements | attributed: ${attributedTo}`);
    return out;
  };

  const destinationScope = productionDestinationScope(region.compiled);
  const subregionGeometries = productionSubregionGeometries(region.compiled);
  console.log('Destination scope:', JSON.stringify(destinationScope));

  const { planFromSkeleton, resolveAnchorPlace } = await import('../src/lib/planning/skeleton-adapter');
  const { tryLeg } = await import('@sidequest/geo');

  console.log('\n=== RUNNING THE ONE PRODUCTION HYDRATION CALL (0 Anthropic calls) ===');
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
      findNearbyLocalities: observedFindNearbyLocalities,
      destinationScope,
      subregionGeometries,
    },
  });
  mark('adapterAndPlanTripMs', tAdapter);

  console.log('\nGeocoder calls:', geocoderCalls, '| Matrix calls:', matrixCalls, '| Direct confirm calls:', confirmCalls, '| findNearbyLocalities calls:', searchCalls, '| Overpass diagnostic probes:', overpassProbeCalls);
  console.log(`Bases resolved (original skeleton bases): ${result.baseResolutions.filter((r) => r.resolvedId).length}/${result.baseResolutions.length}`);

  writeFileSync(path.join(OUT_DIR, `unified-call-log-${SUFFIX}.json`), JSON.stringify(callLog, null, 2));

  // --- Item 2: complete original route, all four mandatory legs ------------
  const baseReport = (skeleton.bases as { id: string; name: string; nights: number }[]).map((base) => {
    const record = result.baseResolutions.find((r) => r.skeletonBaseId === base.id);
    return { skeletonBaseId: base.id, skeletonName: base.name, nights: base.nights, ...record };
  });

  interface MergedLedger {
    ids: string[];
    minutes: Map<string, number>;
    km: Map<string, number>;
  }
  const merged: MergedLedger = { ids: [], minutes: new Map(), km: new Map() };
  const pairKey = (a: string, b: string) => `${a}=>${b}`;
  for (const entry of callLog) {
    if (entry.kind !== 'matrix') continue;
    const out = entry.output as { ids: string[]; minutes: number[][]; km: number[][] } | null;
    if (!out) continue;
    for (const id of out.ids) if (!merged.ids.includes(id)) merged.ids.push(id);
    for (let i = 0; i < out.ids.length; i += 1) {
      for (let j = 0; j < out.ids.length; j += 1) {
        const from = out.ids[i]!;
        const to = out.ids[j]!;
        const minutes = out.minutes[i]?.[j];
        const km = out.km[i]?.[j];
        if (typeof minutes === 'number' && Number.isFinite(minutes)) merged.minutes.set(pairKey(from, to), minutes);
        if (typeof km === 'number' && Number.isFinite(km)) merged.km.set(pairKey(from, to), km);
      }
    }
  }
  function coordinatesFor(resolvedId: string | null): { lat: number; lng: number } | null {
    if (!resolvedId) return null;
    const boardMatch = board.candidates.find((c) => c.place.id === resolvedId);
    if (boardMatch) return boardMatch.place.coordinates;
    const locality = localityCoordinates.get(resolvedId);
    if (locality) return { lat: locality.lat, lng: locality.lng };
    for (const b of baseReport as unknown as { resolvedId?: string | null; candidates?: { selected?: boolean; coordinates: { lat: number; lng: number } }[] | null }[]) {
      if (b.resolvedId === resolvedId && b.candidates) {
        const selected = b.candidates.find((c) => c.selected);
        if (selected) return selected.coordinates;
      }
    }
    return null;
  }
  function confirmationFor(fromCoord: { lat: number; lng: number } | null, toCoord: { lat: number; lng: number } | null): CallLogEntry | null {
    if (!fromCoord || !toCoord) return null;
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    return (
      callLog.find((c) => {
        if (c.kind !== 'confirm') return false;
        const inp = c.input as { from: { lat: number; lng: number }; to: { lat: number; lng: number } };
        return close(inp.from.lat, fromCoord.lat) && close(inp.from.lng, fromCoord.lng) && close(inp.to.lat, toCoord.lat) && close(inp.to.lng, toCoord.lng);
      }) ?? null
    );
  }

  const ceiling = region.matrix.mode === 'car' ? profile.transport.maxDailyDriveMinutes : profile.transport.maxDailyTransportMinutes;
  const originalRouteLegs: unknown[] = [];
  for (let i = 0; i < baseReport.length - 1; i += 1) {
    const from = baseReport[i]!;
    const to = baseReport[i + 1]!;
    const fromCoord = coordinatesFor(from.resolvedId ?? null);
    const toCoord = coordinatesFor(to.resolvedId ?? null);
    const primaryLeg = from.resolvedId && to.resolvedId ? tryLeg(region.matrix, from.resolvedId, to.resolvedId) : null;
    const ledgerMinutes = from.resolvedId && to.resolvedId ? (merged.minutes.get(pairKey(from.resolvedId, to.resolvedId)) ?? merged.minutes.get(pairKey(to.resolvedId, from.resolvedId)) ?? null) : null;
    const matrixMinutes = primaryLeg?.minutes ?? ledgerMinutes;
    const confirmation = confirmationFor(fromCoord, toCoord);
    const confirmOutput = confirmation?.output as { found: boolean; minutes: number | null; km: number | null; reason?: string; geometry?: { lat: number; lng: number }[] } | undefined;
    const finalMinutes = matrixMinutes ?? confirmOutput?.minutes ?? null;
    const finalKm = matrixMinutes !== null && matrixMinutes !== undefined ? (primaryLeg?.km ?? merged.km.get(pairKey(from.resolvedId!, to.resolvedId!)) ?? null) : (confirmOutput?.km ?? null);
    let evidenceSource: string;
    if (matrixMinutes !== null && matrixMinutes !== undefined) evidenceSource = 'matrix';
    else if (confirmation) evidenceSource = confirmOutput?.found ? 'direct_route_confirmation' : 'direct_route_confirmation_no_route';
    else evidenceSource = 'unmeasured';
    originalRouteLegs.push({
      leg: `${from.skeletonName} → ${to.skeletonName}`,
      fromResolvedId: from.resolvedId ?? null,
      toResolvedId: to.resolvedId ?? null,
      minutes: finalMinutes,
      km: finalKm,
      evidenceSource,
      hardCeilingMinutes: ceiling,
      pass: finalMinutes === null ? null : finalMinutes <= ceiling,
      routeGeometryAvailable: Boolean(confirmOutput?.geometry && confirmOutput.geometry.length >= 2),
      routeGeometryPointCount: confirmOutput?.geometry?.length ?? null,
      routedPathDistanceKm: confirmOutput?.geometry && confirmOutput.geometry.length >= 2 ? Math.round(routeLengthKm(confirmOutput.geometry) * 10) / 10 : null,
    });
  }
  console.log('\n=== ITEM 2: COMPLETE ORIGINAL ROUTE (all 4 mandatory legs) ===');
  console.log(JSON.stringify(originalRouteLegs, null, 2));
  writeFileSync(path.join(OUT_DIR, `original-route-complete-${SUFFIX}.json`), JSON.stringify(originalRouteLegs, null, 2));

  // --- Item 3: route-following corridor search — reconstructed from the ----
  // --- findNearbyLocalities call log, with each sample point's approximate -
  // --- position along whichever leg's route geometry was acquired. ---------
  const searchEntries = callLog.filter((c) => c.kind === 'findNearbyLocalities');
  const corridorSearchReport = searchEntries.map((entry) => {
    const input = entry.input as { point: { lat: number; lng: number }; radiusKm: number };
    // Find the geometry (if any) acquired for the leg whose from/to endpoints this sample point sits between.
    const geometryEntries = callLog.filter((c) => c.kind === 'confirm' && (c.output as { geometry?: unknown[] })?.geometry);
    let nearestGeometryLegOutput: { geometry: { lat: number; lng: number }[] } | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const g of geometryEntries) {
      const out = g.output as { geometry: { lat: number; lng: number }[] };
      const proj = nearestFractionAlongRoute(out.geometry, input.point);
      if (proj.distanceFromRouteKm < bestDistance) {
        bestDistance = proj.distanceFromRouteKm;
        nearestGeometryLegOutput = out;
      }
    }
    const projection = nearestGeometryLegOutput ? nearestFractionAlongRoute(nearestGeometryLegOutput.geometry, input.point) : null;
    return {
      point: input.point,
      searchRadiusKm: input.radiusKm,
      resultsCount: (entry.output as unknown[]).length,
      resultNames: (entry.output as { name: string }[]).map((l) => l.name),
      approxFractionAlongNearestRouteGeometry: projection ? Math.round(projection.fraction * 1000) / 1000 : null,
      distanceFromRoutedPathKm: projection ? Math.round(projection.distanceFromRouteKm * 10) / 10 : null,
    };
  });
  console.log('\n=== ITEM 3: CORRIDOR SEARCH POSITIONS (route-following, reconstructed) ===');
  console.log(JSON.stringify(corridorSearchReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `corridor-search-positions-${SUFFIX}.json`), JSON.stringify(corridorSearchReport, null, 2));
  writeFileSync(
    path.join(OUT_DIR, `overpass-diagnostic-probes-${SUFFIX}.json`),
    JSON.stringify(callLog.filter((c) => c.kind === 'overpassDiagnosticProbe'), null, 2),
  );

  // --- Deviations recorded by the real remediation pass ---------------------
  const deviations = result.ok ? result.deviations : [];
  console.log('\n=== DEVIATIONS (the corridor/board remedy record, if the route is feasible) ===');
  console.log(JSON.stringify(deviations, null, 2));

  writeFileSync(path.join(OUT_DIR, `base-resolution-report-${SUFFIX}.json`), JSON.stringify(baseReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `production-plan-result-${SUFFIX}.json`), JSON.stringify(result, null, 2));

  console.log('\n=== BEFORE: ORIGINAL SKELETON BASE SEQUENCE ===');
  for (const b of skeleton.bases as { name: string; nights: number }[]) console.log(`  ${b.name} — ${b.nights} night(s)`);
  const originalTotalNights = (skeleton.bases as { nights: number }[]).reduce((s, b) => s + b.nights, 0);
  console.log('  total nights:', originalTotalNights);

  let outcome: 'A' | 'B' | 'C' | 'D' | 'E';
  if (!result.ok) {
    console.log('\n=== AFTER: DETERMINISTIC REMEDIATION DID NOT PRODUCE A FEASIBLE ROUTE ===');
    console.log(JSON.stringify(result.repairIssue, null, 2));
    const anyUnresolvableIdentity = result.baseResolutions.some((b) => !b.resolvedId) || result.repairIssue.kind === 'base_identity_ambiguous';
    const routingEvidenceGap = result.repairIssue.kind === 'base_unroutable' || result.repairIssue.kind === 'routing_evidence_unavailable';
    const plannerLevelFailure = result.repairIssue.kind === 'planner_refused';
    outcome = plannerLevelFailure ? 'E' : anyUnresolvableIdentity || routingEvidenceGap ? 'C' : 'B';
    writeFileSync(path.join(OUT_DIR, `repair-issue-${SUFFIX}.json`), JSON.stringify(result.repairIssue, null, 2));
  } else {
    console.log('\n=== AFTER: DETERMINISTIC REMEDIATION SUCCEEDED — ITINERARY PRODUCED ===');
    const dayBaseSeq: string[] = [];
    for (const day of result.itinerary.days) {
      if (dayBaseSeq[dayBaseSeq.length - 1] !== day.baseId) dayBaseSeq.push(day.baseId);
    }
    console.log('Distinct base sequence:', dayBaseSeq.join(' -> '));
    console.log('Days scheduled:', result.itinerary.days.length, '(must be 13)');

    // --- Item 6: independent re-measurement of every consecutive relocation
    // --- in the REMEDIATED sequence, from real calls already made this run.
    const remediatedLegs: unknown[] = [];
    for (let i = 0; i < dayBaseSeq.length - 1; i += 1) {
      const fromId = dayBaseSeq[i]!;
      const toId = dayBaseSeq[i + 1]!;
      const fromCoord = coordinatesFor(fromId);
      const toCoord = coordinatesFor(toId);
      const primaryLeg = tryLeg(region.matrix, fromId, toId);
      const ledgerMinutes = merged.minutes.get(pairKey(fromId, toId)) ?? merged.minutes.get(pairKey(toId, fromId)) ?? null;
      const matrixMinutes = primaryLeg?.minutes ?? ledgerMinutes;
      const confirmation = confirmationFor(fromCoord, toCoord) ?? confirmationFor(toCoord, fromCoord);
      const confirmOutput = confirmation?.output as { found: boolean; minutes: number | null; km: number | null } | undefined;
      const minutes = matrixMinutes ?? confirmOutput?.minutes ?? null;
      remediatedLegs.push({
        leg: `${fromId} → ${toId}`,
        minutes,
        hardCeilingMinutes: ceiling,
        pass: minutes === null ? null : minutes <= ceiling,
        evidence: matrixMinutes !== null && matrixMinutes !== undefined ? 'matrix' : confirmation ? 'direct_route_confirmation' : 'unmeasured',
      });
    }
    console.log('\n=== ITEM 6: INDEPENDENT RE-MEASUREMENT OF THE REMEDIATED SEQUENCE ===');
    console.log(JSON.stringify(remediatedLegs, null, 2));
    writeFileSync(path.join(OUT_DIR, `remediated-route-remeasured-${SUFFIX}.json`), JSON.stringify(remediatedLegs, null, 2));
    const allRemediatedLegsPass = remediatedLegs.every((l) => (l as { pass: boolean | null }).pass === true);
    console.log('All remediated legs independently verified ≤', ceiling, 'min:', allRemediatedLegsPass);

    // Night accounting.
    const nightsByBase = new Map<string, number>();
    for (const day of result.itinerary.days) nightsByBase.set(day.baseId, (nightsByBase.get(day.baseId) ?? 0) + 1);
    // Nights are day-counts per base id; a base visited on non-consecutive
    // day ranges (a loop's return) is summed correctly since Map keys by id.
    const _totalNightsAfter = result.itinerary.days.length; // one calendar night per scheduled day, by this skeleton's own convention
    console.log('Distinct bases after remediation:', dayBaseSeq.length, '| total scheduled days:', result.itinerary.days.length);

    // Anchor retention/drop reporting (unchanged breadth — 17/27 known).
    const anchorUnroutableIds = new Set(deviations.filter((d) => d.kind === 'anchor_unroutable').map((d) => d.replacementPlaceId));
    const anchorReport: unknown[] = [];
    for (const day of skeleton.days as { dayNumber: number; anchors: { placeIndex: number; role: string }[] }[]) {
      for (const anchor of day.anchors) {
        const evidencePlace = (skeletonPacket.places as { index: number; name: string; lat: number; lng: number }[]).find((p) => p.index === anchor.placeIndex);
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
          resolvedPlaceName: resolvedAnchor.place ? (resolvedAnchor.place.names?.display ?? resolvedAnchor.place.name) : null,
          inPrimaryMatrix: inMatrix,
          classification,
        });
      }
    }
    const anchorsResolved = anchorReport.filter((a) => (a as { classification?: string }).classification === 'resolved').length;
    console.log('Anchors resolved:', anchorsResolved, '/', anchorReport.length);
    writeFileSync(path.join(OUT_DIR, `anchor-resolution-report-${SUFFIX}.json`), JSON.stringify(anchorReport, null, 2));

    writeFileSync(path.join(OUT_DIR, `itinerary-${SUFFIX}.json`), JSON.stringify(result.itinerary, null, 2));
    writeFileSync(path.join(OUT_DIR, `readiness-${SUFFIX}.json`), JSON.stringify(result.readiness, null, 2));

    const evidenceBreadthRatio = anchorsResolved / Math.max(1, anchorReport.length);
    outcome = !allRemediatedLegsPass ? 'E' : evidenceBreadthRatio < 0.7 ? 'D' : 'A';

    const lines: string[] = [];
    lines.push('# Iceland — deterministic route-geometry-remediated itinerary (founder-readable)');
    lines.push('');
    lines.push('Produced entirely deterministically — zero Anthropic calls — after route-following relocation-corridor remediation resolved the route.');
    lines.push('');
    lines.push('## Route');
    for (const id of dayBaseSeq) lines.push(`- ${id} (${nightsByBase.get(id) ?? 0} night(s))`);
    lines.push('');
    lines.push('## Days');
    for (const day of result.itinerary.days) {
      lines.push(`### ${day.date} — ${day.baseId}`);
      for (const item of day.items) lines.push(`- ${item.startTime ?? ''} ${item.title ?? item.placeId ?? ''}`.trim());
      lines.push('');
    }
    if (deviations.length > 0) {
      lines.push('## Deviations from the original skeleton');
      for (const d of deviations) lines.push(`- [${d.kind}] ${d.detail}`);
    }
    writeFileSync(path.join(OUT_DIR, `founder-readable-itinerary-${SUFFIX}.md`), lines.join('\n'));
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
    poiProviderEnabled: isPoiProviderEnabled(),
    geocoderCalls,
    geocoderMs: Math.round(geocoderMs),
    matrixRoutingCalls: matrixCalls,
    matrixRoutingMs: Math.round(matrixMs),
    directConfirmationCalls: confirmCalls,
    directConfirmationMs: Math.round(confirmMs),
    findNearbyLocalitiesCalls: searchCalls,
    findNearbyLocalitiesMs: Math.round(searchMs),
    overpassDiagnosticProbeCalls: overpassProbeCalls,
    overpassDiagnosticProbeMs: Math.round(overpassProbeMs),
    overpassDiagnosticProbeTotalElements: overpassProbeElements,
    overpassDiagnosticProbeFailures: overpassProbeFailures,
    modelCalls: 0,
    timingsMs: timings,
    totalWallMs,
    resultOk: result.ok,
    repairIssueKind: result.ok ? null : result.repairIssue.kind,
    deviationKinds: result.ok ? deviations.map((d) => d.kind) : [],
    outcome,
  };
  writeFileSync(path.join(OUT_DIR, `diagnostics-${SUFFIX}.json`), JSON.stringify(diagnostics, null, 2));

  console.log('\n=== DIAGNOSTICS ===');
  console.log(JSON.stringify(diagnostics, null, 2));
  console.log('\n=== OUTCOME:', outcome, '===');
  console.log('\nAnthropic calls: 0');
}

main().catch((error) => {
  console.error(error);
  console.error(
    `\nA crash after this point does not lose the run's own provider evidence: checkpoint-${SUFFIX}.json in ${OUT_DIR} holds every real geocode/matrix/confirm/findNearbyLocalities call made up to the last one before this failure, refreshed after each one.`,
  );
  process.exit(1);
});
