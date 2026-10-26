import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_WORLDS, syntheticCandidate } from '@sidequest/compiler/testing';
import { DESTINATION_RESOLUTION_VERSION } from '@sidequest/core';
import type * as DailyCeiling from '../compiler/daily-ceiling';
import type * as OpenData from './open-data-proposal';

type DailyCeilingModule = typeof DailyCeiling;
type OpenDataModule = typeof OpenData;

/**
 * THE DISCOVERY SCAN WHEN THE MODEL CANNOT ANSWER — ON THE REAL (NON-FIXTURE) PATH.
 *
 * Production finding: the composition key was rejected (401), the scan's one
 * proposal call failed, and the traveller got "Sidequest can't reach its
 * research right now" and no board. These run the live branch of `run.ts`
 * with the model and the open-data sources mocked — zero network:
 *
 * - a model that is unavailable (auth, timeout, not configured) falls back to
 *   the open-data proposal and the board completes;
 * - a model that answered badly still fails `invalid_model_response`;
 * - when open data fails too, the scan fails with the model's ORIGINAL cause.
 */

vi.mock('next/server', () => ({ after: () => { throw new Error('no request scope'); } }));

const structured = vi.fn();
vi.mock('../providers/anthropic', () => ({
  ResearchModel: class {
    structured = structured;
  },
}));
vi.mock('../compiler/daily-ceiling', async (original) => ({
  ...(await original<DailyCeilingModule>()),
  reserveModelCalls: () => ({ allowed: true }),
}));
const openDataMode = { fail: false };
vi.mock('./open-data-proposal', async (original) => {
  const actual = await original<OpenDataModule>();
  return {
    ...actual,
    liveOpenDataDeps: () =>
      openDataMode.fail
        ? { source: 'openstreetmap+wikidata', fetchGroup: async () => { throw new Error('busy'); }, fetchSitelinks: async () => new Map() }
        : { ...actual.fixtureOpenDataDeps('Testmouth'), source: 'openstreetmap+wikidata' },
  };
});

const NOW = new Date('2026-08-11T09:00:00.000Z');
let directory: string;
const savedEnv: Record<string, string | undefined> = {};
const KEYS = ['SIDEQUEST_DB_PATH', 'SIDEQUEST_COMPOSER_PROVIDER', 'SIDEQUEST_COMPILER_PROVIDER', 'ANTHROPIC_API_KEY', 'SIDEQUEST_GEOCODER_PROVIDER', 'SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_ACTION_FENCES', 'SIDEQUEST_FIXTURES', 'SIDEQUEST_POI_PROVIDER', 'SIDEQUEST_FOOD_PROVIDER', 'SIDEQUEST_ROUTES_GLOBAL_PROVIDER'];

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-scan-fallback-'));
  for (const key of KEYS) savedEnv[key] = process.env[key];
  process.env.SIDEQUEST_DB_PATH = join(directory, 'scan.db');
  delete process.env.SIDEQUEST_COMPOSER_PROVIDER;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  process.env.SIDEQUEST_ACTION_FENCES = 'off';
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.SIDEQUEST_POI_PROVIDER = 'overpass';
  process.env.SIDEQUEST_FOOD_PROVIDER = 'off';
  delete process.env.SIDEQUEST_GEOCODER_PROVIDER;
  delete process.env.SIDEQUEST_ROUTES_PROVIDER;
  delete process.env.SIDEQUEST_ROUTES_GLOBAL_PROVIDER;
  structured.mockReset();
  openDataMode.fail = false;
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no network in this test'); }));
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  const trip = createTrip({ mode: 'known_destination', destinationInput: destination, regionId: DYNAMIC_REGION_ID, startDate: '2026-08-12', endDate: '2026-08-17', arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] }, 'owner');
  saveDestinationQuery(trip.id, 'known_destination', destination);
  saveResolution(trip.id, { schemaVersion: DESTINATION_RESOLUTION_VERSION, query: destination, normalizedQuery: destination.toLowerCase(), candidates: [candidate], ambiguityReasons: [], unambiguousCandidateId: candidate.id, providersConsulted: ['fixture'], resolvedAt: NOW.toISOString() });
  return trip.id;
}

async function scan(tripId: string) {
  const { startDiscoveryScan } = await import('./run');
  const started = startDiscoveryScan(tripId, { autoBuild: false, caller: 'test', now: NOW });
  const { scanView, getScanProposalExtras } = await import('@/lib/db/scan-repository');
  for (let i = 0; i < 200 && scanView(tripId).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
  return { started, view: scanView(tripId), diagnostics: getScanProposalExtras(tripId)?.diagnostics };
}

function modelError(code: string, status?: number): Error {
  return Object.assign(new Error(`model ${code}`), { name: 'ResearchModelError', code, ...(status !== undefined ? { status } : {}) });
}

describe('the scan when the proposal model is unavailable', () => {
  it('a rejected credential falls back to open data and the board completes', async () => {
    structured.mockRejectedValue(modelError('auth_rejected', 401));
    const tripId = await dynamicTrip('Testmouth');
    const { started, view, diagnostics } = await scan(tripId);
    expect(started.started).toBe(true);
    expect(view.state).toBe('ready');
    expect(structured).toHaveBeenCalledTimes(1);
    expect(diagnostics?.proposalSource).toBe('open_data');
    expect(diagnostics?.fallbackReason).toBe('provider_auth_failure');
    expect(view.counters.proposed).toBeGreaterThan(8);
    const { getTrip } = await import('@/lib/db/repository');
    const { resolveTripRegion } = await import('@/lib/region');
    const resolved = await resolveTripRegion(getTrip(tripId)!);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.context.compiled.sourceManifest.providers.map((p) => p.name)).toContain('openstreetmap+wikidata');
  }, 30_000);

  it('a timeout falls back too', async () => {
    structured.mockRejectedValue(modelError('timeout'));
    const { view, diagnostics } = await scan(await dynamicTrip('Testmouth'));
    expect(view.state).toBe('ready');
    expect(diagnostics?.fallbackReason).toBe('provider_timeout');
  }, 30_000);

  it('no model configured: the preflight lets the scan start and no model is called', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { scanPreflight } = await import('./preflight');
    expect(scanPreflight()).toEqual({ ok: true });
    const { view, diagnostics } = await scan(await dynamicTrip('Testmouth'));
    expect(view.state).toBe('ready');
    expect(structured).not.toHaveBeenCalled();
    expect(diagnostics?.fallbackReason).toBe('composer_not_configured');
  }, 30_000);

  it('no model and no map data service: the preflight still refuses, in the traveller’s words', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.SIDEQUEST_POI_PROVIDER;
    const { scanPreflight } = await import('./preflight');
    expect(scanPreflight()).toEqual({ ok: false, cause: 'composer_not_configured' });
  });

  it('a malformed answer is the model’s defect, never a fallback', async () => {
    structured.mockResolvedValue({ nonsense: true });
    const { view, diagnostics } = await scan(await dynamicTrip('Testmouth'));
    expect(view.state).toBe('failed');
    expect(view.failureKind).toBe('invalid_model_response');
    expect(diagnostics).toBeUndefined();
  }, 30_000);

  it('malformed output thrown by the transport is not a fallback either', async () => {
    structured.mockRejectedValue(modelError('malformed_output'));
    const { view } = await scan(await dynamicTrip('Testmouth'));
    expect(view.state).toBe('failed');
    expect(view.failureKind).toBe('invalid_model_response');
  }, 30_000);

  it('when open data fails too, the scan fails with the model’s original cause', async () => {
    structured.mockRejectedValue(modelError('auth_rejected', 401));
    openDataMode.fail = true;
    const { view } = await scan(await dynamicTrip('Testmouth'));
    expect(view.state).toBe('failed');
    expect(view.failureKind).toBe('provider_auth_failure');
  }, 30_000);

  it('without a map data service the model’s failure stands as it was', async () => {
    structured.mockRejectedValue(modelError('auth_rejected', 401));
    delete process.env.SIDEQUEST_POI_PROVIDER;
    const { view } = await scan(await dynamicTrip('Testmouth'));
    expect(view.state).toBe('failed');
    expect(view.failureKind).toBe('provider_auth_failure');
  }, 30_000);
});
