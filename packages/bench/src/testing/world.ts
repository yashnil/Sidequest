import { haversineKm } from '../geometry';
import type {
  BenchmarkGroundTruth,
  DayOpening,
  FoodVenueFacts,
  InventoryEntry,
  SolarDay,
} from '../ground-truth';
import type { BenchmarkTripRequest } from '../schemas/request';
import { FIXED_NOW, fakeRequest, type FakeRequestOverrides } from './request';

/**
 * A WORLD THAT IS NOT ANYWHERE.
 *
 * The Kestrel Coast does not exist and must never start to. Every name here is
 * invented, following the same rule as the compiler's synthetic worlds: a
 * fixture that used real places would make a validator's behaviour depend on
 * whatever the real inventory happened to hold that week, and would tempt
 * somebody into "fixing" a test by editing the world rather than the check.
 *
 * What the world is *for* is the shape of the gaps. A benchmark's hardest
 * question is what a plan should do when nobody published the answer, so this
 * inventory deliberately contains a place with published hours, a place whose
 * hours dataset exists and says it does not know, a place with no dataset at
 * all, a place that is only open half the year, a place nobody measured a route
 * to, a source that was retrieved but never read, and a restaurant that states
 * plainly what it cannot cook. Each of those is a different answer from
 * `openingOn` or `supportsClaim`, and each is one a check has to handle without
 * inventing a default.
 */

/** How much the world knows about a place's opening times. */
export type FakeHours =
  | { kind: 'no_dataset' }
  | { kind: 'unknown' }
  | { kind: 'always_open' }
  | {
      kind: 'windows';
      windows: readonly { openMinute: number; closeMinute: number }[];
      lastAdmissionMinute?: number;
      /** Dates the place is shut despite the usual window. */
      closedDates?: readonly string[];
    };

export interface FakePlaceSpec {
  entityId: string;
  name: string;
  latitude: number;
  longitude: number;
  typicalDurationMinutes: number | null;
  hours: FakeHours;
  daylightOnly: boolean | null;
  tags: readonly string[];
  /** Months a seasonal rule says it is reachable. `null` means no rule on record. */
  openMonths: readonly number[] | null;
  requiresCar: boolean | null;
  unpavedApproach: boolean | null;
  remoteNoServices: boolean | null;
  strenuous: boolean | null;
}

/**
 * A food venue is stated exactly as the port returns it — there is nothing extra
 * a fixture needs to know about one, and inventing a difference here would let
 * the fake drift from the shape the real implementation has to produce.
 */
export type FakeFoodSpec = FoodVenueFacts;

export interface FakeWorldSpec {
  places: readonly FakePlaceSpec[];
  food: readonly FakeFoodSpec[];
  /**
   * Pairs a routing engine answered for, keyed `from>to`.
   *
   * Read in both directions, because a fixture that made the return leg
   * unmeasured would produce an `unknown` finding on every round trip and drown
   * the defect the test was actually about.
   */
  measuredRoutes: Readonly<Record<string, number>>;
  /** Sunrise and sunset by date. A date with no entry has no solar record. */
  solarByDate: Readonly<Record<string, SolarDay>>;
  /** How many sources the run retrieved. An index beyond this is backed by nothing. */
  sourceCount: number;
  /** Which retrieved sources were actually read. The rest can only answer `unknown`. */
  extractedSources: readonly number[];
  /** Exactly what the read sources were found to say. */
  supportedClaims: readonly { sourceIndex: number; factPath: string; statedValue: string }[];
}

function place(spec: FakePlaceSpec): FakePlaceSpec {
  return spec;
}

export const KESTREL_COAST: FakeWorldSpec = {
  places: [
    place({
      entityId: 'kc-region',
      name: 'Kestrel Coast',
      latitude: 55.2,
      longitude: -5.4,
      typicalDurationMinutes: null,
      hours: { kind: 'no_dataset' },
      daylightOnly: null,
      tags: ['region'],
      openMonths: null,
      requiresCar: null,
      unpavedApproach: null,
      remoteNoServices: null,
      strenuous: null,
    }),
    place({
      entityId: 'kc-harbour-quarter',
      name: 'Harbour Quarter',
      latitude: 55.201,
      longitude: -5.402,
      typicalDurationMinutes: null,
      hours: { kind: 'always_open' },
      daylightOnly: false,
      tags: ['neighbourhood', 'base'],
      openMonths: null,
      requiresCar: false,
      unpavedApproach: false,
      remoteNoServices: false,
      strenuous: false,
    }),
    place({
      entityId: 'kc-old-quay-steps',
      name: 'Old Quay Steps',
      latitude: 55.2035,
      longitude: -5.398,
      typicalDurationMinutes: 60,
      hours: { kind: 'windows', windows: [{ openMinute: 540, closeMinute: 1050 }] },
      daylightOnly: false,
      tags: ['historic_site', 'viewpoint'],
      openMonths: null,
      requiresCar: false,
      unpavedApproach: false,
      remoteNoServices: false,
      strenuous: false,
    }),
    place({
      entityId: 'kc-lantern-museum',
      name: 'Lantern Museum',
      latitude: 55.2062,
      longitude: -5.3925,
      typicalDurationMinutes: 90,
      hours: {
        kind: 'windows',
        windows: [{ openMinute: 600, closeMinute: 1080 }],
        lastAdmissionMinute: 1035,
        closedDates: ['2027-05-21'],
      },
      daylightOnly: false,
      tags: ['museum'],
      openMonths: null,
      requiresCar: false,
      unpavedApproach: false,
      remoteNoServices: false,
      strenuous: false,
    }),
    /** A dataset exists and says it does not know. Not the same as no dataset. */
    place({
      entityId: 'kc-tidal-garden',
      name: 'Tidal Garden',
      latitude: 55.211,
      longitude: -5.386,
      typicalDurationMinutes: 75,
      hours: { kind: 'unknown' },
      daylightOnly: true,
      tags: ['garden', 'easy_walk'],
      openMonths: null,
      requiresCar: false,
      unpavedApproach: false,
      remoteNoServices: false,
      strenuous: false,
    }),
    place({
      entityId: 'kc-gull-rock-lookout',
      name: 'Gull Rock Lookout',
      latitude: 55.1965,
      longitude: -5.4105,
      typicalDurationMinutes: 45,
      hours: { kind: 'always_open' },
      daylightOnly: false,
      tags: ['viewpoint'],
      openMonths: null,
      requiresCar: false,
      unpavedApproach: false,
      remoteNoServices: false,
      strenuous: false,
    }),
    place({
      entityId: 'kc-tide-mill',
      name: 'Tide Mill',
      latitude: 55.1988,
      longitude: -5.4162,
      typicalDurationMinutes: 45,
      hours: { kind: 'windows', windows: [{ openMinute: 660, closeMinute: 1020 }] },
      daylightOnly: false,
      tags: ['historic_site'],
      openMonths: null,
      requiresCar: false,
      unpavedApproach: false,
      remoteNoServices: false,
      strenuous: false,
    }),
    /** Nobody publishes hours, and a seasonal rule shuts the approach in winter. */
    place({
      entityId: 'kc-mirror-tarn',
      name: 'Mirror Tarn',
      latitude: 55.26,
      longitude: -5.31,
      typicalDurationMinutes: 120,
      hours: { kind: 'no_dataset' },
      daylightOnly: null,
      tags: ['lake', 'easy_walk'],
      openMonths: [4, 5, 6, 7, 8, 9, 10],
      requiresCar: true,
      unpavedApproach: false,
      remoteNoServices: false,
      strenuous: false,
    }),
    place({
      entityId: 'kc-cable-station',
      name: 'Wind Ridge Cable Station',
      latitude: 55.245,
      longitude: -5.34,
      typicalDurationMinutes: 90,
      hours: { kind: 'windows', windows: [{ openMinute: 570, closeMinute: 960 }] },
      daylightOnly: false,
      tags: ['viewpoint', 'lift'],
      openMonths: [5, 6, 7, 8, 9],
      requiresCar: true,
      unpavedApproach: false,
      remoteNoServices: false,
      strenuous: false,
    }),
    /** The only strenuous place, and the only one on an unpaved approach. */
    place({
      entityId: 'kc-north-headland',
      name: 'North Headland Path',
      latitude: 55.31,
      longitude: -5.26,
      typicalDurationMinutes: 210,
      hours: { kind: 'no_dataset' },
      daylightOnly: true,
      // Tagged as well as flagged. The two are read by different checks — a
      // mobility constraint looks at the flags, a stated avoidance looks at the
      // taxonomy — and a fixture carrying only one of them would leave half the
      // constraint machinery untested.
      tags: ['day_hike', 'strenuous', 'steep'],
      openMonths: null,
      requiresCar: true,
      unpavedApproach: true,
      remoteNoServices: true,
      strenuous: true,
    }),
    place({
      entityId: 'kc-saltmarsh-hide',
      name: 'Saltmarsh Hide',
      latitude: 55.16,
      longitude: -5.52,
      typicalDurationMinutes: 60,
      hours: { kind: 'always_open' },
      daylightOnly: false,
      tags: ['wildlife_area'],
      openMonths: null,
      requiresCar: true,
      unpavedApproach: false,
      remoteNoServices: true,
      strenuous: false,
    }),
    place({
      entityId: 'kc-storm-light',
      name: 'Storm Light Beacon',
      latitude: 55.02,
      longitude: -5.78,
      typicalDurationMinutes: 90,
      hours: { kind: 'no_dataset' },
      daylightOnly: null,
      tags: ['viewpoint', 'historic_site'],
      openMonths: null,
      requiresCar: true,
      unpavedApproach: false,
      remoteNoServices: true,
      strenuous: false,
    }),
  ],
  food: [
    {
      entityId: 'kc-quay-bakery',
      name: 'Quay Bakery',
      latitude: 55.2015,
      longitude: -5.4035,
      servesSlots: ['breakfast', 'snack'],
      cannotAccommodate: [],
    },
    {
      entityId: 'kc-harbour-canteen',
      name: 'Harbour Canteen',
      latitude: 55.2022,
      longitude: -5.4008,
      servesSlots: ['lunch', 'dinner'],
      // Stated by the venue rather than inferred, which is what makes a strict
      // dietary conflict decidable instead of a guess.
      cannotAccommodate: ['gluten_free'],
    },
    {
      entityId: 'kc-blue-lantern',
      name: 'The Blue Lantern',
      latitude: 55.2044,
      longitude: -5.3968,
      servesSlots: ['dinner'],
      cannotAccommodate: [],
    },
  ],
  measuredRoutes: {
    'kc-harbour-quarter>kc-old-quay-steps': 6,
    'kc-old-quay-steps>kc-lantern-museum': 12,
    'kc-lantern-museum>kc-harbour-canteen': 8,
    'kc-harbour-canteen>kc-tidal-garden': 18,
    'kc-tidal-garden>kc-harbour-quarter': 22,
    'kc-harbour-quarter>kc-gull-rock-lookout': 9,
    'kc-harbour-quarter>kc-tide-mill': 11,
    'kc-harbour-quarter>kc-lantern-museum': 15,
    'kc-harbour-quarter>kc-mirror-tarn': 45,
    'kc-quay-bakery>kc-mirror-tarn': 44,
    'kc-quay-bakery>kc-gull-rock-lookout': 10,
    'kc-quay-bakery>kc-tide-mill': 12,
    'kc-quay-bakery>kc-lantern-museum': 16,
    'kc-quay-bakery>kc-storm-light': 162,
    'kc-mirror-tarn>kc-cable-station': 25,
    'kc-cable-station>kc-harbour-quarter': 35,
    'kc-harbour-quarter>kc-storm-light': 160,
    'kc-harbour-quarter>kc-quay-bakery': 3,
    'kc-harbour-quarter>kc-blue-lantern': 5,
    'kc-harbour-quarter>kc-harbour-canteen': 4,
    // Nothing to the North Headland or the Saltmarsh Hide, on purpose: those two
    // are how a plan reaches an honest `unknown` rather than a defect.
  },
  solarByDate: {
    '2027-05-18': { sunriseMinute: 305, sunsetMinute: 1275, kind: 'normal' },
    '2027-05-19': { sunriseMinute: 304, sunsetMinute: 1277, kind: 'normal' },
    '2027-05-20': { sunriseMinute: 302, sunsetMinute: 1279, kind: 'normal' },
  },
  sourceCount: 5,
  extractedSources: [0, 1, 3, 4],
  supportedClaims: [
    { sourceIndex: 0, factPath: 'hours.weekly', statedValue: '09:00-17:30' },
    { sourceIndex: 1, factPath: 'hours.weekly', statedValue: '10:00-18:00' },
    { sourceIndex: 1, factPath: 'hours.lastAdmission', statedValue: '17:15' },
    { sourceIndex: 3, factPath: 'hours.weekly', statedValue: '09:30-16:00' },
    { sourceIndex: 4, factPath: 'hours.weekly', statedValue: '11:00-17:00' },
  ],
};

export interface FakeGroundTruthOverrides {
  /** Swap the traveller. Sections deep-merge; see `fakeRequest`. */
  request?: FakeRequestOverrides | BenchmarkTripRequest;
  /** The instant the run is judged at. Fixed by default, never read from a clock. */
  now?: Date;
  /** Swap any part of the world — which places have hours, which routes exist. */
  world?: Partial<FakeWorldSpec>;
}

function isFullRequest(
  value: FakeRequestOverrides | BenchmarkTripRequest,
): value is BenchmarkTripRequest {
  return 'schemaVersion' in value;
}

/**
 * The port, implemented over a spec rather than over a database.
 *
 * Every accessor returns `null` for "not established" exactly where the real
 * implementation does, because a fake that answered more confidently than the
 * real thing would let a check pass here and return `unknown` in production —
 * and the benchmark's whole claim rests on those two agreeing.
 */
export function fakeGroundTruth(overrides: FakeGroundTruthOverrides = {}): BenchmarkGroundTruth {
  const world: FakeWorldSpec = { ...KESTREL_COAST, ...overrides.world };
  const request =
    overrides.request === undefined
      ? fakeRequest()
      : isFullRequest(overrides.request)
        ? overrides.request
        : fakeRequest(overrides.request);

  const places = new Map(world.places.map((entry) => [entry.entityId, entry]));
  const venues = new Map(world.food.map((entry) => [entry.entityId, entry]));
  const extracted = new Set(world.extractedSources);

  const coordinatesOf = (entityId: string): { latitude: number; longitude: number } | null => {
    const found = places.get(entityId) ?? venues.get(entityId);
    return found ? { latitude: found.latitude, longitude: found.longitude } : null;
  };

  return {
    request,
    now: overrides.now ?? FIXED_NOW,

    place(entityId: string): InventoryEntry | null {
      const found = places.get(entityId);
      if (!found) return null;
      return {
        entityId: found.entityId,
        name: found.name,
        latitude: found.latitude,
        longitude: found.longitude,
        typicalDurationMinutes: found.typicalDurationMinutes,
        daylightOnly: found.daylightOnly,
        tags: found.tags,
        requiresCar: found.requiresCar,
        unpavedApproach: found.unpavedApproach,
        remoteNoServices: found.remoteNoServices,
        strenuous: found.strenuous,
      };
    },

    openingOn(entityId: string, date: string): DayOpening | null {
      const found = places.get(entityId);
      if (!found) return null;
      const hours = found.hours;
      if (hours.kind === 'no_dataset') return null;
      if (hours.kind === 'unknown') {
        return { status: 'unknown', windows: [], lastAdmissionMinute: null };
      }
      if (hours.kind === 'always_open') {
        return { status: 'always_open', windows: [], lastAdmissionMinute: null };
      }
      if (hours.closedDates?.includes(date)) {
        return { status: 'closed', windows: [], lastAdmissionMinute: null };
      }
      return {
        status: 'open',
        windows: hours.windows,
        lastAdmissionMinute: hours.lastAdmissionMinute ?? null,
      };
    },

    seasonallyOpenOn(entityId: string, date: string): boolean | null {
      const found = places.get(entityId);
      if (!found || found.openMonths === null) return null;
      const month = Number(date.slice(5, 7));
      return found.openMonths.includes(month);
    },

    solar(entityId: string, date: string): SolarDay | null {
      if (!places.has(entityId)) return null;
      return world.solarByDate[date] ?? null;
    },

    routeMinutes(fromEntityId: string, toEntityId: string): number | null {
      return (
        world.measuredRoutes[`${fromEntityId}>${toEntityId}`] ??
        world.measuredRoutes[`${toEntityId}>${fromEntityId}`] ??
        null
      );
    },

    straightLineKm(fromEntityId: string, toEntityId: string): number | null {
      const from = coordinatesOf(fromEntityId);
      const to = coordinatesOf(toEntityId);
      if (!from || !to) return null;
      return haversineKm(from, to);
    },

    food(entityId: string): FoodVenueFacts | null {
      return venues.get(entityId) ?? null;
    },

    supportsClaim(
      sourceIndex: number,
      factPath: string | undefined,
      statedValue: string | undefined,
    ): boolean | null {
      // Three answers, and the middle one is why this is not a boolean. A source
      // the run never retrieved backs nothing, and saying so is a defect the
      // plan owns. A source that was retrieved but never read can neither
      // confirm nor deny, and calling that `false` would punish a plan for the
      // funnel's gap rather than for its own claim.
      /*
       * Out of range is not this port's question.
       *
       * The index belongs to the plan's own source list, not to the world's; the
       * claims validator holds the plan and does that check. Answering `false`
       * here convicted a citation of being unsupported because an unrelated
       * count was smaller.
       */
      if (sourceIndex < 0 || sourceIndex >= world.sourceCount) return null;
      if (!extracted.has(sourceIndex)) return null;
      return world.supportedClaims.some(
        (claim) =>
          claim.sourceIndex === sourceIndex &&
          (factPath === undefined || claim.factPath === factPath) &&
          (statedValue === undefined || claim.statedValue === statedValue),
      );
    },
  };
}
