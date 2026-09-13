import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileRegion, deriveScope } from '@sidequest/compiler';
import { SYNTHETIC_WORLDS, packBackedProviders, syntheticCandidate } from '@sidequest/compiler/testing';
import { DESTINATION_RESOLUTION_VERSION, autoSelect, countTripDays } from '@sidequest/core';
import { getDb } from '@/lib/db/client';
import { createTrip, getItinerary, getReadiness, getSelections, replaceAutoSelections } from '@/lib/db/repository';
import { completeJob, markJobRunning, saveDestinationQuery, saveResolution, saveScope, startJob } from '@/lib/db/compiler-repository';
import { getTripDraft } from '@/lib/db/draft-repository';
import { boardFor, resolveTripRegion, DYNAMIC_REGION_ID } from '@/lib/region';
import { FIXTURE_UNVERIFIABLE_ANCHOR } from '../fixture-composer';
import { boardSignalsFor, defaultProfileFor, generateSidequestPlanForTrip } from '../production-plan';

/**
 * THE REAL PRODUCT PATH, END TO END, WITH FROZEN INPUTS AND ZERO CALLS.
 *
 * Exactly what "Build my trip", "Regenerate", "Quick Plan" and the
 * Auto-Pick-then-Build continuation run in production
 * (`generateSidequestPlanForTrip`), against a real temporary SQLite
 * database, a fixture-compiled region (the same synthetic world the browser
 * suite compiles) and the fixture composer. The model, the geocoder, the
 * router and the map-data provider are all switched off, so nothing here can
 * spend anything — and the whole path still produces a complete, persisted,
 * reloadable itinerary with its package.
 */

const NOW = new Date('2026-08-11T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
let directory: string;
const savedEnv: Record<string, string | undefined> = {};

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-product-flow-'));
  for (const key of ['SIDEQUEST_DB_PATH', 'SIDEQUEST_COMPOSER_PROVIDER', 'SIDEQUEST_COMPILER_PROVIDER', 'ANTHROPIC_API_KEY', 'SIDEQUEST_GEOCODER_PROVIDER', 'SIDEQUEST_POI_PROVIDER', 'SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_ACTION_FENCES']) {
    savedEnv[key] = process.env[key];
  }
  process.env.SIDEQUEST_DB_PATH = join(directory, 'flow.db');
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SIDEQUEST_GEOCODER_PROVIDER;
  delete process.env.SIDEQUEST_POI_PROVIDER;
  delete process.env.SIDEQUEST_ROUTES_PROVIDER;
  getDb();
});

afterEach(() => {
  releaseDatabase();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

async function tripWithCompiledRegion(): Promise<string> {
  const spec = SYNTHETIC_WORLDS.transit_city!;
  const candidate = syntheticCandidate(spec);
  const scope = deriveScope({ candidate, clarifications: { schemaVersion: 1, questions: [], answers: [] }, nights: DATES.length - 1, revision: 1 });
  const compiled = await compileRegion({ compilationId: 'product-flow', scope, dates: [...DATES], months: [8], providers: packBackedProviders(spec), now: NOW });
  if (!compiled.ok) throw new Error(`the world did not compile: ${compiled.code}`);
  const trip = createTrip({ mode: 'known_destination', destinationInput: spec.name, regionId: DYNAMIC_REGION_ID, startDate: DATES[0]!, endDate: DATES[DATES.length - 1]!, arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] }, 'owner');
  saveDestinationQuery(trip.id, 'known_destination', spec.name);
  saveResolution(trip.id, { schemaVersion: DESTINATION_RESOLUTION_VERSION, query: spec.name, normalizedQuery: spec.name.toLowerCase(), candidates: [candidate], ambiguityReasons: [], unambiguousCandidateId: candidate.id, providersConsulted: ['fixture'], resolvedAt: NOW.toISOString() });
  saveScope(trip.id, scope);
  const started = startJob({ tripId: trip.id, scopeFingerprint: 'fp-flow', now: NOW });
  if (started.kind !== 'started') throw new Error('the job did not start');
  markJobRunning(started.job.id, NOW);
  completeJob({ jobId: started.job.id, tripId: trip.id, region: compiled.region, state: 'ready', now: NOW });
  return trip.id;
}

/**
 * The two tests here run the whole canonical orchestrator — compose, resolve
 * every base through the placement ladder, resolve and time both gateways,
 * reconcile, audit, compile, persist and reload — so five seconds is not a
 * meaningful hang and a five-second default only fires under suite contention.
 * Stated per test rather than raised globally, so a genuine hang anywhere else
 * still fails fast.
 */
const ORCHESTRATOR_TIMEOUT_MS = 30_000;

describe('Build my trip, through the canonical orchestrator', () => {
  it('composes, verifies against the compiled region, reconciles, persists and reloads a complete trip with its package', async () => {
    const tripId = await tripWithCompiledRegion();
    const result = await generateSidequestPlanForTrip(tripId, { caller: 'test', now: NOW, mode: 'full' });
    expect(result.ok, result.error).toBe(true);
    expect(result.modelCalls).toHaveLength(0);

    const draft = getTripDraft(tripId);
    expect(draft?.draft.days).toHaveLength(DATES.length);

    const itinerary = getItinerary(tripId);
    expect(itinerary).not.toBeNull();
    expect(itinerary).toEqual(result.result!.itinerary);
    expect(itinerary!.package?.anchors.length).toBe(draft!.draft.days.reduce((s, d) => s + d.anchors.length, 0));
    // Board places verify against the compiled region; the deliberately unverifiable stop is kept as such.
    expect(itinerary!.package!.verification.verified).toBeGreaterThan(0);
    const quiet = itinerary!.package!.anchors.find((a) => a.name === FIXTURE_UNVERIFIABLE_ANCHOR);
    expect(quiet?.disposition).toBe('retained_unverified');
    expect(itinerary!.days.every((d) => d.items.some((i) => i.kind === 'activity'))).toBe(true);
    expect(itinerary!.package!.packing.length).toBeGreaterThan(0);
    expect(itinerary!.package!.beforeYouGo.some((l) => /entry requirements/i.test(l))).toBe(true);
    expect(getReadiness(tripId)?.funnel.scheduled).toBe(itinerary!.package!.verification.scheduled);
  }, ORCHESTRATOR_TIMEOUT_MS);

  it('Regenerate is the same path: a second generation replaces the stored plan and draft', async () => {
    const tripId = await tripWithCompiledRegion();
    const first = await generateSidequestPlanForTrip(tripId, { caller: 'test', now: NOW, mode: 'full' });
    const second = await generateSidequestPlanForTrip(tripId, { caller: 'test', now: new Date(NOW.getTime() + 60_000), mode: 'full' });
    expect(first.ok && second.ok).toBe(true);
    expect(getItinerary(tripId)?.diagnostics.generatedAt).toBe(second.result!.itinerary.diagnostics.generatedAt);
    expect(getTripDraft(tripId)?.createdAt).toBe(new Date(NOW.getTime() + 60_000).toISOString());
  });
});

describe('Quick Plan, through the canonical orchestrator', () => {
  it('a trip with no questionnaire and no compiled region still gets a complete itinerary on the same page', async () => {
    const trip = createTrip({ mode: 'known_destination', destinationInput: 'Harbour City', regionId: DYNAMIC_REGION_ID, startDate: DATES[0]!, endDate: DATES[DATES.length - 1]!, arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] }, 'owner');
    saveDestinationQuery(trip.id, 'known_destination', 'Harbour City');
    const region = await resolveTripRegion(trip);
    expect(region.ok).toBe(false);
    const result = await generateSidequestPlanForTrip(trip.id, { caller: 'test', now: NOW, mode: 'quick' });
    expect(result.ok, result.error).toBe(true);
    const itinerary = getItinerary(trip.id)!;
    expect(itinerary.package).toBeDefined();
    expect(itinerary.days).toHaveLength(DATES.length);
    expect(itinerary.days.every((d) => d.items.some((i) => i.kind === 'activity'))).toBe(true);
    // No evidence anywhere: verification is honestly zero, content is untouched.
    expect(itinerary.package!.verification.verified).toBe(0);
    expect(itinerary.package!.verification.scheduled).toBe(itinerary.package!.verification.anchors);
    expect(itinerary.status).toBe('ready_with_cautions');
  }, ORCHESTRATOR_TIMEOUT_MS);
});

describe('Auto Pick advances into the canonical build', () => {
  it('auto-picked selections become compact board signals for the composition, and the build proceeds', async () => {
    const tripId = await tripWithCompiledRegion();
    const trip = (await import('@/lib/db/repository')).getTrip(tripId)!;
    const region = await resolveTripRegion(trip);
    expect(region.ok).toBe(true);
    if (!region.ok) return;
    const profile = defaultProfileFor(trip, null);
    const board = boardFor(trip, profile, region.context);
    const selection = autoSelect({ candidates: board.candidates, profile, tripDays: countTripDays(trip.basics.startDate, trip.basics.endDate), decided: {}, transitUnmeasured: board.transitUnmeasured });
    replaceAutoSelections(tripId, selection.selectedIds);
    expect(getSelections(tripId).length).toBeGreaterThan(0);
    const signals = boardSignalsFor(board.candidates, getSelections(tripId));
    expect(signals?.mustInclude.length).toBeGreaterThan(0);
    const result = await generateSidequestPlanForTrip(tripId, { caller: 'test', now: NOW, mode: 'full' });
    expect(result.ok, result.error).toBe(true);
    const names = new Set(getItinerary(tripId)!.package!.anchors.map((a) => a.name));
    expect(signals!.mustInclude.some((name) => names.has(name))).toBe(true);
  });
});
