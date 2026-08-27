import { describe, expect, it } from 'vitest';
import type { BaseCandidate, GeographicScope, Place } from '@sidequest/core';
import { buildSubregions } from './compile';

/**
 * SUBREGIONS ARE GEOMETRY OR THEY ARE NOTHING.
 *
 * The live defect this pins: every subregion in three consecutive builds
 * shared one centre — the scope centroid, for one country-breadth build a
 * point *outside the pack's own bounds* — one default radius, and a
 * membership list stamped with every place on the board, under names for
 * areas the compiled trip could not reach. Narrative wearing coordinates.
 * The builder now derives membership from the geometry it is given and omits
 * what it cannot derive; these fixtures are synthetic shapes, never places.
 */

const SCOPE = {
  center: { lat: 10, lng: 10 },
  bounds: {
    southWest: { lat: 9.5, lng: 9.5 },
    northEast: { lat: 10.5, lng: 10.5 },
  },
  shape: { kind: 'bounds', bounds: { southWest: { lat: 9.5, lng: 9.5 }, northEast: { lat: 10.5, lng: 10.5 } } },
  reachRadiusKm: 60,
} as unknown as GeographicScope;

function placeAt(id: string, lat: number, lng: number): Place {
  return { id, coordinates: { lat, lng } } as unknown as Place;
}

function proposal(input: {
  id: string;
  center: { lat: number; lng: number };
  radiusKm?: number;
}): Parameters<typeof buildSubregions>[0][number] {
  return {
    id: input.id,
    name: `Area ${input.id}`,
    summary: 'A proposed area.',
    center: input.center,
    radiusKm: input.radiusKm ?? 20,
    suggestedNights: { min: 1, max: 2 },
  };
}

const NO_BASES: readonly BaseCandidate[] = [];

describe('subregion geometry is derived or omitted, never stamped', () => {
  const nearPlaces = [placeAt('p-1', 10.02, 10.02), placeAt('p-2', 10.05, 10.0)];
  const farPlace = placeAt('p-3', 9.6, 10.45);

  it('derives membership from each subregion’s own circle, not the whole board', () => {
    const subregions = buildSubregions(
      [
        proposal({ id: 'sub-a', center: { lat: 10.03, lng: 10.01 } }),
        proposal({ id: 'sub-b', center: { lat: 9.62, lng: 10.44 } }),
      ],
      NO_BASES,
      [...nearPlaces, farPlace],
      SCOPE,
    );
    expect(subregions).toHaveLength(2);
    expect(subregions[0]!.placeIds.sort()).toEqual(['p-1', 'p-2']);
    expect(subregions[1]!.placeIds).toEqual(['p-3']);
  });

  it('omits placeholder geometry: identical centres carry no information', () => {
    const subregions = buildSubregions(
      [
        proposal({ id: 'sub-a', center: { lat: 10, lng: 10 } }),
        proposal({ id: 'sub-b', center: { lat: 10, lng: 10 } }),
        proposal({ id: 'sub-c', center: { lat: 10, lng: 10 } }),
      ],
      NO_BASES,
      nearPlaces,
      SCOPE,
    );
    expect(subregions).toEqual([]);
  });

  it('omits a named area whose centre lies outside the compiled ground', () => {
    const subregions = buildSubregions(
      [proposal({ id: 'sub-out', center: { lat: 12.5, lng: 14.0 } })],
      NO_BASES,
      nearPlaces,
      SCOPE,
    );
    expect(subregions).toEqual([]);
  });

  it('omits an empty circle: a named area holding nothing on this board describes the destination, not the trip', () => {
    const subregions = buildSubregions(
      [proposal({ id: 'sub-empty', center: { lat: 9.55, lng: 9.55 }, radiusKm: 2 })],
      NO_BASES,
      nearPlaces,
      SCOPE,
    );
    expect(subregions).toEqual([]);
  });
});
