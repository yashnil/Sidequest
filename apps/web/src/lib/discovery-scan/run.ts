import 'server-only';
import { after } from 'next/server';
import { buildDailyWindows, resolveConfig } from '@sidequest/planner';
import { matchNamedMustDos } from './match';
import { productEvent } from '../net/product-events';
import { z } from 'zod';
import {
  assembleScanRegion,
  estimatedScanMatrix,
  normalizeScanProposal,
  planScanPoints,
  scanSufficiency,
  tripDates,
  validateCompiledRegion,
  type DestinationEntityType,
  type Interest,
  type TravelerProfile,
  type Trip,
  type ResolvedPosition,
  type ScanPoint,
  type ScanProposal,
  type ScopeBreadth,
  type TravelTimeMatrixData,
} from '@sidequest/core';
import { getIntent } from '../db/compiler-repository';
import { getProfile, getTrip, setSelection, travellerDecisions } from '../db/repository';
import { beginScan, completeScan, failScan, heartbeatScan, markScanStage, noteScanCounters, saveScanProposalExtras, scanView, type ScanDiagnostics, type ScanView } from '../db/scan-repository';
import { listBookedItems } from '../db/intelligence-repository';
import { listPartyMembersForBrief } from '../db/party-repository';
import { compactBookedFacts } from '../intelligence/booked-facts';
import { ResearchModel } from '../providers/anthropic';
import { reserveModelCalls } from '../compiler/daily-ceiling';
import { isCompositionModelConfigured, isGeocoderEnabled, isPoiProviderEnabled } from '../providers/switches';
import { verificationProviders } from '../planning/verification-providers';
import { buildCanonicalTripBuildInput } from '../planning/canonical-input';
import { composerModel } from '../planning/composition-model';
import { defaultProfileFor } from '../planning/default-profile';
import { destinationEnvelopeFor } from '../planning/destination-envelope';
import { destinationCandidateFor, travelerBriefFor } from '../planning/production-plan';
import { buildFailure, classifyModelError, type BuildFailureCause } from '../planning/build-failure';
import { boardFor, foodProviderChoice, resolveTripRegion } from '../region';
import { seedPlannerAutoPicks } from '../planning/seed-autopicks';
import { SCAN_INSTRUCTION, SCAN_JSON_TAG, SCAN_PROMPT_VERSION, buildScanSupplementTask, buildScanTask, buildScanUntrusted, scanCandidateTarget, scanProposalWireSchema } from './prompt';
import { fixturePlacement, placeScanProposal } from './placement';
import { fixtureScanProposal } from './fixture';
import { fixtureScanFood, groundScanFood, type ScanFoodGrounding } from './food';
import { startAutoBuildAfterScan } from './auto-build';
import { fixtureScan, openDataProposalAvailable, scanPreflight } from './preflight';
import { fixtureOpenDataDeps, liveOpenDataDeps, proposeFromOpenData, type OpenDataDiagnostics } from './open-data-proposal';
import { composerKnownRejected } from '../readiness/probe-cache';

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
/** How many placed points the scan screen's map is sent. */
const SCAN_MAP_POINTS = 80;

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

/**
 * DISCOVERY SCAN FALLBACK — WHICH MODEL FAILURES THE OPEN-DATA PROPOSAL MAY ANSWER.
 *
 * Only the ones that mean *the model could not be asked or could not answer*:
 * no credential, a rejected credential, an allowance or rate limit, a timeout,
 * the vendor unreachable or failing. A malformed answer (`invalid_model_response`)
 * is not here: the model did answer, and replacing a bad answer with a
 * different source would hide a defect the scan must report. Neither is our
 * own `internal_generation_error`.
 */
const MODEL_UNAVAILABLE_CAUSES: ReadonlySet<BuildFailureCause> = new Set<BuildFailureCause>(['composer_not_configured', 'provider_auth_failure', 'provider_quota_or_limit', 'provider_timeout', 'provider_unavailable']);

export function modelUnavailableForScan(cause: BuildFailureCause): boolean {
  return MODEL_UNAVAILABLE_CAUSES.has(cause);
}

/**
 * Whether the model is known unusable before any call: not configured, or a
 * fresh cached probe verdict that the vendor rejected the key. Read from the
 * environment and the probe cache only; a cold cache is not evidence.
 */
function modelUnavailableBeforeCall(): BuildFailureCause | null {
  if (!isCompositionModelConfigured()) return 'composer_not_configured';
  if (composerKnownRejected()) return 'provider_auth_failure';
  return null;
}

/** The typed-destination token that makes the fixture scan exercise the open-data fallback (read from what the traveller typed, never the resolved name). */
function fixtureWantsOpenData(typed: string): boolean {
  return /\bopendata\b/i.test(typed);
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
  /* Production pass — when each stage began, so every scan records where its time went (`diagnostics.timings`). */
  const stageStartedAt: Partial<Record<'proposing' | 'placing' | 'timing' | 'assembling', number>> = {};
  const heartbeat = setInterval(() => {
    try {
      heartbeatScan(tripId, scanId, new Date());
    } catch {
      /* best-effort */
    }
  }, HEARTBEAT_MS);
  const fail = (kind: ScanFailureKind, detail: string) => {
    const ref = failScan(tripId, scanId, kind, new Date());
    productEvent('discovery_failed', tripId, { kind });
    console.error(`Discovery scan failed [ref ${ref}] ${kind}: ${detail}`);
  };
  try {
    const now = new Date();
    const prepared = await scanPromptFor(tripId, now);
    if (!prepared) return fail('internal_generation_error', 'trip disappeared');
    const { trip, profile, envelope, conceptGateways, concept, conceptCountries, canonical, dates, days, namedMustDos, promptInput } = prepared;
    if (!envelope.center || (envelope.center.lat === 0 && envelope.center.lng === 0)) {
      return fail('destination_unplaced', 'no destination centre');
    }

    // --- 1. propose -------------------------------------------------------------
    markScanStage(tripId, scanId, 'proposing', new Date());
    stageStartedAt.proposing = Date.now();
    noteScanCounters(tripId, scanId, { center: envelope.center, scale: envelope.scale ?? null }, new Date());
    let raw: unknown;
    let proposer = 'fixture-proposer';
    let rawInfo: { text: string; stopReason: string | null; outputTokens: number | null } | null = null;
    /* Set when the model could not be asked or could not answer: the open-data proposal stands in, and this is the cause reported if it cannot. */
    let fallback: { cause: BuildFailureCause; detail: string } | null = null;
    if (fixtureScan()) {
      if (fixtureWantsOpenData(trip.basics.destinationInput)) fallback = { cause: 'provider_auth_failure', detail: 'fixture: the typed token asked for the open-data fallback' };
      else raw = fixtureScanProposal(envelope.name, trip.basics.destinationInput, days);
    } else {
      const before = modelUnavailableBeforeCall();
      if (before) {
        fallback = { cause: before, detail: before === 'composer_not_configured' ? 'no composition model is configured' : 'the readiness probe saw the model API reject the credential' };
      } else {
        const reservation = reserveModelCalls(1, { now, caller: options.caller });
        if (!reservation.allowed) {
          fallback = { cause: 'provider_quota_or_limit', detail: reservation.message ?? 'daily allowance' };
        } else {
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
            const cause = classifyModelError(error);
            const detail = `${error instanceof Error ? error.message : 'model call failed'}${seen ? ` | stop=${seen.stopReason} out=${seen.outputTokens} head=${JSON.stringify(seen.text.slice(0, 300))} tail=${JSON.stringify(seen.text.slice(-300))}` : ''}`;
            if (!modelUnavailableForScan(cause)) return fail(cause, detail);
            fallback = { cause, detail };
          }
        }
      }
    }

    /* The traveller's priority interests: personal fit for the open-data ranking and recovery now, sufficiency below. */
    const priorities = (Object.entries(profile.interests) as [Interest, string][]).filter(([, level]) => level === 'core' || level === 'frequent').map(([interest]) => interest);
    const reach = placementReachKm(envelope.scale, days - 1);

    let normalized: Extract<ReturnType<typeof normalizeScanProposal>, { ok: true }>;
    let rawCandidateCount: number;
    let openData: { positions: Map<string, ResolvedPosition | null>; diagnostics: OpenDataDiagnostics; source: string } | null = null;
    if (fallback) {
      /*
       * The model was unavailable: an open-data proposal, labelled as one, then
       * the unchanged place → time → food → assemble → adopt pipeline. Never in
       * addition to a model answer, and never when this deployment has no map
       * data service — then the model's own cause is the honest failure.
       */
      if (!openDataProposalAvailable()) return fail(fallback.cause, `${fallback.detail} | no open-data fallback on this deployment`);
      console.warn(`Discovery scan for ${tripId}: the proposal model is unavailable (${fallback.cause}); proposing from open data.`);
      const deps = fixtureScan() ? fixtureOpenDataDeps(envelope.name) : liveOpenDataDeps();
      const open = await proposeFromOpenData(
        { envelope: { name: envelope.name, center: envelope.center, ...(envelope.scale ? { scale: envelope.scale } : {}) }, days, priorities, carAvailable: canonical.movement.carAvailable, reachKm: reach, countries: conceptCountries, parts: (concept?.parts ?? []).map((part) => ({ label: part.label, center: part.center })) },
        deps,
      );
      if (!open.ok) return fail(fallback.cause, `${fallback.detail} | open-data fallback failed: ${open.reason} (${open.detail})`);
      normalized = open.normalized;
      rawCandidateCount = open.offered;
      proposer = deps.source;
      openData = { positions: open.positions, diagnostics: open.diagnostics, source: deps.source };
    } else {
      const read = normalizeScanProposal(raw);
      if (!read.ok) {
        const seen = rawInfo as { text: string; stopReason: string | null } | null;
        return fail('invalid_model_response', `${read.reason}${seen ? ` | stop=${seen.stopReason} head=${JSON.stringify(seen.text.slice(0, 300))}` : ''}`);
      }
      normalized = read;
      rawCandidateCount = Array.isArray((raw as { candidates?: unknown } | null)?.candidates) ? (raw as { candidates: unknown[] }).candidates.length : 0;
    }
    let proposal: ScanProposal = normalized.proposal;
    {
      /*
       * Every scan says what the model returned and what the normaliser kept. A
       * live Tokyo scan (2026-10-06) produced 4 candidates and its board fell
       * back to composition with nothing on record to say whether the model
       * proposed 4 or proposed 30 and lost 26 here.
       */
      const seen = rawInfo as { stopReason: string | null; outputTokens: number | null } | null;
      const rawCount = rawCandidateCount;
      const drops = normalized.dropped.map((d) => `${d.name}: ${d.reason}`).slice(0, 12);
      console.warn(`Discovery scan proposal for ${tripId}${openData ? ' (open data)' : ''}: ${rawCount} returned, ${proposal.candidates.length} kept, ${normalized.dropped.length} dropped, stop=${seen?.stopReason ?? 'n/a'} out=${seen?.outputTokens ?? 'n/a'}${drops.length > 0 ? ` | ${drops.join('; ')}` : ''}`);
    }
    noteScanCounters(tripId, scanId, { proposed: proposal.candidates.length, bases: proposal.bases.length }, new Date());

    // --- 2. place ---------------------------------------------------------------
    markScanStage(tripId, scanId, 'placing', new Date());
    stageStartedAt.placing = Date.now();
    const placementStarted = Date.now();
    /* An open-data proposal arrives already placed: its positions are the map objects themselves. */
    let placement = openData
      ? { positions: openData.positions, providers: [openData.source === 'fixture-open-data' ? 'fixture-open-data' : 'openstreetmap'], placesCalls: 0, geocoderCalls: 0, diagnostics: [] as Awaited<ReturnType<typeof placeScanProposal>>['diagnostics'] }
      : fixtureScan() || !isGeocoderEnabled()
      ? fixtureScan()
        ? fixturePlacement(proposal, envelope.center)
        : null
      : await placeScanProposal(proposal, {
          center: envelope.center,
          maxDistanceKm: reach,
          ...(envelope.countryCode ? { countryCode: envelope.countryCode } : {}),
          ...(envelope.countryName ? { countryName: envelope.countryName } : {}),
          placesBudget: proposal.candidates.length,
          namedByTraveller: namedMustDos,
          priorities,
          deadline: () => Date.now() - placementStarted > PLACEMENT_DEADLINE_MS,
          onProgress: (placed, attempted) => {
            if (attempted % 4 === 0) noteScanCounters(tripId, scanId, { placed }, new Date());
          },
        });
    if (!placement) return fail('provider_unavailable', 'no geocoder or places provider is configured to place the proposal');
    let plan = planScanPoints(proposal, placement.positions);

    // --- 2b. enough to plan from? one bounded supplement if not -------------------------
    const requested = scanCandidateTarget(days).min;
    const sufficiencyOf = () =>
      scanSufficiency({
        days,
        stopsPerDay: profile.derived.activitySlotsPerDay,
        requested,
        placed: proposal.candidates.filter((c) => plan.placeIdByKey.has(c.key)).map((c) => ({ kind: c.kind, interests: c.interests })),
        priorities,
      });
    const firstSufficiency = sufficiencyOf();
    const recovery: ScanDiagnostics['recovery'] = { attempted: false, reasons: firstSufficiency.reasons, before: { have: firstSufficiency.have, needed: firstSufficiency.needed, kinds: firstSufficiency.distinctKinds } };
    /* No supplement on the open-data path: the supplement is a second model call, and the model is what was unavailable. */
    if (openData) recovery.outcome = 'not_attempted_open_data';
    if (!firstSufficiency.sufficient && !openData) {
      const supplement = await proposeSupplement({ tripId, promptInput, proposal, missingInterests: firstSufficiency.missingInterests, count: Math.max(8, firstSufficiency.needed - firstSufficiency.have + 4), typed: trip.basics.destinationInput, envelopeName: envelope.name, days, caller: options.caller ?? null, now });
      recovery.attempted = true;
      recovery.outcome = supplement.outcome;
      if (supplement.proposal) {
        const supplementPlacement = fixtureScan()
          ? fixturePlacement({ ...supplement.proposal, bases: proposal.bases }, envelope.center)
          : await placeScanProposal({ ...supplement.proposal, bases: [] }, {
              center: envelope.center,
              maxDistanceKm: reach,
              ...(envelope.countryCode ? { countryCode: envelope.countryCode } : {}),
              ...(envelope.countryName ? { countryName: envelope.countryName } : {}),
              placesBudget: supplement.proposal.candidates.length,
              deadline: () => false,
            });
        const positions = new Map(placement.positions);
        for (const c of supplement.proposal.candidates) positions.set(c.key, supplementPlacement.positions.get(c.key) ?? null);
        proposal = { ...proposal, candidates: [...proposal.candidates, ...supplement.proposal.candidates] };
        placement = { ...placement, positions, diagnostics: [...placement.diagnostics, ...supplementPlacement.diagnostics.filter((d) => !d.isBase)], placesCalls: placement.placesCalls + supplementPlacement.placesCalls, geocoderCalls: placement.geocoderCalls + supplementPlacement.geocoderCalls };
        plan = planScanPoints(proposal, placement.positions);
        recovery.added = supplement.proposal.candidates.length;
      }
      const after = sufficiencyOf();
      recovery.after = { have: after.have, needed: after.needed, kinds: after.distinctKinds };
      console.warn(`Discovery scan supplement for ${tripId}: ${recovery.outcome}; ${firstSufficiency.have} → ${after.have} placed (needed ${after.needed}).`);
    }

    /* The scan's own account of itself: what was proposed, what could not be placed and why, and any recovery. Developer-facing; never on the traveller's screen. */
    const placementDiagnostics = placement.diagnostics.filter((d) => d.outcome !== 'placed');
    const diagnostics: ScanDiagnostics = {
      proposalSource: openData ? 'open_data' : fixtureScan() ? 'fixture' : 'model',
      ...(fallback ? { fallbackReason: fallback.cause } : {}),
      ...(openData ? { openData: { source: openData.source, ...openData.diagnostics } } : {}),
      proposal: { returned: rawCandidateCount, kept: normalized.proposal.candidates.length, dropped: normalized.dropped.map((d) => ({ name: d.name, reason: d.reason })), stopReason: (rawInfo as { stopReason: string | null } | null)?.stopReason ?? null, outputTokens: (rawInfo as { outputTokens: number | null } | null)?.outputTokens ?? null },
      envelope: { scale: envelope.scale ?? null, reachKm: reach, center: envelope.center },
      placement: {
        attempted: placement.diagnostics.length,
        unplaced: placementDiagnostics.map((d) => ({ name: d.name, locality: d.locality, category: d.category, isBase: d.isBase, outcome: d.outcome, attempts: d.attempts })),
      },
      assembly: plan.unplaced.filter((u) => u.code !== 'not_placed').map((u) => ({ name: u.name, code: u.code })),
      accessRecovery: placement.diagnostics.filter((d) => d.recovery).map((d) => ({ name: d.name, ...d.recovery! })),
      identities: placement.diagnostics.filter((d) => d.identity && d.identity.type !== 'unchanged').map((d) => d.identity!),
      recovery,
    };
    if (diagnostics.identities && diagnostics.identities.length > 0) {
      console.warn(`Discovery scan lookup names for ${tripId}: ${diagnostics.identities.map((i) => `${i.original} → ${i.lookupName} [${i.type}]`).join('; ')}`);
    }
    if (diagnostics.accessRecovery && diagnostics.accessRecovery.length > 0) {
      console.warn(`Discovery scan access points for ${tripId}: ${diagnostics.accessRecovery.map((r) => `${r.name} [${r.outcome}${r.accessPoint ? ` ${r.accessPoint.kind} via ${r.accessPoint.provider}` : ''}; ${r.queries.length} queries]`).join('; ')}`);
    }
    if (placementDiagnostics.length > 0 || diagnostics.assembly.length > 0) {
      console.warn(`Discovery scan unplaced for ${tripId}: ${[...placementDiagnostics.map((d) => `${d.name} [${d.outcome}]`), ...diagnostics.assembly.map((a) => `${a.name} [${a.code}]`)].join('; ')}`);
    }
    noteScanCounters(
      tripId,
      scanId,
      {
        proposed: proposal.candidates.length,
        placed: plan.points.filter((p) => p.kind === 'place').length,
        unplaced: plan.unplaced.length,
        points: plan.points.slice(0, SCAN_MAP_POINTS).map((p) => ({ name: p.name, lat: p.coordinates.lat, lng: p.coordinates.lng, kind: p.kind })),
      },
      new Date(),
    );
    if (plan.points.filter((p) => p.kind === 'base').length === 0 || plan.points.filter((p) => p.kind === 'place').length < 4) {
      return fail('nothing_placed', `placed ${plan.points.length} of ${proposal.candidates.length + proposal.bases.length}`);
    }

    // --- 3. time ----------------------------------------------------------------
    markScanStage(tripId, scanId, 'timing', new Date());
    stageStartedAt.timing = Date.now();
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
    stageStartedAt.assembling = Date.now();
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
      ...((edges) => (edges ? { edges } : {}))(tripEdgesFor(trip, profile, envelope.center, conceptGateways, envelope.scale)),
      proposal,
      positions: placement.positions,
      plan,
      matrix: timed.matrix,
      createdAt: new Date().toISOString(),
      providers: { proposal: proposer, placement: placement.providers, routing: timed.source },
      ...(openData ? { proposalSource: 'open_data' as const } : {}),
      food: { dataset: food.dataset, status: food.status, source: food.source, detail: food.detail },
    });
    const region = validateCompiledRegion(assembly.region);
    completeScan(tripId, scanId, region, new Date());
    diagnostics.timings = stageTimings(started, stageStartedAt, Date.now());
    try {
      saveScanExtras(tripId, proposal, diagnostics);
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
    productEvent('discovery_completed', tripId, { proposed: proposal.candidates.length, placed: plan.points.filter((p) => p.kind === 'place').length, unplaced: plan.unplaced.length, supplement: recovery.attempted, openData: openData !== null, seconds: Math.round((Date.now() - started) / 1000) });
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
function saveScanExtras(tripId: string, proposal: ScanProposal, diagnostics: ScanDiagnostics): void {
  saveScanProposalExtras(tripId, { foodAreas: proposal.foodAreas, skipped: proposal.skipped, package: proposal.package, diagnostics });
}

/**
 * Everything the scan's one model call is asked, assembled from the stored trip
 * alone — no provider beyond the destination candidate lookup the scan itself
 * makes, and no model. Exported so a thin or odd scan can be diagnosed by
 * replaying exactly what was asked, without spending another call.
 */
export async function scanPromptFor(tripId: string, now: Date) {
  const trip = getTrip(tripId);
  if (!trip) return null;
  const intent = getIntent(tripId);
  const composer = intent?.composer ?? null;
  const profile = getProfile(tripId) ?? defaultProfileFor(trip, composer);
  const candidate = await destinationCandidateFor(trip, intent?.resolution ?? null, intent?.selectedCandidateId ?? null, now);
  const { envelope, rawDestinationPhrase, conceptGateways, concept, conceptCountries } = destinationEnvelopeFor({ trip, intent, candidate, region: null, profile });
  const bookedFacts = compactBookedFacts(listBookedItems(tripId));
  const canonical = buildCanonicalTripBuildInput({ trip, composer, profile, bookedFacts, destinationPhrase: rawDestinationPhrase, now });
  const brief = travelerBriefFor({ input: canonical, envelope, party: listPartyMembersForBrief(tripId, profile.interests as Record<string, string>) });
  const dates = tripDates(trip.basics.startDate, trip.basics.endDate);
  const days = dates.length;
  const namedMustDos = [...canonical.ownWords.mustDo];
  const promptInput = { envelope, brief, startDate: trip.basics.startDate, endDate: trip.basics.endDate, days, namedMustDos };
  return { trip, intent, profile, candidate, envelope, conceptGateways, concept, conceptCountries, canonical, dates, days, namedMustDos, promptInput, task: buildScanTask(promptInput), untrusted: buildScanUntrusted(promptInput) };
}

/**
 * V1 — the one supplementary proposal a thin scan may make: same model, same
 * contract, a task naming what is already proposed and what is missing. At
 * most one call per scan, counted against the same allowance; any failure is
 * an outcome, never a retry.
 */
async function proposeSupplement(input: {
  tripId: string;
  promptInput: Parameters<typeof buildScanTask>[0];
  proposal: ScanProposal;
  missingInterests: readonly string[];
  count: number;
  typed: string;
  envelopeName: string;
  days: number;
  caller: string | null;
  now: Date;
}): Promise<{ outcome: string; proposal: ScanProposal | null }> {
  const already = input.proposal.candidates.map((c) => c.name);
  let raw: unknown;
  if (fixtureScan()) {
    raw = fixtureScanProposal(input.envelopeName, input.typed, input.days, { already });
  } else {
    if (!isCompositionModelConfigured()) return { outcome: 'model_unavailable', proposal: null };
    const reservation = reserveModelCalls(1, { now: input.now, caller: input.caller });
    if (!reservation.allowed) return { outcome: 'allowance_used', proposal: null };
    try {
      const model = new ResearchModel({ maxCalls: 1, maxRetries: 0, model: composerModel() });
      raw = await model.structured({
        promptVersion: SCAN_PROMPT_VERSION,
        instruction: SCAN_INSTRUCTION,
        task: buildScanSupplementTask(input.promptInput, { already, count: input.count, missingInterests: input.missingInterests }),
        untrusted: buildScanUntrusted(input.promptInput),
        schema: scanProposalWireSchema as unknown as z.ZodType<unknown>,
        validationSchema: z.unknown() as z.ZodType<unknown>,
        schemaEnforcement: 'grammar',
        allowEnforcementFallback: true,
        jsonWrapperTag: SCAN_JSON_TAG,
        effort: 'low',
        maxTokens: SCAN_MAX_TOKENS,
        timeoutMs: SCAN_MODEL_TIMEOUT_MS,
        callLabel: 'discovery_scan_supplement',
        attempt: 1,
      });
    } catch (error) {
      console.warn(`Discovery scan supplement failed for ${input.tripId}: ${error instanceof Error ? error.message : 'unknown'}`);
      return { outcome: 'model_failed', proposal: null };
    }
  }
  const record = (raw ?? {}) as Record<string, unknown>;
  const withBases = Array.isArray(record.bases) && record.bases.length > 0 ? record : { ...record, bases: input.proposal.bases.map((b) => ({ name: b.name, locality: b.locality, nightsHint: b.nightsHint, why: b.why })) };
  const normalized = normalizeScanProposal(withBases);
  if (!normalized.ok) return { outcome: 'invalid_response', proposal: null };
  /* Nothing already proposed comes back in under a new key: the same name, or one whose leading name matches, is the same place. */
  const seen = new Set(already.map((n) => n.toLowerCase()));
  const offset = input.proposal.candidates.length;
  const fresh = normalized.proposal.candidates
    .filter((c) => !seen.has(c.name.toLowerCase()))
    .map((c, i) => ({ ...c, key: `c${offset + i + 1}` }));
  if (fresh.length === 0) return { outcome: 'none_new', proposal: null };
  return { outcome: 'added', proposal: { ...normalized.proposal, candidates: fresh } };
}

/**
 * V1 — where the trip starts and ends and how much of each edge day is usable,
 * from the same daily windows the planner uses (arrival settle and departure
 * lead already applied). The arrival point is the first gateway with a
 * position, else the destination centre.
 */
function tripEdgesFor(trip: Trip, profile: TravelerProfile, center: { lat: number; lng: number }, gateways: readonly { coordinates?: { lat: number; lng: number } }[], scale: string | undefined) {
  /* Only a gateway with a position, or a city the traveller named, is where they arrive. A region's centre is a centroid, not an arrival point: unknown edges change nothing. */
  const point = gateways.find((g) => g.coordinates)?.coordinates ?? (scale === 'city' || scale === 'local' ? center : null);
  if (!point) return undefined;
  const windows = buildDailyWindows(trip.basics, profile, resolveConfig());
  const usable = (w: (typeof windows)[number] | undefined) => (w ? Math.max(0, w.window.endMinute - w.window.startMinute) : 0);
  return { arrival: point, departure: point, arrivalUsableMinutes: usable(windows[0]), departureUsableMinutes: usable(windows[windows.length - 1]) };
}

export { matchNamedMustDos };

/**
 * Production pass — milliseconds per scan stage, from the stage boundaries the
 * scan already marks: preparing (destination lookup, brief) until proposing,
 * then each stage until the next, and assembling until completion. Stored on
 * `discovery_scans.extras_json.diagnostics.timings` so latency percentiles are
 * read from real rows rather than guessed.
 */
export function stageTimings(started: number, at: Partial<Record<'proposing' | 'placing' | 'timing' | 'assembling', number>>, finished: number): NonNullable<ScanDiagnostics['timings']> {
  const order = ['proposing', 'placing', 'timing', 'assembling'] as const;
  const out: NonNullable<ScanDiagnostics['timings']> = { preparingMs: Math.max(0, (at.proposing ?? finished) - started), totalMs: Math.max(0, finished - started) };
  order.forEach((stage, i) => {
    const begin = at[stage];
    if (begin === undefined) return;
    const next = order.slice(i + 1).map((s) => at[s]).find((v) => v !== undefined) ?? finished;
    out[`${stage}Ms`] = Math.max(0, next - begin);
  });
  return out;
}
