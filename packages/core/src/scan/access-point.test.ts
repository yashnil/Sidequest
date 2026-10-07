import { describe, expect, it } from 'vitest';
import { MAX_ACCESS_QUERIES, accessEvidence, accessRecoveryQueries, accessStemOf, worthAccessRecovery } from './access-point';

describe('access points for routes and areas (private alpha, live Dolomites finding)', () => {
  it('reads the place out of the activity name and asks a bounded number of access questions', () => {
    expect(accessStemOf('Summit Lakes loop')).toBe('Summit Lakes');
    expect(accessStemOf('Grey Ridge ridge walk')).toBe('Grey Ridge');
    expect(accessStemOf('High Plateau panoramic section (east)')).toBe('High Plateau');
    const queries = accessRecoveryQueries('Summit Lakes loop', 'day_hike');
    expect(queries.length).toBeLessThanOrEqual(MAX_ACCESS_QUERIES);
    expect(queries[0]).toBe('Summit Lakes trailhead');
    expect(accessRecoveryQueries('Grey Ridge cable car hike', 'day_hike')[0]).toBe('Grey Ridge cable car');
  });

  it('only important trail-like candidates are worth provider calls', () => {
    expect(worthAccessRecovery({ kind: 'day_hike', tier: 'classic', namedByTraveller: false })).toBe(true);
    expect(worthAccessRecovery({ kind: 'day_hike', tier: 'hidden_gem', namedByTraveller: true })).toBe(true);
    expect(worthAccessRecovery({ kind: 'day_hike', tier: 'hidden_gem', namedByTraveller: false })).toBe(false);
    expect(worthAccessRecovery({ kind: 'museum', tier: 'classic', namedByTraveller: true })).toBe(false);
  });

  it('accepts a real access point related to the activity, and nothing else', () => {
    expect(accessEvidence({ stem: 'Summit Lakes', resultName: 'Summit Lakes trailhead', osmClass: 'highway', osmType: 'trailhead' })).toBe('trailhead');
    expect(accessEvidence({ stem: 'Summit Lakes', resultName: 'Parcheggio Summit Lakes', googleTypes: ['parking', 'point_of_interest'] })).toBe('parking');
    expect(accessEvidence({ stem: 'Grey Ridge', resultName: 'Funivia Grey Ridge', googleTypes: ['tourist_attraction'] })).toBe('lift_station');
    // A summit, a ridge, a park or an area is never an access point, whatever its name says.
    expect(accessEvidence({ stem: 'Summit Lakes', resultName: 'Summit Lakes parking', osmClass: 'natural', osmType: 'peak' })).toBeNull();
    expect(accessEvidence({ stem: 'Grey Ridge', resultName: 'Grey Ridge', osmClass: 'natural', osmType: 'ridge' })).toBeNull();
    expect(accessEvidence({ stem: 'Grey Ridge', resultName: 'Grey Ridge Nature Park', osmClass: 'leisure', osmType: 'nature_reserve' })).toBeNull();
    // An access point for a different place is not evidence.
    expect(accessEvidence({ stem: 'Summit Lakes', resultName: 'Valley Station parking', googleTypes: ['parking'] })).toBeNull();
    // A related place with no access evidence is not one either.
    expect(accessEvidence({ stem: 'Summit Lakes', resultName: 'Summit Lakes', googleTypes: ['natural_feature'] })).toBeNull();
  });
});
