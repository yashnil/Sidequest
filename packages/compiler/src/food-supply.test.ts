import { describe, expect, it } from 'vitest';
import { foodDatasetSchema, type FoodVenue, type Place } from '@sidequest/core';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core/data';
import { foodSupplyGaps, foodVenuesNeeded } from './food-supply';

function venue(id: string): FoodVenue {
  return {
    id,
    regionId: 'compiled-r',
    name: id,
    locality: 'Somewhere',
    shortDescription: 'A restaurant recorded in the place data for Somewhere.',
    coordinates: { lat: 35.6, lng: 139.7 },
    tags: [],
    source: { name: 'Place data', kind: 'osm', confidence: 0.6, lastVerified: '2026-01-01' },
    serviceType: 'restaurant',
    mealPeriods: ['lunch', 'dinner'],
    cuisines: [],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: 75,
    reservation: { requirement: 'unknown' },
    takeaway: 'unknown',
    provisioning: 'none',
    dietary: [],
    hours: {
      kind: 'unknown',
      hoursConfidence: 'unverified',
      provenance: {
        kind: 'estimated',
        sourceName: 'Place data',
        confidence: 0.5,
        volatility: 'dynamic',
        recheckNote: 'Check before you go.',
      },
    },
    routingId: 'base-1',
    walkMinutesFromRouting: 0,
  } as FoodVenue;
}

const PLACES: readonly Place[] = EASTERN_SIERRA_PLACES.slice(0, 4);

describe('a food dataset says what it does not have', () => {
  it('asks for more when the traveller came for the food', () => {
    // Liking food is not wanting a restaurant survey; asking for the trip to be
    // built around eating is a different supply problem, and gets a different
    // target rather than the same one with a warmer sentence.
    expect(foodVenuesNeeded(6, true)).toBeGreaterThan(foodVenuesNeeded(6, false));
  });

  it('records the shortfall that used to be a hard-coded empty array', () => {
    /*
     * `gaps: []` was a literal on every compiled region from the first one, so
     * the food dataset always asserted that nowhere had been looked at and found
     * wanting. Six days built on three venues said nothing at all.
     */
    const gaps = foodSupplyGaps({
      venues: [venue('a'), venue('b'), venue('c')],
      places: PLACES,
      tripDays: 6,
      foodIsCore: true,
      unroutableCount: 0,
      regionName: 'Somewhere',
    });
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.note).toContain('3 places to eat');
    expect(gaps[0]!.placeIds.length).toBe(PLACES.length);
  });

  it('says nothing when there is enough', () => {
    const plenty = Array.from({ length: 30 }, (_, index) => venue(`v${index}`));
    expect(
      foodSupplyGaps({
        venues: plenty,
        places: PLACES,
        tripDays: 4,
        foodIsCore: false,
        unroutableCount: 0,
        regionName: 'Somewhere',
      }),
    ).toEqual([]);
  });

  it('keeps "we found nothing" and "we could not price the journey" apart', () => {
    /*
     * Two different statements with two different remedies. One says expect to
     * find your own meals; the other says the places exist and we cannot promise
     * the detour. Collapsing them would leave a traveller unable to act on
     * either.
     */
    const gaps = foodSupplyGaps({
      venues: Array.from({ length: 30 }, (_, index) => venue(`v${index}`)),
      places: PLACES,
      tripDays: 4,
      foodIsCore: false,
      unroutableCount: 5,
      regionName: 'Somewhere',
    });
    expect(gaps.length).toBe(1);
    expect(gaps[0]!.note).toContain('could not measure a journey');
  });

  it('never claims a source told us there is nothing here', () => {
    // The provenance is `estimated` and carries a recheck note, because nobody
    // with authority said this — we counted what we hold.
    const gaps = foodSupplyGaps({
      venues: [],
      places: PLACES,
      tripDays: 3,
      foodIsCore: false,
      unroutableCount: 0,
      regionName: 'Somewhere',
    });
    expect(gaps[0]!.provenance.kind).toBe('estimated');
    expect(gaps[0]!.provenance.recheckNote).toBeTruthy();
  });

  it('produces gaps a food dataset will actually accept', () => {
    const parsed = foodDatasetSchema.safeParse({
      version: 1,
      regionId: 'compiled-r',
      venues: [venue('a')],
      gaps: foodSupplyGaps({
        venues: [venue('a')],
        places: PLACES,
        tripDays: 5,
        foodIsCore: true,
        unroutableCount: 2,
        regionName: 'Somewhere',
      }),
    });
    expect(parsed.success).toBe(true);
  });

  it('says nothing about a region with no places in it', () => {
    expect(
      foodSupplyGaps({
        venues: [],
        places: [],
        tripDays: 4,
        foodIsCore: true,
        unroutableCount: 0,
        regionName: 'Somewhere',
      }),
    ).toEqual([]);
  });
});
