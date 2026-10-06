import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_WORLDS, syntheticCandidate } from '@sidequest/compiler/testing';
import { DESTINATION_RESOLUTION_VERSION } from '@sidequest/core';

/**
 * THE DISCOVERY SCAN, END TO END, WITH ZERO CALLS.
 *
 * A dynamic destination with no compiled region and no authored data gets a
 * real Discovery Board: the fixture proposer stands in for the model, fixture
 * placement for the geocoder, distance estimates for the router — and the
 * region that comes out is a stored, adopted `CompiledRegion` the board, the
 * pre-selection and the build all read.
 */

vi.mock('next/server', () => ({ after: () => { throw new Error('no request scope'); } }));

const NOW = new Date('2026-08-11T09:00:00.000Z');
let directory: string;
const savedEnv: Record<string, string | undefined> = {};
const KEYS = ['SIDEQUEST_DB_PATH', 'SIDEQUEST_COMPOSER_PROVIDER', 'SIDEQUEST_COMPILER_PROVIDER', 'ANTHROPIC_API_KEY', 'SIDEQUEST_GEOCODER_PROVIDER', 'SIDEQUEST_ROUTES_PROVIDER', 'SIDEQUEST_ACTION_FENCES', 'SIDEQUEST_FIXTURES'];

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  directory = mkdtempSync(join(tmpdir(), 'sidequest-scan-'));
  for (const key of KEYS) savedEnv[key] = process.env[key];
  process.env.SIDEQUEST_DB_PATH = join(directory, 'scan.db');
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

async function dynamicTrip(destination: string, start = '2026-08-12', end = '2026-08-17'): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const { saveDestinationQuery, saveResolution } = await import('@/lib/db/compiler-repository');
  const { DYNAMIC_REGION_ID } = await import('@/lib/region');
  const spec = SYNTHETIC_WORLDS.transit_city!;
  const candidate = { ...syntheticCandidate(spec), displayName: destination };
  const trip = createTrip({ mode: 'known_destination', destinationInput: destination, regionId: DYNAMIC_REGION_ID, startDate: start, endDate: end, arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] }, 'owner');
  saveDestinationQuery(trip.id, 'known_destination', destination);
  saveResolution(trip.id, { schemaVersion: DESTINATION_RESOLUTION_VERSION, query: destination, normalizedQuery: destination.toLowerCase(), candidates: [candidate], ambiguityReasons: [], unambiguousCandidateId: candidate.id, providersConsulted: ['fixture'], resolvedAt: NOW.toISOString() });
  return trip.id;
}

describe('discovery scan', () => {
  it('turns a destination with no region into a stored, adopted, board-ready region', async () => {
    const tripId = await dynamicTrip('Testmouth');
    const { getTrip, getSelections } = await import('@/lib/db/repository');
    const { resolveTripRegion, boardFor } = await import('@/lib/region');
    expect((await resolveTripRegion(getTrip(tripId)!)).ok).toBe(false);

    const { startDiscoveryScan } = await import('./run');
    const started = startDiscoveryScan(tripId, { autoBuild: false, caller: 'test', now: NOW });
    expect(started.started).toBe(true);
    // Without a request scope the work runs immediately; wait for the row to settle.
    const { scanView } = await import('@/lib/db/scan-repository');
    for (let i = 0; i < 100 && scanView(tripId).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
    const view = scanView(tripId);
    expect(view.state).toBe('ready');
    expect(view.counters.proposed).toBeGreaterThan(10);

    const resolved = await resolveTripRegion(getTrip(tripId)!);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.context.compiled.compilerVersion).toBe('discovery-scan/1');
    const { defaultProfileFor } = await import('@/lib/planning/production-plan');
    const board = boardFor(getTrip(tripId)!, defaultProfileFor(getTrip(tripId)!, null), resolved.context);
    expect(board.candidates.length).toBeGreaterThan(10);
    // Sidequest's pre-selection is seeded and labelled as Sidequest's, never the traveller's.
    const picks = getSelections(tripId);
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((p) => p.source === 'auto')).toBe(true);
  });

  it('records a typed failure instead of a board when the proposer refuses', async () => {
    const tripId = await dynamicTrip('unscannable bay');
    const { startDiscoveryScan } = await import('./run');
    startDiscoveryScan(tripId, { autoBuild: false, caller: 'test', now: NOW });
    const { scanView } = await import('@/lib/db/scan-repository');
    for (let i = 0; i < 100 && scanView(tripId).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
    const view = scanView(tripId);
    expect(view.state).toBe('failed');
    expect(view.failureKind).toBe('internal_generation_error');
    expect(view.failureRef).toMatch(/^[0-9a-f]{8}$/);
  });

  it('attaches to a running scan instead of starting a second one', async () => {
    const tripId = await dynamicTrip('Testmouth');
    const { beginScan } = await import('@/lib/db/scan-repository');
    beginScan(tripId, new Date(), { autoBuild: false });
    const { startDiscoveryScan } = await import('./run');
    expect(startDiscoveryScan(tripId, { autoBuild: false, caller: 'test' }).started).toBe(false);
  });
});

describe('a thin scan (live Tokyo finding)', () => {
  it('asks once for more, places only the new places, records why, and plans on the planner', async () => {
    const tripId = await dynamicTrip('thinscan harbour');
    const { startDiscoveryScan } = await import('./run');
    startDiscoveryScan(tripId, { autoBuild: false, caller: 'test', now: NOW });
    const { scanView, getScanProposalExtras } = await import('@/lib/db/scan-repository');
    for (let i = 0; i < 150 && scanView(tripId).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(scanView(tripId).state).toBe('ready');
    const diagnostics = getScanProposalExtras(tripId)?.diagnostics;
    expect(diagnostics?.proposal.kept).toBe(4);
    expect(diagnostics?.recovery.attempted).toBe(true);
    expect(diagnostics?.recovery.outcome).toBe('added');
    expect(diagnostics?.recovery.reasons).toContain('too_few_places');
    expect(diagnostics!.recovery.after!.have).toBeGreaterThan(diagnostics!.recovery.before.have);
    expect(scanView(tripId).counters.proposed).toBeGreaterThan(4);

    const { generateSidequestPlanForTrip } = await import('@/lib/planning/production-plan');
    const result = await generateSidequestPlanForTrip(tripId, { caller: 'test', now: NOW });
    expect(result.ok, result.error).toBe(true);
    expect(result.result!.itinerary.package?.planning?.mode).toBe('planner');
  }, 60_000);

  it('a sufficient scan never spends the supplement', async () => {
    const tripId = await dynamicTrip('Testmouth');
    const { startDiscoveryScan } = await import('./run');
    startDiscoveryScan(tripId, { autoBuild: false, caller: 'test', now: NOW });
    const { scanView, getScanProposalExtras } = await import('@/lib/db/scan-repository');
    for (let i = 0; i < 100 && scanView(tripId).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
    expect(getScanProposalExtras(tripId)?.diagnostics?.recovery.attempted).toBe(false);
  });
});

describe('scan regions are estimated, and say so (live Utah finding)', () => {
  it('a planner build on a distance-estimated region labels no leg "measured"', async () => {
    const tripId = await dynamicTrip('Testmouth');
    const { startDiscoveryScan } = await import('./run');
    startDiscoveryScan(tripId, { autoBuild: false, caller: 'test', now: NOW });
    const { scanView } = await import('@/lib/db/scan-repository');
    for (let i = 0; i < 100 && scanView(tripId).state === 'running'; i += 1) await new Promise((r) => setTimeout(r, 20));
    const { generateSidequestPlanForTrip } = await import('@/lib/planning/production-plan');
    const result = await generateSidequestPlanForTrip(tripId, { caller: 'test', now: NOW });
    expect(result.ok, result.error).toBe(true);
    const legs = result.result!.itinerary.days.flatMap((d) => d.items.filter((i) => i.kind === 'travel').map((i) => i.travel!));
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.filter((l) => l.provenance === 'measured')).toHaveLength(0);
    expect(result.result!.itinerary.transportStrategy.dataDisclosure).not.toMatch(/measured by estimated/);
    /* Live Hanoi finding: a walking matrix's figure was reused for a bus leg (95 km in 1,480 minutes). No ridden leg is ever timed at walking pace. */
    for (const leg of legs) {
      if (leg.mode === 'walk' || leg.minutes === null || !leg.estimate || leg.estimate.straightLineKm < 5) continue;
      expect(leg.estimate.straightLineKm / (leg.minutes / 60), `${leg.fromName} → ${leg.toName} by ${leg.mode}`).toBeGreaterThan(8);
    }
  }, 60_000);
});

describe('named must-dos', () => {
  it('match board places by whole words, either way round, and nothing fuzzier', async () => {
    const { matchNamedMustDos } = await import('./run');
    const places = [{ id: 'a', name: 'Delicate Arch Trail' }, { id: 'b', name: 'Arches National Park Visitor Center' }, { id: 'c', name: 'Senso-ji' }];
    expect(matchNamedMustDos(['Delicate Arch'], places)).toEqual(['a']);
    expect(matchNamedMustDos(['the Senso-ji temple in Asakusa'], places)).toEqual(['c']);
    expect(matchNamedMustDos(['Arch'], places)).toEqual([]);
    expect(matchNamedMustDos(['Arches'], places)).toEqual([]);
    expect(matchNamedMustDos(['Arches National Park'], places)).toEqual(['b']);
  });
});
