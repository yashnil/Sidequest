import { geographicScopeSchema, type GeographicScope, type SourceRecord } from '@sidequest/core';
import { describe, expect, it } from 'vitest';
import { buildTripScopeOverlay, namedDivisionChains, subjectFor } from './overlay';

/**
 * THE PACK SHAPE A REAL CATALOGUE ACTUALLY PUBLISHES, AND WHAT IT COSTS.
 *
 * `containment-fixtures.ts` gives every borough a division record of its own,
 * which is the shape the containment ladder was designed against and is not the
 * shape that arrives. Measured on the Tokyo pack stored on this machine: the
 * divisions layer is capped at 320 records and what a cap keeps is the leaves —
 * 269 neighbourhoods, 47 microhoods, one locality, three counties, out of 800
 * features read. Not one of the eight wards those neighbourhoods sit in is a
 * record of its own, and neither is the destination.
 *
 * The wards are nonetheless *published*, 68 times over for `世田谷区` alone, as
 * the parent locality on every neighbourhood inside them, each carrying the
 * division chain that ward sits in. The consequence of reading a division only
 * under its own name was that of 3,787 records exactly 100 could resolve their
 * published locality, none of the 103 attractions could, and every one of them
 * was demoted out of the anchor slot — `portfolio.supply.anchors: 0` for a world
 * city.
 *
 * These fixtures are that shape, on the synthetic graticule the other fixtures
 * use: leaf divisions only, plus the destination's own division, plus a place
 * record whose address names a ward and which publishes no identifiers at all.
 */

const CENTRE = { lat: 10, lng: 20 } as const;
const KM_PER_DEGREE_LAT = 111.19;

function northOf(km: number): { lat: number; lng: number } {
  return { lat: CENTRE.lat + km / KM_PER_DEGREE_LAT, lng: CENTRE.lng };
}

function cityScope(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: 'fixture/metropolis',
    destinationName: 'Selected City',
    destinationEntityType: 'city',
    breadth: 'city',
    center: CENTRE,
    countryCode: 'AA',
    administrative: { countryCode: 'AA', regionCode: 'AA-SR', aliases: [], hierarchy: [], divisionIds: [] },
    timeZones: ['UTC'],
    shape: { kind: 'radius', center: CENTRE, radiusKm: 40 },
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: 'walk',
      allowedModes: ['walk', 'rail'],
      carAvailable: false,
      acceptsWaterOrAirTransfers: false,
      basis: 'default',
      note: 'Fixture transport.',
    },
    maxBaseChanges: 0,
    nights: 5,
    rationale: 'An overlay fixture.',
    confidence: { level: 'high', signals: [], note: 'Fixture.' },
    decidedBy: [],
    confirmedByUser: true,
    ...overrides,
  });
}

/**
 * A leaf division, as the catalogue publishes one: a point, a chain ending in
 * itself, and the *parent* locality named in its address rather than held as a
 * record.
 */
function leaf(input: {
  id: string;
  name: string;
  locality: string;
  chain: string[];
  km: number;
  regionName?: string;
}): SourceRecord {
  const point = northOf(input.km);
  return {
    id: `divisions:${input.id}`,
    layerId: 'divisions',
    sourceId: input.id,
    name: input.name,
    alternateNames: [],
    coordinates: point,
    /* A few metres across, which is what a representative point looks like. */
    bounds: {
      southWest: { lat: point.lat, lng: point.lng },
      northEast: { lat: point.lat + 0.00001, lng: point.lng + 0.00001 },
    },
    sourceCategory: 'neighborhood',
    sourceCategoryPath: [],
    planningRole: 'administrative',
    websiteCandidates: [],
    containment: {
      countryCode: 'AA',
      regionName: input.regionName ?? 'AA-SR',
      localityName: input.locality,
      divisionIds: input.chain,
    },
    attributes: { subtype: 'neighborhood' },
    sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  };
}

/** The destination's own division, when the retention budget happened to keep it. */
function destinationDivision(): SourceRecord {
  return {
    id: 'divisions:div-city',
    layerId: 'divisions',
    sourceId: 'div-city',
    name: 'Selected City',
    alternateNames: [],
    coordinates: CENTRE,
    bounds: {
      southWest: { lat: CENTRE.lat, lng: CENTRE.lng },
      northEast: { lat: CENTRE.lat + 0.00001, lng: CENTRE.lng + 0.00001 },
    },
    sourceCategory: 'locality',
    sourceCategoryPath: [],
    planningRole: 'administrative',
    websiteCandidates: [],
    containment: {
      countryCode: 'AA',
      regionName: 'AA-SR',
      divisionIds: ['div-country', 'div-city'],
    },
    attributes: { subtype: 'locality' },
    sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  };
}

/**
 * A museum whose address names a ward and which publishes no identifiers.
 *
 * Deliberately not sitting on any leaf's coordinates. A leaf's published box is
 * a few metres across, and a record that lands on one is inside it — so a museum
 * placed at a leaf's own point is decided by `selected_division_geometry` and
 * proves the box pass rather than the recovery. Half a kilometre off is enough
 * to make the address the only thing that can answer, which is the real
 * distribution.
 */
function wardMuseum(locality: string, km = 8.5): SourceRecord {
  return {
    id: `places:museum-${locality}`,
    layerId: 'places',
    sourceId: `museum-${locality}`,
    name: `${locality} Museum`,
    alternateNames: [],
    coordinates: northOf(km),
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { countryCode: 'AA', localityName: locality, divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary-catalogue', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  };
}

/** The eight-of-a-ward shape: siblings that agree down to the ward and diverge after it. */
function wardLeaves(): SourceRecord[] {
  return [
    leaf({
      id: 'leaf-a1',
      name: 'First Quarter',
      locality: 'Inner Ward',
      chain: ['div-country', 'div-city', 'div-inner-ward', 'div-leaf-a1'],
      km: 8,
    }),
    leaf({
      id: 'leaf-a2',
      name: 'Second Quarter',
      locality: 'Inner Ward',
      chain: ['div-country', 'div-city', 'div-inner-ward', 'div-leaf-a2'],
      km: 9,
    }),
    leaf({
      id: 'leaf-b1',
      name: 'Far Quarter',
      locality: 'Outer Township',
      chain: ['div-country', 'div-other-region', 'div-outer-township', 'div-leaf-b1'],
      km: 30,
      regionName: 'AA-AR',
    }),
  ];
}

describe('the administrative hierarchy a pack publishes but does not hold as records', () => {
  it('recovers a ward’s ancestry from the leaves that name it, and stops at the ward', () => {
    const chains = namedDivisionChains(wardLeaves());
    /*
     * Two siblings agree as far as the ward and diverge at their own
     * identifiers, so the longest common prefix *is* the ancestry — no
     * threshold, and no assumption about what sits at which depth.
     */
    expect(chains.get('inner ward')).toEqual(['div-country', 'div-city', 'div-inner-ward']);
  });

  it('pins the ancestry from a single leaf by dropping that leaf’s own identifier', () => {
    const chains = namedDivisionChains([wardLeaves()[2]!]);
    expect(chains.get('outer township')).toEqual([
      'div-country',
      'div-other-region',
      'div-outer-township',
    ]);
  });

  it('carries the recovered ancestry onto a record that publishes none of its own', () => {
    const chains = namedDivisionChains(wardLeaves());
    const subject = subjectFor(wardMuseum('Inner Ward'), chains);
    expect(subject.evidence?.divisionIds).toEqual([
      'div-country',
      'div-city',
      'div-inner-ward',
    ]);
  });

  it('recovers nothing for a locality name two unrelated places share', () => {
    /*
     * The homonym, and the fail-closed direction. Two divisions publishing the
     * same locality name under different countries agree about nothing, so the
     * common prefix is empty and no ancestry is claimed — rather than the first
     * one indexed being handed to every record that carries the name, which is
     * how a legitimate record twelve kilometres inside a destination once got
     * deleted for an unrelated township that sorted first.
     */
    const chains = namedDivisionChains([
      leaf({
        id: 'leaf-x',
        name: 'One Quarter',
        locality: 'Common Name',
        chain: ['div-country', 'div-city', 'div-common-a', 'div-leaf-x'],
        km: 6,
      }),
      leaf({
        id: 'leaf-y',
        name: 'Another Quarter',
        locality: 'Common Name',
        chain: ['div-elsewhere', 'div-far-region', 'div-common-b', 'div-leaf-y'],
        km: 7,
      }),
    ]);
    expect(chains.get('common name')).toBeUndefined();
  });

  it('leaves a record alone when nothing in the pack names its locality', () => {
    const chains = namedDivisionChains(wardLeaves());
    expect(subjectFor(wardMuseum('Somewhere Else'), chains).evidence).toBeUndefined();
  });

  it('places a ward museum inside the destination, where before it was unplaceable', () => {
    /*
     * THE MEASURED DEFECT.
     *
     * The destination's own division is present, so its identity is known; the
     * ward is not a record and never will be at a 320-record cap. Before the
     * recovery this decided `membership_unknown` — no anchor slot, and 56 real
     * attractions demoted out of a Tokyo board.
     */
    const overlay = buildTripScopeOverlay({
      scope: cityScope(),
      records: [destinationDivision(), ...wardLeaves(), wardMuseum('Inner Ward')],
    });
    const decision = overlay.decisions.get('places:museum-Inner Ward');
    expect(decision?.relationship).toBe('inside_selected_division');
    expect(decision?.basis).toBe('division_identity');
    expect(decision?.eligibility.finalBoardEligible).toBe(true);
  });

  it('does not admit a record whose recovered ancestry runs under a different first-level division', () => {
    const overlay = buildTripScopeOverlay({
      scope: cityScope(),
      records: [destinationDivision(), ...wardLeaves(), wardMuseum('Outer Township', 31)],
    });
    /*
     * The recovery is read in the positive direction only: it can place a record
     * inside the destination and it never refuses one. An ancestry that does not
     * reach the destination leaves the record exactly where it was — unplaced,
     * fail-closed, and off every final slot.
     */
    const decision = overlay.decisions.get('places:museum-Outer Township');
    expect(decision?.relationship).toBe('membership_unknown');
    expect(decision?.eligibility.finalBoardEligible).toBe(false);
  });
});

/**
 * The metropolis, as a catalogue publishes it: the same name at two levels.
 *
 * Overture holds `東京都 / Tokyo` as a `region` whose parent is Japan and as a
 * `locality` whose parent is Chiyoda ward, with the same ISO 3166-2 code on
 * both; New York, Berlin, Seoul and Bangkok all come in the same pair. The
 * index picks the locality, and everything outside the historic core is then a
 * different place.
 */
function metropolisRegion(): SourceRecord {
  const point = northOf(2);
  return {
    id: 'divisions:div-metropolis',
    layerId: 'divisions',
    sourceId: 'div-metropolis',
    name: 'Selected City',
    alternateNames: [],
    coordinates: point,
    bounds: {
      southWest: { lat: point.lat, lng: point.lng },
      northEast: { lat: point.lat + 0.00001, lng: point.lng + 0.00001 },
    },
    sourceCategory: 'region',
    sourceCategoryPath: [],
    planningRole: 'administrative',
    websiteCandidates: [],
    containment: {
      countryCode: 'AA',
      regionName: 'AA-SR',
      divisionIds: ['div-country', 'div-metropolis'],
    },
    attributes: { subtype: 'region' },
    sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
  };
}

/** The core locality the index actually picked, sitting inside the metropolis. */
function coreLocality(): SourceRecord {
  return {
    ...destinationDivision(),
    containment: {
      countryCode: 'AA',
      regionName: 'AA-SR',
      divisionIds: ['div-country', 'div-metropolis', 'div-core-ward', 'div-city'],
    },
  };
}

/** A ward of the metropolis, outside the core locality the index picked. */
function outerWardLeaf(): SourceRecord {
  return leaf({
    id: 'leaf-c1',
    name: 'Outer Quarter',
    locality: 'Outer Ward',
    chain: ['div-country', 'div-metropolis', 'div-outer-ward', 'div-leaf-c1'],
    km: 12,
  });
}

describe('the destination’s own identity', () => {
  it('is both readings when the catalogue publishes the destination at two levels', () => {
    /*
     * §12.1, exactly. `selectDivisions` prefers the match at the level the
     * breadth guessed, so the destination resolved to the locality inside the
     * core ward and every other ward of the same metropolis lost its only
     * positive rung. The region is an *ancestor* of that locality, published
     * under the destination's own name, so it is the same destination.
     */
    const overlay = buildTripScopeOverlay({
      scope: cityScope(),
      records: [metropolisRegion(), coreLocality(), outerWardLeaf(), wardMuseum('Outer Ward', 12.5)],
    });
    expect(overlay.context.selectedDivisionIds).toEqual(
      expect.arrayContaining(['div-city', 'div-metropolis']),
    );
    expect(overlay.decisions.get('places:museum-Outer Ward')?.relationship).toBe(
      'inside_selected_division',
    );
  });

  it('does not union a same-named division that is not in the destination’s own chain', () => {
    /*
     * The homonym guard. A village sharing the destination's name in the same
     * first-level division is consistent by code and is not the destination, and
     * ancestry is what tells them apart — no radius and no popularity.
     */
    const namesake = leaf({
      id: 'leaf-namesake',
      name: 'Selected City',
      locality: 'Far Parish',
      chain: ['div-country', 'div-metropolis', 'div-far-parish', 'div-namesake'],
      km: 35,
    });
    const overlay = buildTripScopeOverlay({
      scope: cityScope(),
      records: [destinationDivision(), namesake, ...wardLeaves()],
    });
    expect(overlay.context.selectedDivisionIds).not.toContain('div-namesake');
  });

  it('uses the division identity the scope was told, when the pack did not retain it', () => {
    /*
     * `selectDivisions` rediscovers the destination from the divisions layer
     * alone. A capped layer does not hold it — measured across every pack stored
     * here, not one retains a division under its destination's own name — so a
     * scope that was handed the answer was being made to prove it again and
     * failing.
     */
    const overlay = buildTripScopeOverlay({
      scope: cityScope({
        administrative: {
          countryCode: 'AA',
          regionCode: 'AA-SR',
          aliases: [],
          hierarchy: [],
          divisionIds: ['div-city'],
        },
      }),
      records: [...wardLeaves(), wardMuseum('Inner Ward')],
    });
    expect(overlay.context.selectedDivisionIds).toContain('div-city');
    expect(overlay.decisions.get('places:museum-Inner Ward')?.relationship).toBe(
      'inside_selected_division',
    );
  });
});

/**
 * THE LAYERS THAT PUBLISH GEOMETRY AND NO ADDRESS.
 *
 * Measured on the fresh dense-metro pack of 2026-07-22: all 1,627 supplemental
 * records (land, water, land_use, infrastructure) publish a real polygon extent
 * and **not one administrative name** — no locality, no region, no chain. The
 * name-recovery above has nothing to read, the divisions layer's own boxes are
 * points a few metres across so `covering` never fires, and a city has no
 * published boundary of its own. So every park, garden and zoo the geographic
 * layers carry fell to `membership_unknown`, 638 attractions were demoted out
 * of the anchor slot, and the city's real parks lost their board seats to
 * whatever the place catalogue happened to misfile.
 *
 * What the pack *does* hold is the divisions layer's leaves, each publishing a
 * full parent chain — so a ward's own children sample the ward's ground. These
 * fixtures are that shape: point-box leaf divisions spread in two dimensions,
 * and supplemental records carrying only geometry.
 */
function eastNorthOf(kmEast: number, kmNorth: number): { lat: number; lng: number } {
  return {
    lat: CENTRE.lat + kmNorth / KM_PER_DEGREE_LAT,
    lng: CENTRE.lng + kmEast / (KM_PER_DEGREE_LAT * Math.cos((CENTRE.lat * Math.PI) / 180)),
  };
}

/** A leaf division at an explicit point, still a point-box like the real layer. */
function leafAt(input: {
  id: string;
  name: string;
  locality: string;
  chain: string[];
  point: { lat: number; lng: number };
  regionName?: string;
}): SourceRecord {
  return {
    ...leaf({
      id: input.id,
      name: input.name,
      locality: input.locality,
      chain: input.chain,
      km: 0,
      ...(input.regionName ? { regionName: input.regionName } : {}),
    }),
    coordinates: input.point,
    bounds: {
      southWest: { lat: input.point.lat, lng: input.point.lng },
      northEast: { lat: input.point.lat + 0.00001, lng: input.point.lng + 0.00001 },
    },
  };
}

/** A supplemental-layer record: a polygon, a point, and no address at all. */
function supplemental(input: {
  id: string;
  name: string;
  point: { lat: number; lng: number };
  bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } };
  regionName?: string;
}): SourceRecord {
  return {
    id: `land_use:${input.id}`,
    layerId: 'land_use',
    sourceId: input.id,
    name: input.name,
    alternateNames: [],
    coordinates: input.point,
    ...(input.bounds ? { bounds: input.bounds } : {}),
    sourceCategory: 'park',
    sourceCategoryPath: ['park'],
    planningRole: 'outdoor',
    websiteCandidates: [],
    containment: { ...(input.regionName ? { regionName: input.regionName } : {}), divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0' }],
    cellId: 'g-0-0',
  };
}

/** A ward of the destination, sampled by three of its own leaves in two dimensions. */
function harbourWardLeaves(): SourceRecord[] {
  const chain = (own: string) => ['div-country', 'div-city', 'div-ward-harbour', own];
  return [
    leafAt({
      id: 'leaf-h1',
      name: 'West Basin',
      locality: 'Harbour Ward',
      chain: chain('div-leaf-h1'),
      point: eastNorthOf(-3, 3),
    }),
    leafAt({
      id: 'leaf-h2',
      name: 'East Basin',
      locality: 'Harbour Ward',
      chain: chain('div-leaf-h2'),
      point: eastNorthOf(3, 5),
    }),
    leafAt({
      id: 'leaf-h3',
      name: 'Mid Basin',
      locality: 'Harbour Ward',
      chain: chain('div-leaf-h3'),
      point: eastNorthOf(0, 4),
    }),
  ];
}

/** A ward of the *adjacent* first-level division, sampled the same way. */
function farWardLeaves(): SourceRecord[] {
  const chain = (own: string) => ['div-country', 'div-other-region', 'div-ward-far', own];
  return [
    leafAt({
      id: 'leaf-f1',
      name: 'Far West Quarter',
      locality: 'Far Ward',
      chain: chain('div-leaf-f1'),
      point: eastNorthOf(-2, 29),
      regionName: 'AA-AR',
    }),
    leafAt({
      id: 'leaf-f2',
      name: 'Far East Quarter',
      locality: 'Far Ward',
      chain: chain('div-leaf-f2'),
      point: eastNorthOf(2, 31),
      regionName: 'AA-AR',
    }),
  ];
}

function boxAround(point: { lat: number; lng: number }, km: number) {
  const dLat = km / KM_PER_DEGREE_LAT;
  const dLng = km / (KM_PER_DEGREE_LAT * Math.cos((CENTRE.lat * Math.PI) / 180));
  return {
    southWest: { lat: point.lat - dLat, lng: point.lng - dLng },
    northEast: { lat: point.lat + dLat, lng: point.lng + dLng },
  };
}

describe('membership for the layers that publish geometry and no address', () => {
  const ground = [destinationDivision(), ...harbourWardLeaves(), ...farWardLeaves()];

  it('places a polygon on ground the destination’s own subdivisions sample inside it', () => {
    /*
     * The park's point sits amid the ward's own leaves; its polygon is small
     * enough to contain none of them, so the measured extent is the only thing
     * that can answer — which is the real distribution.
     */
    const park = supplemental({
      id: 'ward-park',
      name: 'Harbour Common',
      point: eastNorthOf(0.5, 4),
      bounds: boxAround(eastNorthOf(0.5, 4), 0.3),
    });
    const overlay = buildTripScopeOverlay({ scope: cityScope(), records: [...ground, park] });
    const decision = overlay.decisions.get('land_use:ward-park');
    expect(decision?.relationship).toBe('inside_selected_division');
    expect(decision?.basis).toBe('selected_division_geometry');
    expect(decision?.eligibility.finalBoardEligible).toBe(true);
  });

  it('reads a division standing inside the record’s own boundary as whose ground it covers', () => {
    /*
     * The reverse direction: the polygon's representative point is outside the
     * ward's sampled cloud, but the polygon itself contains one of the ward's
     * published leaf points — the divisions layer standing inside the feature.
     */
    const park = supplemental({
      id: 'spanning-park',
      name: 'Basin Reach',
      point: eastNorthOf(3, 8),
      bounds: {
        southWest: eastNorthOf(2, 4.5),
        northEast: eastNorthOf(4, 9),
      },
    });
    const overlay = buildTripScopeOverlay({ scope: cityScope(), records: [...ground, park] });
    const decision = overlay.decisions.get('land_use:spanning-park');
    expect(decision?.relationship).toBe('inside_selected_division');
    expect(decision?.basis).toBe('selected_division_geometry');
  });

  it('leaves a record with no usable geometry unknown, so the fail-closed contract stays true', () => {
    const bare = supplemental({
      id: 'unplaceable',
      name: 'Nameless Green',
      point: eastNorthOf(0, 60),
    });
    const overlay = buildTripScopeOverlay({ scope: cityScope(), records: [...ground, bare] });
    const decision = overlay.decisions.get('land_use:unplaceable');
    expect(decision?.relationship).toBe('membership_unknown');
    expect(decision?.eligibility.finalBoardEligible).toBe(false);
    expect(decision?.eligibility.plannerEligible).toBe(false);
  });

  it('keeps a polygon on another division’s sampled ground out of the destination', () => {
    /*
     * Same record shape, same mechanism, the other side of the border: the far
     * ward's leaves sample its ground just as densely, and their chains run
     * under a different first-level division. Geometry is positive-only, so the
     * answer is the honest unknown — off the final board — not an exclusion.
     */
    const park = supplemental({
      id: 'far-park',
      name: 'Far Meadow',
      point: eastNorthOf(0, 30),
      bounds: boxAround(eastNorthOf(0, 30), 0.3),
    });
    const overlay = buildTripScopeOverlay({ scope: cityScope(), records: [...ground, park] });
    const decision = overlay.decisions.get('land_use:far-park');
    expect(decision?.relationship).toBe('membership_unknown');
    expect(decision?.eligibility.finalBoardEligible).toBe(false);
  });

  it('never lets geometry overrule a published refusal', () => {
    /*
     * A record standing on the destination's own sampled ground whose source
     * places it in the adjacent first-level division. The disagreement decides,
     * before any positive is looked for — the same asymmetry the whole layer
     * rests on: geometry supports, names refuse.
     */
    const misfiled = supplemental({
      id: 'misfiled',
      name: 'Contested Green',
      point: eastNorthOf(0.5, 4),
      bounds: boxAround(eastNorthOf(0.5, 4), 0.3),
      regionName: 'AA-AR',
    });
    const overlay = buildTripScopeOverlay({ scope: cityScope(), records: [...ground, misfiled] });
    expect(overlay.decisions.get('land_use:misfiled')?.relationship).toBe('outside_scope');
  });

  it('does not reconstruct the destination’s own extent from its children', () => {
    /*
     * The guard the mechanism carries. A subdivision's measured extent claims
     * ground the same order of size as what its children sampled; the
     * *destination's* own extent, rebuilt from a scatter of child points, is
     * the largest claim from the sparsest sampling — on the real pack, the
     * whole-metro cloud covered a theme park in the neighbouring prefecture.
     * So a covering measured extent admits only as a proper descendant of a
     * selected division, never as the selected division itself.
     */
    const cityChildren = [
      leafAt({
        id: 'sub-a',
        name: 'North Annex',
        locality: 'Selected City',
        chain: ['div-country', 'div-city', 'div-sub-a'],
        point: eastNorthOf(-8, 12),
      }),
      leafAt({
        id: 'sub-b',
        name: 'South Annex',
        locality: 'Selected City',
        chain: ['div-country', 'div-city', 'div-sub-b'],
        point: eastNorthOf(8, -12),
      }),
    ];
    /* Inside the two annexes' joint bounding box, outside every ward's own. */
    const between = supplemental({
      id: 'between',
      name: 'Between Green',
      point: eastNorthOf(4, -6),
      bounds: boxAround(eastNorthOf(4, -6), 0.3),
    });
    const overlay = buildTripScopeOverlay({
      scope: cityScope(),
      records: [destinationDivision(), ...cityChildren, between],
    });
    expect(overlay.decisions.get('land_use:between')?.relationship).toBe('membership_unknown');
  });
});
