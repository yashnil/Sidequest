/*
 * THE ONE LIVE ICELAND PRODUCTION-HYDRATION RUN — DETERMINISTIC
 * RELOCATION-CORRIDOR REMEDIATION, AGAINST THE REAL CONTROLLED LOCAL
 * VALHALLA INSTANCE AND REAL NOMINATIM. ZERO ANTHROPIC CALLS.
 *
 * Exercises the exact real production path, once: TripSkeleton ->
 * planFromSkeletonForTrip()'s own assembly -> resolveSkeletonBase() (real
 * Nominatim geocoding) -> assessRelocationFeasibility() (mandatory-leg
 * routing, then — new this round — the corridor remedy tier when the board
 * has nothing) -> Phase B (bounded per-day legs) -> planTrip() -> real
 * validation. Calls the same real functions `planFromSkeletonForTrip()`
 * calls internally, inlined only so every call is logged for this run's
 * diagnostics — not a different code path, the same one, observed.
 *
 * `createOpenProviders({ maxModelCalls: 0 })` — the same mechanism every
 * prior script in this arc has used. No skeleton generation, no skeleton
 * repair, no model call anywhere in this script.
 *
 * Run with (from apps/web):
 *   npx tsx scripts/iceland-corridor-remediation-live.ts
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
const TRIP_ID = '64bc0495-370f-42ad-950d-12d1c0a10317';
const SUFFIX = 'corridor-remediation-live';

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
  console.log('Board candidates with relationship=base:', board.candidates.filter((c) => c.place.relationship === 'base').length);
  console.log('Compiled places with relationship=base:', region.places.filter((p) => p.relationship === 'base').length, 'of', region.places.length, 'total');

  const {
    productionGeocodeLocality,
    productionRouteMatrix,
    productionConfirmRoute,
    productionReverseGeocodeLocality,
    productionDestinationScope,
    productionSubregionGeometries,
  } = await import('../src/lib/planning/skeleton-orchestrator');
  const { createOpenProviders } = await import('../src/lib/providers/live');
  const { providers } = createOpenProviders({ maxModelCalls: 0 });

  // --- A single, unified, chronological call log — every real provider call
  // --- this run makes, in the order it happens, so the corridor search can
  // --- be reconstructed after the fact without guessing. -------------------
  interface CallLogEntry {
    seq: number;
    kind: 'geocode' | 'matrix' | 'confirm' | 'reverseGeocode';
    at: number; // ms since wallStart
    latencyMs: number;
    input: unknown;
    output: unknown;
  }
  const callLog: CallLogEntry[] = [];
  let seq = 0;

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
    callLog.push({
      seq,
      kind: 'matrix',
      at: Math.round(t - wallStart),
      latencyMs: Math.round(latencyMs),
      input: { pointIds: points.map((p) => p.id) },
      output: out,
    });
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
    return out;
  };

  let reverseGeocodeCalls = 0;
  let reverseGeocodeMs = 0;
  const observedReverseGeocode = async (point: { lat: number; lng: number }) => {
    reverseGeocodeCalls += 1;
    const t = performance.now();
    const out = await productionReverseGeocodeLocality(point);
    const latencyMs = performance.now() - t;
    reverseGeocodeMs += latencyMs;
    seq += 1;
    callLog.push({ seq, kind: 'reverseGeocode', at: Math.round(t - wallStart), latencyMs: Math.round(latencyMs), input: { point }, output: out });
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
      reverseGeocode: observedReverseGeocode,
      destinationScope,
      subregionGeometries,
    },
  });
  mark('adapterAndPlanTripMs', tAdapter);

  console.log('Geocoder calls:', geocoderCalls, '| Matrix calls:', matrixCalls, '| Direct confirm calls:', confirmCalls, '| Reverse-geocode calls:', reverseGeocodeCalls);
  console.log(`Bases resolved (original skeleton bases): ${result.baseResolutions.filter((r) => r.resolvedId).length}/${result.baseResolutions.length}`);

  writeFileSync(path.join(OUT_DIR, `unified-call-log-${SUFFIX}.json`), JSON.stringify(callLog, null, 2));

  // --- Item 1: the complete original route, all four mandatory legs, ------
  // --- reconstructed from every real matrix/confirm call actually made ----
  // --- (the merged ledger view, read-only — same technique every prior -----
  // --- round's own reporting has used). ------------------------------------
  const baseReport = (skeleton.bases as { id: string; name: string; nights: number }[]).map((base) => {
    const record = result.baseResolutions.find((r) => r.skeletonBaseId === base.id);
    return { skeletonBaseId: base.id, skeletonName: base.name, nights: base.nights, ...record };
  });

  interface MergedLedger {
    ids: string[];
    minutes: Map<string, number>;
    km: Map<string, number>;
    failures: Map<string, string>;
  }
  const merged: MergedLedger = { ids: [], minutes: new Map(), km: new Map(), failures: new Map() };
  const pairKey = (a: string, b: string) => `${a}=>${b}`;
  for (const entry of callLog) {
    if (entry.kind !== 'matrix') continue;
    const out = entry.output as { ids: string[]; minutes: number[][]; km: number[][]; failedPairs?: { fromId: string; toId: string; reason: string }[] } | null;
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
    for (const fp of out.failedPairs ?? []) merged.failures.set(pairKey(fp.fromId, fp.toId), fp.reason);
  }
  function confirmationFor(fromId: string | null, toId: string | null): CallLogEntry | null {
    const fromCoord = coordinatesFor(fromId);
    const toCoord = coordinatesFor(toId);
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
  function coordinatesFor(resolvedId: string | null): { lat: number; lng: number } | null {
    if (!resolvedId) return null;
    const boardMatch = board.candidates.find((c) => c.place.id === resolvedId);
    if (boardMatch) return boardMatch.place.coordinates;
    for (const b of baseReport as unknown as { resolvedId?: string | null; candidates?: { selected?: boolean; coordinates: { lat: number; lng: number } }[] | null }[]) {
      if (b.resolvedId === resolvedId && b.candidates) {
        const selected = b.candidates.find((c) => c.selected);
        if (selected) return selected.coordinates;
      }
    }
    return null;
  }

  const ceiling = region.matrix.mode === 'car' ? profile.transport.maxDailyDriveMinutes : profile.transport.maxDailyTransportMinutes;
  const originalRouteLegs: unknown[] = [];
  for (let i = 0; i < baseReport.length - 1; i += 1) {
    const from = baseReport[i]!;
    const to = baseReport[i + 1]!;
    const primaryLeg = from.resolvedId && to.resolvedId ? tryLeg(region.matrix, from.resolvedId, to.resolvedId) : null;
    const ledgerMinutes = from.resolvedId && to.resolvedId ? (merged.minutes.get(pairKey(from.resolvedId, to.resolvedId)) ?? merged.minutes.get(pairKey(to.resolvedId, from.resolvedId)) ?? null) : null;
    const matrixMinutes = primaryLeg?.minutes ?? ledgerMinutes;
    const confirmation = confirmationFor(from.resolvedId ?? null, to.resolvedId ?? null);
    const confirmOutput = confirmation?.output as { found: boolean; minutes: number | null; km: number | null; reason?: string } | undefined;
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
    });
  }
  console.log('\n=== ITEM 1: COMPLETE ORIGINAL ROUTE (all 4 mandatory legs) ===');
  console.log(JSON.stringify(originalRouteLegs, null, 2));
  writeFileSync(path.join(OUT_DIR, `original-route-complete-${SUFFIX}.json`), JSON.stringify(originalRouteLegs, null, 2));

  // --- Item 2: corridor remediation detail, reconstructed from the unified
  // --- call log's reverseGeocode/confirm entries. --------------------------
  const reverseGeocodeEntries = callLog.filter((c) => c.kind === 'reverseGeocode');
  console.log('\n=== ITEM 2: RAW REVERSE-GEOCODE CALLS (chronological) ===');
  console.log(JSON.stringify(reverseGeocodeEntries, null, 2));
  writeFileSync(path.join(OUT_DIR, `reverse-geocode-calls-${SUFFIX}.json`), JSON.stringify(reverseGeocodeEntries, null, 2));

  // --- Deviations recorded by the real remediation pass — the authoritative
  // --- "what happened and why" text, in the adapter's own words. -----------
  const deviations = result.ok ? result.deviations : [];
  console.log('\n=== DEVIATIONS (the corridor/board remedy record, if the route is feasible) ===');
  console.log(JSON.stringify(deviations, null, 2));

  // --- Item 4/5/6: before/after, or the typed issue. -----------------------
  writeFileSync(path.join(OUT_DIR, `base-resolution-report-${SUFFIX}.json`), JSON.stringify(baseReport, null, 2));
  writeFileSync(path.join(OUT_DIR, `production-plan-result-${SUFFIX}.json`), JSON.stringify(result, null, 2));

  console.log('\n=== BEFORE: ORIGINAL SKELETON BASE SEQUENCE ===');
  for (const b of skeleton.bases as { name: string; nights: number }[]) console.log(`  ${b.name} — ${b.nights} night(s)`);
  console.log('  total nights:', (skeleton.bases as { nights: number }[]).reduce((s, b) => s + b.nights, 0));

  let outcome: 'A' | 'B' | 'C' | 'D' | 'E';
  if (!result.ok) {
    console.log('\n=== AFTER: DETERMINISTIC REMEDIATION DID NOT PRODUCE A FEASIBLE ROUTE ===');
    console.log(JSON.stringify(result.repairIssue, null, 2));
    const anyUnresolvableIdentity = result.baseResolutions.some((b) => !b.resolvedId) || result.repairIssue.kind === 'base_identity_ambiguous';
    outcome = anyUnresolvableIdentity ? 'C' : 'B';
    writeFileSync(path.join(OUT_DIR, `repair-issue-${SUFFIX}.json`), JSON.stringify(result.repairIssue, null, 2));
  } else {
    console.log('\n=== AFTER: DETERMINISTIC REMEDIATION SUCCEEDED — ITINERARY PRODUCED ===');
    console.log('Final base sequence (from the real itinerary):');
    const dayBaseSeq: string[] = [];
    for (const day of result.itinerary.days) {
      if (dayBaseSeq[dayBaseSeq.length - 1] !== day.baseId) dayBaseSeq.push(day.baseId);
      console.log(`  ${day.date}: ${day.baseId}`);
    }
    console.log('Distinct base sequence:', dayBaseSeq.join(' -> '));
    console.log('Days scheduled:', result.itinerary.days.length, '(must be 13)');

    // Anchor retention/drop reporting.
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
    outcome = evidenceBreadthRatio < 0.7 ? 'D' : 'A'; // known baseline: 17/27 ≈ 0.63 — well under a reasonable "materially poor" line

    // Founder-readable summary — no invented content.
    const lines: string[] = [];
    lines.push('# Iceland — deterministic corridor-remediated itinerary (founder-readable)');
    lines.push('');
    lines.push('Produced entirely deterministically — zero Anthropic calls — after relocation-corridor remediation resolved the route.');
    lines.push('');
    lines.push('## Route');
    for (const id of dayBaseSeq) lines.push(`- ${id}`);
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
    boardSize: board.candidates.length,
    compiledPlacesWithRelationshipBase: region.places.filter((p) => p.relationship === 'base').length,
    geocoderCalls,
    geocoderMs: Math.round(geocoderMs),
    geocoderQueries,
    matrixRoutingCalls: matrixCalls,
    matrixRoutingMs: Math.round(matrixMs),
    directConfirmationCalls: confirmCalls,
    directConfirmationMs: Math.round(confirmMs),
    reverseGeocodeCalls,
    reverseGeocodeMs: Math.round(reverseGeocodeMs),
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
  process.exit(1);
});
