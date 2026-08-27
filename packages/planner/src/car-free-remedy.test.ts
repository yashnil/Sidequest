import { describe, expect, it } from 'vitest';
import type { DiscoveryCandidate } from '@sidequest/core';
import { resolveCandidates } from './candidates';

/**
 * A REMEDY OFFERED TO SOMEBODY WHO CANNOT TAKE IT IS NOT A REMEDY.
 *
 * Live evidence, on a trip whose own itinerary page reads "This plan assumes no
 * car": every place the planner could not reach carried "This needs a vehicle.
 * Renting one would open up most of the region", and the readiness panel's top
 * suggestion was to raise a daily driving limit the traveller does not have.
 * The readiness layer now refuses to file a remedy that contradicts a stated
 * answer; these are the two per-place sentences beside it, which the same rule
 * has to reach or the traveller reads the contradiction one screen down.
 *
 * The clause turns on one fact and nothing else, so a traveller who *is*
 * driving keeps the sentence that is genuinely useful to them.
 */

/** The narrowest input `resolveCandidates` will take: one unreachable choice. */
function candidateBlockedWithoutAVehicle(): DiscoveryCandidate {
  return {
    place: {
      id: 'places:blocked',
      name: 'Ridgeway Overlook',
      names: { primary: 'Ridgeway Overlook' },
      coordinates: { lat: 0, lng: 0 },
      typicalDurationMinutes: 60,
      hiddenGemScore: 0.2,
      popularityScore: 0.5,
      category: 'viewpoint',
    },
    fit: {
      score: 0.4,
      band: 'not_workable',
      matchedInterests: [],
      blockers: [{ code: 'needs_car', message: 'Reaching the start of this one needs your own vehicle.' }],
    },
    providerRefs: [],
    travelMinutesFromBase: 40,
  } as unknown as DiscoveryCandidate;
}

function remedyFor(willDrive: boolean): string | undefined {
  const { rejected } = resolveCandidates(
    [candidateBlockedWithoutAVehicle()] as never,
    [{ placeId: 'places:blocked', status: 'included', source: 'user' }] as never,
    undefined as never,
    undefined,
    { derived: {}, transport: { willDrive } } as never,
  );
  return rejected[0]?.suggestedRemedy;
}

describe('a remedy for a place no scheduled service reaches', () => {
  it('never tells a traveller with no car to hire one', () => {
    const remedy = remedyFor(false);
    expect(remedy).toBeDefined();
    expect(remedy).not.toMatch(/rent|hire/i);
    expect(remedy).toMatch(/drop/i);
  });

  it('keeps the sentence that is useful to somebody who is driving', () => {
    expect(remedyFor(true)).toMatch(/Renting one would open up/);
  });
});
