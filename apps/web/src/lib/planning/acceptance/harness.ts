import { buildScenario, EASTERN_SIERRA_WORLD } from '@sidequest/planner/testing';
import type { PlannerInput } from '@sidequest/planner';
import { tripDates, unavailableWeatherDataset, type Trip, type TravelerProfile, type TripBasics } from '@sidequest/core';
import type { GeocodedLocality, RouteMatrixResult, RouteConfirmation } from '../skeleton-adapter';
import type { ReconcileContext } from '../reconcile';
import { defaultProfileFor } from '../production-plan';
import type { TripDraft } from '../trip-draft';

/**
 * ACCEPTANCE HARNESS — FICTIONAL DESTINATIONS WITH PROGRAMMABLE EVIDENCE.
 *
 * Every shape fixture in `shapes.test.ts` is a *fictional* geography: named
 * places at coordinates that exist only here, a geocoder that knows some of
 * them, a router that measures road legs at a fixed speed and can be told
 * which pairs have no road, which fail, or that it is down altogether. Nothing
 * here names a real recommendation; the fixtures test architectural
 * behaviour — retention under missing evidence, correction under affirmative
 * evidence, graceful degradation — not travel knowledge.
 */

export interface FictionalPlace {
  name: string;
  lat: number;
  lng: number;
  /** Whether the fixture geocoder knows this place at all. */
  known?: boolean;
  entityType?: 'city' | 'neighbourhood' | 'unknown';
}

export interface FictionalWorldOptions {
  name: string;
  countryCode?: string;
  center: { lat: number; lng: number };
  places: readonly FictionalPlace[];
  basics: Partial<TripBasics>;
  profile?: Partial<TravelerProfile['transport']> & { pace?: TravelerProfile['pace'] };
  /** Road speed in km/h for the fixture router. */
  roadKmh?: number;
  /** Pairs (by place name) the router affirmatively answers "no route" for, in either direction. */
  noRoadBetween?: readonly [string, string][];
  /** Provider outage switches. */
  outage?: { geocoder?: boolean; router?: boolean; corridor?: boolean };
  /** Corridor settlements the corridor search may return near a point. */
  settlements?: readonly FictionalPlace[];
  /** Simulates a deadline that has already passed. */
  deadlineReached?: boolean;
  mustIncludeNames?: readonly string[];
}

export interface FictionalWorld {
  context: ReconcileContext;
  calls: { geocode: number; matrix: number; confirm: number; corridor: number };
  trip: Trip;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371.0088;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function normalize(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function fictionalWorld(options: FictionalWorldOptions): FictionalWorld {
  const calls = { geocode: 0, matrix: 0, confirm: 0, corridor: 0 };
  const basics: TripBasics = {
    mode: 'known_destination',
    destinationInput: options.name,
    regionId: 'dynamic',
    startDate: '2026-08-01',
    endDate: '2026-08-05',
    arrivalTime: '10:00',
    departureTime: '17:00',
    /*
     * PRODUCTION LOCK V5 §7 — these fixture worlds mean their times.
     *
     * Every acceptance world here states an arrival and a departure on purpose,
     * to exercise the day windows they imply, so the traveller they describe is
     * one who has booked. Marking them `exact` is what says so: without it the
     * precision reads as unknown and the times become unprintable, which is
     * correct for a real trip nobody has booked and wrong for these.
     */
    arrivalPrecision: 'exact',
    departurePrecision: 'exact',
    adults: 2,
    children: 0,
    travelerNeeds: [],
    ...options.basics,
  };
  const trip: Trip = { id: `fixture-${normalize(options.name).replace(/\s+/g, '-')}`, basics, status: 'draft', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' };
  const baseProfile = defaultProfileFor(trip, null);
  const profile: TravelerProfile = {
    ...baseProfile,
    ...(options.profile?.pace ? { pace: options.profile.pace } : {}),
    transport: { ...baseProfile.transport, ...(options.profile ? Object.fromEntries(Object.entries(options.profile).filter(([k]) => k !== 'pace')) : {}) },
  };
  const regionId = `fixture:${trip.id}`;
  const roadKmh = options.roadKmh ?? 60;
  const byName = new Map(options.places.map((p) => [normalize(p.name), p] as const));
  const coordsById = new Map<string, { lat: number; lng: number }>();
  const idOf = (place: FictionalPlace) => `fx:${normalize(place.name).replace(/\s+/g, '-')}`;
  for (const place of options.places) coordsById.set(idOf(place), place);
  for (const s of options.settlements ?? []) coordsById.set(idOf(s), s);
  const noRoad = new Set((options.noRoadBetween ?? []).flatMap(([a, b]) => [`${normalize(a)}|${normalize(b)}`, `${normalize(b)}|${normalize(a)}`]));
  const nameOfId = (id: string) => normalize([...options.places, ...(options.settlements ?? [])].find((p) => idOf(p) === id)?.name ?? id);

  const geocodeLocality = async (query: string): Promise<readonly GeocodedLocality[]> => {
    calls.geocode += 1;
    if (options.outage?.geocoder) throw new Error('fixture geocoder outage');
    const wanted = normalize(query.split(',')[0] ?? query);
    const place = byName.get(wanted);
    if (!place || place.known === false) return [];
    return [{ sourceId: idOf(place), name: place.name, lat: place.lat, lng: place.lng, countryCode: options.countryCode ?? 'xx', entityType: place.entityType ?? 'unknown', importance: 0.5 }];
  };

  const legFor = (from: { lat: number; lng: number }, to: { lat: number; lng: number }) => {
    const km = Math.round(haversineKm(from, to) * 1.25 * 10) / 10;
    return { minutes: Math.round((km / roadKmh) * 60), km };
  };

  const routeMatrix = async (points: readonly { id: string; lat: number; lng: number }[]): Promise<RouteMatrixResult | null> => {
    calls.matrix += 1;
    if (options.outage?.router) throw new Error('fixture router outage');
    const ids = points.map((p) => p.id);
    const failedPairs: { fromId: string; toId: string; reason: 'not_found' }[] = [];
    const minutes = points.map((a) => points.map((b) => (a.id === b.id ? 0 : legFor(a, b).minutes)));
    const km = points.map((a) => points.map((b) => (a.id === b.id ? 0 : legFor(a, b).km)));
    for (const [i, a] of points.entries()) {
      for (const [j, b] of points.entries()) {
        if (i === j) continue;
        if (noRoad.has(`${nameOfId(a.id)}|${nameOfId(b.id)}`)) {
          failedPairs.push({ fromId: a.id, toId: b.id, reason: 'not_found' });
        }
      }
    }
    // A pair the router refuses is reported as a failure, not measured.
    const filteredMinutes = minutes.map((row, i) => row.map((v, j) => (failedPairs.some((f) => f.fromId === ids[i] && f.toId === ids[j]) ? Number.NaN : v)));
    return { ids, minutes: filteredMinutes, km, failedPairs };
  };

  const confirmRoute = async (from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<RouteConfirmation | null> => {
    calls.confirm += 1;
    if (options.outage?.router) throw new Error('fixture router outage');
    const fromName = [...options.places, ...(options.settlements ?? [])].find((p) => Math.abs(p.lat - from.lat) < 1e-6 && Math.abs(p.lng - from.lng) < 1e-6);
    const toName = [...options.places, ...(options.settlements ?? [])].find((p) => Math.abs(p.lat - to.lat) < 1e-6 && Math.abs(p.lng - to.lng) < 1e-6);
    if (fromName && toName && noRoad.has(`${normalize(fromName.name)}|${normalize(toName.name)}`)) {
      return { found: false, minutes: null, km: null, reason: 'not_found', provider: 'fixture-router' };
    }
    const leg = legFor(from, to);
    const geometry = Array.from({ length: 20 }, (_, i) => ({ lat: from.lat + ((to.lat - from.lat) * i) / 19, lng: from.lng + ((to.lng - from.lng) * i) / 19 }));
    return { found: true, minutes: leg.minutes, km: leg.km, provider: 'fixture-router', geometry };
  };

  const findNearbyLocalities = async (point: { lat: number; lng: number }, radiusKm: number): Promise<readonly GeocodedLocality[]> => {
    calls.corridor += 1;
    if (options.outage?.corridor) throw new Error('fixture corridor outage');
    return (options.settlements ?? [])
      .filter((s) => haversineKm(point, s) <= radiusKm)
      .map((s) => ({ sourceId: idOf(s), name: s.name, lat: s.lat, lng: s.lng, countryCode: options.countryCode ?? 'xx', entityType: s.entityType ?? 'city' }));
  };

  const dates = tripDates(basics.startDate, basics.endDate);
  const mode = profile.transport.willDrive ? 'car' : 'foot';
  const context: ReconcileContext = {
    tripId: trip.id,
    basics,
    profile,
    region: {
      id: regionId,
      name: options.name,
      baseName: options.name,
      baseCoordinates: options.center,
      summary: `${options.name}, a fictional acceptance destination.`,
      maxRadiusKm: 600,
      aliases: [],
      transportSummary: 'Fictional.',
      noVehicleSummary: 'Fictional.',
    },
    candidates: [],
    compiledPlaces: [],
    matrix: { mode, ids: [], minutes: [], km: [], provenance: { kind: 'measured', note: 'Fixture: every leg measured on demand.' } },
    scheduledNetwork: null,
    access: { regionId, points: [], services: [], rules: [] },
    hours: { version: 1, regionId, calendars: [] },
    weather: unavailableWeatherDataset({
      regionId,
      locations: [{ id: `${regionId}:c`, label: options.name, coordinates: options.center, elevationMetres: 0, timeZone: 'UTC', placeIds: [`${regionId}:c`], limitation: 'One point.' }],
      dates,
      now: new Date('2026-06-01T00:00:00Z'),
      reason: 'not_configured',
      message: 'No weather in the fixture.',
    }),
    now: new Date('2026-06-01T00:00:00Z'),
    baseId: `${regionId}:c`,
    compiledBases: [],
    geocodeLocality,
    routeMatrix,
    confirmRoute,
    findNearbyLocalities,
    destinationScope: { ...(options.countryCode ? { countryCode: options.countryCode } : {}), boundaryEvidence: 'reach_circle', reachRadiusKm: 600 },
    subregionGeometries: [],
    deadlineReached: () => options.deadlineReached ?? false,
    ...(options.mustIncludeNames ? { mustIncludeNames: options.mustIncludeNames } : {}),
  };
  return { context, calls, trip };
}

/** A context over the real fictional Eastern Sierra board — the compact base+satellites shape with real board evidence. */
export function boardWorld(overrides: { basics?: Partial<TripBasics>; geocodeLocality?: ReconcileContext['geocodeLocality'] } = {}): ReconcileContext {
  const input: PlannerInput = buildScenario({ world: EASTERN_SIERRA_WORLD, ...(overrides.basics ? { basics: overrides.basics } : {}) });
  return {
    ...input,
    compiledPlaces: input.candidates.map((c) => c.place),
    compiledBases: [],
    ...(overrides.geocodeLocality ? { geocodeLocality: overrides.geocodeLocality } : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Draft builders
 * ------------------------------------------------------------------ */

export interface DayShape {
  base: string;
  theme?: string;
  anchors: readonly { name: string; role?: 'core' | 'secondary' | 'optional' | 'flex'; category?: TripDraft['days'][number]['anchors'][number]['category']; transport?: TripDraft['days'][number]['anchors'][number]['transport']; minutes?: number; locality?: string; timeOfDay?: TripDraft['days'][number]['anchors'][number]['timeOfDay'] }[];
  intensity?: 'light' | 'moderate' | 'intense';
  relocation?: boolean;
  meals?: TripDraft['days'][number]['meals'];
  /** PRODUCTION LOCK V5 §10 — the multi-day experience this day is one day of. */
  partOf?: string;
  /** V6 §5 — a split experience on this day. */
  split?: { who: string; does: string; rejoin?: string };
}

export function draftOf(input: {
  archetype?: TripDraft['archetype'];
  bases: readonly { id: string; name: string; nights: number; area?: string; style?: string; locality?: string; overnight?: TripDraft['bases'][number]['overnight'] }[];
  days: readonly DayShape[];
  omissions?: readonly { name: string; reason: string }[];
  package?: Partial<TripDraft['package']>;
  /** PRODUCTION LOCK V5 — the fields the V5 audit reads. */
  signatures?: readonly string[];
  driving?: TripDraft['driving'];
}): TripDraft {
  return {
    archetype: input.archetype ?? (input.bases.length > 1 ? 'moving_route' : 'single_base'),
    purpose: 'A fictional acceptance trip.',
    routeRationale: 'Bases follow the direction of travel.',
    assumptions: ['Fixture assumption.'],
    tradeoffs: ['Fixture tradeoff.'],
    ...(input.signatures ? { signatures: [...input.signatures] } : {}),
    ...(input.driving ? { driving: input.driving } : {}),
    bases: input.bases.map((b) => ({ id: b.id, name: b.name, nights: b.nights, why: `Why ${b.name}.`, ...(b.area ? { lodgingArea: b.area } : {}), ...(b.style ? { lodgingStyle: b.style } : {}), ...(b.locality ? { locality: b.locality } : {}), ...(b.overnight ? { overnight: b.overnight } : {}) })),
    days: input.days.map((d, i) => ({
      dayNumber: i + 1,
      baseId: d.base,
      theme: d.theme ?? `Day ${i + 1}`,
      intensity: d.intensity ?? 'moderate',
      ...(d.relocation ? { relocation: true } : {}),
      anchors: d.anchors.map((a) => ({
        name: a.name,
        category: a.category ?? 'landmark',
        role: a.role ?? 'core',
        why: `Why ${a.name}.`,
        ...(a.minutes ? { estimatedDurationMinutes: a.minutes } : {}),
        ...(a.transport ? { transport: a.transport } : {}),
        ...(a.locality ? { locality: a.locality } : {}),
        ...(a.timeOfDay ? { timeOfDay: a.timeOfDay } : {}),
      })),
      meals: d.meals ?? { lunch: 'somewhere near the first stop', dinner: 'near base' },
      ...(d.partOf ? { partOf: d.partOf } : {}),
      ...(d.split ? { split: d.split } : {}),
    })),
    omissions: input.omissions ? [...input.omissions] : [],
    unresolved: [],
    package: {
      foodStrategy: ['Simple local meals.'],
      transport: { summary: 'Drive.', notes: ['Fuel up before remote days.'] },
      beforeYouGo: ['Verify official entry requirements.'],
      packing: ['Layers', 'Boots'],
      backups: [{ trigger: 'Rain', alternative: 'The museum.' }],
      ...input.package,
    },
  };
}

/** Every anchor the draft proposed, for the no-silent-loss invariant. */
export function anchorCount(draft: TripDraft): number {
  return draft.days.reduce((sum, day) => sum + day.anchors.length, 0);
}
