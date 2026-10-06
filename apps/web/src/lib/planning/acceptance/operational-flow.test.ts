import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compileRegion, deriveScope } from '@sidequest/compiler';
import { SYNTHETIC_WORLDS, packBackedProviders, syntheticCandidate } from '@sidequest/compiler/testing';
import { DESTINATION_RESOLUTION_VERSION } from '@sidequest/core';
import { getDb } from '@/lib/db/client';
import { createTrip, getItinerary, getTrip } from '@/lib/db/repository';
import { completeJob, markJobRunning, saveDestinationQuery, saveResolution, saveScope, startJob } from '@/lib/db/compiler-repository';
import { loadTripIntelligence } from '@/lib/intelligence/load';
import { DYNAMIC_REGION_ID } from '@/lib/region';
import { FIXTURE_UNLISTED_VENUE } from '../fixture-composer';
import { generateSidequestPlanForTrip } from '../production-plan';

/**
 * LIVE WORLD V1 CLOSURE — THE CANONICAL FLOW, WITH RECORDED GOOGLE RESPONSES.
 *
 *   Build my trip → fixture draft names a venue the board does not carry →
 *   registry offers Google Places (recorded) → identity seam → operational
 *   seam → normalised evidence → reconciler → persisted disposition →
 *   reload → travel intelligence access state (what the Trip Hub renders).
 *
 * The real adapter, field masks and normalisation run; only the network is
 * a saved JSON file. Zero calls anywhere.
 */
const NOW = new Date('2026-08-11T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
let directory: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['SIDEQUEST_DB_PATH', 'SIDEQUEST_COMPOSER_PROVIDER', 'SIDEQUEST_COMPILER_PROVIDER', 'ANTHROPIC_API_KEY', 'GOOGLE_MAPS_API_KEY', 'SIDEQUEST_GEOCODER_PROVIDER', 'SIDEQUEST_POI_PROVIDER', 'SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_ACTION_FENCES', 'SIDEQUEST_PLACES_FIXTURE'];

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

const GOOGLE_ID = 'ChIJ-old-mill-museum';
// The recorded hit's address and website are Google content the plan must never store.
const searchHit = { places: [{ id: GOOGLE_ID, displayName: { text: 'The Old Mill Museum', languageCode: 'en' }, location: { latitude: 38.7235, longitude: -9.1365 }, types: ['museum', 'tourist_attraction', 'point_of_interest'], primaryType: 'museum', formattedAddress: 'Rua do Moinho 3, Harbour City', addressComponents: [{ longText: 'Harbour City', shortText: 'Harbour City', types: ['locality', 'political'] }] }] };
const periods = [2, 3, 4, 5, 6, 0].map((day) => ({ open: { day, hour: 10, minute: 0 }, close: { day, hour: 17, minute: 0 } }));
function fixtureFile(name: string, details: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify({ searchText: { [`${FIXTURE_UNLISTED_VENUE}, Harbour City`]: searchHit }, places: { [GOOGLE_ID]: details } }));
  return path;
}
const OPEN_DETAILS = { id: GOOGLE_ID, displayName: { text: 'The Old Mill Museum' }, location: { latitude: 38.7235, longitude: -9.1365 }, types: ['museum'], businessStatus: 'OPERATIONAL', regularOpeningHours: { periods, weekdayDescriptions: ['Monday: Closed'] }, websiteUri: 'https://oldmill.example', googleMapsUri: 'https://maps.google.com/?cid=1' };

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-operational-flow-'));
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.SIDEQUEST_DB_PATH = join(directory, 'flow.db');
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  /* V1 — this file proves what verification does to venues a model named; the planner names only board places, so the model-composed path is pinned. */
  process.env.SIDEQUEST_PLANNING_MODE = 'model';
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.SIDEQUEST_GEOCODER_PROVIDER;
  delete process.env.SIDEQUEST_POI_PROVIDER;
  delete process.env.SIDEQUEST_ROUTES_PROVIDER;
  getDb();
});

afterEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

async function tripWithCompiledRegion(): Promise<string> {
  const spec = SYNTHETIC_WORLDS.transit_city!;
  const candidate = syntheticCandidate(spec);
  const scope = deriveScope({ candidate, clarifications: { schemaVersion: 1, questions: [], answers: [] }, nights: DATES.length - 1, revision: 1 });
  const compiled = await compileRegion({ compilationId: 'operational-flow', scope, dates: [...DATES], months: [8], providers: packBackedProviders(spec), now: NOW });
  if (!compiled.ok) throw new Error(`the world did not compile: ${compiled.code}`);
  const trip = createTrip({ mode: 'known_destination', destinationInput: spec.name, regionId: DYNAMIC_REGION_ID, startDate: DATES[0]!, endDate: DATES[DATES.length - 1]!, arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] }, 'owner');
  saveDestinationQuery(trip.id, 'known_destination', spec.name);
  saveResolution(trip.id, { schemaVersion: DESTINATION_RESOLUTION_VERSION, query: spec.name, normalizedQuery: spec.name.toLowerCase(), candidates: [candidate], ambiguityReasons: [], unambiguousCandidateId: candidate.id, providersConsulted: ['fixture'], resolvedAt: NOW.toISOString() });
  saveScope(trip.id, scope);
  const started = startJob({ tripId: trip.id, scopeFingerprint: 'fp-operational', now: NOW });
  if (started.kind !== 'started') throw new Error('the job did not start');
  markJobRunning(started.job.id, NOW);
  completeJob({ jobId: started.job.id, tripId: trip.id, region: compiled.region, state: 'ready', now: NOW });
  return trip.id;
}

describe('canonical flow — recorded Google operational evidence reaches the plan and the hub', () => {
  it('a museum the board does not know is identified, its regular hours checked, the outcome persisted, reloaded and surfaced as an access state with attribution', async () => {
    process.env.SIDEQUEST_PLACES_FIXTURE = fixtureFile('open.json', OPEN_DETAILS);
    const tripId = await tripWithCompiledRegion();
    const result = await generateSidequestPlanForTrip(tripId, { caller: 'test', now: NOW, mode: 'full' });
    expect(result.ok, result.error).toBe(true);
    expect(result.modelCalls).toHaveLength(0);
    expect(result.providerBudget?.spent.place_identity).toBeGreaterThanOrEqual(1);
    expect(result.providerBudget?.spent.place_operational).toBe(1);

    const stored = getItinerary(tripId)!;
    expect(stored).toEqual(result.result!.itinerary);
    const anchor = stored.package!.anchors.find((a) => a.name === FIXTURE_UNLISTED_VENUE)!;
    expect(anchor.disposition).toBe('preserved');
    expect(anchor.identity?.method).toBe('places');
    expect(anchor.identity?.providerRef).toBe(GOOGLE_ID);
    const stop = stored.days.flatMap((d) => d.items).find((i) => i.title === FIXTURE_UNLISTED_VENUE)!;
    // Open that weekday; the visit either sits inside the window, was pulled to opening, or honestly runs past closing.
    expect(['open_at_time', 'opens_later', 'closes_earlier']).toContain(stop.operational?.outcome);
    expect(stop.operational?.attribution).toBe('Place data © Google');
    expect(stop.operational?.recheck).toBe(stop.operational?.outcome !== 'open_at_time');
    expect(stop.startMinute).toBeGreaterThanOrEqual(600);
    // PRODUCT RECOVERY V1 — the legs before it now carry honest estimates, so the visit lands in the late afternoon; it still starts before the recorded 18:00 close.
    expect(stop.startMinute).toBeLessThan(1080);
    // Terms: no Google hours values, no Google name, no website persisted.
    const json = JSON.stringify(stored);
    expect(json).not.toContain('Rua do Moinho');
    expect(json).not.toMatch(/regularOpeningHours|weekly|oldmill\.example|weekdayDescriptions/);

    // The Trip Hub reads the intelligence layer; the access state carries the provider's evidence and attribution.
    const loaded = loadTripIntelligence({ trip: getTrip(tripId)!, itinerary: stored, now: NOW, persist: false });
    const access = loaded.intelligence.access.find((a) => a.title === FIXTURE_UNLISTED_VENUE)!;
    expect(['confirmed_open', 'hours_known']).toContain(access.state);
    expect(access.attribution).toBe('Place data © Google');
    expect(access.sourceName).toBe('Google');
    const claim = loaded.intelligence.sourceRegistry.find((c) => c.id === `claim:access:${stop.id}`)!;
    expect(claim.state).toBe('confirmed');
    expect(claim.authority).toBe('authoritative_structured');
    expect(claim.sourceName).toContain('Place data © Google');
  });

  it('a permanently closed venue is taken off with the provider named; a timeout leaves it on, unverified', async () => {
    process.env.SIDEQUEST_PLACES_FIXTURE = fixtureFile('closed.json', { ...OPEN_DETAILS, businessStatus: 'CLOSED_PERMANENTLY' });
    const closedTrip = await tripWithCompiledRegion();
    const closed = await generateSidequestPlanForTrip(closedTrip, { caller: 'test', now: NOW, mode: 'full' });
    expect(closed.ok, closed.error).toBe(true);
    const gone = getItinerary(closedTrip)!;
    expect(gone.package!.anchors.find((a) => a.name === FIXTURE_UNLISTED_VENUE)?.disposition).toBe('rejected_contradiction');
    expect(gone.unscheduled.find((u) => u.name === FIXTURE_UNLISTED_VENUE)?.reason).toMatch(/permanently closed/);

    process.env.SIDEQUEST_PLACES_FIXTURE = fixtureFile('timeout.json', 'timeout');
    const slowTrip = await tripWithCompiledRegion();
    const slow = await generateSidequestPlanForTrip(slowTrip, { caller: 'test', now: NOW, mode: 'full' });
    expect(slow.ok, slow.error).toBe(true);
    const kept = getItinerary(slowTrip)!;
    expect(kept.package!.anchors.find((a) => a.name === FIXTURE_UNLISTED_VENUE)?.disposition).toBe('preserved');
    const stop = kept.days.flatMap((d) => d.items).find((i) => i.title === FIXTURE_UNLISTED_VENUE)!;
    expect(stop.operational?.outcome).toBe('unavailable');
    const loaded = loadTripIntelligence({ trip: getTrip(slowTrip)!, itinerary: kept, now: NOW, persist: false });
    expect(loaded.intelligence.access.find((a) => a.title === FIXTURE_UNLISTED_VENUE)?.state).toBe('hours_unknown');
  });
});
