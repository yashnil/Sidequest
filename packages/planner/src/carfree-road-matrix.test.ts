import { describe, expect, it } from 'vitest';
import {
  unavailableWeatherDataset,
  type DiscoveryCandidate,
  type DiscoverySelection,
  type TripBasics,
  type WeatherDataset,
} from '@sidequest/core';
import {
  TRANSIT_CITY_ACCESS,
  TRANSIT_CITY_DATES,
  TRANSIT_CITY_HOURS,
  TRANSIT_CITY_IDENTITY,
  TRANSIT_CITY_PLACES,
  TRANSIT_CITY_REGION,
  transitCityTraveler,
} from '@sidequest/core/testing';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { planTrip } from './plan';
import { MODELLED_WALK_KMH } from './modelled-walk';

/**
 * THE RELEASE GATE FOR PR-PLAN-10: A CAR-FREE TRIP HANDED A ROAD MATRIX.
 *
 * The live Tokyo journey died here. The compiler stored a `car` matrix for a
 * car-free scope — its half of the contract, owned elsewhere — and the planner,
 * correctly refusing to schedule road times for a traveller with no car,
 * refused *everything*: six picked, zero scheduled, "there is no legal way in
 * to any of the 6 places you picked", for stops a quarter of an hour's stroll
 * from the hotel.
 *
 * The contract this file gates:
 *
 *   1. near stops plan anyway, as derived walks — road *distance* at a slow
 *      pace, labelled `modelled`, never the road *time*, never a transit label;
 *   2. far stops are refused per stop, by name, with the distance in the
 *      sentence — a decision, not a data gap;
 *   3. the trip as a whole never comes back empty while near stops exist;
 *   4. the funnel agrees with itself: "measurable" is mode-aware, so it cannot
 *      claim six measurable places above a list of six with no usable journey.
 */

const IDS = TRANSIT_CITY_IDENTITY;

const NEAR_ROAD = { minutes: 5, km: 1.2 };
/** The audited Tokyo shape: 16.4 road-km once scheduled as a 10-minute walk. */
const FAR_ROAD = { minutes: 20, km: 16.4 };

/** A road matrix over the base and two stops — the only network in the scope. */
function roadOnlyMatrix(): TravelTimeMatrix {
  const ids = [IDS.baseId, IDS.candidateA, IDS.candidateB];
  const between = (from: string, to: string) => {
    if (from === to) return { minutes: 0, km: 0 };
    const other = from === IDS.baseId ? to : from;
    return other === IDS.candidateA ? NEAR_ROAD : FAR_ROAD;
  };
  return {
    mode: 'car',
    ids,
    minutes: ids.map((from) => ids.map((to) => between(from, to).minutes)),
    km: ids.map((from) => ids.map((to) => between(from, to).km)),
    provenance: {
      kind: 'measured',
      note: 'Road network, measured by construction.',
      source: 'carfree-road-matrix.test.ts',
    },
  };
}

function candidateFor(placeId: string): DiscoveryCandidate {
  const place = TRANSIT_CITY_PLACES.find((entry) => entry.id === placeId)!;
  return {
    place,
    fit: {
      score: 0.8,
      band: 'strong',
      matchedInterests: [],
      blockers: [],
      cautions: [],
      reasons: [],
      transportFit: 1,
      seasonFit: 1,
    },
    quality: { outcome: 'kept', reason: 'fixture', score: 1, signals: [] },
    detourClass: 'in_tolerance',
    season: { band: 'open', note: 'fixture', months: [8] },
    access: { requiredModes: [], cautions: [], available: true, summary: 'fixture' },
    operating: { status: 'open', note: 'fixture' },
  } as unknown as DiscoveryCandidate;
}

const SELECTIONS: DiscoverySelection[] = [IDS.candidateA, IDS.candidateB].map((placeId) => ({
  placeId,
  status: 'included',
  source: 'user',
  updatedAt: '2026-08-10T09:00:00.000Z',
}));

const BASICS: TripBasics = {
  mode: 'known_destination',
  destinationInput: 'Two Rivers',
  regionId: IDS.regionId,
  startDate: TRANSIT_CITY_DATES[0]!,
  endDate: TRANSIT_CITY_DATES[TRANSIT_CITY_DATES.length - 1]!,
  arrivalTime: '10:00',
  departureTime: '19:00',
  adults: 2,
  children: 0,
  travelerNeeds: [],
};

function unfetchedWeather(): WeatherDataset {
  return unavailableWeatherDataset({
    regionId: TRANSIT_CITY_REGION.id,
    locations: [
      {
        id: 'tc-weather',
        label: 'Two Rivers',
        coordinates: TRANSIT_CITY_REGION.baseCoordinates,
        elevationMetres: 20,
        timeZone: 'Europe/Lisbon',
        placeIds: TRANSIT_CITY_PLACES.map((place) => place.id),
        limitation: 'One point for the whole city.',
      },
    ],
    dates: TRANSIT_CITY_DATES,
    now: new Date('2026-08-10T09:00:00.000Z'),
    reason: 'not_configured',
    message: 'We have not fetched the weather for this trip yet.',
  });
}

function planCarFreeRoadScope() {
  return planTrip({
    tripId: 'carfree-road-scope',
    basics: BASICS,
    profile: transitCityTraveler(),
    region: TRANSIT_CITY_REGION,
    candidates: [candidateFor(IDS.candidateA), candidateFor(IDS.candidateB)],
    selections: SELECTIONS,
    matrix: roadOnlyMatrix(),
    access: TRANSIT_CITY_ACCESS,
    hours: TRANSIT_CITY_HOURS,
    weather: unfetchedWeather(),
    baseId: IDS.baseId,
    now: new Date('2026-08-10T09:00:00.000Z'),
    generatedAt: '2026-08-10T09:00:00.000Z',
  });
}

describe('a car-free scope compiled with a road matrix', () => {
  it('plans the near stop as a modelled walk instead of refusing the whole trip', () => {
    const result = planCarFreeRoadScope();
    expect(result.ok, result.ok ? '' : `refused: ${result.message}`).toBe(true);
    if (!result.ok) return;

    const scheduled = result.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.kind === 'activity').map((item) => item.placeId),
    );
    expect(scheduled).toContain(IDS.candidateA);

    /* The legs that reach it: walks, derived, and labelled as derived. */
    const legs = result.itinerary.days.flatMap((day) =>
      day.items.filter((item) => item.travel !== undefined).map((item) => item.travel!),
    );
    expect(legs.length).toBeGreaterThan(0);
    const expectedWalk = Math.ceil((NEAR_ROAD.km * 60) / MODELLED_WALK_KMH);
    for (const leg of legs) {
      /* A road time never renders as transit, and never as a drive here. */
      expect(leg.mode).toBe('walk');
      expect(leg.provenance).toBe('modelled');
      expect(leg.minutes).toBe(expectedWalk);
      /* And in particular never the road's own five minutes. */
      expect(leg.minutes).not.toBe(NEAR_ROAD.minutes);
    }
  });

  it('refuses the far stop per stop, by name, with the distance in the sentence', () => {
    const result = planCarFreeRoadScope();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const far = result.itinerary.unscheduled.find((entry) => entry.placeId === IDS.candidateB);
    expect(far, 'the far stop vanished instead of being refused by name').toBeDefined();
    expect(far!.reasonCode).toBe('transport_mode_unavailable');
    expect(far!.reason).toContain('16.4 km by road');
    /* The refusal is a decision for the traveller, never a "retry" data gap. */
    expect(far!.reason).toMatch(/on foot/);
  });

  it('keeps the funnel consistent with the per-stop story', () => {
    const result = planCarFreeRoadScope();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /*
     * "MEASURABLE 6" above "6 with no measured travel time" was two honest
     * derivations from two different definitions. One definition now: the near
     * stop is measurable (a derived walk resolves both ways), the far one is
     * not, and the access gate agrees.
     */
    expect(result.readiness.funnel.selected).toBe(2);
    expect(result.readiness.funnel.eligible).toBe(1);
    expect(result.readiness.funnel.accessFeasible).toBe(1);
    expect(result.readiness.funnel.scheduled).toBeGreaterThan(0);
  });
});
