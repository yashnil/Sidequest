import { describe, expect, it } from 'vitest';
import { validateMatrix, leg } from '@sidequest/geo';
import { EASTERN_SIERRA_ACCESS, EASTERN_SIERRA_PLACES } from './index';
import { EASTERN_SIERRA_BASE_ID, easternSierraTravelMatrix } from './travel-times';

/**
 * The corridor model claims an invariant in its own documentation:
 * `|corridorMinutes| + spurMinutes` equals the `driveMinutes` recorded on each
 * place. That claim was written and never checked, which is the most expensive
 * kind of comment — the two numbers are authored in different files and would
 * drift silently, leaving base-to-place times that contradict the place cards.
 */

describe('the Eastern Sierra corridor model', () => {
  const matrix = easternSierraTravelMatrix();

  it('is structurally sound', () => {
    expect(() => validateMatrix(matrix)).not.toThrow();
  });

  it('reproduces every authored base-to-place drive time exactly', () => {
    for (const place of EASTERN_SIERRA_PLACES) {
      const hop = leg(matrix, EASTERN_SIERRA_BASE_ID, place.id);
      expect(
        hop.minutes,
        `${place.id}: corridor model says ${hop.minutes} min, the place card says ${place.travelFromBase.driveMinutes}`,
      ).toBe(place.travelFromBase.driveMinutes);
    }
  });

  it('is symmetric, as a road network with no one-way sections should be', () => {
    for (const place of EASTERN_SIERRA_PLACES.slice(0, 8)) {
      for (const other of EASTERN_SIERRA_PLACES.slice(0, 8)) {
        expect(leg(matrix, place.id, other.id).minutes).toBe(
          leg(matrix, other.id, place.id).minutes,
        );
      }
    }
  });

  it('keeps places on one spur road measured along that spur', () => {
    // The case the whole model exists for: six kilometres apart as the raven
    // flies, an hour apart by road, because the only way between them is back
    // down Minaret Road.
    const vistaToPostpile = leg(matrix, 'minaret-vista', 'devils-postpile').minutes;
    const townToPostpile = leg(matrix, EASTERN_SIERRA_BASE_ID, 'devils-postpile').minutes;
    expect(vistaToPostpile).toBeLessThan(townToPostpile);
    expect(vistaToPostpile).toBe(30);
  });

  it('carries every access point the access rules need to route to', () => {
    for (const point of EASTERN_SIERRA_ACCESS.points) {
      expect(
        matrix.ids,
        `access point "${point.id}" routes via "${point.routingId}", which the matrix does not know`,
      ).toContain(point.routingId);
    }
  });

  it('never presents itself as measured road data', () => {
    expect(matrix.provenance.kind).toBe('modelled');
    expect(matrix.provenance.note).toMatch(/not measured/i);
  });
});
