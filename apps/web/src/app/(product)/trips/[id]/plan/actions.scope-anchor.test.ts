import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TripPreflight } from '@sidequest/core';

/**
 * THE WIRE BETWEEN THE PREFLIGHT'S CHOSEN PART AND THE NARROWED SCOPE.
 *
 * `deriveScope` can centre a narrowed area on the part the preview chose — that
 * much is unit-tested in the compiler package. None of it matters unless the
 * action that builds the scope actually hands the stored portfolio's first base
 * across, and that hand-off is exactly what was missing on a live car-free
 * country trip: the preflight had chosen the capital, seven nights, "the
 * densest part of the region", and `proposeScopeAction` passed only the reach
 * number. The compiled scope was a twelve-kilometre walking circle on the
 * country's uninhabited geometric centroid, and the traveller was told it was
 * enough to plan on.
 *
 * Nothing here reaches a network: the destination is written the way an index
 * selection writes one, and the preflight is stored the way the preflight step
 * stores one.
 */

vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => null }),
  /*
   * Outside a request scope, like the benchmark driver and the compile worker:
   * `cookies()` throws, which is the internal-caller path the ownership
   * boundary documents. A fake jar with no cookie would instead read as a
   * foreign browser and be refused.
   */
  cookies: async () => {
    throw new Error('cookies() called outside a request scope');
  },
}));

let dir: string;

function releaseDatabase(): void {
  const holder = globalThis as unknown as { sidequestDb?: { close(): void } };
  holder.sidequestDb?.close();
  delete holder.sidequestDb;
}

beforeEach(() => {
  releaseDatabase();
  dir = mkdtempSync(join(tmpdir(), 'sidequest-scope-anchor-'));
  process.env.SIDEQUEST_DB_PATH = join(dir, 'test.db');
  process.env.SIDEQUEST_COMPILER_PROVIDER = 'fixture';
});

afterEach(() => {
  releaseDatabase();
  delete process.env.SIDEQUEST_DB_PATH;
  delete process.env.SIDEQUEST_COMPILER_PROVIDER;
  rmSync(dir, { recursive: true, force: true });
});

/** A country whose middle is empty: the capital sits well off the centroid. */
const CENTROID = { lat: 2.0, lng: 2.0 };
const CAPITAL = { id: 'cluster-westhaven', name: 'Westhaven', center: { lat: 0.6, lng: 0.5 } };

function preflightChoosingTheCapital(destinationKey: string): TripPreflight {
  const cluster = {
    id: CAPITAL.id,
    name: CAPITAL.name,
    center: CAPITAL.center,
    memberCount: 4,
    memberNames: [],
    distanceFromGatewayKm: 0,
    transferMinutesFromGateway: 0,
  };
  return {
    schemaVersion: 1,
    destinationKey,
    portfolio: {
      gateway: { name: CAPITAL.name, center: CAPITAL.center },
      route: [cluster],
      baseReasons: [
        {
          clusterId: CAPITAL.id,
          reason: 'The densest part of the region.',
          nights: 7,
          transferMinutes: 0,
        },
      ],
      satellites: [],
      excluded: [],
      basesProposed: 1,
      transferDays: 0,
      mode: 'walk',
      reachRadiusKm: 12,
      rationale: 'One base holds the whole structure.',
      estimated: true,
    },
    strategies: [],
    dates: null,
    duration: null,
    supply: null,
    builtAt: '2026-08-01T00:00:00.000Z',
    elapsedMs: 10,
  };
}

async function carFreeNarrowedCountryTrip(input: { withPreflight: boolean }): Promise<string> {
  const { createTrip } = await import('@/lib/db/repository');
  const repo = await import('@/lib/db/compiler-repository');

  const trip = createTrip({
    mode: 'known_destination',
    destinationInput: 'Highland Republic',
    regionId: 'open-world',
    startDate: '2026-09-01',
    endDate: '2026-09-08',
    arrivalTime: '10:00',
    departureTime: '18:00',
    adults: 2,
    children: 0,
    travelerNeeds: [],
  });
  repo.saveDestinationQuery(trip.id, 'known_destination', 'Highland Republic');
  /* Exactly what the destination step writes when a country is selected. */
  repo.saveSelectedDestination(trip.id, {
    entryId: 'index:highland-republic',
    catalog: 'test-index',
    sourceId: 'highland-republic',
    releaseId: 'test-release',
    displayName: 'Highland Republic',
    qualifiedName: 'Highland Republic',
    featureType: 'country',
    center: CENTROID,
    countryCode: 'ZQ',
    aliases: [],
    hierarchy: [],
    selectedAt: '2026-08-01T00:00:00.000Z',
  });
  /* The traveller chose "one area, in depth" and said no to a car. */
  repo.saveClarifications(trip.id, {
    schemaVersion: 1,
    questions: [],
    answers: [
      { questionId: 'scope.breadth-strategy', values: ['one_area'], answeredAt: '2026-08-01T00:00:00.000Z' },
      { questionId: 'transport.car-available', values: ['no'], answeredAt: '2026-08-01T00:00:00.000Z' },
    ],
  });
  if (input.withPreflight) {
    repo.savePreflight(trip.id, preflightChoosingTheCapital('index:highland-republic'));
  }
  return trip.id;
}

describe('narrowing a country with the preflight structure stored', () => {
  it('centres the compiled area on the base the preflight chose, and names it', async () => {
    const tripId = await carFreeNarrowedCountryTrip({ withPreflight: true });
    const { proposeScopeAction, confirmScopeAction } = await import('./actions');
    const repo = await import('@/lib/db/compiler-repository');

    const result = await proposeScopeAction(tripId);
    expect(result.ok).toBe(true);

    const scope = repo.getIntent(tripId)?.scope;
    expect(scope?.shape.kind).toBe('radius');
    if (scope?.shape.kind === 'radius') {
      /* The capital, never the empty centroid the candidate's centre points at. */
      expect(scope.shape.center).toEqual(CAPITAL.center);
      /* Walking ground around the settlement: the traveller said no car. */
      expect(scope.shape.radiusKm).toBeLessThanOrEqual(12);
    }
    expect(scope?.rationale).toContain('Westhaven');
    expect(scope?.includedAreas).toEqual([
      expect.objectContaining({ id: CAPITAL.id, name: CAPITAL.name }),
    ]);

    /* A resolved part is a confirmable trip. */
    const confirmed = await confirmScopeAction(tripId);
    expect(confirmed.ok).toBe(true);
  });

  it('refuses to confirm the narrowed country when no preflight resolved a part', async () => {
    const tripId = await carFreeNarrowedCountryTrip({ withPreflight: false });
    const { proposeScopeAction, confirmScopeAction } = await import('./actions');
    const repo = await import('@/lib/db/compiler-repository');

    const proposed = await proposeScopeAction(tripId);
    expect(proposed.ok).toBe(true);

    /* Never the banned shape: no walking circle on the centroid. */
    const scope = repo.getIntent(tripId)?.scope;
    expect(scope?.shape.kind === 'radius' ? scope.shape.radiusKm : Infinity).toBeGreaterThan(12);

    /* Refused before any money is spent, with something the traveller can act on. */
    const confirmed = await confirmScopeAction(tripId);
    expect(confirmed.ok).toBe(false);
    expect(confirmed.error).toMatch(/part|hotel/i);
  });
});

describe('a profile that appears after the proposal reaches the scope before anything is confirmed or built', () => {
  /**
   * THE LIVE-FLOW ORDERING, EXACTLY. Destination and dates come first; the
   * scope proposal is derived and persisted at the first plan visit, before
   * any questionnaire exists; the questionnaire then materialises a profile;
   * and "Build the region" reuses the stored proposal. A profile-aware day
   * reach that runs only at proposal time is unreachable for every real
   * traveller — verified live: a stored driving profile predated the build
   * and the compiled region still carried the profile-blind 70 km rationale.
   * The re-derivation triggers on the delta (`derivedFromProfile`), replaces
   * the proposal unconfirmed when the ground changed, and asks the traveller
   * to confirm the region they can actually see.
   */
  async function drivingNarrowedCountryTrip(): Promise<string> {
    const repo = await import('@/lib/db/compiler-repository');
    const tripId = await carFreeNarrowedCountryTrip({ withPreflight: true });
    /* Same trip shape, but the traveller can drive. */
    repo.saveClarifications(tripId, {
      schemaVersion: 1,
      questions: [],
      answers: [
        { questionId: 'scope.breadth-strategy', values: ['one_area'], answeredAt: '2026-08-01T00:00:00.000Z' },
        { questionId: 'transport.car-available', values: ['yes'], answeredAt: '2026-08-01T00:00:00.000Z' },
      ],
    });
    return tripId;
  }

  it('re-derives on the profile delta, refuses the stale confirm once, and confirms the widened ground', async () => {
    const tripId = await drivingNarrowedCountryTrip();
    const { proposeScopeAction, confirmScopeAction } = await import('./actions');
    const { saveProfile } = await import('@/lib/db/repository');
    const { getIntent } = await import('@/lib/db/compiler-repository');
    const { buildTravelerProfile, defaultAnswers, countTripDays } = await import('@sidequest/core');

    /* 1. Proposal derived before any questionnaire exists: the generic day. */
    const proposed = await proposeScopeAction(tripId);
    expect(proposed.ok, proposed.ok ? '' : proposed.error).toBe(true);
    const before = getIntent(tripId)!.scope!;
    expect(before.reachRadiusKm).toBe(70);
    expect(before.derivedFromProfile).toBe(false);

    /* 2. The questionnaire materialises a driving profile. */
    const context = { travelerNeeds: [], tripDays: countTripDays('2026-09-01', '2026-09-08') };
    const answers = { ...defaultAnswers(context), willDrive: true, maxDailyTravelMinutes: 240 };
    saveProfile(tripId, answers, buildTravelerProfile(answers, context)!);

    /* 3. Confirming the stale proposal is refused once, with the update saved. */
    const staleConfirm = await confirmScopeAction(tripId);
    expect(staleConfirm.ok).toBe(false);
    if (!staleConfirm.ok) expect(staleConfirm.error).toContain('updated the proposed region');
    const rederived = getIntent(tripId)!.scope!;
    expect(rederived.reachRadiusKm).toBe(110);
    expect(rederived.derivedFromProfile).toBe(true);
    expect(rederived.confirmedByUser).toBe(false);

    /* 4. Confirming what the traveller can now see succeeds, and sticks. */
    const confirmed = await confirmScopeAction(tripId);
    expect(confirmed.ok, confirmed.ok ? '' : confirmed.error).toBe(true);
    expect(getIntent(tripId)!.scope!.confirmedByUser).toBe(true);
    expect(getIntent(tripId)!.scope!.reachRadiusKm).toBe(110);
  });
});
