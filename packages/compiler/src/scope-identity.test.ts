import { describe, expect, it } from 'vitest';
import type { DestinationCandidate } from '@sidequest/core';
import { deriveScope } from './scope';

/**
 * THE DESTINATION'S OWN DIVISION IDENTITY HAS TO SURVIVE THE TRIP HERE.
 *
 * `scope.administrative.divisionIds` was a hardcoded empty array, and the whole
 * membership layer downstream is built on it: a record's published parent chain
 * is compared against "the division the destination **is**", and with nothing to
 * compare against, a stored Tokyo build returned `membership_unknown` for 3,767
 * of 3,787 records and put zero anchors on a world city's board.
 *
 * The identity was never missing. A traveller who picks a row out of the place
 * index has pointed at a catalogue division record, and its identifier reaches
 * this function on the candidate. These tests hold the two halves that matter:
 * it is read where it exists, and it is **not invented** where it does not.
 */

function candidate(overrides: Partial<DestinationCandidate> = {}): DestinationCandidate {
  return {
    id: 'overture:798895d4',
    displayName: 'Tokyo',
    qualifiedName: 'Tokyo, Japan',
    entityType: 'city',
    breadth: 'city',
    center: { lat: 35.6768, lng: 139.7638 },
    countryCode: 'JP',
    regionCode: 'JP-13',
    aliases: ['Tokio'],
    administrativeAreas: ['Japan', 'Tokyo'],
    timeZones: ['Asia/Tokyo'],
    providerRefs: [{ provider: 'overture', externalId: '798895d4' }],
    confidence: { level: 'high', signals: [], note: 'Test.' },
    ...overrides,
  } as DestinationCandidate;
}

function scopeFor(overrides: Partial<DestinationCandidate>, divisionIds?: readonly string[]) {
  return deriveScope({
    candidate: candidate(overrides),
    clarifications: { schemaVersion: 1, questions: [], answers: [] },
    nights: 5,
    revision: 1,
    ...(divisionIds ? { divisionIds } : {}),
  });
}

describe('the division the destination is', () => {
  it('carries the identifier the traveller pointed at, off the candidate itself', () => {
    /*
     * The regression. This array was literally `[]`, so the overlay had to
     * rediscover the destination from a divisions layer a retention budget had
     * already capped — and on the real Tokyo pack it failed.
     */
    expect(scopeFor({}).administrative.divisionIds).toEqual(['798895d4']);
  });

  it('unions a caller-resolved second publication with the candidate’s own', () => {
    /*
     * A catalogue that publishes a metropolis twice — Tokyo is a `region` under
     * Japan and a `locality` under Chiyoda ward, and every record in the city
     * refers to the first while the index hands the traveller the second. Both
     * are the destination, so neither reading may displace the other.
     */
    const scope = scopeFor({}, ['689e36ca']);
    expect(scope.administrative.divisionIds).toEqual(['798895d4', '689e36ca']);
  });

  it('does not repeat an identifier a caller resolved twice over', () => {
    expect(scopeFor({}, ['798895d4', '689e36ca']).administrative.divisionIds).toEqual([
      '798895d4',
      '689e36ca',
    ]);
  });

  it('claims nothing for a destination a geocoder resolved', () => {
    /**
     * A free-text destination carries an OSM element reference, not a catalogue
     * division. Writing it into `divisionIds` would be an identity claim that
     * can never be true — no record's parent chain contains an OSM element id —
     * and `scopeIdentityKnown` would start reporting a usable identity for a
     * scope that has none.
     */
    const scope = scopeFor({
      id: 'relation/1543125',
      providerRefs: [{ provider: 'openstreetmap', externalId: 'relation/1543125' }],
    });
    expect(scope.administrative.divisionIds).toEqual([]);
  });

  it('ignores a reference from a provider that did not mint this candidate', () => {
    /*
     * The index path stores its selection as `resolver:<candidate id>` when the
     * destination came from a geocoder, so a provider reference existing is not
     * on its own evidence that the candidate *is* that provider's record.
     */
    const scope = scopeFor({
      id: 'resolver:relation/1543125',
      providerRefs: [{ provider: 'nominatim', externalId: 'relation/1543125' }],
    });
    expect(scope.administrative.divisionIds).toEqual([]);
  });
});
