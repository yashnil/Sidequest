import { describe, expect, it, vi } from 'vitest';
import type { DiscoveryCandidate, Trip } from '@sidequest/core';
import { fictionalTrailRegion, TRAIL_DATES, TRAIL_VILLAGES } from '../../../../../packages/core/src/scan/trail-fixture.test-support';
import { composeWithPlanner } from './planner-composer';
import { defaultProfileFor } from './default-profile';
import type { RegionContext } from '../region';

/**
 * FINAL PASS — A STAY IN A NAMED CITY MAY TAKE THE METRO, WHATEVER THE TRIP'S SCALE.
 *
 * Live "Tokyo and Kyoto by train" printed every Tokyo hop as a bus: the metro
 * was allowed only on a city-scale trip, and two cities read as a region. A
 * stay near the centre of a named part that is a city now names the metro for
 * its short car-free hops, where the country's facts say one runs (Japan's do).
 */

vi.mock('server-only', () => ({}));

function plan(metroAreas?: { lat: number; lng: number }[]) {
  const compiled = fictionalTrailRegion({ follow: false, moveTolerance: 'stay_put' }).region;
  const dates = [...TRAIL_DATES];
  const trip = { id: 'metro-trip', basics: { mode: 'known_destination', destinationInput: 'Two cities by train', regionId: 'dynamic', startDate: dates[0]!, endDate: dates[dates.length - 1]!, arrivalTime: '10:00', departureTime: '17:00', adults: 2, children: 0, travelerNeeds: [] }, status: 'draft', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' } as unknown as Trip;
  const region = { region: compiled.region, places: compiled.places, access: compiled.access, hours: compiled.operatingHours, weather: null, food: null, matrix: compiled.travelTimes, transit: undefined, scheduledNetwork: null, baseId: compiled.bases.find((b) => b.id === compiled.primaryBaseId)!.routingId, basePortfolio: compiled.basePortfolio, months: [10], dates, compiled } as unknown as RegionContext;
  const candidates = compiled.places.map((place) => ({ place, fit: { score: 80, blockers: [] } }) as unknown as DiscoveryCandidate);
  const composed = composeWithPlanner({ trip, profile: defaultProfileFor(trip, null), region, candidates, selections: [], extras: null, destinationName: 'Two cities', carAvailable: false, maxDailyTravelMinutes: 180, ...(metroAreas ? { metroAreas } : {}) });
  return composed.draft.days.flatMap((d) => d.anchors.map((a) => a.transport));
}

describe('the metro in a named city', () => {
  it('is never named on a regional trip without a city part, and is named once the stay is in one', () => {
    const without = plan();
    expect(without).not.toContain('metro');
    const centre = Object.values(TRAIL_VILLAGES).map((v) => v.at);
    const within = plan(centre);
    expect(within).toContain('metro');
  });
});

describe('audit pass — only cities the traveller named promote a metro', () => {
  it('a region’s representative towns are not metro areas, whatever row placed them; a city the phrase named still is', async () => {
    const { metroAreaCentres } = await import('./metro-areas');
    const tokyo = { label: 'Tokyo', center: { lat: 35.68, lng: 139.76 }, featureType: 'city', source: 'geocoder' as const };
    const naxos = { label: 'Naxos', center: { lat: 37.105, lng: 25.376 }, featureType: 'city', source: 'geocoder' as const };
    const picked = { label: 'Fira', center: { lat: 36.417, lng: 25.432 }, featureType: 'city', source: 'interpretation' as const };
    expect(metroAreaCentres([tokyo, naxos, picked], ['Tokyo', 'Kyoto'])).toEqual([tokyo.center]);
    expect(metroAreaCentres([naxos, picked], ['Cyclades'])).toEqual([]);
  });
});
