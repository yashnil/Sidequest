import { describe, expect, it } from 'vitest';
import { PLACEMENT_UNAVAILABLE_NOTE, placementNote } from './placement-note';

describe('placementNote', () => {
  it('says calmly that the map, not the answer, failed — for every failure on our side', () => {
    for (const reason of ['no_resolver', 'provider_failed', 'rate_limited', 'request_failed'] as const) {
      expect(placementNote(reason)).toBe(PLACEMENT_UNAVAILABLE_NOTE);
    }
    expect(PLACEMENT_UNAVAILABLE_NOTE).toMatch(/you can continue/);
    expect(PLACEMENT_UNAVAILABLE_NOTE).not.toMatch(/SIDEQUEST_|nominatim|geocoder|provider/i);
  });

  it('leaves a phrase the sources could not settle to the canvas’s own words', () => {
    expect(placementNote('unresolved')).toBeNull();
    expect(placementNote('locating')).toBeNull();
    expect(placementNote(null)).toBeNull();
  });
});
