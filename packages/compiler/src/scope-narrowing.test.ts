import { describe, expect, it } from 'vitest';
import type { DestinationCandidate } from '@sidequest/core';
import { deriveScope, scopeFitsTrip } from './scope';
import { QUESTION_IDS } from './clarify';

/**
 * "ONE AREA, DONE PROPERLY" — WITH NO AREA.
 *
 * The breadth question offers that option over every container-sized
 * destination, and its own copy promises "We pick the part that fits you best
 * and stay there". The part is the preflight's first base; the preflight builds
 * its portfolio from the destination index; and a destination the index holds
 * no parts for produces a narrowing with nothing to centre on. `deriveShape`
 * then keeps the container's whole published extent — deliberately, because the
 * alternative is a twelve-kilometre circle around a bounding box's centroid,
 * which is the banned shape `scope-extent.test.ts` exists to hold.
 *
 * What was missing is the other half. A live Tokyo build with an unseeded index
 * confirmed at `high` confidence carrying:
 *
 *   rationale      "A single part of Tokyo, about 12 km out, from one base."
 *   baseName       Shinjuku
 *   reachRadiusKm  12
 *   shape.bounds   20.2°N → 35.9°N, 135.9°E → 154.2°E
 *
 * — the whole metropolis, because Tokyo administers the Izu and Ogasawara
 * islands. Every one of the 24 places it compiled was on those islands, 176 to
 * 1,225 km from the base it had just named; the foot matrix came back with one
 * point in it; and the traveller was told "None of the 7 places you picked has
 * a travel time we could measure."
 *
 * `deriveShape`'s own comment says `scopeFitsTrip` refuses this state before a
 * compile is bought. It did not: the only refusal there was keyed on `country`
 * breadth, and a metropolis is a `region`. These tests drive the real
 * derivation and the real refusal.
 */

/** A container whose administered ground reaches far beyond its populated part. */
function metropolis(overrides: Partial<DestinationCandidate> = {}): DestinationCandidate {
  return {
    id: 'relation/1543125',
    displayName: 'Tokyo',
    entityType: 'state_or_province',
    breadth: 'region',
    center: { lat: 35.6768601, lng: 139.7638947 },
    // The real published extent: the mainland ward, then 1,700 km of ocean.
    bounds: {
      southWest: { lat: 20.2145811, lng: 135.8536855 },
      northEast: { lat: 35.8984245, lng: 154.205541 },
    },
    qualifiedName: 'Tokyo, Japan',
    countryCode: 'JP',
    aliases: [],
    administrativeAreas: [],
    timeZones: ['Asia/Tokyo'],
    confidence: { level: 'high', signals: [], note: 'Test.' },
    providerRefs: [],
    ...overrides,
  } as DestinationCandidate;
}

const ONE_AREA = {
  schemaVersion: 1 as const,
  questions: [],
  answers: [
    { questionId: QUESTION_IDS.breadthStrategy, values: ['one_area'], answeredAt: '2026-08-27T00:00:00.000Z' },
  ],
};

function narrowed(anchor?: { id: string; name: string; center: { lat: number; lng: number } }) {
  return deriveScope({
    candidate: metropolis(),
    clarifications: ONE_AREA,
    nights: 5,
    revision: 1,
    composerTransport: 'public_transport',
    ...(anchor ? { preflightAnchor: anchor } : {}),
  });
}

const SHINJUKU = { id: 'relation/1758858', name: 'Shinjuku', center: { lat: 35.6937632, lng: 139.7036319 } };

describe('a container narrowed to "one area" with no part resolved', () => {
  it('is the shape the live build produced, or these tests are asserting nothing', () => {
    /*
     * The witness. Without a part the derivation keeps the container's extent —
     * that branch is deliberate and stays; what follows is about confirming it.
     */
    const scope = narrowed();
    expect(scope.shape.kind).toBe('bounds');
    expect(scope.shape.kind === 'bounds' && scope.shape.bounds.southWest.lat).toBeCloseTo(20.21, 1);
    // And the rationale beside it still quotes the trip's reach, not the shape.
    expect(scope.rationale).toContain('km out');
    expect(scope.reachRadiusKm).toBeLessThan(50);
  });

  it('records that the narrowing found no part to narrow to', () => {
    expect(narrowed().narrowedWithoutPart).toBe(true);
  });

  it('cannot be confirmed, because one area would cover the whole of it', () => {
    const verdict = scopeFitsTrip(narrowed());
    expect(verdict.fits).toBe(false);
    // The two ways out a traveller can actually take, both named.
    expect(verdict.reason).toContain('name the part');
    expect(verdict.reason).toContain('hotel change');
  });

  it('confirms normally once the preflight has a part to hand over', () => {
    /*
     * The control. The same destination, the same answer, one working index
     * behind it: the shape becomes the reach around the part, the marker is
     * absent, and nothing refuses.
     */
    const scope = narrowed(SHINJUKU);
    expect(scope.narrowedWithoutPart).toBeUndefined();
    expect(scopeFitsTrip(scope).fits).toBe(true);

    expect(scope.shape.kind).toBe('bounds');
    if (scope.shape.kind !== 'bounds') throw new Error('unreachable');
    // Clipped around Shinjuku, so the Ogasawara islands are no longer inside it.
    expect(scope.shape.bounds.southWest.lat).toBeGreaterThan(35);
    expect(scope.shape.bounds.northEast.lat).toBeLessThan(36.5);
    expect(scope.shape.bounds.northEast.lng).toBeLessThan(141);
  });

  it('leaves a container small enough to *be* one area alone', () => {
    /**
     * The over-refusal this rule had in its first form, and the reason it now
     * measures the ground rather than counting the missing part.
     *
     * "One area" is only an unkept promise when the container is far bigger than
     * the area it should have narrowed to. An ordinary subregion whose whole
     * extent already sits inside a day's reach *is* the one area — there is
     * nothing to narrow, and refusing turns a working trip into the dead end
     * this rule exists to prevent. Measured: the first version disabled "Build
     * the region" on a small fixture subregion and broke five browser tests.
     */
    const small = metropolis({
      displayName: 'Faraway Reaches',
      entityType: 'subregion',
      breadth: 'subregion',
      center: { lat: 39.5, lng: -106.0 },
      bounds: {
        southWest: { lat: 39.35, lng: -106.2 },
        northEast: { lat: 39.65, lng: -105.8 },
      },
    });
    const scope = deriveScope({
      candidate: small,
      clarifications: ONE_AREA,
      nights: 5,
      revision: 1,
      composerTransport: 'drive',
    });
    expect(scope.narrowedWithoutPart).toBeUndefined();
    expect(scopeFitsTrip(scope).fits).toBe(true);
  });

  it('leaves an un-narrowed container alone, which is a different trip', () => {
    /*
     * Nothing here may refuse "the whole of it, as a circuit": that scope claims
     * the ground it covers and says so, and it is the answer this refusal's own
     * sentence points the traveller towards.
     */
    const whole = deriveScope({
      candidate: metropolis(),
      clarifications: { schemaVersion: 1, questions: [], answers: [] },
      nights: 5,
      revision: 1,
      composerTransport: 'public_transport',
    });
    expect(whole.narrowedWithoutPart).toBeUndefined();
    expect(scopeFitsTrip(whole).fits).toBe(true);
  });
});
