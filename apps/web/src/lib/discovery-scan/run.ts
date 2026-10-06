import 'server-only';
import { after } from 'next/server';
import { matchNamedMustDos } from './match';
import { z } from 'zod';
import {
  assembleScanRegion,
  estimatedScanMatrix,
  normalizeScanProposal,
  planScanPoints,
  tripDates,
  validateCompiledRegion,
  type DestinationEntityType,
  type ScanPoint,
  type ScanProposal,
  type ScopeBreadth,
  type TravelTimeMatrixData,
} from '@sidequest/core';
import { getIntent } from '../db/compiler-repository';
import { getProfile, getTrip, setSelection, travellerDecisions } from '../db/repository';
import { beginScan, completeScan, failScan, heartbeatScan, markScanStage, noteScanCounters, saveScanProposalExtras, scanView, type ScanView } from '../db/scan-repository';
import { listBookedItems } from '../db/intelligence-repository';
import { listPartyMembersForBrief } from '../db/party-repository';
import { compactBookedFacts } from '../intelligence/booked-facts';
import { ResearchModel } from '../providers/anthropic';
import { reserveModelCalls } from '../compiler/daily-ceiling';
import { isGeocoderEnabled, isPoiProviderEnabled } from '../providers/switches';
import { verificationProviders } from '../planning/verification-providers';
import { buildCanonicalTripBuildInput } from '../planning/canonical-input';
import { composerModel } from '../planning/composition-model';
import { defaultProfileFor } from '../planning/default-profile';
import { destinationEnvelopeFor } from '../planning/destination-envelope';
import { destinationCandidateFor, travelerBriefFor } from '../planning/production-plan';
import { buildFailure, classifyModelError, type BuildFailureCause } from '../planning/build-failure';
import { boardFor, foodProviderChoice, resolveTripRegion } from '../region';
import { seedPlannerAutoPicks } from '../planning/seed-autopicks';
import { SCAN_INSTRUCTION, SCAN_JSON_TAG, SCAN_PROMPT_VERSION, buildScanTask, buildScanUntrusted, scanProposalWireSchema } from './prompt';
import { fixturePlacement, placeScanProposal } from './placement';
import { fixtureScanProposal } from './fixture';
import { fixtureScanFood, groundScanFood, type ScanFoodGrounding } from './food';
import { startAutoBuildAfterScan } from './auto-build';
import { fixtureScan, scanPreflight } from './preflight';

/**
 * V1 CONVERGENCE — THE DISCOVERY SCAN, END TO END.
 *
 * propose (one model call) → place (places provider / geocoder) → time
 * (router matrix, else labelled estimates) → assemble (a `CompiledRegion`) →
 * adopt → seed Sidequest's pre-selection. Each boundary writes the durable
 * scan row, so the screen waiting on it reads real stages and real counts.
 *
 * Runs after the response (like a build run), heartbeats while the model is
 * silent, and turns every failure into a typed, traveller-safe kind. A scan
 * never edits an itinerary and never starts a build unless the traveller asked
 * for one ("Plan with smart defaults" → `autoBuild`).
 */

const SCAN_MODEL_TIMEOUT_MS = 150_000;
const SCAN_MAX_TOKENS = 16_000;
const PLACEMENT_DEADLINE_MS = 120_000;
const HEARTBEAT_MS = 10_000;

export type ScanFailureKind = BuildFailureCause | 'destination_unplaced' | 'nothing_placed';

export interface StartScanResult {
  started: boolean;
  view: ScanView;
  failure?: ReturnType<typeof buildFailure>;
}

/* `scanPreflight` and `fixtureScan` live in `./preflight` so a page render can ask without importing this module's providers. */
export { scanPreflight };

function schedule(work: () => Promise<void>): void {
  try {
    after(work);
  } catch {
    void work();
  }
}

/**
 * Begin a scan, or attach to the one already running. Idempotent per trip: a
 * second press while a scan runs returns that scan; a press after a finished
 * scan starts a fresh one (a rescan replaces the board's candidate pool).
 */
export function startDiscoveryScan(tripId: string, options: { autoBuild: boolean; caller: string | null; now?: Date }): StartScanResult {
  const now = options.now ?? new Date();
  const current = scanView(tripId, now);
  if (current.state === 'running') return { started: false, view: current };
  const preflight = scanPreflight();
  if (!preflight.ok) return { started: false, view: current, failure: buildFailure(preflight.cause) };
  const { scanId } = beginScan(tripId, now, { autoBuild: options.autoBuild });
  schedule(() => runDiscoveryScan(tripId, scanId, { caller: options.caller }));
  return { started: true, view: scanView(tripId, now) };
}

function entityTypeFor(scale: string | undefined): DestinationEntityType {
  switch (scale) {
    case 'country':
      return 'country';
    case 'multi_country':
      return 'multi_country';
    case 'region':
      return 'natural_region';
    case 'subregion':
      return 'subregion';
    case 'local':
      return 'neighbourhood';
    default:
      return 'city';
  }
}

function breadthFor(scale: string | undefined): ScopeBreadth {
  return (['local', 'city', 'subregion', 'region', 'country', 'multi_country'] as const).find((b) => b === scale) ?? 'city';
}

/** How far from the centre a match may be, by the destination's own scale. */
export function placementReachKm(scale: string | undefined, nights: number): number {
  const base = scale === 'continental' ? 4000 : scale === 'multi_country' ? 3000 : scale === 'country' ? 1600 : scale === 'region' ? 500 : scale === 'subregion' ? 250 : 120;
  return Math.max(base, Math.min(base * 2, 60 * Math.max(1, nights)));
}

async function measureMatrix(points: readonly ScanPoint[], mode: 'car' | 'foot', deadline: () => boolean): Promise<{ matrix: TravelTimeMatrixData; source: string; measuredPairs: number; totalPairs: number }> {
  const estimate = estimatedScanMatrix(points, mode);
  const totalPairs = points.length * (points.length - 1);
  const routing = verificationProviders().routing;
  if (!routing || deadline() || points.length < 2) return { matrix: estimate, source: 'distance estimates', measuredPairs: 0, totalPairs };
  try {
    const result = await routing.matrix({ points: points.map((p) => ({ id: p.id, lat: p.coordinates.lat, lng: p.coordinates.lng })), mode, maxElements: points.length * points.length });
    const index = new Map(result.ids.map((id, i) => [id, i]));
    let measuredPairs = 0;
    const minutes = estimate.minutes.map((row) => [...row]);
    const km = estimate.km.map((row) => [...row]);
    estimate.ids.forEach((from, i) => {
      estimate.ids.forEach((to, j) => {
        if (i === j) return;
        const a = index.get(from);
        const b = index.get(to);
        if (a === undefined || b === undefined) return;
        const m = result.minutes[a]?.[b];
        const k = result.km[a]?.[b];
        if (typeof m === 'number' && Number.isFinite(m) && m > 0 && result.provenance.kind === 'measured') {
          minutes[i]![j] = Math.round(m);
          if (typeof k === 'number' && Number.isFinite(k)) km[i]![j] = Math.round(k * 10) / 10;
          measuredPairs += 1;
        }
      });
    });
    const all = measuredPairs === totalPairs;
    return {
      matrix: {
        mode,
        ids: estimate.ids,
        minutes,
        km,
        provenance: all
          ? { kind: 'measured', note: `Measured by ${routing.name}.`, source: routing.name }
          : { kind: 'estimated', note: `${measuredPairs} of ${totalPairs} journeys measured by ${routing.name}; the rest estimated from distance.`, source: routing.name },
      },
      source: measuredPairs > 0 ? routing.name : 'distance estimates',
      measuredPairs,
      totalPairs,
    };
  } catch (error) {
    console.warn('Scan matrix: the router did not answer; using estimates', error instanceof Error ? error.message : error);
    return { matrix: estimate, source: 'distance estimates', measuredPairs: 0, totalPairs };
  }
}

/**
 * The scan's food step. Food switched off (`SIDEQUEST_FOOD_PROVIDER=off`) → no
 * food data; fixture switches → a synthetic dataset; no POI provider
 * (`SIDEQUEST_POI_PROVIDER=overpass`, the same opt-in the compiler's food stage
 * reads) → no food data, said so; otherwise OSM venues near the scan's points.
 * Never throws.
 */
async function scanFoodFor(input: {
  regionId: string;
  destinationName: string;
  points: readonly ScanPoint[];
  proposal: ScanProposal;
  envelope: { center: { lat: number; lng: number }; countryCode?: string | null; countryName?: string | null };
  reach: number;
}): Promise<ScanFoodGrounding> {
  const today = new Date().toISOString().slice(0, 10);
  const off = (detail: string): ScanFoodGrounding => ({ dataset: null, status: 'disabled', source: null, boxes: 0, failedBoxes: 0, calls: 0, unroutable: 0, detail });
  try {
    if (foodProviderChoice() === 'off') return off('Food data is switched off on this deployment; meals are described rather than named.');
    if (fixtureScan()) return fixtureScanFood({ regionId: input.regionId, destinationName: input.destinationName, points: input.points, today });
    if (!isPoiProviderEnabled()) return off('No map data source for food is configured; meals are described rather than named.');
    const grounded = await groundScanFood(
      {
        regionId: input.regionId,
        destinationName: input.destinationName,
        points: input.points,
        foodAreas: input.proposal.foodAreas,
        center: input.envelope.center,
        maxDistanceKm: input.reach,
        ...(input.envelope.countryCode ? { countryCode: input.envelope.countryCode } : {}),
        ...(input.envelope.countryName ? { countryName: input.envelope.countryName } : {}),
        today,
      },
      { geocodeArea: isGeocoderEnabled() ? undefined : null },
    );
    console.warn(`Scan food: ${grounded.status}, ${grounded.dataset?.venues.length ?? 0} venues from ${grounded.boxes} boxes (${grounded.failedBoxes} failed, ${grounded.calls} calls, ${grounded.unroutable} beyond a door walk).`);
    return grounded;
  } catch (error) {
    console.warn('Scan food step failed; the region has no food data', error instanceof Error ? error.message : error);
    return { dataset: null, status: 'unavailable', source: null, boxes: 0, failedBoxes: 0, calls: 0, unroutable: 0, detail: 'The map data service did not answer for food, so meals are described rather than named.' };
  }
}

export async function runDiscoveryScan(tripId: string, scanId: string, options: { caller: string | null }): Promise<void> {
  const started = Date.now();
  const heartbeat = setInterval(() => {
    try {
      heartbeatScan(tripId, scanId, new Date());
    } catch {
      /* best-effort */
    }
  }, HEARTBEAT_MS);
  const fail = (kind: ScanFailureKind, detail: string) => {
    const ref = failScan(tripId, scanId, kind, new Date());
    console.error(`Discovery scan failed [ref ${ref}] ${kind}: ${detail}`);
  };
  try {
    const now = new Date();
    const trip = getTrip(tripId);
    if (!trip) return fail('internal_generation_error', 'trip disappeared');
    const intent = getIntent(tripId);
    const composer = intent?.composer ?? null;
    const profile = getProfile(tripId) ?? defaultProfileFor(trip, composer);
    const candidate = await destinationCandidateFor(trip, intent?.resolution ?? null, intent?.selectedCandidateId ?? null, now);
    const { envelope, rawDestinationPhrase } = destinationEnvelopeFor({ trip, intent, candidate, region: null, profile });
    if (!envelope.center || (envelope.center.lat === 0 && envelope.center.lng === 0)) {
      return fail('destination_unplaced', 'no destination centre');
    }
    const bookedFacts = compactBookedFacts(listBookedItems(tripId));
    const canonical = buildCanonicalTripBuildInput({ trip, composer, profile, bookedFacts, destinationPhrase: rawDestinationPhrase, now });
    const brief = travelerBriefFor({ input: canonical, envelope, party: listPartyMembersForBrief(tripId, profile.interests as Record<string, string>) });
    const dates = tripDates(trip.basics.startDate, trip.basics.endDate);
    const days = dates.length;
    const namedMustDos = [...canonical.ownWords.mustDo];
    const promptInput = { envelope, brief, startDate: trip.basics.startDate, endDate: trip.basics.endDate, days, namedMustDos };

    // --- 1. propose -------------------------------------------------------------
    markScanStage(tripId, scanId, 'proposing', new Date());
    let raw: unknown;
    let proposer = 'fixture-proposer';
    let rawInfo: { text: string; stopReason: string | null; outputTokens: number | null } | null = null;
    if (fixtureScan()) {
      raw = fixtureScanProposal(envelope.name, trip.basics.destinationInput, days);
    } else {
      const reservation = reserveModelCalls(1, { now, caller: options.caller });
      if (!reservation.allowed) return fail('provider_quota_or_limit', reservation.message ?? 'daily allowance');
      const model = new ResearchModel({ maxCalls: 1, maxRetries: 0, model: composerModel() });
      proposer = composerModel();
      try {
        raw = await model.structured({
          promptVersion: SCAN_PROMPT_VERSION,
          instruction: SCAN_INSTRUCTION,
          task: buildScanTask(promptInput),
          untrusted: buildScanUntrusted(promptInput),
          schema: scanProposalWireSchema as unknown as z.ZodType<unknown>,
          validationSchema: z.unknown() as z.ZodType<unknown>,
          schemaEnforcement: 'grammar',
          allowEnforcementFallback: true,
          jsonWrapperTag: SCAN_JSON_TAG,
          effort: 'low',
          maxTokens: SCAN_MAX_TOKENS,
          timeoutMs: SCAN_MODEL_TIMEOUT_MS,
          callLabel: 'discovery_scan',
          attempt: 1,
          onResponse: (info) => {
            rawInfo = { text: info.text, stopReason: info.stopReason, outputTokens: info.outputTokens };
          },
        });
      } catch (error) {
        const seen = rawInfo as { text: string; stopReason: string | null; outputTokens: number | null } | null;
        return fail(classifyModelError(error), `${error instanceof Error ? error.message : 'model call failed'}${seen ? ` | stop=${seen.stopReason} out=${seen.outputTokens} head=${JSON.stringify(seen.text.slice(0, 300))} tail=${JSON.stringify(seen.text.slice(-300))}` : ''}`);
      }
    }
    const normalized = normalizeScanProposal(raw);
    if (!normalized.ok) {
      const seen = rawInfo as { text: string; stopReason: string | null } | null;
      return fail('invalid_model_response', `${normalized.reason}${seen ? ` | stop=${seen.stopReason} head=${JSON.stringify(seen.text.slice(0, 300))}` : ''}`);
    }
    const proposal: ScanProposal = normalized.proposal;
    {
      /*
       * Every scan says what the model returned and what the normaliser kept. A
       * live Tokyo scan (2026-10-06) produced 4 candidates and its board fell
       * back to composition with nothing on record to say whether the model
       * proposed 4 or proposed 30 and lost 26 here.
       */
      const seen = rawInfo as { stopReason: string | null; outputTokens: number | null } | null;
      const rawCount = Array.isArray((raw as { candidates?: unknown } | null)?.candidates) ? ((raw as { candidates: unknown[] }).candidates.length) : 0;
      const drops = normalized.dropped.map((d) => `${d.name}: ${d.reason}`).slice(0, 12);
      console.warn(`Discovery scan proposal for ${tripId}: ${rawCount} returned, ${proposal.candidates.length} kept, ${normalized.dropped.length} dropped, stop=${seen?.stopReason ?? 'n/a'} out=${seen?.outputTokens ?? 'n/a'}${drops.length > 0 ? ` | ${drops.join('; ')}` : ''}`);
    }
    noteScanCounters(tripId, scanId, { proposed: proposal.candidates.length, bases: proposal.bases.length }, new Date());

    // --- 2. place ---------------------------------------------------------------
    markScanStage(tripId, scanId, 'placing', new Date());
    const placementStarted = Date.now();
    const reach = placementReachKm(envelope.scale, days - 1);
    const placement = fixtureScan() || !isGeocoderEnabled()
      ? fixtureScan()
        ? fixturePlacement(proposal, envelope.center)
        : null
      : await placeScanProposal(proposal, {
          center: envelope.center,
          maxDistanceKm: reach,
          ...(envelope.countryCode ? { countryCode: envelope.countryCode } : {}),
          ...(envelope.countryName ? { countryName: envelope.countryName } : {}),
          placesBudget: proposal.candidates.length,
          deadline: () => Date.now() - placementStarted > PLACEMENT_DEADLINE_MS,
          onProgress: (placed, attempted) => {
            if (attempted % 4 === 0) noteScanCounters(tripId, scanId, { placed }, new Date());
          },
        });
    if (!placement) return fail('provider_unavailable', 'no geocoder or places provider is configured to place the proposal');
    const plan = planScanPoints(proposal, placement.positions);
    noteScanCounters(tripId, scanId, { placed: plan.points.filter((p) => p.kind === 'place').length, unplaced: plan.unplaced.length }, new Date());
    if (plan.points.filter((p) => p.kind === 'base').length === 0 || plan.points.filter((p) => p.kind === 'place').length < 4) {
      return fail('nothing_placed', `placed ${plan.points.length} of ${proposal.candidates.length + proposal.bases.length}`);
    }

    // --- 3. time ----------------------------------------------------------------
    markScanStage(tripId, scanId, 'timing', new Date());
    const mode: 'car' | 'foot' = canonical.movement.carAvailable === false ? 'foot' : 'car';
    const timed = fixtureScan()
      ? { matrix: estimatedScanMatrix(plan.points, mode), source: 'distance estimates', measuredPairs: 0, totalPairs: plan.points.length * (plan.points.length - 1) }
      : await measureMatrix(plan.points, mode, () => false);
    noteScanCounters(tripId, scanId, { timed: timed.measuredPairs, measured: timed.matrix.provenance.kind === 'measured' }, new Date());

    // --- 3b. somewhere to eat (open map data; never fails the scan) -------------------
    const regionId = `scan-${tripId.slice(0, 8)}-${scanId}`;
    const food = await scanFoodFor({ regionId, destinationName: envelope.name, points: plan.points, proposal, envelope: { center: envelope.center, countryCode: envelope.countryCode ?? null, countryName: envelope.countryName ?? null }, reach });

    // --- 4. assemble, validate, adopt ------------------------------------------------
    markScanStage(tripId, scanId, 'assembling', new Date());
    const assembly = assembleScanRegion({
      regionId,
      destinationName: envelope.name,
      entityType: entityTypeFor(envelope.scale),
      breadth: breadthFor(envelope.scale),
      center: envelope.center,
      ...(envelope.countryCode ? { countryCode: envelope.countryCode } : {}),
      timeZone: envelope.timeZone ?? 'UTC',
      dates,
      carAvailable: canonical.movement.carAvailable,
      maxBaseChanges: canonical.movement.maxBaseChanges.value ?? 1,
      proposal,
      positions: placement.positions,
      plan,
      matrix: timed.matrix,
      createdAt: new Date().toISOString(),
      providers: { proposal: proposer, placement: placement.providers, routing: timed.source },
      food: { dataset: food.dataset, status: food.status, source: food.source, detail: food.detail },
    });
    const region = validateCompiledRegion(assembly.region);
    completeScan(tripId, scanId, region, new Date());
    try {
      saveScanExtras(tripId, proposal);
    } catch {
      /* extras are display-only */
    }

    // --- 5. Sidequest's pre-selection, respecting every decision already made ---
    try {
      const resolved = await resolveTripRegion(getTrip(tripId)!);
      if (resolved.ok) {
        const board = boardFor(trip, profile, resolved.context);
        /*
         * The places the traveller already named ("I already have a plan", or
         * must-dos typed at setup) are their own includes, not Sidequest's
         * suggestions: matched to the board by name and written as user rows
         * before the pre-selection, so the planner treats them as fixed.
         */
        const named = matchNamedMustDos(namedMustDos, board.candidates.map((c) => ({ id: c.place.id, name: c.place.name })));
        const decided = travellerDecisions(tripId);
        for (const placeId of named) if (!decided[placeId]) setSelection(tripId, placeId, 'included', 'user');
        seedPlannerAutoPicks({ trip, profile, region: resolved.context, candidates: board.candidates });
      }
    } catch (error) {
      console.warn('Scan pre-selection failed; the board stays unpicked', error instanceof Error ? error.message : error);
    }
    console.warn(`Discovery scan ready for ${tripId} in ${Math.round((Date.now() - started) / 1000)}s: ${region.places.length} places, ${region.basePortfolio?.bases.length ?? 1} bases, matrix ${timed.matrix.provenance.kind} (${timed.measuredPairs}/${timed.totalPairs}).`);

    // --- 6. "Plan with smart defaults": the build the traveller asked to follow the scan (slice D) ---
    startAutoBuildAfterScan(tripId, scanId, options.caller);
  } catch (error) {
    fail('internal_generation_error', error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : 'unknown');
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * What the scan proposed that is not a place to plan — food areas, the classics
 * left out on purpose, and the practical package — kept beside the region for
 * the board and the build to read. Stored as a small JSON row; never planned.
 */
function saveScanExtras(tripId: string, proposal: ScanProposal): void {
  saveScanProposalExtras(tripId, { foodAreas: proposal.foodAreas, skipped: proposal.skipped, package: proposal.package });
}

export { matchNamedMustDos };
