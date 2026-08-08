import type { BenchmarkTripRequest } from '@sidequest/bench';
import type { BaselineGeneration } from './generate';
import type { PacketInputs, RawDay, RawPlace } from './packet';
import type { PacketDestination } from './packet-types';

/**
 * OFFLINE MATERIAL, AND NOTHING THAT COULD REACH A NETWORK.
 *
 * Small, hand-written world data for the suite and for `fixture` mode. It lives
 * beside the code rather than in a test file because two things consume it: the
 * tests, and a fixture-mode run — which is the mode this build defaults to, so a
 * developer with no credentials can still see the whole flow work.
 *
 * The places are invented and belong to nobody. That matters: a fixture named
 * after a real town would tempt somebody into checking the plan against the real
 * town, and a benchmark arm that could be tuned against a specific destination
 * has memorised the test rather than passed it.
 */

export const FIXTURE_DESTINATION: PacketDestination = {
  entityId: 'relation/900001',
  displayName: 'Ardenholt',
  countryCode: 'ZZ',
  latitude: 45,
  longitude: 9,
  radiusKm: 30,
  scale: 'subregion',
};

function place(overrides: Partial<RawPlace> & Pick<RawPlace, 'entityId' | 'name'>): RawPlace {
  return {
    latitude: 45,
    longitude: 9,
    kind: 'tourism=attraction',
    tags: ['tourism', 'attraction'],
    typicalDurationMinutes: null,
    daylightOnly: null,
    hours: { state: 'unknown' },
    seasonal: { state: 'unknown' },
    access: {
      requiresCar: null,
      unpavedApproach: null,
      remoteNoServices: null,
      strenuous: null,
      wheelchair: 'unknown',
      feeStated: null,
    },
    food: null,
    source: {
      host: 'openstreetmap.org',
      title: overrides.name,
      url: `https://www.openstreetmap.org/${overrides.entityId}`,
      retrievedAt: '2026-08-01T00:00:00.000Z',
    },
    ...overrides,
  };
}

export const FIXTURE_PLACES: RawPlace[] = [
  place({ entityId: 'node/1001', name: 'Ardenholt Belvedere', latitude: 45.02, longitude: 9.02, kind: 'tourism=viewpoint' }),
  place({ entityId: 'node/1002', name: 'Vetterlin Falls', latitude: 45.14, longitude: 9.21, kind: 'natural=waterfall' }),
  place({
    entityId: 'node/1003',
    name: 'Ardenholt Museum',
    latitude: 45.01,
    longitude: 9.0,
    kind: 'tourism=museum',
    hours: {
      state: 'known',
      windows: [
        { date: '2026-09-01', openMinute: 600, closeMinute: 1020 },
        { date: '2026-09-02', openMinute: 600, closeMinute: 1020 },
      ],
      closedDates: [],
      sourceIndex: null,
    },
  }),
  place({
    entityId: 'node/1004',
    name: 'Hollow Pass Overlook',
    latitude: 45.31,
    longitude: 9.4,
    kind: 'natural=peak',
    seasonal: { state: 'closed_in_season', note: 'The approach road is shut outside the summer.' },
  }),
  place({
    entityId: 'node/2001',
    name: 'The Millstone',
    latitude: 45.0,
    longitude: 9.01,
    kind: 'amenity=restaurant',
    tags: ['amenity', 'restaurant'],
    food: { servesSlots: [], dietaryTags: [], cuisine: 'regional', cannotAccommodate: [] },
  }),
  place({
    entityId: 'node/2002',
    name: 'Brant Bakery',
    latitude: 45.13,
    longitude: 9.2,
    kind: 'shop=bakery',
    tags: ['shop', 'bakery'],
    food: { servesSlots: [], dietaryTags: ['vegetarian'], cuisine: null, cannotAccommodate: [] },
  }),
];

export const FIXTURE_DAYS: RawDay[] = [
  {
    dayNumber: 1,
    date: '2026-09-01',
    daylight: { state: 'known', sunriseMinute: 400, sunsetMinute: 1180 },
    weather: {
      state: 'climate',
      summary: 'Typical conditions for early September in recent years, not a forecast.',
      highCelsius: 24,
      lowCelsius: 13,
      precipitationChance: 20,
      sourceIndex: null,
    },
    weatherSource: { host: 'open-meteo.com', title: 'Open-Meteo', url: null, retrievedAt: '2026-08-01T00:00:00.000Z' },
  },
  {
    dayNumber: 2,
    date: '2026-09-02',
    daylight: { state: 'known', sunriseMinute: 402, sunsetMinute: 1178 },
    weather: { state: 'unknown' },
    weatherSource: null,
  },
];

export function fixturePacketInputs(overrides: Partial<PacketInputs> = {}): PacketInputs {
  return {
    destination: FIXTURE_DESTINATION,
    days: FIXTURE_DAYS,
    places: FIXTURE_PLACES,
    baseCandidates: [
      {
        entityId: null,
        name: 'Ardenholt',
        latitude: 45,
        longitude: 9,
        basis: 'The destination the traveller named, as resolved by the geocoder.',
      },
    ],
    routeLegs: [
      { fromEntityId: 'node/1001', toEntityId: 'node/1002', minutes: 28, km: 21.4, mode: 'drive' },
      { fromEntityId: 'node/1002', toEntityId: 'node/1001', minutes: 27, km: 21.4, mode: 'drive' },
    ],
    gaps: [],
    unknowns: [],
    ...overrides,
  };
}

/**
 * A canned generation, shaped exactly as the schema demands.
 *
 * Deliberately imperfect in one visible way — day two has no meal — so a test
 * that runs the validators against it has something to find, and so nobody
 * mistakes this for a worked example of a good plan.
 */
export function fixtureGeneration(overrides: Partial<BaselineGeneration> = {}): BaselineGeneration {
  return {
    summary: 'Two unhurried days around Ardenholt, with the far overlook left out because it is shut.',
    scopeNote: 'Everything here is within half an hour of the town.',
    bases: [
      {
        id: 'ardenholt',
        placeIndex: null,
        name: 'Ardenholt',
        nights: 1,
        why: 'Central to everything on this list, which keeps both days short.',
      },
    ],
    days: [
      {
        dayNumber: 1,
        baseId: 'ardenholt',
        theme: 'The town and the view above it',
        blocks: [
          {
            kind: 'activity',
            title: 'The museum, before it fills up',
            startMinute: 610,
            endMinute: 730,
            placeIndex: 2,
            travel: null,
            meal: null,
            opening: {
              openMinute: 600,
              closeMinute: 1020,
              lastAdmissionMinute: null,
              sourceIndex: 2,
            },
            note: 'Opens at ten, and an hour and a half is enough for it.',
            uncertainty: [],
            sourceIndex: 2,
          },
          {
            kind: 'meal',
            title: 'Lunch in town',
            startMinute: 750,
            endMinute: 810,
            placeIndex: 4,
            travel: null,
            meal: { slot: 'lunch', stopKind: 'venue', venuePlaceIndex: 4, detourMinutes: 0 },
            opening: null,
            note: 'Two minutes from the museum door, which is the only reason it is here.',
            uncertainty: ['Nobody publishes when this place is open.'],
            sourceIndex: null,
          },
        ],
        /*
         * The day's own arithmetic, stated as the model is asked to state it:
         * no travel block on this day, so nought minutes of it, and no claim
         * about free time rather than a zero that would read as a full day.
         */
        statedTotals: { travelMinutes: 0, driveMinutes: 0, freeMinutes: null },
        alternatives: [],
        warnings: [],
      },
      {
        dayNumber: 2,
        baseId: 'ardenholt',
        theme: 'Out to the falls',
        blocks: [
          {
            kind: 'travel',
            title: 'Drive out to the falls',
            startMinute: 540,
            endMinute: 568,
            placeIndex: null,
            travel: {
              mode: 'drive',
              fromPlaceIndex: 0,
              toPlaceIndex: 1,
              minutes: 28,
              provenance: 'measured',
            },
            meal: null,
            opening: null,
            note: 'Measured, so this is the real time rather than an estimate.',
            uncertainty: [],
            sourceIndex: null,
          },
          {
            kind: 'activity',
            title: 'The falls',
            startMinute: 570,
            endMinute: 690,
            placeIndex: 1,
            travel: null,
            meal: null,
            opening: null,
            note: 'No gate and no hours published, so any time in the light works.',
            uncertainty: ['No opening hours are published for this.'],
            sourceIndex: 1,
          },
        ],
        // The one measured leg of the day, and the plan says so itself.
        statedTotals: { travelMinutes: 28, driveMinutes: 28, freeMinutes: null },
        alternatives: [],
        warnings: [],
      },
    ],
    exclusions: [{ placeIndex: 3, reason: 'The approach road is shut outside the summer.' }],
    unknowns: ['Opening hours could not be confirmed for most of these places.'],
    preparation: ['Carry lunch on the second day; there is nothing listed near the falls.'],
    warnings: [],
    ...overrides,
  };
}

/**
 * The fixture world, stretched to the length of a particular trip.
 *
 * `fixturePacketInputs` holds two days because that is what its canned
 * generation covers. A harness running a fourteen-night case against it would
 * get a packet with twelve dates missing, and every one of those days would
 * arrive at the plan as "the plan did not cover this day" — a defect belonging
 * to the fixture rather than to either system.
 *
 * So the dates come from the request. The places, the legs and the gaps do not:
 * inventing more world for a longer trip would make trip length and inventory
 * size covary, and no result sliced by length would mean anything afterwards.
 */
export function baselineFixtureInputs(
  request: BenchmarkTripRequest,
  now: Date,
): PacketInputs {
  const base = fixturePacketInputs();
  const start =
    request.dates.startDate ??
    (request.dates.year !== null && request.dates.month !== null
      ? `${String(request.dates.year).padStart(4, '0')}-${String(request.dates.month).padStart(2, '0')}-01`
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10));
  const startMs = Date.parse(`${start}T00:00:00.000Z`);

  const template = base.days;
  const days: RawDay[] = Array.from({ length: Math.max(1, request.dates.nights + 1) }, (_, index) => {
    const pattern = template[index % Math.max(1, template.length)];
    const date = new Date(startMs + index * 86_400_000).toISOString().slice(0, 10);
    return {
      dayNumber: index + 1,
      date,
      daylight: pattern?.daylight ?? { state: 'unknown' },
      weather: pattern?.weather ?? { state: 'unknown' },
      weatherSource: pattern?.weatherSource ?? null,
    };
  });

  return { ...base, days };
}
