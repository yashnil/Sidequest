/*
 * ONE live production-hydration attempt for the already-validated, saved
 * Iceland TripSkeleton — NOT part of the app build, NOT a repeatable harness.
 *
 * Drives the real production pipeline (trip creation, destination resolution,
 * scope, real compiler evidence acquisition, real questionnaire→profile→board)
 * and then hands the frozen skeleton to `planFromSkeleton()` — the real
 * `@sidequest/planner` `planTrip()`, not the Phase 13 benchmark-isolated
 * hydrator.
 *
 * ZERO ANTHROPIC CALLS, ENFORCED STRUCTURALLY, NOT BY CONVENTION.
 *
 * The production pipeline has exactly one provider seam that can carry a
 * model call at every stage that matters here (destination "is this a place"
 * corroboration, region expansion, evidence extraction/classification) —
 * `ResearchModel`, and every one of those call sites checks
 * `this.callsRemaining <= 0` and returns *before* opening a socket. This
 * script builds exactly one such model, via the same `createOpenProviders`
 * production factory every live compilation uses, with `maxModelCalls: 0` —
 * so every one of those call sites degrades exactly the way it already does
 * for an exhausted daily ceiling, and is reused for both the one call this
 * script makes directly (destination resolution — see below) and the one it
 * hands to `runCompilation`. No HTTP request to Anthropic can happen; there is
 * no code path left that reaches the network.
 *
 * The one action NOT called directly is `resolveDestinationAction` — it reads
 * a module-level, uncapped provider singleton with no injection seam, so
 * calling it would make one live "is this a place" classification call
 * despite everything above. Its non-model logic (resolve → decide → persist)
 * is reproduced here verbatim, calling the same real, exported production
 * functions (`saveResolution`, `decideInterpretation`, `saveSelectedCandidate`,
 * `saveSelectedDestination`, `rebuildClarificationSet`, `saveClarifications`)
 * against MY zero-budget resolver instead. Everything else — preflight,
 * clarifications, strategy, scope, compilation, questionnaire — is the
 * unmodified production action, called exactly as the browser calls it.
 *
 * Run with:
 *   npx tsx apps/web/scripts/iceland-production-hydration.ts [resumeTripId]
 *
 * `resumeTripId`: an already-compiled trip id from a prior run of this
 * script, to skip straight to the questionnaire step without repeating
 * several minutes of real provider work.
 */
import { loadEnvConfig } from '@next/env';
loadEnvConfig(process.cwd());

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Absolute, independent of cwd: this script must run with cwd = apps/web (so
// @next/env finds apps/web/.env.local and the default DB path resolves), but
// these private artifacts live at the repo root regardless of where it runs.
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

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function main() {
  const wallStart = performance.now();
  const timings: Record<string, number> = {};
  const mark = (label: string, startedAt: number) => {
    timings[label] = Math.round(performance.now() - startedAt);
  };

  // --- Diagnostics: before -------------------------------------------------
  const head = execSync('git rev-parse HEAD').toString().trim();
  const diffHash = sha256(execSync('git diff HEAD').toString());
  const skeletonRaw = readFileSync(SKELETON_PATH, 'utf8');
  const skeletonShaBefore = sha256(skeletonRaw);
  const skeleton = JSON.parse(skeletonRaw);
  const packetRaw = readFileSync(PACKET_PATH, 'utf8');
  const skeletonPacket = JSON.parse(packetRaw);

  console.log('HEAD', head);
  console.log('diff sha256', diffHash);
  console.log('skeleton sha256 (before)', skeletonShaBefore);

  // --- The zero-budget provider set, built once, used everywhere ----------
  const { createOpenProviders } = await import('../src/lib/providers/live');
  const { providers, diagnostics: liveDiagnostics } = createOpenProviders({ maxModelCalls: 0 });

  const { getTrip, getProfile } = await import('../src/lib/db/repository');
  const { getIntent } = await import('../src/lib/db/compiler-repository');

  const resumeTripId = process.argv[2];
  let tripId: string;

  if (resumeTripId) {
    // --- Resume: reuse a prior run's already-compiled trip -----------------
    const existing = getTrip(resumeTripId);
    if (!existing) throw new Error(`Resume trip id ${resumeTripId} not found`);
    if (!getIntent(resumeTripId)?.selectedCompiledRegionId) {
      throw new Error(`Resume trip id ${resumeTripId} has no adopted compiled region`);
    }
    tripId = resumeTripId;
    console.log('Resuming trip', tripId, '(skipping trip creation/destination/compilation)');
  } else {
    // --- Trip creation (no model calls: classifyPreferences only runs on
    //     non-empty mustDo/avoid text, and both are empty here) ------------
    const { createTripFromComposer } = await import('../src/app/(product)/trips/new/actions');
    const tStart0 = performance.now();
    const created = await createTripFromComposer({
      destinationText: 'Iceland',
      destinationEntryId: null,
      dateMode: 'exact',
      startDate: '2026-07-05',
      endDate: '2026-07-17',
      flexDays: 0,
      month: 7,
      season: 'summer',
      wantsDateRecommendation: false,
      wantsLengthRecommendation: false,
      nights: 12,
      arrivalPrecision: 'unknown',
      departurePrecision: 'unknown',
      adults: 2,
      children: 0,
      travelerNeeds: [],
      shape: 'circuit',
      pace: 'balanced',
      transport: 'drive',
      budget: 'mid_range',
      themes: [],
      crowdTolerance: null,
      outdoorIntensity: 'moderate',
      foodImportance: null,
      freeTime: null,
      mustDo: '',
      avoid: '',
      origin: '',
    });
    if (!created.ok) throw new Error(`Trip creation failed: ${created.error ?? JSON.stringify(created.fieldErrors)}`);
    const createdTripId = /^\/trips\/([^/]+)\//.exec(created.href)?.[1];
    if (!createdTripId) throw new Error(`Could not read trip id from href ${created.href}`);
    tripId = createdTripId;
    console.log('Created trip', tripId);

    const freshTrip = getTrip(tripId);
    if (!freshTrip) throw new Error('Trip vanished immediately after creation');
    if (freshTrip.basics.regionId !== 'dynamic') {
      throw new Error(`Expected the dynamic region door; got regionId=${freshTrip.basics.regionId}`);
    }

    // --- Destination resolution, reproduced without the model call --------
    const { decideInterpretation, countNights } = await import('@sidequest/core');
    const { saveResolution, saveSelectedCandidate, saveSelectedDestination, saveClarifications } = await import(
      '../src/lib/db/compiler-repository'
    );
    const { rebuildClarificationSet } = await import('@sidequest/compiler');

    const resolution = await providers.resolver.resolve({ query: 'Iceland', now: new Date() });
    saveResolution(tripId, resolution);
    const decision = decideInterpretation(resolution);
    console.log('Destination decision', decision.kind, 'candidates:', resolution.candidates.length);
    if (decision.kind !== 'single') {
      throw new Error(
        `Destination resolution for "Iceland" was not a single unambiguous reading (${decision.kind}) — ` +
          'stopping rather than guessing which candidate to adopt.',
      );
    }
    const candidate = decision.candidate;
    // Verbatim from `resolveDestinationAction`'s own private table
    // (apps/web/src/app/(product)/trips/[id]/plan/actions.ts).
    const FEATURE_TYPE_FROM_ENTITY: Record<string, string> = {
      country: 'country',
      multi_country: 'country',
      state_or_province: 'region',
      subregion: 'county',
      city: 'city',
      metro_area: 'city',
      neighbourhood: 'district',
      island: 'island',
      archipelago: 'island',
      protected_area: 'national_park',
      point_of_interest: 'landmark',
    };
    saveSelectedCandidate(tripId, candidate.id);
    saveSelectedDestination(tripId, {
      entryId: `resolver:${candidate.id}`,
      catalog: 'nominatim',
      sourceId: candidate.providerRefs[0]?.externalId ?? candidate.id,
      releaseId: 'resolver',
      displayName: candidate.displayName,
      qualifiedName: candidate.qualifiedName,
      featureType: (FEATURE_TYPE_FROM_ENTITY[candidate.entityType] ?? 'other') as never,
      center: candidate.center,
      ...(candidate.bounds ? { bounds: candidate.bounds } : {}),
      ...(candidate.countryCode ? { countryCode: candidate.countryCode } : {}),
      ...(candidate.regionCode ? { regionCode: candidate.regionCode } : {}),
      aliases: [...candidate.aliases],
      hierarchy: candidate.administrativeAreas,
      selectedAt: new Date().toISOString(),
    });
    saveClarifications(
      tripId,
      rebuildClarificationSet({
        resolution,
        candidate,
        nights: countNights(freshTrip.basics.startDate, freshTrip.basics.endDate),
        known: { transport: 'drive' },
      }),
    );
    mark('destinationResolutionMs', tStart0);

    // --- Preflight, clarifications, strategy, scope (real, model-free) ----
    const planActions = await import('../src/app/(product)/trips/[id]/plan/actions');
    const tPreflight = performance.now();
    const preflight = await planActions.ensurePreflightAction(tripId);
    mark('preflightMs', tPreflight);
    if (!preflight.ok) throw new Error(`Preflight refused: ${preflight.error}`);

    const clarAnswer = await planActions.saveClarificationAnswersAction(tripId, []);
    if (!clarAnswer.ok) throw new Error(`Clarification save refused: ${clarAnswer.error}`);

    const tScope = performance.now();
    await planActions.applyStrategyAction(tripId, 'circuit');
    if (!getIntent(tripId)?.scope) {
      const proposed = await planActions.proposeScopeAction(tripId);
      if (!proposed.ok) throw new Error(`Scope proposal refused: ${proposed.error}`);
    }
    const confirmed = await planActions.confirmScopeAction(tripId);
    if (!confirmed.ok) throw new Error(`Scope confirmation refused: ${confirmed.error}`);
    mark('scopeMs', tScope);

    // --- Compilation: real Overture/OSM/Valhalla/weather providers, -------
    // --- ZERO model calls (the same zero-budget provider set) -------------
    const { startCompilation, runCompilation } = await import('../src/lib/compiler/runner');
    const tripForCompile = getTrip(tripId)!;
    const started = startCompilation(tripForCompile, new Date(), null);
    console.log('startCompilation ->', started.kind);
    let compileResult: unknown = null;
    const tCompile = performance.now();
    if (started.kind === 'started' || started.kind === 'queued') {
      const jobId = started.jobId;
      compileResult = await runCompilation({ trip: tripForCompile, jobId, providers });
    } else if (started.kind !== 'already_compiled') {
      throw new Error(`Compilation could not start: ${started.kind} ${'message' in started ? started.message : ''}`);
    }
    mark('compilationMs', tCompile);

    const compiledIntent = getIntent(tripId);
    if (!compiledIntent?.selectedCompiledRegionId) {
      writeFileSync(
        path.join(OUT_DIR, 'compilation-failure.json'),
        JSON.stringify({ started, compileResult, intent: compiledIntent }, null, 2),
      );
      throw new Error('Compilation did not adopt a compiled region — see compilation-failure.json');
    }
    console.log('Adopted compiled region', compiledIntent.selectedCompiledRegionId, '- resume with:', tripId);
  }

  let trip = getTrip(tripId);
  if (!trip) throw new Error('Trip vanished');
  const finalIntent = getIntent(tripId);
  if (!finalIntent?.selectedCompiledRegionId) throw new Error('No adopted compiled region on this trip');

  // --- Questionnaire → real TravelerProfile + real Discovery Board --------
  const { defaultAnswers } = await import('@sidequest/core');
  const questionnaireActions = await import('../src/app/(product)/trips/[id]/questionnaire/actions');
  // `validatedQuestionnaireAnswersSchema` requires at least one interest above
  // 'low' ("pick at least one thing you actually want to do") — a real
  // production gate the skeleton's own traveller abstraction has no
  // equivalent of (its own snapshot states "Interests above 'only if it is
  // right there': none"). These four are the categories the skeleton's own
  // 27 anchors are actually built from (waterfalls, glacier lagoons,
  // geothermal ground, coastal viewpoints, scenic driving) — a defensible
  // minimum to satisfy the gate without inventing a preference the skeleton
  // did not already reflect.
  const baseAnswers = defaultAnswers({ travelerNeeds: [], tripDays: 13 });
  const answers = {
    ...baseAnswers,
    interests: {
      ...baseAnswers.interests,
      scenic_viewpoints: 'frequent' as const,
      scenic_drives: 'frequent' as const,
      geology_and_geothermal: 'frequent' as const,
      easy_nature_walks: 'occasional' as const,
    },
    pace: 'balanced' as const,
    dailyIntensity: 'moderate' as const,
    budgetStyle: 'midrange' as const,
    willDrive: true,
    maxDailyTravelMinutes: 240,
  };
  const tQuestionnaire = performance.now();
  try {
    const questionnaireResult = await questionnaireActions.completeQuestionnaireAction(tripId, answers as never);
    if (questionnaireResult && questionnaireResult.ok === false) {
      throw new Error(`Questionnaire refused: ${questionnaireResult.error}`);
    }
  } catch (error) {
    const digest = (error as { digest?: unknown })?.digest;
    if (typeof digest !== 'string' || !digest.startsWith('NEXT_REDIRECT')) throw error;
  }
  mark('questionnaireMs', tQuestionnaire);

  const profile = getProfile(tripId);
  if (!profile) throw new Error('No traveler profile was saved by the questionnaire step');
  console.log(
    'Profile transport ceiling: drive',
    profile.transport.maxDailyDriveMinutes,
    'min, transport',
    profile.transport.maxDailyTransportMinutes,
    'min',
  );

  // --- Assemble the real SkeletonPlanningContext, exactly as build.ts does --
  const { resolveTripRegion, boardFor } = await import('../src/lib/region');
  const tContext = performance.now();
  trip = getTrip(tripId)!;
  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) throw new Error(`Region resolution failed: ${resolved.error}`);
  const context = resolved.context;
  const board = boardFor(trip, profile, context);
  mark('contextAssemblyMs', tContext);

  console.log('Region', context.region.name, '- places on board:', board.candidates.length);
  console.log('Matrix mode:', context.matrix.mode);

  // --- The adapter: skeleton -> production planner -------------------------
  const { planFromSkeleton, resolveAnchorPlace } = await import('../src/lib/planning/skeleton-adapter');
  const tAdapter = performance.now();
  const result = planFromSkeleton({
    skeleton,
    skeletonPacket,
    context: {
      tripId,
      basics: trip.basics,
      profile,
      region: context.region,
      candidates: board.candidates,
      matrix: context.matrix,
      ...(context.transit ? { transit: context.transit } : {}),
      scheduledNetwork: context.scheduledNetwork,
      access: context.access,
      hours: context.hours,
      weather: context.weather,
      ...(context.food ? { food: context.food } : {}),
      now: new Date(),
      baseId: context.baseId,
    },
  });
  mark('adapterMs', tAdapter);

  // --- Independent resolution report: every base, every one of 27 anchors ---
  const baseReport = (skeleton.bases as Array<{ id: string; name: string; nights: number; placeIndex: number | null }>).map(
    (base: { id: string; name: string; nights: number; placeIndex: number | null }) => {
      const evidencePlace =
        base.placeIndex !== null
          ? (skeletonPacket.places as Array<{ index: number; name: string; lat: number; lng: number }>).find(
              (p) => p.index === base.placeIndex,
            )
          : (skeletonPacket.baseCandidates as Array<{ name: string; lat: number; lng: number }>).find(
              (b) => b.name === base.name,
            );
      if (!evidencePlace) {
        return { skeletonBaseId: base.id, skeletonName: base.name, nights: base.nights, resolution: 'no_evidence_entry' };
      }
      const resolved2 = resolveAnchorPlace(evidencePlace, board.candidates);
      const distanceKm = resolved2.place ? haversineKm(evidencePlace, resolved2.place.coordinates) : null;
      return {
        skeletonBaseId: base.id,
        skeletonName: base.name,
        nights: base.nights,
        resolvedPlaceId: resolved2.place?.id ?? null,
        resolvedPlaceName: resolved2.place ? displayName(resolved2.place) : null,
        method: resolved2.confidence,
        distanceKm,
      };
    },
  );

  const anchorReport: unknown[] = [];
  for (const day of skeleton.days as Array<{ dayNumber: number; anchors: Array<{ placeIndex: number; role: string; why: string }> }>) {
    for (const anchor of day.anchors) {
      const evidencePlace = (skeletonPacket.places as Array<{ index: number; name: string; lat: number; lng: number }>).find(
        (p) => p.index === anchor.placeIndex,
      );
      if (!evidencePlace) {
        anchorReport.push({ dayNumber: day.dayNumber, placeIndex: anchor.placeIndex, resolution: 'no_evidence_entry' });
        continue;
      }
      const resolved2 = resolveAnchorPlace(evidencePlace, board.candidates);
      const distanceKm = resolved2.place ? haversineKm(evidencePlace, resolved2.place.coordinates) : null;
      anchorReport.push({
        dayNumber: day.dayNumber,
        placeIndex: anchor.placeIndex,
        skeletonName: evidencePlace.name,
        role: anchor.role,
        resolvedPlaceId: resolved2.place?.id ?? null,
        resolvedPlaceName: resolved2.place ? displayName(resolved2.place) : null,
        method: resolved2.confidence,
        distanceKm,
      });
    }
  }

  const basesResolved = baseReport.filter((b) => 'resolvedPlaceId' in b && b.resolvedPlaceId).length;
  const anchorsResolved = anchorReport.filter((a) => (a as { resolvedPlaceId?: unknown }).resolvedPlaceId).length;
  const duplicatePlaceIds = duplicates(
    baseReport.map((b) => (b as { resolvedPlaceId?: string | null }).resolvedPlaceId).filter(Boolean) as string[],
  );

  console.log(`Bases resolved: ${basesResolved}/${baseReport.length}`);
  console.log(`Anchors resolved: ${anchorsResolved}/${anchorReport.length}`);

  // --- The result: itinerary, or a typed repair issue -----------------------
  writeFileSync(path.join(OUT_DIR, 'base-resolution-report.json'), JSON.stringify(baseReport, null, 2));
  writeFileSync(path.join(OUT_DIR, 'anchor-resolution-report.json'), JSON.stringify(anchorReport, null, 2));
  writeFileSync(path.join(OUT_DIR, 'production-plan-result.json'), JSON.stringify(result, null, 2));

  const totalWallMs = Math.round(performance.now() - wallStart);
  const skeletonShaAfter = sha256(readFileSync(SKELETON_PATH, 'utf8'));

  const diagnostics = {
    head,
    diffHashBefore: diffHash,
    diffHashAfter: sha256(execSync('git diff HEAD').toString()),
    skeletonShaBefore,
    skeletonShaAfter,
    skeletonUnchanged: skeletonShaBefore === skeletonShaAfter,
    tripId,
    compiledRegionId: finalIntent.selectedCompiledRegionId,
    regionScopeFingerprint: (context.compiled as { scopeFingerprint?: string }).scopeFingerprint ?? null,
    matrixMode: context.matrix.mode,
    boardSize: board.candidates.length,
    basesResolved: `${basesResolved}/${baseReport.length}`,
    anchorsResolved: `${anchorsResolved}/${anchorReport.length}`,
    duplicatePhysicalPlaceResolutions: duplicatePlaceIds,
    modelCalls: liveDiagnostics.model.calls,
    modelEstimatedCostUsd: liveDiagnostics.model.estimatedCostUsd,
    liveDiagnostics,
    timingsMs: timings,
    totalWallMs,
    outcome: result.ok ? 'itinerary' : 'repair_issue',
  };
  writeFileSync(path.join(OUT_DIR, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2));

  console.log('\n=== OUTCOME:', result.ok ? 'PRODUCTION ITINERARY' : 'SkeletonRepairIssue', '===');
  console.log(JSON.stringify(diagnostics, null, 2));
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371.0088;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function displayName(place: { names?: { display?: string }; name?: string }): string {
  return place.names?.display ?? place.name ?? 'unknown';
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return [...dupes];
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
