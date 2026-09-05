/*
 * THE ONE PRODUCTION TRIPSKELETON REPAIR CALL — REAL, SENT, BOUNDED.
 *
 * Uses the exact compact repair context two prior rounds constructed (real
 * SkeletonRepairIssues, real measured relocation evidence, real persisted
 * artifacts) to make exactly ONE `repairTripSkeleton()` call
 * (claude-sonnet-5, effort medium, maxCalls: 1). If the repaired skeleton
 * validates, verifies it deterministically against the local Valhalla
 * instance (zero further model calls), and — only if that verification
 * passes — runs exactly ONE production hydration
 * (`planFromSkeletonForTrip()`).
 *
 * ANTHROPIC CALLS: at most 1 (the repair itself). Everything after it is
 * zero-model, using the same `createOpenProviders({ maxModelCalls: 0 })`
 * mechanism every prior round's verification/hydration scripts have used.
 *
 * Run with (from apps/web):
 *   npx tsx scripts/iceland-repair-call.ts
 */
process.env.SIDEQUEST_COMPOSER_EFFORT = 'medium';
process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';

import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ART_DIR = path.join(REPO_ROOT, '.claude-private/benchmark/iceland-production-hydration-2026-08-29');
const SKELETON_PATH = path.join(
  REPO_ROOT,
  '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/trip-skeleton.json',
);
const PACKET_PATH = path.join(
  REPO_ROOT,
  '.claude-private/benchmark/iceland-skeleton-generation-2026-08-29/skeleton-evidence-packet.json',
);
const TRIP_ID = '64bc0495-370f-42ad-950d-12d1c0a10317';
const CEILING = 240;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  const wallStart = performance.now();
  const head = execSync('git rev-parse HEAD').toString().trim();
  const diffHashBefore = sha256(execSync('git diff HEAD').toString());
  const skeletonShaBefore = sha256(readFileSync(SKELETON_PATH, 'utf8'));
  console.log('HEAD', head);
  console.log('diff sha256 (before)', diffHashBefore);
  console.log('original skeleton sha256 (must remain immutable)', skeletonShaBefore);

  // --- Rebuild the exact same compact repair context, from the same
  // --- persisted artifacts, following the same construction already
  // --- reviewed and saved to repair-context-constructed-not-sent.json. ----
  const skeleton = JSON.parse(readFileSync(SKELETON_PATH, 'utf8'));
  const packet = JSON.parse(readFileSync(PACKET_PATH, 'utf8'));
  const planResult = JSON.parse(readFileSync(path.join(ART_DIR, 'production-plan-result-confirmed-routing.json'), 'utf8'));
  const hofnToAkureyri = planResult.repairIssue;
  const evidence = JSON.parse(readFileSync(path.join(ART_DIR, 'complete-relocation-evidence.json'), 'utf8'));
  const akureyriToReykjavik = evidence.find((e: { leg: string }) => e.leg === 'Akureyri → Reykjavík');
  const baseReport = JSON.parse(readFileSync(path.join(ART_DIR, 'base-resolution-report-confirmed-routing.json'), 'utf8'));
  const akureyriName = baseReport.find((b: { skeletonBaseId: string }) => b.skeletonBaseId === 'akureyri')?.resolvedName ?? 'Akureyri';
  const reykjavik2Name = baseReport.find((b: { skeletonBaseId: string }) => b.skeletonBaseId === 'reykjavik-2')?.resolvedName ?? 'Reykjavik';

  const secondIssue = {
    kind: 'relocation_infeasible' as const,
    detail: `${akureyriName} → ${reykjavik2Name} measures ${akureyriToReykjavik.measuredMinutes} minute(s), past the traveller's stated ${CEILING}-minute daily driving limit, and no verified intermediate base resolves it.`,
    affectedDayNumbers: [] as number[],
    affectedBaseIds: ['akureyri', 'reykjavik-2'],
    relocationEvidence: {
      fromBaseId: 'akureyri',
      toBaseId: 'reykjavik-2',
      fromPlaceId: akureyriToReykjavik.fromId,
      toPlaceId: akureyriToReykjavik.toId,
      measuredMinutes: akureyriToReykjavik.measuredMinutes,
      hardCeilingMinutes: CEILING,
      matrixMode: 'car',
      matrixOutcome: 'authoritative_no_route',
      confirmationAttempted: true,
      confirmationProvider: 'valhalla',
      confirmationMinutes: akureyriToReykjavik.measuredMinutes,
      confirmationKm: akureyriToReykjavik.measuredKm,
      finalEvidenceClassification: 'direct_route_confirmed',
    },
    verifiedAlternatives: [] as { placeId: string; name: string; reason: string }[],
  };

  const context = { skeleton, packet, issues: [hofnToAkureyri, secondIssue] };

  const { buildProductionRepairTask, repairTripSkeleton } = await import('../src/lib/benchmark/baseline/skeleton-repair');
  const built = buildProductionRepairTask(context);
  if (!built.ok) throw new Error(`Repair task could not be built: ${built.detail}`);

  const previouslySaved = readFileSync(path.join(ART_DIR, 'repair-task-constructed-not-sent.txt'), 'utf8');
  const taskMatchesPreviouslyConstructed = built.task === previouslySaved;
  console.log('Task identical to the previously constructed/saved version:', taskMatchesPreviouslyConstructed);
  console.log('Issues included:', built.eligibleIssues.map((i) => i.kind).join(', '));

  // --- THE ONE ANTHROPIC CALL --------------------------------------------
  const { ResearchModel } = await import('../src/lib/providers/anthropic');
  const repairModel = new ResearchModel({ maxCalls: 1, model: 'claude-sonnet-5' });

  console.log('\n=== SENDING THE ONE REPAIR CALL (claude-sonnet-5, effort medium) ===');
  const repairStart = performance.now();
  let repairResult: Awaited<ReturnType<typeof repairTripSkeleton>>;
  try {
    repairResult = await repairTripSkeleton(context, repairModel);
  } catch (error) {
    const diag = repairModel.callLog[0];
    console.log('\n=== OUTCOME: F — repair model call itself failed (threw) ===');
    console.log(error);
    writeFileSync(
      path.join(ART_DIR, 'repair-call-failure.json'),
      JSON.stringify({ error: error instanceof Error ? error.message : String(error), diagnostic: diag ?? null }, null, 2),
    );
    console.log(`\nAnthropic repair calls: ${repairModel.usage.calls}`);
    return;
  }
  const repairElapsedMs = Math.round(performance.now() - repairStart);

  const diag = repairModel.callLog[0];
  const diagnosticsReport = diag
    ? {
        model: diag.model,
        effort: 'medium',
        callLabel: diag.callLabel,
        elapsedMs: diag.elapsedMs,
        inputTokens: diag.inputTokens,
        outputTokens: diag.outputTokens,
        thinkingTokens: diag.thinkingTokens,
        nonThinkingOutputTokens: diag.nonThinkingOutputTokens,
        stopReason: diag.stopReason,
        requestBytes: diag.requestBytes,
        responseBytes: diag.responseBytes,
        outcome: diag.outcome,
        enforcementFallback: diag.enforcementFallback,
        enforcementAttempted: diag.enforcementAttempted,
        schemaRefusal: diag.schemaRefusal,
        attempt: diag.attempt,
      }
    : null;
  console.log('\n=== ANTHROPIC CALL DIAGNOSTICS ===');
  console.log(JSON.stringify(diagnosticsReport, null, 2));
  console.log('Wall-clock for the call:', repairElapsedMs, 'ms');
  writeFileSync(path.join(ART_DIR, 'repair-call-diagnostics.json'), JSON.stringify(diagnosticsReport, null, 2));

  console.log(`\nAnthropic repair calls: ${repairModel.usage.calls}`);

  if (!repairResult.ok) {
    console.log('\n=== OUTCOME: F — repair model call itself failed ===');
    console.log(JSON.stringify(repairResult, null, 2));
    writeFileSync(path.join(ART_DIR, 'repair-call-failure.json'), JSON.stringify(repairResult, null, 2));
    return;
  }

  // Preserve the raw response privately before any further processing.
  writeFileSync(path.join(ART_DIR, 'repair-raw-model-output.json'), JSON.stringify(repairResult.output, null, 2));

  // --- Strict schema validation — normalize nothing beyond what the
  // --- currently-shipped repairTripSkeleton() already does (none), so no
  // --- source is touched to make this pass. -------------------------------
  const { tripSkeletonSchema } = await import('../src/lib/benchmark/baseline/skeleton');
  const validation = tripSkeletonSchema.safeParse(repairResult.output);
  if (!validation.success) {
    console.log('\n=== OUTCOME: C — the repair response does not validate as a TripSkeleton ===');
    console.log(JSON.stringify(validation.error.issues, null, 2));
    writeFileSync(
      path.join(ART_DIR, 'repair-schema-validation-failure.json'),
      JSON.stringify({ issues: validation.error.issues }, null, 2),
    );
    return;
  }
  const repaired = validation.data;

  // Saved separately — the original trip-skeleton.json is never touched.
  const skeletonShaAfterOriginalCheck = sha256(readFileSync(SKELETON_PATH, 'utf8'));
  if (skeletonShaAfterOriginalCheck !== skeletonShaBefore) {
    throw new Error('The original trip-skeleton.json changed during this run — aborting before reporting anything further.');
  }
  writeFileSync(path.join(ART_DIR, 'trip-skeleton-repaired.json'), JSON.stringify(repaired, null, 2));

  // --- Report the model's actual changes, precisely, before hydrating -----
  console.log('\n=== ORIGINAL ROUTE ===');
  for (const b of skeleton.bases) console.log(`  ${b.name} (${b.nights} night(s))`);
  console.log('  total nights:', skeleton.bases.reduce((s: number, b: { nights: number }) => s + b.nights, 0));

  console.log('\n=== REPAIRED ROUTE ===');
  for (const b of repaired.bases) console.log(`  ${b.name} (${b.nights} night(s))`);
  console.log('  total nights:', repaired.bases.reduce((s: number, b: { nights: number }) => s + b.nights, 0));

  const originalBaseIds = new Set(skeleton.bases.map((b: { id: string }) => b.id));
  const repairedBaseIds = new Set(repaired.bases.map((b) => b.id));
  const insertedBases = repaired.bases.filter((b) => !originalBaseIds.has(b.id));
  const removedBases = skeleton.bases.filter((b: { id: string }) => !repairedBaseIds.has(b.id));
  const keptBasesWithNightChange = repaired.bases.filter((b) => {
    const original = skeleton.bases.find((ob: { id: string }) => ob.id === b.id);
    return original && original.nights !== b.nights;
  });

  console.log('\n=== EXACT SKELETON CHANGES ===');
  for (const b of insertedBases) console.log(`  INSERTED BASE: ${b.name} (id ${b.id}), ${b.nights} night(s), placeIndex=${b.placeIndex}, why: ${b.why}`);
  for (const b of removedBases) console.log(`  REMOVED BASE: ${b.name} (id ${b.id}), was ${b.nights} night(s)`);
  for (const b of keptBasesWithNightChange) {
    const original = skeleton.bases.find((ob: { id: string }) => ob.id === b.id);
    console.log(`  NIGHT CHANGE: ${b.name} (id ${b.id}): ${original.nights} -> ${b.nights}`);
  }
  // Day/base assignment changes
  for (const day of repaired.days) {
    const originalDay = skeleton.days.find((d: { dayNumber: number }) => d.dayNumber === day.dayNumber);
    if (!originalDay) {
      console.log(`  NEW DAY: day ${day.dayNumber} -> base ${day.baseId}`);
      continue;
    }
    if (originalDay.baseId !== day.baseId) {
      console.log(`  DAY MOVED TO DIFFERENT BASE: day ${day.dayNumber}: ${originalDay.baseId} -> ${day.baseId}`);
    }
    const originalAnchorIdx = new Set(originalDay.anchors.map((a: { placeIndex: number }) => a.placeIndex));
    const repairedAnchorIdx = new Set(day.anchors.map((a) => a.placeIndex));
    for (const idx of originalAnchorIdx) if (!repairedAnchorIdx.has(idx)) console.log(`  ANCHOR DROPPED: day ${day.dayNumber}, placeIndex ${idx}`);
    for (const idx of repairedAnchorIdx) if (!originalAnchorIdx.has(idx)) console.log(`  ANCHOR ADDED/MOVED IN: day ${day.dayNumber}, placeIndex ${idx}`);
  }
  const removedDayNumbers = skeleton.days
    .map((d: { dayNumber: number }) => d.dayNumber)
    .filter((n: number) => !repaired.days.some((rd) => rd.dayNumber === n));
  for (const n of removedDayNumbers) console.log(`  DAY REMOVED: day ${n}`);

  const originalOmissions = new Set(skeleton.majorOmissions ?? []);
  const repairedOmissions = new Set(repaired.majorOmissions ?? []);
  for (const o of repairedOmissions) if (!originalOmissions.has(o)) console.log(`  OMISSION ADDED: ${o}`);
  for (const o of originalOmissions) if (!repairedOmissions.has(o)) console.log(`  OMISSION REMOVED: ${o}`);

  const originalUnresolved = new Set((skeleton.unresolved ?? []).map((u: unknown) => JSON.stringify(u)));
  const repairedUnresolved = new Set((repaired.unresolved ?? []).map((u) => JSON.stringify(u)));
  for (const u of repairedUnresolved) if (!originalUnresolved.has(u)) console.log(`  UNRESOLVED ITEM ADDED: ${u}`);
  for (const u of originalUnresolved) if (!repairedUnresolved.has(u)) console.log(`  UNRESOLVED ITEM REMOVED (now resolved): ${u}`);

  const totalNightsRepaired = repaired.bases.reduce((s, b) => s + b.nights, 0);
  console.log('\nTotal nights check: repaired =', totalNightsRepaired, '(must equal 12)');
  if (totalNightsRepaired !== 12) {
    console.log('\n=== OUTCOME: B — repaired skeleton fails the total-nights invariant before any routing check ===');
    return;
  }

  // --- Deterministic verification + (if feasible) the one production
  // --- hydration — planFromSkeleton() is one atomic pipeline (base
  // --- resolution -> relocation feasibility -> planTrip() -> validator),
  // --- so these two steps are necessarily one real call, reported
  // --- together from what that one call actually returns. -----------------
  const { getTrip, getProfile } = await import('../src/lib/db/repository');
  const { getIntent } = await import('../src/lib/db/compiler-repository');
  const trip = getTrip(TRIP_ID);
  if (!trip) throw new Error(`Trip ${TRIP_ID} not found.`);
  const _intent = getIntent(TRIP_ID);
  const profile = getProfile(TRIP_ID);
  if (!profile) throw new Error(`Trip ${TRIP_ID} has no saved profile.`);

  const { resolveTripRegion, boardFor } = await import('../src/lib/region');
  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) throw new Error(`Region resolution failed: ${resolved.error}`);
  const region = resolved.context;
  const board = boardFor(trip, profile, region);

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
  const observedGeocoder = async (query: string) => {
    geocoderCalls += 1;
    const t = performance.now();
    const out = await productionGeocodeLocality(query);
    geocoderMs += performance.now() - t;
    return out;
  };
  let matrixCalls = 0;
  let matrixMs = 0;
  const observedRouteMatrix = async (points: readonly { id: string; lat: number; lng: number }[]) => {
    matrixCalls += 1;
    const t = performance.now();
    const out = await productionRouteMatrix(providers.routing, region.matrix.mode, points);
    matrixMs += performance.now() - t;
    return out;
  };
  let confirmCalls = 0;
  let confirmMs = 0;
  const observedConfirmRoute = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
    confirmCalls += 1;
    const t = performance.now();
    const out = await productionConfirmRoute(providers.routing, region.matrix.mode, from, to);
    confirmMs += performance.now() - t;
    return out;
  };

  const { planFromSkeleton } = await import('../src/lib/planning/skeleton-adapter');
  const destinationScope = productionDestinationScope(region.compiled);
  const subregionGeometries = productionSubregionGeometries(region.compiled);

  const hydrationStart = performance.now();
  const result = await planFromSkeleton({
    skeleton: repaired,
    skeletonPacket: packet,
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
  const hydrationMs = Math.round(performance.now() - hydrationStart);

  console.log('\n=== DETERMINISTIC VERIFICATION (from the one planFromSkeleton() call) ===');
  console.log('Bases resolved:', result.baseResolutions.filter((r) => r.resolvedId).length, '/', result.baseResolutions.length);
  for (const b of result.baseResolutions) {
    console.log(`  ${b.skeletonBaseId} (${b.skeletonName}) -> ${b.resolvedId ?? 'UNRESOLVED'} (${b.resolvedName ?? '—'}), method=${b.method}, routable=${b.routable}`);
  }

  writeFileSync(path.join(ART_DIR, 'repaired-base-resolution-report.json'), JSON.stringify(result.baseResolutions, null, 2));
  writeFileSync(path.join(ART_DIR, 'repaired-production-plan-result.json'), JSON.stringify(result, null, 2));

  const routingDiagnostics = {
    geocoderCalls,
    geocoderMs: Math.round(geocoderMs),
    matrixRoutingCalls: matrixCalls,
    matrixRoutingMs: Math.round(matrixMs),
    directConfirmationCalls: confirmCalls,
    directConfirmationMs: Math.round(confirmMs),
    hydrationMs,
  };
  console.log('\n=== ROUTING/HYDRATION DIAGNOSTICS ===');
  console.log(JSON.stringify(routingDiagnostics, null, 2));

  if (!result.ok) {
    console.log('\n=== SkeletonRepairIssue (repaired skeleton still infeasible) ===');
    console.log(JSON.stringify(result.repairIssue, null, 2));
    const anyUnresolved = result.baseResolutions.some((b) => !b.resolvedId);
    console.log(
      '\n=== OUTCOME:',
      anyUnresolved || result.repairIssue.kind === 'base_identity_ambiguous'
        ? 'C — repair proposed a base/identity Sidequest cannot verify'
        : 'B — one repair call completed, but repaired skeleton remains deterministically infeasible',
      '===',
    );
  } else {
    console.log('\n=== OUTCOME: A — repaired production itinerary produced ===');
    writeFileSync(path.join(ART_DIR, 'itinerary-repaired.json'), JSON.stringify(result.itinerary, null, 2));
    console.log('Final base sequence:');
    for (const day of result.itinerary.days) console.log(`  ${day.date}: ${day.baseId}`);
    console.log('Deviations:', JSON.stringify(result.deviations, null, 2));

    // A minimal, honest founder-readable summary — no invented content.
    const lines: string[] = [];
    lines.push('# Iceland — repaired itinerary (founder-readable)');
    lines.push('');
    lines.push(`Repaired from the frozen skeleton after a bounded whole-route repair (Höfn→Akureyri, Akureyri→Reykjavík both over the 240-minute ceiling).`);
    lines.push('');
    lines.push('## Route');
    for (const b of repaired.bases) lines.push(`- ${b.name} — ${b.nights} night(s)`);
    lines.push('');
    lines.push('## Days');
    for (const day of result.itinerary.days) {
      lines.push(`### ${day.date} — ${day.baseId}`);
      for (const item of day.items) {
        lines.push(`- ${item.startTime ?? ''} ${item.title ?? item.placeId ?? ''}`.trim());
      }
      lines.push('');
    }
    if (result.deviations.length > 0) {
      lines.push('## Deviations from the original skeleton');
      for (const d of result.deviations) lines.push(`- [${d.kind}] ${d.detail}`);
    }
    writeFileSync(path.join(ART_DIR, 'founder-readable-itinerary-repaired.md'), lines.join('\n'));
  }

  const totalWallMs = Math.round(performance.now() - wallStart);
  const diffHashAfter = sha256(execSync('git diff HEAD').toString());
  const skeletonShaAfter = sha256(readFileSync(SKELETON_PATH, 'utf8'));
  console.log('\n=== FINAL INTEGRITY CHECK ===');
  console.log('diff hash unchanged:', diffHashBefore === diffHashAfter);
  console.log('original skeleton unchanged:', skeletonShaBefore === skeletonShaAfter);
  console.log('total wall time ms:', totalWallMs);
  console.log(`\nAnthropic repair calls: ${repairModel.usage.calls}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
