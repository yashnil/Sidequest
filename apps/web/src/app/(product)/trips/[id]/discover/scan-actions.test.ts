import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_WORLDS, syntheticCandidate } from '@sidequest/compiler/testing';
import { DESTINATION_RESOLUTION_VERSION } from '@sidequest/core';
import { mintSessionToken } from '@/lib/net/session-signature';

/**
 * V1 CONVERGENCE — "FIND PLACES FOR MY TRIP", THE ACTION AND THE POLLING ROUTE.
 *
 * Zero calls: the fixture proposer, fixture placement and distance estimates
 * stand in for the model, the geocoder and the router. What is under test is
 * the door — who may press it, that a second press is the same scan, that a
 * scan that cannot run says so in the traveller's words — and the route the
 * scan screen polls, which must carry nothing about providers or configuration.
 */

process.env.SIDEQUEST_SESSION_SECRET = 'scan-actions-test-secret';
const OWNER = mintSessionToken('scan-owner');
const STRANGER = mintSessionToken('scan-stranger');

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, after: () => { throw new Error('no request scope'); } };
});
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/navigation', () => ({ redirect: () => {} }));

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  cookies: async () => ({
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { value };
    },
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));

/* The auto-build hook is exercised for its decision, not for a whole build running on after the test. */
const startedBuilds: { tripId: string; buildKey: string; mode?: string }[] = [];
vi.mock('@/lib/planning/build-runs', () => ({
  startBuildRun: (input: { tripId: string; buildKey: string; mode?: string }) => {
    startedBuilds.push(input);
    return { started: true, view: { state: 'running' } };
  },
}));

const NOW = new Date('2026-08-11T09:00:00.000Z');
const KEYS = ['SIDEQUEST_DB_PATH', 'SIDEQUEST_COMPOSER_PROVIDER', 'SIDEQUEST_COMPILER_PROVIDER', 'ANTHROPIC_API_KEY', 'SIDEQUEST_GEOCODER_PROVIDER', 'SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_ACTION_FENCES', 'SIDEQUEST_FIXTURES', 'NODE_ENV'];
const savedEnv: Record<string, string | undefined> = {};
let directory: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  jar.clear();
  jar.set('sidequest_session', OWNER);
  startedBuilds.length = 0;
  directory = mkdtempSync(join(tmpdir(), 'sidequest-scan-actions-'));
  for (const key of KEYS) savedEnv[key] = process.env[key];
  process.env.SIDEQUEST_DB_PATH = join(directory, 'scan-actions.db');
  process.env.SIDEQUEST_COMPOSER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
  process.env.SIDEQUEST_FIXTURES = 'allow';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.SIDEQUEST_GEOCODER_PROVIDER;
  delete process.env.SIDEQUEST_ROUTES_PROVIDER;
});

afterEach(() => {
  releaseDatabase();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

async function dynamicTrip(destination: string): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const { saveDestinationQuery, saveResolution } = await import('@/lib/db/compiler-repository');
  const { DYNAMIC_REGION_ID } = await import('@/lib/region');
  const spec = SYNTHETIC_WORLDS.transit_city!;
  const candidate = { ...syntheticCandidate(spec), displayName: destination };
  const trip = createTrip({ mode: 'known_destination', destinationInput: destination, regionId: DYNAMIC_REGION_ID, startDate: '2026-08-12', endDate: '2026-08-17', arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] }, OWNER);
  saveDestinationQuery(trip.id, 'known_destination', destination);
  saveResolution(trip.id, { schemaVersion: DESTINATION_RESOLUTION_VERSION, query: destination, normalizedQuery: destination.toLowerCase(), candidates: [candidate], ambiguityReasons: [], unambiguousCandidateId: candidate.id, providersConsulted: ['fixture'], resolvedAt: NOW.toISOString() });
  return trip.id;
}

async function settle(tripId: string): Promise<void> {
  const { scanView } = await import('@/lib/db/scan-repository');
  for (let i = 0; i < 150 && scanView(tripId).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
}

async function poll(tripId: string): Promise<{ status: number; body: Record<string, unknown>; raw: string; cache: string | null }> {
  const { GET } = await import('@/app/api/trips/[id]/scan/route');
  const response = await GET(new Request(`http://localhost/api/trips/${tripId}/scan`), { params: Promise.resolve({ id: tripId }) });
  const raw = await response.text();
  return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw, cache: response.headers.get('cache-control') };
}

describe('startDiscoveryScanAction', () => {
  it('starts a scan for the owner and the board-ready region follows', async () => {
    const tripId = await dynamicTrip('Testmouth');
    const { startDiscoveryScanAction } = await import('./scan-actions');
    const result = await startDiscoveryScanAction(tripId, { autoBuild: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.started).toBe(true);
    await settle(tripId);
    const { scanView } = await import('@/lib/db/scan-repository');
    expect(scanView(tripId).state).toBe('ready');
    expect(startedBuilds).toHaveLength(0);
  });

  it('refuses a browser that does not own the trip, and starts nothing', async () => {
    const tripId = await dynamicTrip('Testmouth');
    jar.set('sidequest_session', STRANGER);
    const { startDiscoveryScanAction } = await import('./scan-actions');
    const result = await startDiscoveryScanAction(tripId, { autoBuild: true });
    expect(result.ok).toBe(false);
    const { scanView } = await import('@/lib/db/scan-repository');
    expect(scanView(tripId).state).toBe('none');
  });

  it('attaches to a running scan instead of starting a second one', async () => {
    const tripId = await dynamicTrip('Testmouth');
    const { beginScan, scanView } = await import('@/lib/db/scan-repository');
    const { scanId } = beginScan(tripId, new Date(), { autoBuild: false });
    const { startDiscoveryScanAction } = await import('./scan-actions');
    const result = await startDiscoveryScanAction(tripId, { autoBuild: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.started).toBe(false);
    expect(result.view.state).toBe('running');
    expect(scanView(tripId).scanId).toBe(scanId);
  });

  it('says in the traveller’s words when no scan can run here', async () => {
    const tripId = await dynamicTrip('Testmouth');
    delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
    delete process.env.SIDEQUEST_COMPILER_PROVIDER;
    const { startDiscoveryScanAction } = await import('./scan-actions');
    const result = await startDiscoveryScanAction(tripId, { autoBuild: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure?.kind).toBe('composer_not_configured');
    expect(result.failure?.retryable).toBe(false);
    expect(result.error).not.toMatch(/ANTHROPIC|API key|SIDEQUEST_|anthropic|fixture/i);
  });

  it('starts the build the traveller asked to follow, once, under the scan’s own key', async () => {
    const tripId = await dynamicTrip('Testmouth');
    const { startDiscoveryScanAction } = await import('./scan-actions');
    const result = await startDiscoveryScanAction(tripId, { autoBuild: true });
    expect(result.ok).toBe(true);
    await settle(tripId);
    const { scanView } = await import('@/lib/db/scan-repository');
    const view = scanView(tripId);
    expect(view.state).toBe('ready');
    expect(startedBuilds).toEqual([expect.objectContaining({ tripId, buildKey: `scan-${view.scanId}`, mode: 'quick' })]);
    // Consumed: a second look at the same scan never starts another build.
    expect(view.autoBuild).toBe(false);
    const { startAutoBuildAfterScan } = await import('@/lib/discovery-scan/auto-build');
    expect(startAutoBuildAfterScan(tripId, view.scanId!, null).started).toBe(false);
    expect(startedBuilds).toHaveLength(1);
  });

  it('records a typed failure, with a reference, when the scan fails', async () => {
    const tripId = await dynamicTrip('unscannable bay');
    const { startDiscoveryScanAction } = await import('./scan-actions');
    expect((await startDiscoveryScanAction(tripId, { autoBuild: true })).ok).toBe(true);
    await settle(tripId);
    const polled = await poll(tripId);
    expect(polled.body.state).toBe('failed');
    const failure = polled.body.failure as { kind: string; heading: string; message: string; retryable: boolean; ref: string };
    expect(failure.kind).toBe('internal_generation_error');
    expect(failure.retryable).toBe(true);
    expect(failure.ref).toMatch(/^[0-9a-f]{8}$/);
    expect(polled.body.autoBuildPending).toBe(false);
    expect(startedBuilds).toHaveLength(0);
  });
});

describe('GET /api/trips/[id]/scan', () => {
  it('answers the owner with stages, real counts and nothing about providers', async () => {
    const tripId = await dynamicTrip('Testmouth');
    const before = await poll(tripId);
    expect(before.status).toBe(200);
    expect(before.cache).toBe('no-store');
    expect(before.body.state).toBe('none');

    const { startDiscoveryScanAction } = await import('./scan-actions');
    await startDiscoveryScanAction(tripId, { autoBuild: false });
    await settle(tripId);
    const after = await poll(tripId);
    expect(after.status).toBe(200);
    expect(after.body.state).toBe('ready');
    expect(Object.keys(after.body).sort()).toEqual(['autoBuildPending', 'autoBuildStarted', 'counters', 'elapsedSeconds', 'failure', 'label', 'lines', 'reached', 'stage', 'stages', 'state'].sort());
    expect((after.body.counters as { proposed: number }).proposed).toBeGreaterThan(10);
    expect((after.body.lines as string[])[0]).toMatch(/^Proposed \d+ places that fit you/);
    // No provider, model, environment or region identifiers reach the traveller.
    expect(after.raw).not.toMatch(/fixture|anthropic|claude|nominatim|valhalla|openrouteservice|google|SIDEQUEST_|API_KEY|compiledRegionId|scanId|caller/i);
  });

  it('is a plain 404 for a browser that does not own the trip, and for a malformed id', async () => {
    const tripId = await dynamicTrip('Testmouth');
    jar.set('sidequest_session', STRANGER);
    const foreign = await poll(tripId);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ error: 'not_found' });
    const { GET } = await import('@/app/api/trips/[id]/scan/route');
    const malformed = await GET(new Request('http://localhost/api/trips/x/scan'), { params: Promise.resolve({ id: '../etc' }) });
    expect(malformed.status).toBe(404);
  });
});

describe('scan failure copy', () => {
  it('says the two placement failures calmly, with a way forward', async () => {
    const { scanFailureCopy } = await import('@/lib/discovery-scan/view');
    for (const kind of ['destination_unplaced', 'nothing_placed']) {
      const copy = scanFailureCopy(kind, 'abcd1234');
      expect(copy.retryable).toBe(true);
      expect(copy.message).toBe('We couldn’t place enough of this destination on the map to build a board. Try a more specific place name, or plan without the board.');
      expect(copy.ref).toBe('abcd1234');
    }
    expect(scanFailureCopy('something we never wrote').kind).toBe('internal_generation_error');
  });
});
