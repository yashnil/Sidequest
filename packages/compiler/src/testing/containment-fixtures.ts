import {
  geographicScopeSchema,
  type GeographicScope,
  type PlanningRole,
  type RecordContainment,
  type ScopeRelationship,
  type SourceRecord,
} from '@sidequest/core';
import type { IncludedArea } from '../backbone/containment';

/**
 * SCOPES AND RECORDS FOR THE QUESTION "DOES THIS BELONG HERE".
 *
 * Every fixture is built from the *shape* of a real normalised record — an
 * identifier, a point, a source category, and a containment block whose country,
 * region, locality and division identifiers are exactly the fields the divisions
 * layer and the primary catalogue publish. None of them is a real place. That is
 * deliberate twice over: the architecture suite forbids a destination name in
 * generic code, and a containment rule that only worked because somebody
 * recognised a name would not be a containment rule.
 *
 * ---
 *
 * ## What the probe changed about these fixtures
 *
 * The measured probe in `phase-12-containment-probe.md` found that in real
 * stored packs **no candidate carries a division identity**, a region name is
 * published for 1.5 %–5.9 % of them, and a locality name for 83 %–98 %. The
 * earlier fixtures gave every record a full `divisionIds` chain, which is a
 * population that does not exist — so they proved a ladder whose top three rungs
 * never fire in production.
 *
 * These fixtures therefore model the real evidence distribution:
 *
 * - candidates carry a **country code and a locality name** and usually nothing
 *   else, which is what an address supplies;
 * - the **divisions layer** carries the identity, the parent chain and the
 *   boxes, and it is *sparse* — a handful of records for a whole region;
 * - `DIVISIONS` is what a candidate's locality name is resolved *through*, which
 *   is the mechanism that separates a borough of the selected city from a
 *   township in the next state along without measuring a distance.
 *
 * ## The situations covered
 *
 * The nine that broke, plus the ten the closure goal names:
 *
 * 1. a candidate inside a metropolitan scope;
 * 2. a candidate in a constituent borough, recorded under the borough's name;
 * 3. a gateway outside the city and legitimately part of the trip;
 * 4. **a record an over-broad partition returned from an adjacent first-level
 *    division** — the class that put an auto-parts store on a city board;
 * 5. a record in the same first-level division that is simply nothing to do with
 *    the destination — the *honest unknown*, not a rejection;
 * 6. a record from another country that shared a row group;
 * 7. a city with no polygon at all, which is *every* city in the index;
 * 8. a candidate with no division metadata whatsoever;
 * 9. a **legitimate distant regional member**, the case a radius must not delete;
 * 10. an optional satellite, which requires an explicit inclusion;
 * 11. a park gateway town;
 * 12. an island ferry and airport gateway;
 * 13. a broad country's own internal regions;
 * 14. an airport, a driver-for-hire, a genuine attraction, an outdoor place and a
 *     market in one utility-heavy destination;
 * 15. a rich support record, which metadata completeness must not promote;
 * 16. a fallback-provider candidate with no address at all;
 * 17. a regional-expansion base.
 *
 * Coordinates are laid out on a synthetic graticule so distances are arithmetic
 * a reader can check: one degree of latitude is about 111 km, and the fixtures
 * sit due north of their centre so the longitude scaling never enters into it.
 */

const KM_PER_DEGREE_LAT = 111.19;

/** A point `km` due north of `centre`. Keeps every distance readable. */
export function northOf(centre: { lat: number; lng: number }, km: number): { lat: number; lng: number } {
  return { lat: centre.lat + km / KM_PER_DEGREE_LAT, lng: centre.lng };
}

function boxAround(centre: { lat: number; lng: number }, km: number) {
  const delta = km / KM_PER_DEGREE_LAT;
  return {
    southWest: { lat: centre.lat - delta, lng: centre.lng - delta },
    northEast: { lat: centre.lat + delta, lng: centre.lng + delta },
  };
}

export const METRO_CENTRE = { lat: 10, lng: 20 } as const;
export const ISLAND_CENTRE = { lat: -5, lng: 120 } as const;
export const PARK_CENTRE = { lat: 45, lng: -100 } as const;
export const COUNTRY_CENTRE = { lat: 30, lng: 60 } as const;
/** A town-breadth destination with legitimate regional members far outside it. */
export const CORRIDOR_TOWN_CENTRE = { lat: 37.6, lng: -119 } as const;
/** A destination whose catalogue is dominated by transport and services. */
export const UTILITY_CENTRE = { lat: -8.4, lng: 115.1 } as const;

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

function scope(overrides: Partial<GeographicScope>): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: 'fixture/1',
    destinationName: 'Selected City',
    destinationEntityType: 'city',
    breadth: 'city',
    center: METRO_CENTRE,
    countryCode: 'AA',
    timeZones: ['UTC'],
    shape: { kind: 'radius', center: METRO_CENTRE, radiusKm: 170 },
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: 'drive',
      allowedModes: ['drive', 'walk'],
      carAvailable: true,
      acceptsWaterOrAirTransfers: false,
      basis: 'default',
      note: 'Fixture transport.',
    },
    maxBaseChanges: 0,
    nights: 5,
    rationale: 'A containment fixture.',
    confidence: { level: 'high', signals: [], note: 'Fixture.' },
    decidedBy: [],
    confirmedByUser: true,
    ...overrides,
  });
}

/**
 * The common case, and the one the whole closure is about.
 *
 * No boundary of any kind: the index publishes none for any city, so the scope
 * is a reach circle of a hundred and seventy kilometres drawn around a centre. A
 * layer that reads that circle as a border admits five first-level divisions.
 */
export function metropolitanScope(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return scope(overrides);
}

/** The rare case: a destination whose extent somebody actually measured. */
export function measuredExtentScope(overrides: Partial<GeographicScope> = {}): GeographicScope {
  const bounds = {
    southWest: { lat: METRO_CENTRE.lat - 0.2, lng: METRO_CENTRE.lng - 0.2 },
    northEast: { lat: METRO_CENTRE.lat + 0.2, lng: METRO_CENTRE.lng + 0.2 },
  };
  /*
   * `boundaryEvidence` is stated, not inferred from the presence of `bounds`.
   *
   * The scope schema defaults it to `reach_circle`, which is the truthful
   * reading for a scope whose provenance is unknown — and it is what very nearly
   * every real destination gets, since no city in the index publishes a polygon.
   * A fixture that means "somebody measured this" has to say so.
   */
  return scope({
    bounds,
    shape: { kind: 'bounds', bounds },
    boundaryEvidence: 'measured_extent',
    administrativeBoundary: bounds,
    ...overrides,
  });
}

/**
 * The same metropolitan destination narrowed to one area.
 *
 * The CS-9 fixture. Narrowing changes the *shape* the trip covers; it does not
 * change the destination's published extent, and it must not make containment
 * stricter. A scope that asks for less ground and consequently refuses records
 * it previously accepted is the four-times-stricter behaviour CS-9 names.
 */
export function narrowedMetropolitanScope(): GeographicScope {
  const bounds = {
    southWest: { lat: METRO_CENTRE.lat - 0.2, lng: METRO_CENTRE.lng - 0.2 },
    northEast: { lat: METRO_CENTRE.lat + 0.2, lng: METRO_CENTRE.lng + 0.2 },
  };
  return scope({
    /*
     * A narrowed scope keeps the *unclipped* published extent beside a smaller
     * shape. That is what `deriveScope` writes, and it is what makes the
     * positive direction of geometry survive narrowing.
     */
    shape: { kind: 'radius', center: METRO_CENTRE, radiusKm: 20 },
    boundaryEvidence: 'measured_extent',
    administrativeBoundary: bounds,
    maxBaseChanges: 0,
  });
}

export function islandScope(overrides: Partial<GeographicScope> = {}): GeographicScope {
  /*
   * An island publishes a coastline, and that is the whole reason this class of
   * destination behaves differently from a city: a city has no polygon, so
   * membership has to come from division identity, and an island has one, so it
   * does not need a division to be identified with.
   */
  const bounds = boxAround(ISLAND_CENTRE, 55);
  return scope({
    destinationCandidateId: 'fixture/island',
    destinationName: 'Selected Island',
    destinationEntityType: 'island',
    breadth: 'subregion',
    center: ISLAND_CENTRE,
    bounds,
    boundaryEvidence: 'published_boundary',
    administrativeBoundary: bounds,
    shape: { kind: 'bounds', bounds },
    transport: {
      primaryMode: 'drive',
      allowedModes: ['drive', 'walk', 'ferry'],
      carAvailable: true,
      acceptsWaterOrAirTransfers: true,
      basis: 'clarification',
      note: 'Fixture transport.',
    },
    ...overrides,
  });
}

export function protectedAreaScope(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return scope({
    destinationCandidateId: 'fixture/park',
    destinationName: 'Selected Protected Area',
    destinationEntityType: 'protected_area',
    breadth: 'subregion',
    center: PARK_CENTRE,
    shape: { kind: 'radius', center: PARK_CENTRE, radiusKm: 200 },
    ...overrides,
  });
}

export function countryScope(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return scope({
    destinationCandidateId: 'fixture/country',
    destinationName: 'Selected Country',
    destinationEntityType: 'country',
    breadth: 'country',
    center: COUNTRY_CENTRE,
    shape: { kind: 'radius', center: COUNTRY_CENTRE, radiusKm: 220 },
    ...overrides,
  });
}

/**
 * A small town whose trip is genuinely regional.
 *
 * The Mono Lake shape: legitimate members forty to seventy kilometres out, in
 * the same first-level division, in *different* localities and counties. A
 * per-breadth radius small enough to exclude an unrelated adjacent division is
 * necessarily small enough to delete these, which is why they can only be kept
 * by an explicit relationship.
 */
export function corridorTownScope(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return scope({
    destinationCandidateId: 'fixture/corridor-town',
    destinationName: 'Corridor Town',
    destinationEntityType: 'city',
    breadth: 'city',
    center: CORRIDOR_TOWN_CENTRE,
    shape: { kind: 'radius', center: CORRIDOR_TOWN_CENTRE, radiusKm: 120 },
    ...overrides,
  });
}

/** A destination whose catalogue is dominated by transport and services. */
export function utilityHeavyScope(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return scope({
    destinationCandidateId: 'fixture/utility-island',
    destinationName: 'Service Island',
    destinationEntityType: 'island',
    breadth: 'subregion',
    center: UTILITY_CENTRE,
    countryCode: 'BB',
    shape: { kind: 'radius', center: UTILITY_CENTRE, radiusKm: 80 },
    transport: {
      primaryMode: 'drive',
      allowedModes: ['drive', 'walk', 'ferry'],
      carAvailable: true,
      acceptsWaterOrAirTransfers: true,
      basis: 'clarification',
      note: 'Fixture transport.',
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export function fixtureRecord(input: {
  id: string;
  name: string;
  coordinates: { lat: number; lng: number };
  containment: Partial<RecordContainment>;
  planningRole?: PlanningRole;
  sourceCategory?: string;
  sourceCategoryPath?: string[];
  layerId?: string;
  bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } };
  attributes?: Record<string, string>;
  websiteCandidates?: string[];
}): SourceRecord {
  const layerId = input.layerId ?? 'places';
  return {
    id: `${layerId}:${input.id}`,
    layerId,
    sourceId: input.id,
    name: input.name,
    alternateNames: [],
    coordinates: input.coordinates,
    ...(input.bounds ? { bounds: input.bounds } : {}),
    sourceCategory: input.sourceCategory ?? 'museum',
    sourceCategoryPath: input.sourceCategoryPath ?? ['arts_and_entertainment', 'museum'],
    planningRole: input.planningRole ?? 'attraction',
    websiteCandidates: input.websiteCandidates ?? [],
    containment: { divisionIds: [], ...input.containment },
    attributes: input.attributes ?? {},
    sources: [{ dataset: 'primary-catalogue', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  };
}

/**
 * A divisions-layer record: a name, a box, and a parent chain ending in itself.
 *
 * Exactly the shape the real catalogue publishes — verified against stored packs,
 * where every division record carries `divisionIds` running country → region →
 * county → itself, and a bounding box.
 */
export function fixtureDivision(input: {
  id: string;
  name: string;
  subtype: string;
  centre: { lat: number; lng: number };
  radiusKm: number;
  chain: string[];
  countryCode?: string;
  regionName?: string;
}): SourceRecord {
  return {
    id: `divisions:${input.id}`,
    layerId: 'divisions',
    sourceId: input.id,
    name: input.name,
    alternateNames: [],
    coordinates: input.centre,
    bounds: boxAround(input.centre, input.radiusKm),
    sourceCategory: input.subtype,
    sourceCategoryPath: [],
    planningRole: 'administrative',
    websiteCandidates: [],
    containment: {
      ...(input.countryCode ? { countryCode: input.countryCode } : {}),
      ...(input.regionName ? { regionName: input.regionName } : {}),
      divisionIds: input.chain,
    },
    attributes: { subtype: input.subtype },
    sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  };
}

// ---------------------------------------------------------------------------
// The divisions layer, which is where identity actually lives
// ---------------------------------------------------------------------------

const AA = 'AA';
const SELECTED_REGION_CODE = 'AA-SR';
const ADJACENT_REGION_CODE = 'AA-AR';

/**
 * The metropolitan destination's divisions, as sparsely as a real pack has them.
 *
 * The chains are the whole point. `div-inner-borough` sits *under*
 * `div-selected-city`, so a candidate whose address says "Inner Borough"
 * resolves to a division whose chain contains the selected city — which is the
 * evidence that a borough is part of its city, published by the source, with no
 * distance and no name list. `div-adjacent-township` sits under a different
 * first-level division, and that is the evidence that excludes it.
 */
export function metropolitanDivisions(): SourceRecord[] {
  return [
    fixtureDivision({
      id: 'div-selected-country',
      name: 'Selected Country',
      subtype: 'country',
      centre: METRO_CENTRE,
      radiusKm: 600,
      chain: ['div-selected-country'],
      countryCode: AA,
    }),
    fixtureDivision({
      id: 'div-selected-region',
      name: 'Selected Region',
      subtype: 'region',
      centre: METRO_CENTRE,
      radiusKm: 300,
      chain: ['div-selected-country', 'div-selected-region'],
      countryCode: AA,
      regionName: SELECTED_REGION_CODE,
    }),
    fixtureDivision({
      id: 'div-selected-city',
      name: 'Selected City',
      subtype: 'locality',
      centre: METRO_CENTRE,
      radiusKm: 8,
      chain: ['div-selected-country', 'div-selected-region', 'div-selected-city'],
      countryCode: AA,
      regionName: SELECTED_REGION_CODE,
    }),
    /*
     * A borough whose box does **not** contain the gallery, on purpose.
     *
     * The gallery sits fourteen kilometres out, beyond the eight-kilometre city
     * box. If the box reached it the test would be proving the geometry pass,
     * which is the pass that is unavailable in production. The name is what has
     * to carry it.
     */
    fixtureDivision({
      id: 'div-inner-borough',
      name: 'Inner Borough',
      subtype: 'locality',
      centre: northOf(METRO_CENTRE, 14),
      radiusKm: 3,
      chain: [
        'div-selected-country',
        'div-selected-region',
        'div-selected-city',
        'div-inner-borough',
      ],
      countryCode: AA,
      regionName: SELECTED_REGION_CODE,
    }),
    fixtureDivision({
      id: 'div-outlying-township',
      name: 'Outlying Township',
      subtype: 'locality',
      centre: northOf(METRO_CENTRE, 90),
      radiusKm: 5,
      chain: ['div-selected-country', 'div-selected-region', 'div-outlying-township'],
      countryCode: AA,
      regionName: SELECTED_REGION_CODE,
    }),
    fixtureDivision({
      id: 'div-adjacent-region',
      name: 'Adjacent Region',
      subtype: 'region',
      centre: northOf(METRO_CENTRE, 200),
      radiusKm: 150,
      chain: ['div-selected-country', 'div-adjacent-region'],
      countryCode: AA,
      regionName: ADJACENT_REGION_CODE,
    }),
    fixtureDivision({
      id: 'div-adjacent-township',
      name: 'Adjacent Township',
      subtype: 'locality',
      centre: northOf(METRO_CENTRE, 160),
      radiusKm: 4,
      chain: ['div-selected-country', 'div-adjacent-region', 'div-adjacent-township'],
      countryCode: AA,
      regionName: ADJACENT_REGION_CODE,
    }),
    fixtureDivision({
      id: 'div-airfield',
      name: 'Airfield Township',
      subtype: 'locality',
      centre: northOf(METRO_CENTRE, 50),
      radiusKm: 4,
      chain: ['div-selected-country', 'div-selected-region', 'div-airfield'],
      countryCode: AA,
      regionName: SELECTED_REGION_CODE,
    }),
  ];
}

export interface ContainmentCase {
  /** What the situation is, in one line, for a failing test to print. */
  label: string;
  record: SourceRecord;
  expected: ScopeRelationship;
  /** Why this is the answer, for a failing test to print beside the label. */
  because: string;
}

/**
 * The metropolitan set: one destination, ten records, five different answers.
 *
 * Every record here is inside the reach circle and would have been admitted by
 * the old acceptance path, because the old acceptance path *was* the circle.
 * None of them carries a division identity, because no real candidate does.
 */
export function metropolitanCases(): ContainmentCase[] {
  return [
    {
      label: 'a museum in the selected locality',
      because: 'its address names the selected city, which the divisions layer confirms',
      record: fixtureRecord({
        id: 'metro-core',
        name: 'Harbour Museum',
        coordinates: northOf(METRO_CENTRE, 6),
        containment: { countryCode: AA, localityName: 'Selected City' },
      }),
      expected: 'inside_selected_division',
    },
    {
      label: 'a gallery in a constituent borough, recorded under the borough name',
      because: 'the borough resolves to a division whose published chain contains the city',
      record: fixtureRecord({
        id: 'metro-borough',
        name: 'Borough Gallery',
        coordinates: northOf(METRO_CENTRE, 14),
        containment: { countryCode: AA, localityName: 'Inner Borough' },
      }),
      expected: 'inside_selected_division',
    },
    {
      label: 'an airport outside the city and inside the trip',
      because: 'a gateway role, outside, and the destination has no way in of its own',
      record: fixtureRecord({
        id: 'metro-airport',
        name: 'Regional Airport',
        coordinates: northOf(METRO_CENTRE, 50),
        planningRole: 'gateway',
        sourceCategory: 'airport',
        sourceCategoryPath: ['travel_and_transportation', 'airport'],
        containment: { countryCode: AA, localityName: 'Airfield Township' },
      }),
      expected: 'adjacent_gateway',
    },
    {
      /**
       * The defect, generically.
       *
       * A hundred and sixty kilometres out, inside the reach circle, inside the
       * bounding box, inside a partition cell — and in a first-level division
       * the destination is not in. Nothing about it is unusual: it is an
       * ordinary local business with an ordinary address, and the address is
       * what excludes it.
       *
       * Its address carries **no region**, which is the real distribution: fewer
       * than six candidates in a hundred publish one. The exclusion comes from
       * resolving its locality through the divisions layer and finding a chain
       * under a different first-level division.
       */
      label: 'an auto-parts retailer in an adjacent first-level division',
      because: 'its locality resolves to a division under a different first-level division',
      record: fixtureRecord({
        id: 'adjacent-division-retail',
        name: 'Township Auto Parts',
        coordinates: northOf(METRO_CENTRE, 160),
        sourceCategory: 'automotive_parts',
        sourceCategoryPath: ['automotive', 'automotive_parts'],
        containment: { countryCode: AA, localityName: 'Adjacent Township' },
      }),
      expected: 'outside_scope',
    },
    {
      /**
       * The honest unknown, and the case the old fallback got wrong in the other
       * direction.
       *
       * Same country, same first-level division, a locality the destination does
       * not contain. Nothing published says it is in the city and nothing
       * published says it is not. It is admitted, labelled, kept off the final
       * board and kept away from the planner — which is a different outcome from
       * both "inside" and "deleted", and is the only truthful one.
       */
      label: 'a historical society in the same division and nothing to do with the trip',
      because: 'same region, a locality outside the city, and nothing that settles it either way',
      record: fixtureRecord({
        id: 'same-division-outlying',
        name: 'Outlying Historical Society',
        coordinates: northOf(METRO_CENTRE, 90),
        sourceCategory: 'historic_site',
        sourceCategoryPath: ['cultural_and_historic', 'historic_site'],
        containment: { countryCode: AA, localityName: 'Outlying Township' },
      }),
      expected: 'membership_unknown',
    },
    {
      label: 'a record from another country that shared a row group',
      because: 'the country codes disagree, which a city cannot span',
      record: fixtureRecord({
        id: 'cross-country',
        name: 'Border Library',
        coordinates: northOf(METRO_CENTRE, 150),
        sourceCategory: 'library',
        sourceCategoryPath: ['education', 'library'],
        containment: { countryCode: 'ZZ', localityName: 'Far Town' },
      }),
      expected: 'outside_scope',
    },
    {
      label: 'a record inside the extent that nobody published an address for',
      because: 'no comparable evidence exists on either side',
      record: fixtureRecord({
        id: 'unplaced-inner',
        name: 'Unplaced Viewpoint',
        coordinates: northOf(METRO_CENTRE, 9),
        sourceCategory: 'viewpoint',
        sourceCategoryPath: ['geographic_entities', 'viewpoint'],
        containment: {},
      }),
      expected: 'membership_unknown',
    },
    {
      /**
       * CS-7, as a fixture.
       *
       * Identical evidence to the record above and a hundred and twenty
       * kilometres further out. The old ladder returned `outside_scope` for this
       * one and `membership_unknown` for that one, and the only difference
       * between them is a number that appears nowhere in the definition of
       * belonging. They must now agree.
       */
      label: 'a record beyond the extent that nobody published an address for',
      because: 'distance is the only thing that differs from the record above, and distance is not evidence',
      record: fixtureRecord({
        id: 'unplaced-outer',
        name: 'Distant Unplaced Viewpoint',
        coordinates: northOf(METRO_CENTRE, 120),
        sourceCategory: 'viewpoint',
        sourceCategoryPath: ['geographic_entities', 'viewpoint'],
        containment: {},
      }),
      expected: 'membership_unknown',
    },
    {
      /** A fallback provider's output: a name, a point, and nothing else. */
      /**
       * The fallback map service publishes a name, a point and no address at all.
       *
       * The layer is named generically rather than after the service, because
       * the engine packages must not name a provider and an architecture test
       * enforces it.
       *
       * It still goes through the gate, and here the gate can answer: the point
       * falls inside the published box of a division whose chain contains the
       * selected city. That is geometry — a source's own extent for a named
       * division — and it is the one positive available to a destination that
       * publishes no polygon of its own. It is *not* a reach circle and it is
       * *not* a partition cell, which is the distinction the whole file turns on.
       */
      label: 'a fallback-service candidate with no address, inside a published division box',
      because: 'a division’s published extent contains it, and that division is part of the selected city',
      record: fixtureRecord({
        id: 'fallback-inside',
        name: 'Mapped Viewpoint',
        layerId: 'fallback_places',
        coordinates: northOf(METRO_CENTRE, 15),
        sourceCategory: 'viewpoint',
        sourceCategoryPath: ['geographic_entities', 'viewpoint'],
        containment: {},
      }),
      expected: 'inside_selected_division',
    },
    {
      label: 'a fallback-service candidate with no address and no division covering it',
      because: 'nothing published says anything about it, and being far away is not a finding',
      record: fixtureRecord({
        id: 'fallback-unplaced',
        name: 'Remote Mapped Viewpoint',
        layerId: 'fallback_places',
        coordinates: northOf(METRO_CENTRE, 400),
        sourceCategory: 'viewpoint',
        sourceCategoryPath: ['geographic_entities', 'viewpoint'],
        containment: {},
      }),
      expected: 'membership_unknown',
    },
    {
      /**
       * A hotel with a website, hours, an operator and an open identifier.
       *
       * Rich metadata, correct locality, genuinely inside. Containment says
       * `inside_selected_division` and says nothing about whether it may be an
       * attraction — that is the role layer's answer, and the two must not be
       * able to substitute for one another.
       */
      label: 'a richly catalogued hotel inside the city',
      because: 'metadata completeness is not a membership question and not a role permission',
      record: fixtureRecord({
        id: 'metro-hotel',
        name: 'Harbour Grand Hotel',
        coordinates: northOf(METRO_CENTRE, 4),
        planningRole: 'lodging',
        sourceCategory: 'hotel',
        sourceCategoryPath: ['accommodation', 'hotel'],
        websiteCandidates: ['https://example.invalid/hotel'],
        attributes: { opening_hours: '24/7', operator: 'Fixture Group' },
        containment: { countryCode: AA, localityName: 'Selected City' },
      }),
      expected: 'inside_selected_division',
    },
  ];
}

/** A gateway the destination has of its own. Demotes the external one. */
export function metropolitanInternalGateway(): SourceRecord {
  return fixtureRecord({
    id: 'metro-station',
    name: 'Central Station',
    coordinates: northOf(METRO_CENTRE, 3),
    planningRole: 'gateway',
    sourceCategory: 'train_station',
    sourceCategoryPath: ['travel_and_transportation', 'train_station'],
    containment: { countryCode: AA, localityName: 'Selected City' },
  });
}

// ---------------------------------------------------------------------------
// The corridor town: legitimate distant regional members
// ---------------------------------------------------------------------------

export function corridorDivisions(): SourceRecord[] {
  return [
    fixtureDivision({
      id: 'div-corridor-country',
      name: 'Selected Country',
      subtype: 'country',
      centre: CORRIDOR_TOWN_CENTRE,
      radiusKm: 900,
      chain: ['div-corridor-country'],
      countryCode: AA,
    }),
    fixtureDivision({
      id: 'div-corridor-region',
      name: 'Corridor Region',
      subtype: 'region',
      centre: CORRIDOR_TOWN_CENTRE,
      radiusKm: 400,
      chain: ['div-corridor-country', 'div-corridor-region'],
      countryCode: AA,
      regionName: 'AA-CR',
    }),
    fixtureDivision({
      id: 'div-corridor-town',
      name: 'Corridor Town',
      subtype: 'locality',
      centre: CORRIDOR_TOWN_CENTRE,
      radiusKm: 6,
      chain: ['div-corridor-country', 'div-corridor-region', 'div-corridor-town'],
      countryCode: AA,
      regionName: 'AA-CR',
    }),
    fixtureDivision({
      id: 'div-lakeside-village',
      name: 'Lakeside Village',
      subtype: 'locality',
      centre: northOf(CORRIDOR_TOWN_CENTRE, 45),
      radiusKm: 4,
      chain: ['div-corridor-country', 'div-corridor-region', 'div-lakeside-village'],
      countryCode: AA,
      regionName: 'AA-CR',
    }),
  ];
}

/**
 * The areas a regional expansion asked for, once it has run.
 *
 * These cannot exist at pack build: expansion runs after it, and putting them in
 * the pack's cache key would give every traveller their own pack. They are
 * therefore an *overlay* input, and they are the only thing that turns a
 * legitimate distant member into something the trip may plan around.
 */
export function corridorExpansionAreas(): IncludedArea[] {
  return [
    {
      id: 'area-lakeside',
      name: 'Lakeside Village',
      reason: 'regional_expansion_requested',
      status: 'included',
      center: northOf(CORRIDOR_TOWN_CENTRE, 45),
      divisionIds: ['div-lakeside-village'],
    },
    {
      id: 'area-far-basin',
      name: 'Far Basin',
      reason: 'expansion_subregion',
      status: 'optional',
      center: northOf(CORRIDOR_TOWN_CENTRE, 70),
    },
  ];
}

export function corridorCases(): ContainmentCase[] {
  return [
    {
      label: 'a café in the town itself',
      because: 'its address names the selected town',
      record: fixtureRecord({
        id: 'corridor-cafe',
        name: 'Corridor Café',
        coordinates: northOf(CORRIDOR_TOWN_CENTRE, 2),
        planningRole: 'food',
        sourceCategory: 'cafe',
        sourceCategoryPath: ['food_and_drink', 'cafe'],
        containment: { countryCode: AA, localityName: 'Corridor Town' },
      }),
      expected: 'inside_selected_division',
    },
    {
      /**
       * The Mono Lake shape, and the half of the trade the closure forbids.
       *
       * Forty-five kilometres out from a town-breadth destination whose tuned
       * core radius was thirty. Same country, same first-level division, a
       * different locality. Without an expansion it is honestly unknown; with
       * one it is a member of the trip, and no radius anywhere decides it.
       */
      label: 'a lake forty-five kilometres out, in an area the expansion asked for',
      because: 'the expansion explicitly included the area, which is the only thing that admits it',
      record: fixtureRecord({
        id: 'corridor-lake',
        name: 'Lakeside Overlook',
        coordinates: northOf(CORRIDOR_TOWN_CENTRE, 45),
        planningRole: 'outdoor',
        sourceCategory: 'lake',
        sourceCategoryPath: ['geographic_entities', 'lake'],
        containment: { countryCode: AA, localityName: 'Lakeside Village' },
      }),
      expected: 'regional_expansion_member',
    },
    {
      label: 'a viewpoint seventy kilometres out, in an area offered but not taken',
      because: 'an optional area produces an optional satellite, which stays labelled and unplanned',
      record: fixtureRecord({
        id: 'corridor-basin',
        name: 'Far Basin Viewpoint',
        coordinates: northOf(CORRIDOR_TOWN_CENTRE, 70),
        planningRole: 'outdoor',
        sourceCategory: 'viewpoint',
        sourceCategoryPath: ['geographic_entities', 'viewpoint'],
        containment: { countryCode: AA, localityName: 'Far Basin' },
      }),
      expected: 'optional_satellite',
    },
  ];
}

/** A base a regional expansion proposed and a geocoder resolved. */
export function corridorExpansionBase(): SourceRecord {
  return fixtureRecord({
    id: 'expansion-base-lakeside',
    name: 'Lakeside Village',
    layerId: 'expansion',
    coordinates: northOf(CORRIDOR_TOWN_CENTRE, 45),
    planningRole: 'lodging',
    sourceCategory: 'town',
    sourceCategoryPath: ['geographic_entities', 'town'],
    containment: { countryCode: AA, localityName: 'Lakeside Village' },
  });
}

// ---------------------------------------------------------------------------
// Island, park, country
// ---------------------------------------------------------------------------

export function islandDivisions(): SourceRecord[] {
  return [
    fixtureDivision({
      id: 'div-island-country',
      name: 'Selected Country',
      subtype: 'country',
      centre: ISLAND_CENTRE,
      radiusKm: 900,
      chain: ['div-island-country'],
      countryCode: AA,
    }),
    fixtureDivision({
      id: 'div-island',
      name: 'Island Region',
      subtype: 'region',
      centre: ISLAND_CENTRE,
      radiusKm: 60,
      chain: ['div-island-country', 'div-island'],
      countryCode: AA,
      regionName: 'AA-IS',
    }),
    fixtureDivision({
      id: 'div-mainland-port',
      name: 'Mainland Region',
      subtype: 'region',
      centre: northOf(ISLAND_CENTRE, 96),
      radiusKm: 40,
      chain: ['div-island-country', 'div-mainland-port'],
      countryCode: AA,
      regionName: 'AA-ML',
    }),
  ];
}

export function islandCases(): ContainmentCase[] {
  return [
    {
      label: 'a beach on the island itself',
      because: 'the island division’s published box contains it',
      record: fixtureRecord({
        id: 'island-beach',
        name: 'North Shore Beach',
        coordinates: northOf(ISLAND_CENTRE, 20),
        planningRole: 'outdoor',
        sourceCategory: 'beach',
        sourceCategoryPath: ['geographic_entities', 'beach'],
        containment: { countryCode: AA, localityName: 'Island Town' },
      }),
      expected: 'inside_scope',
    },
    {
      label: 'the mainland ferry terminal the island is reached from',
      because: 'a gateway role, outside, and the destination is across water',
      record: fixtureRecord({
        id: 'mainland-ferry',
        name: 'Mainland Ferry Terminal',
        coordinates: northOf(ISLAND_CENTRE, 95),
        planningRole: 'gateway',
        sourceCategory: 'ferry_terminal',
        sourceCategoryPath: ['travel_and_transportation', 'ferry_terminal'],
        containment: { countryCode: AA, regionName: 'AA-ML', localityName: 'Port Town' },
      }),
      expected: 'adjacent_gateway',
    },
    {
      label: 'a mainland restaurant that is simply across the water',
      because: 'its published region disagrees with the island’s, and a subregion cannot span two',
      record: fixtureRecord({
        id: 'mainland-restaurant',
        name: 'Port Town Restaurant',
        coordinates: northOf(ISLAND_CENTRE, 97),
        planningRole: 'food',
        sourceCategory: 'restaurant',
        sourceCategoryPath: ['food_and_drink', 'restaurant'],
        containment: { countryCode: AA, regionName: 'AA-ML', localityName: 'Port Town' },
      }),
      expected: 'outside_scope',
    },
  ];
}

export function protectedAreaDivisions(): SourceRecord[] {
  return [
    fixtureDivision({
      id: 'div-park-country',
      name: 'Selected Country',
      subtype: 'country',
      centre: PARK_CENTRE,
      radiusKm: 900,
      chain: ['div-park-country'],
      countryCode: AA,
    }),
    fixtureDivision({
      id: 'div-upland-region',
      name: 'Upland Region',
      subtype: 'region',
      centre: PARK_CENTRE,
      radiusKm: 400,
      chain: ['div-park-country', 'div-upland-region'],
      countryCode: AA,
      regionName: 'AA-UP',
    }),
    fixtureDivision({
      id: 'div-approach-town',
      name: 'Approach Town',
      subtype: 'locality',
      centre: northOf(PARK_CENTRE, 150),
      radiusKm: 5,
      chain: ['div-park-country', 'div-upland-region', 'div-approach-town'],
      countryCode: AA,
      regionName: 'AA-UP',
    }),
  ];
}

/**
 * The protected area's own extent, which — unlike a city's — a source does
 * publish. This is the one destination class where rung 1 is genuinely available.
 */
export function protectedAreaScopeWithBoundary(): GeographicScope {
  const bounds = boxAround(PARK_CENTRE, 60);
  return protectedAreaScope({
    bounds,
    shape: { kind: 'bounds', bounds },
    boundaryEvidence: 'published_boundary',
    administrativeBoundary: bounds,
  });
}

/** The gateway town, once an expansion has asked for it. */
export function protectedAreaExpansionAreas(): IncludedArea[] {
  return [
    {
      id: 'area-approach-town',
      name: 'Approach Town',
      reason: 'expansion_base',
      status: 'included',
      center: northOf(PARK_CENTRE, 150),
      divisionIds: ['div-approach-town'],
    },
  ];
}

export function protectedAreaCases(): ContainmentCase[] {
  return [
    {
      label: 'a trail inside the protected area',
      because: 'the park’s published boundary contains it',
      record: fixtureRecord({
        id: 'park-trail',
        name: 'Ridge Trail',
        coordinates: northOf(PARK_CENTRE, 30),
        planningRole: 'outdoor',
        sourceCategory: 'hiking_trail',
        sourceCategoryPath: ['sports_and_recreation', 'hiking_trail'],
        containment: { countryCode: AA, regionName: 'AA-UP' },
      }),
      expected: 'inside_scope',
    },
    {
      label: 'the rail station in the town outside the protected area',
      because: 'a gateway role, outside the boundary, and the park has no way in of its own',
      record: fixtureRecord({
        id: 'approach-station',
        name: 'Approach Town Station',
        coordinates: northOf(PARK_CENTRE, 150),
        planningRole: 'gateway',
        sourceCategory: 'train_station',
        sourceCategoryPath: ['travel_and_transportation', 'train_station'],
        containment: { countryCode: AA, regionName: 'AA-UP', localityName: 'Approach Town' },
      }),
      expected: 'adjacent_gateway',
    },
    {
      /**
       * The same town's museum, which adjacency alone must not admit.
       *
       * Same region as the park, outside its boundary, and nothing asked for the
       * town. Honestly unknown — not deleted, and not inside. It becomes a
       * `regional_expansion_member` under `protectedAreaExpansionAreas` and
       * under nothing else.
       */
      label: 'a museum in that town, with no expansion asking for it',
      because: 'a park is not an administrative region, so agreeing at region settles nothing',
      record: fixtureRecord({
        id: 'approach-museum',
        name: 'Approach Town Museum',
        coordinates: northOf(PARK_CENTRE, 151),
        containment: { countryCode: AA, regionName: 'AA-UP', localityName: 'Approach Town' },
      }),
      expected: 'membership_unknown',
    },
  ];
}

export function countryDivisions(): SourceRecord[] {
  return [
    fixtureDivision({
      id: 'div-country',
      name: 'Selected Country',
      subtype: 'country',
      centre: COUNTRY_CENTRE,
      radiusKm: 600,
      chain: ['div-country'],
      countryCode: AA,
    }),
  ];
}

export function countryCases(): ContainmentCase[] {
  return [
    {
      label: 'a museum in one internal region',
      because: 'a country contains its regions, so agreeing at country is membership',
      record: fixtureRecord({
        id: 'country-region-a',
        name: 'First Region Museum',
        coordinates: northOf(COUNTRY_CENTRE, 40),
        containment: { countryCode: AA, regionName: 'AA-1', localityName: 'First Region Town' },
      }),
      expected: 'inside_selected_region',
    },
    {
      /**
       * A hundred and eighty kilometres out, in a *different* internal region,
       * and still inside the country. The case a per-breadth radius cannot get
       * right, because the honest radius for a country is the country.
       */
      label: 'a museum in a different internal region of the same country',
      because: 'a different region of the same country is still the same country',
      record: fixtureRecord({
        id: 'country-region-b',
        name: 'Second Region Museum',
        coordinates: northOf(COUNTRY_CENTRE, 180),
        containment: { countryCode: AA, regionName: 'AA-2', localityName: 'Second Region Town' },
      }),
      expected: 'inside_selected_region',
    },
    {
      label: 'a museum over the national border',
      because: 'the country codes disagree, which is the one level a country cannot span',
      record: fixtureRecord({
        id: 'country-foreign',
        name: 'Foreign Museum',
        coordinates: northOf(COUNTRY_CENTRE, 190),
        containment: { countryCode: 'ZZ', regionName: 'ZZ-1', localityName: 'Foreign Town' },
      }),
      expected: 'outside_scope',
    },
  ];
}

// ---------------------------------------------------------------------------
// The utility-heavy destination
// ---------------------------------------------------------------------------

export function utilityDivisions(): SourceRecord[] {
  return [
    fixtureDivision({
      id: 'div-utility-country',
      name: 'Service Country',
      subtype: 'country',
      centre: UTILITY_CENTRE,
      radiusKm: 900,
      chain: ['div-utility-country'],
      countryCode: 'BB',
    }),
    fixtureDivision({
      id: 'div-utility-island',
      name: 'Service Island',
      subtype: 'region',
      centre: UTILITY_CENTRE,
      radiusKm: 70,
      chain: ['div-utility-country', 'div-utility-island'],
      countryCode: 'BB',
      regionName: 'BB-SI',
    }),
  ];
}

/**
 * The Bali set: everything containment says yes to, and role says no to.
 *
 * All five are *geographically correct* — that was never the failure. The
 * failure was that an international airport, a driver-for-hire and two tour
 * operators occupied slots a traveller chooses between, promoted by prominence,
 * source completeness and an archetype's `food_and_towns` interest. Containment
 * cannot fix that and must not try: it reports where they are, and the role
 * layer decides what they may be.
 */
export function utilityCases(): ContainmentCase[] {
  return [
    {
      label: 'the international airport',
      because: 'inside the destination, and a gateway is still never a thing to do',
      record: fixtureRecord({
        id: 'utility-airport',
        name: 'Island International Airport',
        coordinates: northOf(UTILITY_CENTRE, 8),
        planningRole: 'gateway',
        sourceCategory: 'airport',
        sourceCategoryPath: ['travel_and_transportation', 'airport'],
        websiteCandidates: ['https://example.invalid/airport'],
        attributes: { opening_hours: '24/7', operator: 'Fixture Airports' },
        containment: { countryCode: 'BB', regionName: 'BB-SI', localityName: 'Service Island' },
      }),
      expected: 'inside_selected_division',
    },
    {
      label: 'a driver-for-hire listed as a business',
      because: 'inside the destination, and a transport service is not an attraction',
      record: fixtureRecord({
        id: 'utility-driver',
        name: 'Best Driver On The Island',
        coordinates: northOf(UTILITY_CENTRE, 5),
        planningRole: 'support',
        sourceCategory: 'taxi_service',
        sourceCategoryPath: ['travel_and_transportation', 'taxi_service'],
        websiteCandidates: ['https://example.invalid/driver'],
        containment: { countryCode: 'BB', regionName: 'BB-SI', localityName: 'Service Island' },
      }),
      expected: 'inside_selected_division',
    },
    {
      label: 'a genuine attraction',
      because: 'inside the destination and something to do',
      record: fixtureRecord({
        id: 'utility-temple',
        name: 'Cliffside Temple',
        coordinates: northOf(UTILITY_CENTRE, 12),
        sourceCategory: 'temple',
        sourceCategoryPath: ['cultural_and_historic', 'temple'],
        containment: { countryCode: 'BB', regionName: 'BB-SI', localityName: 'Service Island' },
      }),
      expected: 'inside_selected_division',
    },
    {
      label: 'an outdoor place',
      because: 'inside the destination and weather-bound rather than opening-hours-bound',
      record: fixtureRecord({
        id: 'utility-beach',
        name: 'South Cliff Beach',
        coordinates: northOf(UTILITY_CENTRE, 18),
        planningRole: 'outdoor',
        sourceCategory: 'beach',
        sourceCategoryPath: ['geographic_entities', 'beach'],
        containment: { countryCode: 'BB', regionName: 'BB-SI', localityName: 'Service Island' },
      }),
      expected: 'inside_selected_division',
    },
    {
      label: 'a market',
      because: 'inside the destination, and both somewhere to eat and something to do',
      record: fixtureRecord({
        id: 'utility-market',
        name: 'Morning Market',
        coordinates: northOf(UTILITY_CENTRE, 3),
        planningRole: 'market',
        sourceCategory: 'market',
        sourceCategoryPath: ['food_and_drink', 'market'],
        containment: { countryCode: 'BB', regionName: 'BB-SI', localityName: 'Service Island' },
      }),
      expected: 'inside_selected_division',
    },
    {
      label: 'a pharmacy',
      because: 'inside the destination, and a practical stop rather than a day out',
      record: fixtureRecord({
        id: 'utility-pharmacy',
        name: 'Island Pharmacy',
        coordinates: northOf(UTILITY_CENTRE, 4),
        planningRole: 'support',
        sourceCategory: 'pharmacy',
        sourceCategoryPath: ['health_and_medical', 'pharmacy'],
        containment: { countryCode: 'BB', regionName: 'BB-SI', localityName: 'Service Island' },
      }),
      expected: 'inside_selected_division',
    },
  ];
}
