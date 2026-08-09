import { describe, expect, it } from 'vitest';
import type { DestinationCandidate, ScopeBreadth } from '@sidequest/core';
import { deriveScope } from './scope';

/**
 * WHAT A TRAVELLER'S LEGS MAY AND MAY NOT DECIDE.
 *
 * A traveller asked for a two-island country and said they would rather not
 * drive. Not driving selects the walking reach; the walking reach caps at twelve
 * kilometres; and the shape derivation clipped the country's published boundary
 * to twelve kilometres around its centroid. The second island was outside the
 * compiled ground before a single record was read, and nothing said so.
 *
 * The rule this file holds is the separation the failure exposed:
 *
 *   **transport decides what a traveller can cover; it does not decide what the
 *   destination is.**
 *
 * Clipping a *city* to reach is legitimate and stays — a New York evaluation
 * showed a walking trip taking the full fifty-kilometre boundary and losing 272
 * of 380 legs across the harbour. Clipping a *country* is not the same
 * operation with different numbers: one narrows a place, the other removes
 * members of a set.
 */

function candidate(overrides: Partial<DestinationCandidate> = {}): DestinationCandidate {
  return {
    id: 'relation/900001',
    displayName: 'Twin Isles',
    entityType: 'country',
    breadth: 'country',
    center: { lat: 0.2, lng: 6.6 },
    // Two landmasses, roughly 150 km apart north to south.
    bounds: { southWest: { lat: 0.0, lng: 6.4 }, northEast: { lat: 1.75, lng: 7.5 } },
    qualifiedName: 'Twin Isles',
    countryCode: 'ZQ',
    aliases: [],
    administrativeAreas: [],
    timeZones: ['UTC'],
    confidence: { level: 'high', signals: [], note: 'Test.' },
    providerRefs: [],
    ...overrides,
  } as DestinationCandidate;
}

function scopeFor(
  breadth: ScopeBreadth,
  entityType: DestinationCandidate['entityType'],
  willDrive: boolean,
) {
  return deriveScope({
    candidate: candidate({ breadth, entityType }),
    clarifications: { schemaVersion: 1, questions: [], answers: [] },
    nights: 4,
    revision: 1,
    composerTransport: willDrive ? 'drive' : 'public_transport',
  });
}

/** How much of the published boundary the derived shape still covers, by area. */
function extentCoverage(
  shape: { kind: string; bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } },
  published: NonNullable<DestinationCandidate['bounds']>,
): number {
  if (shape.kind !== 'bounds' || !shape.bounds) return 0;
  const area = (b: NonNullable<DestinationCandidate['bounds']>) =>
    Math.max(0, b.northEast.lat - b.southWest.lat) * Math.max(0, b.northEast.lng - b.southWest.lng);
  return area(shape.bounds) / area(published);
}

describe('a destination that is a container of parts', () => {
  const published = candidate().bounds!;

  it('keeps its whole published extent for a traveller who will not drive', () => {
    /**
     * The regression. Before the fix this shape was a 12 km box and the coverage
     * ratio was about 0.01 — one island out of two, decided by a walking speed.
     */
    const scope = scopeFor('country', 'country', false);
    expect(extentCoverage(scope.shape, published)).toBe(1);
  });

  it('derives the same ground whether or not the traveller drives', () => {
    /**
     * The property stated directly: the destination is the same destination.
     * Transport may change the reach, the bases and the day plan; it may not
     * change the answer to "where is this trip".
     */
    const walking = scopeFor('country', 'country', false);
    const driving = scopeFor('country', 'country', true);
    expect(walking.shape).toEqual(driving.shape);
  });

  it('still records the traveller reach, which is what constrains the days', () => {
    /**
     * The reach did not disappear; it moved to where it belongs. A walker's
     * reach is far smaller than a driver's, and base selection and the planner's
     * per-day travel caps both read it. What changed is that it no longer
     * decides the extent.
     */
    const walking = scopeFor('country', 'country', false);
    const driving = scopeFor('country', 'country', true);
    expect(walking.reachRadiusKm ?? 0).toBeLessThan(driving.reachRadiusKm ?? 0);
  });

  it.each<ScopeBreadth>(['subregion', 'region', 'country', 'multi_country'])(
    'never clips a %s to a walking radius',
    (breadth) => {
      const scope = scopeFor(breadth, 'country', false);
      expect(extentCoverage(scope.shape, published)).toBe(1);
    },
  );
});

describe('a destination that is one settlement', () => {
  const published = candidate().bounds!;

  it('is still clipped to what the traveller can cross', () => {
    /**
     * The New York property, preserved. A walking traveller in a city whose
     * boundary spans a harbour gets the part of it they can actually cover,
     * because that narrows one place rather than deleting a member of a set.
     */
    const scope = scopeFor('city', 'city', false);
    expect(extentCoverage(scope.shape, published)).toBeLessThan(0.5);
  });

  it('clips a city less for a driver than for a walker', () => {
    const walking = scopeFor('city', 'city', false);
    const driving = scopeFor('city', 'city', true);
    expect(extentCoverage(walking.shape, published)).toBeLessThan(
      extentCoverage(driving.shape, published),
    );
  });

  it('never clips a settlement to nothing', () => {
    const scope = scopeFor('local', 'city', false);
    expect(extentCoverage(scope.shape, published)).toBeGreaterThan(0);
  });
});
