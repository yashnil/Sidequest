import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveDiagnostics } from '../providers/live';
import { emptyUsage } from '../providers/anthropic';

/**
 * A BUILD WHOSE RESEARCH CREDENTIAL WAS REJECTED FAILS LOUDLY, AT THE RUNNER.
 *
 * Twelve consecutive live builds ran against a dead key. The transport 401'd
 * every research call, each stage degraded exactly as it does for a bad
 * minute, and every build completed as a quiet `partial` with zero extracted
 * facts — "0 of 260 questions answered", hours, costs and safety all skipped —
 * while charging the day's allowance. Nothing failed, so nothing said so, and
 * a whole review round was run on artifacts nobody knew were hollow.
 *
 * The transport now counts credential rejections on the usage ledger the
 * runner reads (`ModelUsage.authFailures`); this file asserts the runner's
 * half: a run whose transport reported any credential rejection is failed with
 * `provider_credentials_missing` — non-retryable, the code whose traveller
 * copy names the deployment's configuration — instead of committing the hollow
 * artifact. The control beside it proves the boundary is exactly the auth
 * class: the same degraded run with no credential rejection still commits,
 * because bounded degradation for transient failures is the designed
 * behaviour.
 *
 * Built like `limits.wiring.test.ts`: the open provider stack is replaced at
 * the module seam so its diagnostics can be authored, and `compileRegion` is
 * replaced so no compilation happens — the subject is what the runner does
 * with the result and the counters, not the compile.
 */

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

/** The diagnostics the mocked open stack will report for the next run. */
let nextDiagnostics: LiveDiagnostics | null = null;

function liveDiagnostics(authFailures: number): LiveDiagnostics {
  return {
    geocoderCalls: 1,
    geocoderCacheHits: 0,
    poiCalls: 1,
    poiCacheHits: 0,
    poiElements: 0,
    pagesRevalidated: 0,
    routeCalls: 1,
    routePairs: 0,
    routeCacheHits: 0,
    wikidataCalls: 0,
    sourceSearches: 0,
    pagesFetched: 0,
    pagesRejected: 0,
    model: { ...emptyUsage(), calls: authFailures, authFailures },
    timeZone: null,
    timeZoneCalls: 0,
    timeZoneCacheHits: 0,
    transitCalls: 0,
    transitPairsRequested: 0,
    transitPairsMeasured: 0,
    timeZoneDataVersion: null,
    attributions: [],
  };
}

vi.mock('../providers/live', async () => {
  const actual = await import('../providers/live');
  return {
    ...actual,
    createOpenProviders: () => ({
      // Never called: compileRegion is mocked below. The diagnostics are the
      // subject — they are what the real transport fills in as it fails.
      providers: {} as never,
      diagnostics: nextDiagnostics ?? liveDiagnostics(0),
    }),
  };
});

/** What the mocked compiler returns; null delegates to the real one. */
let compileOutcome: unknown = null;

vi.mock('@sidequest/compiler', async () => {
  const actual = await import('@sidequest/compiler');
  return {
    ...actual,
    compileRegion: async (input: unknown) =>
      compileOutcome ?? (actual.compileRegion as (i: unknown) => Promise<unknown>)(input),
  };
});

const ENV_KEYS = [
  'SIDEQUEST_COMPILER_PROVIDER',
  'SIDEQUEST_GEOCODER_PROVIDER',
  'SIDEQUEST_PLACE_BACKBONE',
  'SIDEQUEST_ROUTES_PROVIDER',
  'SIDEQUEST_RESEARCH_PROVIDER',
  'ANTHROPIC_API_KEY',
  'SIDEQUEST_SHARED_EVIDENCE',
];

beforeEach(() => {
  releaseDatabase();
  nextDiagnostics = null;
  compileOutcome = null;
  for (const key of ENV_KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), 'sidequest-credential-failure-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  process.env.SIDEQUEST_SHARED_EVIDENCE = 'off';
});

afterEach(() => {
  releaseDatabase();
  for (const key of ENV_KEYS) delete process.env[key];
  delete process.env.SIDEQUEST_DB_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function goOpen(): void {
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'open';
  process.env.SIDEQUEST_GEOCODER_PROVIDER = 'nominatim';
  process.env.SIDEQUEST_PLACE_BACKBONE = 'overture';
  process.env.SIDEQUEST_ROUTES_PROVIDER = 'valhalla';
  process.env.SIDEQUEST_RESEARCH_PROVIDER = 'anthropic';
  process.env.ANTHROPIC_API_KEY = 'sk-test-never-a-real-key';
}

/** A confirmed fixture trip with a started job, exactly as the actions make one. */
async function seededStartedJob(): Promise<{ tripId: string; jobId: string }> {
  const { createTrip, getTrip } = await import('../db/repository');
  const repo = await import('../db/compiler-repository');
  const { compilerProviders } = await import('./providers');
  const { deriveScope, rebuildClarificationSet } = await import('@sidequest/compiler');
  const { startCompilation } = await import('./runner');

  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: 'Harbour City',
    regionId: 'open-world',
    startDate: '2026-09-01',
    endDate: '2026-09-04',
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  });
  repo.saveDestinationQuery(trip.id, 'known_destination', 'Harbour City');
  /*
   * Resolution always happens on the fixture resolver: the open stack in this
   * file is a stub whose only real part is its diagnostics, and the seeding is
   * scaffolding rather than subject. The caller's provider choice is restored
   * before the job starts, which is the part under test.
   */
  const chosen = process.env.SIDEQUEST_COMPILER_PROVIDER;
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
  const { providers } = compilerProviders();
  const resolution = await providers.resolver.resolve({ query: 'Harbour City', now: new Date() });
  process.env.SIDEQUEST_COMPILER_PROVIDER = chosen;
  repo.saveResolution(trip.id, resolution);
  const candidate = resolution.candidates[0]!;
  repo.saveSelectedCandidate(trip.id, candidate.id);
  const clarifications = rebuildClarificationSet({ resolution, candidate, nights: 3, known: {} });
  repo.saveClarifications(trip.id, clarifications);
  repo.saveScope(
    trip.id,
    deriveScope({ candidate, clarifications, nights: 3, revision: 1, transitMeasurable: false }),
  );
  const intent = repo.getIntent(trip.id)!;
  repo.saveScope(trip.id, {
    ...intent.scope!,
    confirmedByUser: true,
    confirmedAt: new Date().toISOString(),
  });
  const outcome = startCompilation(getTrip(trip.id)!);
  if (outcome.kind !== 'started') throw new Error(`expected a started job, got ${outcome.kind}`);
  return { tripId: trip.id, jobId: outcome.jobId };
}

/**
 * A real partial CompileResult, minted by one genuine fixture compile so the
 * region on it is schema-valid without a second hand-built fixture.
 */
async function partialOutcomeFrom(jobId: string, forJobId: string): Promise<unknown> {
  const repo = await import('../db/compiler-repository');
  const { compilationOperationalSchema } = await import('@sidequest/core');
  const job = repo.getJob(jobId);
  const region = repo.getCompiledRegion(job!.compiledRegionId!);
  expect(region, 'the seed compile produced no region').not.toBeNull();
  return {
    ok: true,
    partial: true,
    region: { ...region!, id: `region-${forJobId}` },
    removals: [],
    operational: compilationOperationalSchema.parse({
      schemaVersion: 1,
      budget: { consumed: {}, limits: {} },
    }),
  };
}

describe('what a run with a rejected credential ends as', () => {
  it('fails the job as provider configuration instead of committing a hollow partial', async () => {
    // One honest fixture compile first, to mint a schema-valid region.
    const seed = await seededStartedJob();
    const { runCompilation } = await import('./runner');
    const { getTrip } = await import('../db/repository');
    await runCompilation({ trip: getTrip(seed.tripId)!, jobId: seed.jobId });

    // Now the same partial result, produced by a run whose transport reported
    // three credential rejections.
    goOpen();
    const { tripId, jobId } = await seededStartedJob();
    compileOutcome = await partialOutcomeFrom(seed.jobId, jobId);
    nextDiagnostics = liveDiagnostics(3);

    await runCompilation({ trip: getTrip(tripId)!, jobId });

    const repo = await import('../db/compiler-repository');
    const job = repo.getJob(jobId)!;
    expect(job.state).toBe('failed');
    expect(job.errorCode).toBe('provider_credentials_missing');
    // The artifact was not adopted: a hollow region must not become the trip.
    expect(job.compiledRegionId ?? null).toBeNull();
    // The detail names the fact an operator has to act on.
    expect(job.errorDetail ?? '').toMatch(/credential/i);

    // Loud to the traveller too: the code is non-retryable, so the screen
    // cannot offer a "Try again" that would fail identically.
    const { isRetryable } = await import('@sidequest/core');
    expect(isRetryable('provider_credentials_missing')).toBe(false);

    // And countable by an operator: the rejection count is on the job's
    // operational counters, where the other spend figures already live.
    expect(repo.getOperationalDiagnostics(jobId)?.modelAuthFailures).toBe(3);
  });

  it('still commits a degraded run whose failures were not credential rejections', async () => {
    /*
     * The boundary control: identical run, identical partial result, but the
     * transport reports zero credential rejections. Bounded degradation for
     * transient failures is designed behaviour and must survive this change.
     */
    const seed = await seededStartedJob();
    const { runCompilation } = await import('./runner');
    const { getTrip } = await import('../db/repository');
    await runCompilation({ trip: getTrip(seed.tripId)!, jobId: seed.jobId });

    goOpen();
    const { tripId, jobId } = await seededStartedJob();
    compileOutcome = await partialOutcomeFrom(seed.jobId, jobId);
    nextDiagnostics = liveDiagnostics(0);

    await runCompilation({ trip: getTrip(tripId)!, jobId });

    const repo = await import('../db/compiler-repository');
    const job = repo.getJob(jobId)!;
    expect(job.state).toBe('partial');
    expect(job.compiledRegionId).toBe(`region-${jobId}`);
  });
});
