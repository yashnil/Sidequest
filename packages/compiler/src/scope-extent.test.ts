import { describe, expect, it } from 'vitest';
import type { DestinationCandidate, GeographicScope, ScopeBreadth, TravelerProfile } from '@sidequest/core';
import { buildTravelerProfile, defaultAnswers } from '@sidequest/core';
import { deriveScope, scopeFitsTrip } from './scope';
import { QUESTION_IDS } from './clarify';

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

/**
 * THE SAME RULE ON THE BRANCH THE REAL DESTINATIONS ACTUALLY TAKE.
 *
 * Every case above hands `deriveShape` a published boundary, and measured
 * against the live destination index almost nothing has one: 38,909 of 38,909
 * counties carry no bounds, as do 53,542 of 53,542 towns and 12,080 of 12,080
 * cities. `county`, `island`, `national_park` and `protected_area` all resolve
 * to breadth `subregion` — the first entry in `MULTI_PART_BREADTHS` — so a
 * traveller who picks an island group or a national park out of the suggestion
 * list reaches the *radius* branch, not the bounds branch, and the guard written
 * to stop a walking speed deciding what their destination is could not execute
 * for them.
 *
 * These cases hold the container rule on that branch. Without them the fix is a
 * comment: the whole file passes with the radius branch reverted to
 * `{ kind: 'radius', center, radiusKm }`.
 */
describe('a container of parts that nobody published edges for', () => {
  function boundlessScope(
    breadth: ScopeBreadth,
    entityType: DestinationCandidate['entityType'],
    willDrive: boolean,
  ) {
    return deriveScope({
      candidate: candidate({ breadth, entityType, bounds: undefined }),
      clarifications: { schemaVersion: 1, questions: [], answers: [] },
      nights: 4,
      revision: 1,
      composerTransport: willDrive ? 'drive' : 'public_transport',
    });
  }

  /** The circle's radius, or 0 for a shape that is not one. */
  function radiusOf(shape: { kind: string; radiusKm?: number }): number {
    return shape.kind === 'radius' ? (shape.radiusKm ?? 0) : 0;
  }

  /** The walking reach cap, which is what the archipelago was shrunk to. */
  const WALKING_CAP_KM = 12;

  it('does not shrink an island group to a walking radius when it has no published edges', () => {
    const scope = boundlessScope('subregion', 'archipelago', false);
    /*
     * The regression, exactly: a two-island destination became a 12 km circle
     * around its centroid and the second island was outside the compiled ground
     * before a record was read.
     */
    expect(scope.shape.kind).toBe('radius');
    expect(radiusOf(scope.shape)).toBeGreaterThan(WALKING_CAP_KM);
  });

  it('derives the same ground whether or not the traveller drives', () => {
    const walking = boundlessScope('subregion', 'archipelago', false);
    const driving = boundlessScope('subregion', 'archipelago', true);
    expect(walking.shape).toEqual(driving.shape);
  });

  it('still records the traveller reach, which is what constrains the days', () => {
    const walking = boundlessScope('subregion', 'archipelago', false);
    const driving = boundlessScope('subregion', 'archipelago', true);
    expect(walking.reachRadiusKm ?? 0).toBeLessThan(driving.reachRadiusKm ?? 0);
    /* And the reach is not the extent — the whole point of separating them. */
    expect(walking.reachRadiusKm ?? 0).toBeLessThan(radiusOf(walking.shape));
  });

  it('still says the edge is a circle rather than a border', () => {
    /*
     * Widening the circle must not promote it. Nobody published an outline, and
     * a consumer that needs a *border* — containment reads this — has to be able
     * to tell it has been handed a travelling distance.
     */
    expect(boundlessScope('subregion', 'archipelago', false).boundaryEvidence).toBe('reach_circle');
  });

  it.each<ScopeBreadth>(['subregion', 'region', 'country', 'multi_country'])(
    'never sizes a boundless %s by a walking speed',
    (breadth) => {
      expect(radiusOf(boundlessScope(breadth, 'country', false).shape)).toBeGreaterThan(
        WALKING_CAP_KM,
      );
    },
  );

  it('leaves a boundless settlement sized by what the traveller can cross', () => {
    /*
     * The other half, and the reason this is a container rule rather than a
     * blanket widening. A city is one place: reach narrows it, and a walker's
     * city is smaller than a driver's.
     */
    const walking = boundlessScope('city', 'city', false);
    const driving = boundlessScope('city', 'city', true);
    expect(radiusOf(walking.shape)).toBeLessThan(radiusOf(driving.shape));
    expect(radiusOf(walking.shape)).toBe(walking.reachRadiusKm);
  });
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

/**
 * NARROWING TO "ONE AREA" MUST RESOLVE **WHICH** AREA.
 *
 * A traveller who chose "one area, in depth" for a car-free country got a
 * twelve-kilometre walking circle on the country's geometric centroid — for a
 * real country, an uninhabited ice cap — while the preflight structure sitting
 * on the same trip had already chosen the capital as the one base. The narrowing
 * legitimately turns the container into a part; nothing resolved which part, so
 * the centroid substituted. §12.1 bans exactly this shape.
 *
 * The same branch failed in the other direction with a car: the narrowed radius
 * was sized by nights alone, so "a single part" of a city compiled 168 km of
 * other prefectures. Both directions live here.
 */
describe('narrowing a container to one area', () => {
  /**
   * A country whose geometric centre is empty highland. The capital sits near
   * the south-west coast; nothing lives in the middle. Fictional, like every
   * world in this suite.
   */
  const HIGHLAND = {
    bounds: { southWest: { lat: 0.0, lng: 0.0 }, northEast: { lat: 4.0, lng: 4.0 } },
    centroid: { lat: 2.0, lng: 2.0 },
    capital: { id: 'cluster-westhaven', name: 'Westhaven', center: { lat: 0.6, lng: 0.5 } },
  };

  function highlandCountry(overrides: Partial<DestinationCandidate> = {}): DestinationCandidate {
    return candidate({
      displayName: 'Highland Republic',
      qualifiedName: 'Highland Republic',
      breadth: 'country',
      entityType: 'country',
      center: HIGHLAND.centroid,
      bounds: HIGHLAND.bounds,
      ...overrides,
    });
  }

  function narrowedScope(input: {
    anchor?: { id: string; name: string; center: { lat: number; lng: number } };
    car: 'yes' | 'no';
    candidate?: DestinationCandidate;
    nights?: number;
    profile?: TravelerProfile;
  }) {
    return deriveScope({
      candidate: input.candidate ?? highlandCountry(),
      clarifications: {
        schemaVersion: 1,
        questions: [],
        answers: [
          { questionId: QUESTION_IDS.breadthStrategy, values: ['one_area'], answeredAt: 'x' },
          { questionId: QUESTION_IDS.carAvailable, values: [input.car], answeredAt: 'x' },
        ],
      },
      nights: input.nights ?? 7,
      revision: 1,
      ...(input.anchor ? { preflightAnchor: input.anchor } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
    });
  }

  /** Whether the derived ground covers a point, for either shape kind. */
  function covers(shape: GeographicScope['shape'], point: { lat: number; lng: number }): boolean {
    if (shape.kind === 'bounds') {
      return (
        point.lat >= shape.bounds.southWest.lat &&
        point.lat <= shape.bounds.northEast.lat &&
        point.lng >= shape.bounds.southWest.lng &&
        point.lng <= shape.bounds.northEast.lng
      );
    }
    if (shape.kind !== 'radius') return false;
    const dLat = (point.lat - shape.center.lat) * 111;
    const dLng =
      (point.lng - shape.center.lng) * 111 * Math.cos((shape.center.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLng) <= shape.radiusKm;
  }

  /** The derived ground's north–south span in kilometres, for either shape kind. */
  function spanKm(shape: GeographicScope['shape']): number {
    if (shape.kind === 'bounds') {
      return (shape.bounds.northEast.lat - shape.bounds.southWest.lat) * 111;
    }
    return shape.kind === 'radius' ? shape.radiusKm * 2 : 0;
  }

  it('anchors the area on the part the preview chose, never the geometric centroid', () => {
    /**
     * The banned class, exactly: car-free country, "one area, in depth", and the
     * preflight portfolio had already chosen the capital as the one base. The
     * compiled ground must hold the capital, and must not be a circle on the
     * empty middle of the country.
     */
    const scope = narrowedScope({ anchor: HIGHLAND.capital, car: 'no' });
    expect(covers(scope.shape, HIGHLAND.capital.center)).toBe(true);
    expect(covers(scope.shape, HIGHLAND.centroid)).toBe(false);
  });

  it('sizes a car-free area as the walking ground around the settlement', () => {
    /**
     * Honest car-free-country behaviour while no transit provider can measure a
     * journey: the walking reach around the chosen settlement, not the whole
     * country silently and not a centroid circle. The transit gap stays a named
     * readiness deficit downstream.
     */
    const scope = narrowedScope({ anchor: HIGHLAND.capital, car: 'no' });
    expect(spanKm(scope.shape)).toBeLessThanOrEqual(30);
  });

  it('never compiles more ground than the destination itself', () => {
    /**
     * The car direction of the same defect: the narrowed radius was sized by
     * nights alone, so "one area" of a destination could reach past its own
     * published bounds into the next prefecture. One area of X is inside X.
     */
    const scope = narrowedScope({ anchor: HIGHLAND.capital, car: 'yes' });
    expect(scope.shape.kind).toBe('bounds');
    if (scope.shape.kind === 'bounds') {
      expect(scope.shape.bounds.southWest.lat).toBeGreaterThanOrEqual(HIGHLAND.bounds.southWest.lat);
      expect(scope.shape.bounds.southWest.lng).toBeGreaterThanOrEqual(HIGHLAND.bounds.southWest.lng);
      expect(scope.shape.bounds.northEast.lat).toBeLessThanOrEqual(HIGHLAND.bounds.northEast.lat);
      expect(scope.shape.bounds.northEast.lng).toBeLessThanOrEqual(HIGHLAND.bounds.northEast.lng);
    }
  });

  it('holds one area of a settlement inside its own published bounds too', () => {
    /**
     * The city case as measured live: a six-night drive turned "a single part"
     * of a city into a 168 km circle — eleven times the city's own extent.
     */
    const city = candidate({ breadth: 'city', entityType: 'city' });
    const scope = narrowedScope({ car: 'yes', candidate: city, nights: 6 });
    expect(scope.shape.kind).toBe('bounds');
    const published = city.bounds!;
    if (scope.shape.kind === 'bounds') {
      expect(scope.shape.bounds.southWest.lat).toBeGreaterThanOrEqual(published.southWest.lat);
      expect(scope.shape.bounds.northEast.lat).toBeLessThanOrEqual(published.northEast.lat);
      expect(scope.shape.bounds.northEast.lng).toBeLessThanOrEqual(published.northEast.lng);
    }
  });

  it('sizes a driven area as a day\'s ground, not the whole trip\'s arithmetic', () => {
    /**
     * "One area, worked from one base" means day trips out and back. The
     * nights-times-reach table sizes how much ground a whole trip covers moving
     * across parts; a trip that does not move must not inherit it.
     */
    const scope = narrowedScope({ anchor: HIGHLAND.capital, car: 'yes', nights: 7 });
    expect(scope.reachRadiusKm!).toBeLessThanOrEqual(70);
  });

  it('names the chosen part rather than announcing an anonymous single part', () => {
    const scope = narrowedScope({ anchor: HIGHLAND.capital, car: 'no' });
    expect(scope.rationale).toContain('Westhaven');
  });

  it('records the chosen part on the scope for everything downstream', () => {
    const scope = narrowedScope({ anchor: HIGHLAND.capital, car: 'no' });
    expect(scope.includedAreas).toEqual([
      expect.objectContaining({ id: 'cluster-westhaven', name: 'Westhaven' }),
    ]);
  });

  it('keeps a resolved area confirmable', () => {
    const scope = narrowedScope({ anchor: HIGHLAND.capital, car: 'no' });
    expect(scopeFitsTrip(scope).fits).toBe(true);
  });

  it('refuses to confirm one area of a country when nothing resolved which area', () => {
    /**
     * The refuse-before-spend guard. The portfolio layer already refuses a
     * region with nowhere to base a trip from; a scope that claims "one area"
     * without a part to anchor it must be refused before a compile is bought,
     * not flagged as unrecognisable after one.
     */
    const scope = narrowedScope({ car: 'no' });
    expect(scopeFitsTrip(scope).fits).toBe(false);
  });

  it('never falls back to a centroid circle while the part is unresolved', () => {
    /**
     * Even before the confirm-time refusal, the derived shape must not be the
     * banned one: with no part resolved, the container's own ground stands.
     */
    const scope = narrowedScope({ car: 'no' });
    expect(extentCoverage(scope.shape, HIGHLAND.bounds)).toBe(1);
  });
});

describe('a narrowed car trip on a container reaches its own day-trip range', () => {
  /**
   * The clipped-circuit class, exactly as it shipped: a seven-night car trip
   * anchored on a container destination's capital was cut to the generic
   * 70 km day constant, and the standard day-trip circuit for exactly that
   * shape of trip — ~100 km out — fell outside the compiled ground, taking
   * half the destination's canonical subjects out of every denominator. The
   * traveller's own questionnaire states how long they will drive in a day;
   * half of it outbound at the region model's transfer speed is the radius
   * their answer implies.
   */
  const HIGHLAND_ANCHOR = { id: 'cluster-westhaven', name: 'Westhaven', center: { lat: 0.6, lng: 0.5 } };
  /* ~100 km east of the anchor: inside a stated 4-hour driving day, outside the 70 km constant. */
  const CIRCUIT_FALLS = { lat: 0.62, lng: 1.4 };

  const drivingProfile = (maxDailyTravelMinutes: number) =>
    buildTravelerProfile(
      {
        ...defaultAnswers({ travelerNeeds: [], tripDays: 8 }),
        willDrive: true,
        maxDailyTravelMinutes,
      },
      { travelerNeeds: [], tripDays: 8 },
    );

  function narrowedCar(profile?: TravelerProfile) {
    return deriveScope({
      candidate: candidate({
        displayName: 'Highland Republic',
        qualifiedName: 'Highland Republic',
        breadth: 'country',
        entityType: 'country',
        center: { lat: 2.0, lng: 2.0 },
        bounds: { southWest: { lat: 0.0, lng: 0.0 }, northEast: { lat: 4.0, lng: 4.0 } },
      }),
      clarifications: {
        schemaVersion: 1,
        questions: [],
        answers: [
          { questionId: QUESTION_IDS.breadthStrategy, values: ['one_area'], answeredAt: 'x' },
          { questionId: QUESTION_IDS.carAvailable, values: ['yes'], answeredAt: 'x' },
        ],
      },
      nights: 7,
      revision: 1,
      preflightAnchor: HIGHLAND_ANCHOR,
      ...(profile ? { profile } : {}),
    });
  }

  function covers(shape: GeographicScope['shape'], point: { lat: number; lng: number }): boolean {
    if (shape.kind === 'bounds') {
      return (
        point.lat >= shape.bounds.southWest.lat &&
        point.lat <= shape.bounds.northEast.lat &&
        point.lng >= shape.bounds.southWest.lng &&
        point.lng <= shape.bounds.northEast.lng
      );
    }
    if (shape.kind !== 'radius') return false;
    const dLat = (point.lat - shape.center.lat) * 111;
    const dLng =
      (point.lng - shape.center.lng) * 111 * Math.cos((shape.center.lat * Math.PI) / 180);
    return Math.hypot(dLat, dLng) <= shape.radiusKm;
  }

  it('widens the day reach to the stated drive tolerance, clamped by the mode cap', () => {
    const stated = narrowedCar(drivingProfile(240));
    expect(stated.reachRadiusKm).toBe(110);
    expect(covers(stated.shape, CIRCUIT_FALLS)).toBe(true);
    /* The rationale says what it covers — the number is the honest one. */
    expect(stated.rationale).toContain('110 km');
  });

  it('keeps the generic day for a traveller who stated nothing, and floors a cautious answer', () => {
    const generic = narrowedCar();
    expect(generic.reachRadiusKm).toBe(70);
    expect(covers(generic.shape, CIRCUIT_FALLS)).toBe(false);
    /* An answer smaller than the table's day never shrinks below it. */
    const cautious = narrowedCar(drivingProfile(60));
    expect(cautious.reachRadiusKm).toBe(70);
  });
});
