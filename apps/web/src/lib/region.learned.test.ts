import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLARIFICATION_SET_VERSION, buildTravelerProfile, countTripDays, defaultAnswers, type CompiledRegion, type Interest, type LearnedPreference, type TravelerProfile, type Trip } from '@sidequest/core';
import { compileRegion, deriveScope } from '@sidequest/compiler';
import { SYNTHETIC_WORLDS, packBackedProviders, syntheticCandidate } from '@sidequest/compiler/testing';

/**
 * FINAL PASS — WHAT SIDEQUEST LEARNED CHANGES THE BOARD THE PLANNER READS.
 *
 * Through the production door (`resolveTripRegion` → `boardFor`) on a real
 * compiled synthetic world: a learned leaning lifts the fit of places for an
 * interest this trip left unstated, an answer given for this trip outranks it,
 * and a trip with no account is untouched. The planner and Auto-pick rank from
 * these fit scores, so this is the seam they share.
 */

const NOW = new Date('2026-08-10T09:00:00.000Z');
const DATES = ['2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
let storedArtifact: CompiledRegion | null = null;
let learned: LearnedPreference[] = [];

vi.mock('./db/compiler-repository', () => ({
  getIntent: (tripId: string) => (tripId ? ({ selectedCompiledRegionId: 'stored-artifact' } as never) : null),
  getCompiledRegion: () => {
    if (!storedArtifact) throw new Error('no artifact staged');
    return storedArtifact;
  },
}));
vi.mock('./weather/snapshot-repository', async (importOriginal) => ({ ...((await importOriginal()) as Record<string, unknown>), getWeatherSnapshot: () => null }));
vi.mock('./db/preference-evidence-repository', () => ({ learnedForOwner: () => ({ learned, hints: [] }) }));

import { boardFor, resolveTripRegion } from './region';

async function compiled(): Promise<CompiledRegion> {
  const spec = { ...SYNTHETIC_WORLDS.transit_city!, id: 'learned-city' };
  const scope = deriveScope({ candidate: syntheticCandidate(spec), clarifications: { schemaVersion: CLARIFICATION_SET_VERSION, questions: [], answers: [] }, nights: DATES.length, revision: 1 });
  const result = await compileRegion({ compilationId: 'learned', scope, dates: [...DATES], months: [8], providers: packBackedProviders(spec), now: NOW });
  if (!result.ok) throw new Error(result.message);
  return result.region;
}

function tripFor(region: CompiledRegion, userId?: string): Trip {
  return {
    id: `trip-${region.region.id}`,
    ...(userId ? { userId } : {}),
    basics: { mode: 'known_destination', destinationInput: region.scope.destinationName, regionId: region.region.id, startDate: DATES[0]!, endDate: DATES[3]!, arrivalTime: '10:00', departureTime: '18:00', adults: 2, children: 0, travelerNeeds: [] },
    status: 'discovering',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function profileWith(interests: TravelerProfile['interests']): TravelerProfile {
  const context = { travelerNeeds: [], tripDays: countTripDays(DATES[0]!, DATES[3]!) };
  const profile = buildTravelerProfile({ ...defaultAnswers(context), pace: 'balanced', dayStart: 'normal' }, context);
  return { ...profile, interests };
}

const lean = (interest: Interest): LearnedPreference => ({ feature: `interest:${interest}`, weight: 0.9, confidence: 0.9, rows: 5, band: 'high' });

beforeEach(() => {
  storedArtifact = null;
  learned = [];
});

describe('learned taste reaches the board', () => {
  it('lifts an unstated interest, never over this trip’s answer, and only for an account', async () => {
    storedArtifact = await compiled();
    const resolved = await resolveTripRegion(tripFor(storedArtifact, 'user-1'));
    if (!resolved.ok) throw new Error(resolved.error);
    const baseProfile = profileWith({});
    const plain = boardFor(tripFor(storedArtifact, 'user-1'), baseProfile, resolved.context);
    /* An interest some candidate offers that this trip left unstated. */
    const interest = plain.candidates.flatMap((c) => c.place.interests).find((i) => baseProfile.interests[i] === undefined);
    expect(interest).toBeDefined();
    const fitOf = (board: typeof plain) => new Map(board.candidates.map((c) => [c.place.id, c.fit.score] as const));
    const before = fitOf(plain);
    const offering = plain.candidates.filter((c) => c.place.interests.includes(interest!)).map((c) => c.place.id);

    learned = [lean(interest!)];
    const lifted = fitOf(boardFor(tripFor(storedArtifact, 'user-1'), baseProfile, resolved.context));
    expect(offering.some((id) => lifted.get(id)! > before.get(id)!)).toBe(true);

    /* This trip said "low": the history does not override it. */
    const answered = profileWith({ [interest!]: 'low' });
    const answeredPlain = fitOf((() => { learned = []; return boardFor(tripFor(storedArtifact!, 'user-1'), answered, resolved.context); })());
    learned = [lean(interest!)];
    expect(fitOf(boardFor(tripFor(storedArtifact, 'user-1'), answered, resolved.context))).toEqual(answeredPlain);

    /* No account behind the trip: nothing learned is read. */
    expect(fitOf(boardFor(tripFor(storedArtifact), baseProfile, resolved.context))).toEqual(before);
  });
});
