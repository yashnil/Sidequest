import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLARIFICATION_SET_VERSION,
  buildTravelerProfile,
  countTripDays,
  defaultAnswers,
  scheduledNetworkFrom,
  type ClarificationSet,
  type CompiledRegion,
  type QuestionnaireAnswers,
  type TravelerProfile,
  type Trip,
} from '@sidequest/core';
import { compileRegion, deriveScope } from '@sidequest/compiler';
import {
  SYNTHETIC_WORLDS,
  packBackedProviders,
  syntheticCandidate,
} from '@sidequest/compiler/testing';

/**
 * THE PERSISTED SCHEDULED-NETWORK OBSERVATION REACHES THE LIVE BOARD PATH.
 *
 * `transitBlindWalk` (core/travel/reach.ts) refuses to pass a distance verdict
 * on a walk that is standing in for scheduled transport nobody could measure —
 * but only when the destination evidence *observes* a scheduled network, and
 * the only party who can say so is whoever compiled the destination. The
 * compiler now persists that observation on the artifact
 * (`CompiledRegion.scheduledStops`); this suite proves the production door the
 * board is built through — `resolveTripRegion` → `RegionContext` → `boardFor`
 * — actually carries it, because an observation that stops at the artifact is
 * exactly the dead code this slice exists to wire.
 *
 * The repository and weather snapshot store are mocked at their module seam:
 * this is a test of `region.ts`'s own mapping, not of SQLite. The artifacts
 * themselves are real compiler output over synthetic worlds — offline, no
 * provider, no network, no money.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];

/** What the mocked repository serves. Reassigned per test. */
let storedArtifact: CompiledRegion | null = null;

vi.mock('./db/compiler-repository', () => ({
  getIntent: (tripId: string) =>
    tripId ? ({ selectedCompiledRegionId: 'stored-artifact' } as never) : null,
  getCompiledRegion: () => {
    if (!storedArtifact) throw new Error('no artifact staged for this test');
    return storedArtifact;
  },
}));

vi.mock('./weather/snapshot-repository', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getWeatherSnapshot: () => null };
});

import { boardFor, resolveTripRegion } from './region';

function emptyClarifications(): ClarificationSet {
  return { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] };
}

async function compileServedCity(options: {
  id: string;
  stops?: Readonly<Record<string, number>>;
}): Promise<CompiledRegion> {
  const spec = {
    ...SYNTHETIC_WORLDS.transit_city!,
    id: options.id,
    ...(options.stops ? { scheduledStopRecords: options.stops } : {}),
  };
  const scope = deriveScope({
    candidate: syntheticCandidate(spec),
    clarifications: emptyClarifications(),
    nights: DATES.length,
    revision: 1,
  });
  const result = await compileRegion({
    compilationId: `wire-${spec.id}`,
    scope,
    dates: [...DATES],
    months: [8],
    providers: packBackedProviders(spec),
    now: NOW,
  });
  if (!result.ok) {
    throw new Error(`the ${spec.id} world did not compile: ${result.code} — ${result.message}`);
  }
  return result.region;
}

function tripFor(region: CompiledRegion): Trip {
  return {
    id: `trip-${region.region.id}`,
    basics: {
      mode: 'known_destination',
      destinationInput: region.scope.destinationName,
      regionId: region.region.id,
      startDate: DATES[0]!,
      endDate: DATES[DATES.length - 1]!,
      arrivalTime: '10:00',
      departureTime: '18:00',
      adults: 2,
      children: 0,
      travelerNeeds: [],
    },
    status: 'discovering',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

/**
 * A traveller with no car and a stated walking limit — the traveller the
 * transit-blind verdict exists for. Built through the questionnaire's own
 * constructor, then given the walking tolerance the scenario turns on.
 */
function carFreeProfile(): TravelerProfile {
  const context = { travelerNeeds: [], tripDays: countTripDays(DATES[0]!, DATES[DATES.length - 1]!) };
  const answers: QuestionnaireAnswers = {
    ...defaultAnswers(context),
    willDrive: false,
    pace: 'balanced',
    dayStart: 'normal',
  };
  const profile = buildTravelerProfile(answers, context);
  return {
    ...profile,
    transport: {
      ...profile.transport,
      willDrive: false,
      maxDailyDriveMinutes: 0,
      maxAccessWalkMinutes: 20,
    },
  };
}

async function resolvedContextFor(artifact: CompiledRegion) {
  storedArtifact = artifact;
  const trip = tripFor(artifact);
  const resolved = await resolveTripRegion(trip);
  if (!resolved.ok) throw new Error(`the region did not resolve: ${resolved.error}`);
  return { trip, context: resolved.context };
}

/** The compiled artifact as a build before the observation existed stored it. */
function legacyCopyOf(artifact: CompiledRegion): CompiledRegion {
  const copy = { ...artifact, id: `${artifact.id}-legacy` } as CompiledRegion & {
    scheduledStops?: unknown;
  };
  delete copy.scheduledStops;
  return copy;
}

beforeEach(() => {
  storedArtifact = null;
});

describe('the resolved region context', () => {
  it('carries the observed scheduled network off the stored artifact', async () => {
    const artifact = await compileServedCity({
      id: 'wire-city-served',
      stops: { railway_station: 3, train_station: 1, bus_station: 2 },
    });
    /* The artifact itself must say observed, or the wiring test proves nothing. */
    expect(scheduledNetworkFrom(artifact.scheduledStops)).toBe('observed');

    const { context } = await resolvedContextFor(artifact);
    expect(context.scheduledNetwork).toBe('observed');
  });

  it('reads a counted zero as not-observed, never as silence', async () => {
    const artifact = await compileServedCity({ id: 'wire-city-bare' });
    expect(artifact.scheduledStops?.total).toBe(0);

    const { context } = await resolvedContextFor(artifact);
    expect(context.scheduledNetwork).toBe('not_observed');
  });

  it('reads an artifact from before the field existed as nobody-said', async () => {
    const artifact = await compileServedCity({
      id: 'wire-city-old',
      stops: { railway_station: 2 },
    });
    const { context } = await resolvedContextFor(legacyCopyOf(artifact));
    expect(context.scheduledNetwork).toBeNull();
  });
});

describe('the board built through the production door', () => {
  it('withholds the distance verdict exactly where the observation permits it', async () => {
    const artifact = await compileServedCity({
      id: 'wire-city-flip',
      stops: { railway_station: 3, train_station: 1, bus_station: 2 },
    });
    /*
     * The preconditions the flip turns on, asserted so a fixture drift fails
     * here with a name rather than as a silently empty flip set: the journeys
     * are priced off a pedestrian matrix, and the compilation signed that
     * nothing could measure a scheduled journey.
     */
    expect(artifact.travelTimes.mode).toBe('foot');
    expect(artifact.transitEvidence?.measured).toBe(0);
    expect(artifact.transitEvidence?.absence).toBe('unsupported');

    const profile = carFreeProfile();
    const served = await resolvedContextFor(artifact);
    const servedBoard = boardFor(served.trip, profile, served.context);

    const legacy = await resolvedContextFor(legacyCopyOf(artifact));
    const legacyBoard = boardFor(legacy.trip, profile, legacy.context);

    const legacyClassOf = new Map(
      legacyBoard.candidates.map((candidate) => [candidate.place.id, candidate.detourClass]),
    );
    /* The candidates the observation flipped: unknown now, a verdict before. */
    const flipped = servedBoard.candidates.filter(
      (candidate) =>
        candidate.detourClass === 'unknown' &&
        legacyClassOf.get(candidate.place.id) !== undefined &&
        legacyClassOf.get(candidate.place.id) !== 'unknown',
    );

    expect(
      flipped.length,
      'no card moved: the persisted observation is not reaching the board',
    ).toBeGreaterThan(0);
    for (const candidate of flipped) {
      /*
       * Each flipped card carried a distance verdict priced off a walk nobody
       * would make, and is now an honest unknown. Any other source class —
       * `base`, or a comfortable `in_tolerance` — would mean the flip fired
       * somewhere it should not, which is the thing this guards.
       *
       * Both refusing verdicts, not `too_far` alone: separating the last-mile
       * answer from the whole-journey budget widened a non-driver's radius from
       * their walking answer to their ride answer, so a walk that used to clear
       * the radius by an hour can now land inside the stretch band instead. The
       * same walk, the same refusal to price it, one band softer. Measured on
       * this fixture at the time of the split: six `too_far`, one `stretch`.
       */
      expect(['too_far', 'stretch']).toContain(legacyClassOf.get(candidate.place.id));
    }
  });

  it('does not fire the flip over ground whose evidence records no stop', async () => {
    const artifact = await compileServedCity({ id: 'wire-city-zero' });
    expect(artifact.scheduledStops?.total).toBe(0);

    const profile = carFreeProfile();
    const bare = await resolvedContextFor(artifact);
    const bareBoard = boardFor(bare.trip, profile, bare.context);

    const legacy = await resolvedContextFor(legacyCopyOf(artifact));
    const legacyBoard = boardFor(legacy.trip, profile, legacy.context);

    /*
     * A counted zero and an absent field must produce the same board: the
     * transit-blind flip needs a positive observation, and a world with no
     * scheduled stop keeps its walking verdicts — a long walk really is the
     * story there.
     */
    expect(
      bareBoard.candidates.map((candidate) => [candidate.place.id, candidate.detourClass]),
    ).toEqual(
      legacyBoard.candidates.map((candidate) => [candidate.place.id, candidate.detourClass]),
    );
  });
});
