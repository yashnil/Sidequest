import { describe, expect, it } from 'vitest';
import {
  assertFoodRoutingWithinDoorWalk,
  foodDoorWalkMinutes,
  foodRoutingSnapKm,
  foodVenueSchema,
  FOOD_DOOR_WALK_MAX_MINUTES,
  snapFoodRouting,
  type FoodVenue,
} from './food';
import { MODELLED_WALK_KMH } from '../travel/reach';

/**
 * ---- THE CONTRACT UNDER THE LEG THAT TIMED THE WRONG PLACE ----------------
 *
 * `routingId` says a venue is a door on the same street as a node the matrix
 * already holds, and `walkMinutesFromRouting` bounds that door walk at twenty
 * minutes. Nothing enforced the first half. A compiled venue took the nearest
 * anchor whatever the distance — the anchors being the bases plus two dozen
 * compiled places — so a named restaurant was priced against a park 4.80 km
 * away, with the door walk hard-coded to zero, and the day printed the park's
 * "8 min on foot" as a measured leg under the restaurant's name. Four of four
 * such legs in the founder journeys were wrong the same way.
 *
 * These are the contract's own tests: the ceiling, its derivation, and the
 * assertion that stops a venue being stored past it.
 */

const BASE = { id: 'base-1', coordinates: { lat: 38.72, lng: -9.14 } };
/** Degrees of latitude to kilometres, at the earth radius `haversineKm` uses. */
const KM_PER_DEGREE = 111.19493;

function northOfBase(km: number): { lat: number; lng: number } {
  return { lat: BASE.coordinates.lat + km / KM_PER_DEGREE, lng: BASE.coordinates.lng };
}

function venue(overrides: Partial<FoodVenue> & { id: string }): FoodVenue {
  return foodVenueSchema.parse({
    regionId: 'compiled-r',
    name: 'A venue',
    locality: 'Somewhere',
    shortDescription: 'A restaurant recorded in the place data for Somewhere.',
    coordinates: BASE.coordinates,
    tags: ['places=restaurant'],
    serviceType: 'restaurant',
    mealPeriods: ['lunch', 'dinner'],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: 75,
    reservation: { requirement: 'unknown' },
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
    source: { name: 'Place data', kind: 'osm', confidence: 0.6, lastVerified: '2026-01-01' },
    routingId: BASE.id,
    ...overrides,
  });
}

describe('a routing node a venue may share', () => {
  it('is bounded by the door walk the schema already states, not by a new number', () => {
    const ceilingKm = foodRoutingSnapKm(MODELLED_WALK_KMH);
    /*
     * The derivation, checked at the only point where it can be checked without
     * restating it: a venue exactly at the ceiling owes exactly the maximum door
     * walk the schema allows, and one minute more is a walk the schema refuses.
     */
    expect(foodDoorWalkMinutes(ceilingKm, MODELLED_WALK_KMH)).toBe(FOOD_DOOR_WALK_MAX_MINUTES);
    expect(() => venue({ id: 'v', walkMinutesFromRouting: FOOD_DOOR_WALK_MAX_MINUTES })).not.toThrow();
    expect(() => venue({ id: 'v', walkMinutesFromRouting: FOOD_DOOR_WALK_MAX_MINUTES + 1 })).toThrow();
  });

  it('is refused at the distance the live defect snapped across', () => {
    /* 4.80 km — the venue and the park the itinerary priced it against. */
    const far = snapFoodRouting({
      coordinates: northOfBase(4.8),
      anchors: [BASE],
      walkKmh: MODELLED_WALK_KMH,
    });
    expect(far).toBeNull();
  });

  it('is granted, with the walk it really is, to a venue that really is beside it', () => {
    const near = snapFoodRouting({
      coordinates: northOfBase(0.556),
      anchors: [BASE],
      walkKmh: MODELLED_WALK_KMH,
    });
    expect(near?.routingId).toBe(BASE.id);
    /*
     * Eight minutes: the same figure the broken leg printed for a venue 4.80 km
     * out, except this is what 0.56 km costs on foot. The compiled venue builder
     * wrote `0` here whatever the distance.
     */
    expect(near?.walkMinutesFromRouting).toBe(8);
  });

  it('is the nearest node, not the first — a ceiling is not an excuse to stop looking', () => {
    const other = { id: 'place-9', coordinates: northOfBase(1.0) };
    const snapped = snapFoodRouting({
      coordinates: northOfBase(1.1),
      anchors: [BASE, other],
      walkKmh: MODELLED_WALK_KMH,
    });
    expect(snapped?.routingId).toBe('place-9');
    expect(snapped?.walkMinutesFromRouting).toBe(foodDoorWalkMinutes(0.1, MODELLED_WALK_KMH));
  });
});

describe('a venue past the contract cannot be stored quietly', () => {
  it('refuses a venue priced against a node it is 4.8 km from', () => {
    expect(() =>
      assertFoodRoutingWithinDoorWalk({
        venues: [venue({ id: 'v', coordinates: northOfBase(4.8), walkMinutesFromRouting: 0 })],
        anchors: [BASE],
        walkKmh: MODELLED_WALK_KMH,
      }),
    ).toThrow(/4\.80 km from "base-1"/);
  });

  it('refuses a door walk of zero for a venue that is not at its node', () => {
    /*
     * The other half of the same defect, and the half a distance ceiling alone
     * would not catch: a venue inside the ceiling whose walk was still written
     * as the hard-coded zero both live food paths used.
     */
    expect(() =>
      assertFoodRoutingWithinDoorWalk({
        venues: [venue({ id: 'v', coordinates: northOfBase(0.556), walkMinutesFromRouting: 0 })],
        anchors: [BASE],
        walkKmh: MODELLED_WALK_KMH,
      }),
    ).toThrow(/records a 0-minute walk to the door/);
  });

  it('refuses a routing id that is not a node at all', () => {
    expect(() =>
      assertFoodRoutingWithinDoorWalk({
        venues: [venue({ id: 'v', routingId: 'invented-for-this-venue' })],
        anchors: [BASE],
        walkKmh: MODELLED_WALK_KMH,
      }),
    ).toThrow(/which is not a node/);
  });

  it('accepts a venue snapped the sanctioned way', () => {
    const coordinates = northOfBase(0.556);
    const snapped = snapFoodRouting({ coordinates, anchors: [BASE], walkKmh: MODELLED_WALK_KMH })!;
    expect(() =>
      assertFoodRoutingWithinDoorWalk({
        venues: [
          venue({
            id: 'v',
            coordinates,
            routingId: snapped.routingId,
            walkMinutesFromRouting: snapped.walkMinutesFromRouting,
          }),
        ],
        anchors: [BASE],
        walkKmh: MODELLED_WALK_KMH,
      }),
    ).not.toThrow();
  });
});
