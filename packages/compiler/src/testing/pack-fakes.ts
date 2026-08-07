import {
  accessRuleSchema,
  operatingCalendarSchema,
  packScopeHash,
  REGION_PACK_VERSION,
  type AccessRule,
  type GeographicScope,
  type OperatingCalendar,
  type PackLayer,
  type RegionPack,
  type SourceRecord,
} from '@sidequest/core';
import { assemblePack } from '../backbone/assemble';
import { buildInventory, foodVenueFromRecord } from '../backbone/inventory';
import { partitionScope, scopeBounds } from '../backbone/partition';
import type {
  CompilerProviders,
  ConstraintResearchProvider,
  FoodDiscoveryProvider,
  PlaceDiscoveryProvider,
  ProviderGap,
} from '../providers';
import type { RegionPackProvider } from '../backbone/pack';
import { fakeProviders, type FakeResearchOptions, type SyntheticWorldSpec } from './fakes';

/**
 * A SEVENTH SYNTHETIC WORLD, AND THE ONLY ONE THAT GOES THROUGH THE BACKBONE.
 *
 * The six worlds in `fakes.ts` hand the compiler finished `Place`s, which is the
 * right shape for testing the *planner's* behaviour under six geographies. It is
 * the wrong shape for testing the backbone, because the backbone's whole job is
 * everything that happens before a `Place` exists: partitioning, extraction,
 * normalisation, cross-source linking, taxonomy classification, density-aware
 * retention and the inventory.
 *
 * So this builds a region pack of raw source records — two layers, under two
 * different licences, with deliberate duplicates across them — and runs the real
 * `buildInventory` over it. Everything downstream is derived from whatever
 * survives, rather than from a list written in advance, which is what makes a
 * regression in the backbone fail here instead of in a browser.
 *
 * Deterministic to the byte: no clock, no randomness, every value derived from
 * an index.
 */

const SOURCE_CATEGORIES = [
  'viewpoint',
  'museum',
  'lake',
  'park',
  'marketplace',
  'historic_site',
  'hiking_trail',
  'nature_reserve',
] as const;

const CATEGORY_PATHS: Record<string, string[]> = {
  viewpoint: ['geographic_entities', 'natural_feature', 'viewpoint'],
  museum: ['arts_and_entertainment', 'museum'],
  lake: ['geographic_entities', 'water_feature', 'lake'],
  park: ['sports_and_recreation', 'park'],
  marketplace: ['shopping', 'market', 'marketplace'],
  historic_site: ['cultural_and_historic', 'historic_site'],
  hiking_trail: ['sports_and_recreation', 'trail', 'hiking_trail'],
  nature_reserve: ['geographic_entities', 'protected_area', 'nature_reserve'],
};

const FOOD_CATEGORIES = ['restaurant', 'cafe', 'bakery', 'supermarket'] as const;

/** Categories a classifier must refuse. One of each shape it has to get right. */
const NOISE_CATEGORIES = [
  'atm',
  'insurance_agency',
  'dance_club',
  'christian_place_of_worship',
] as const;

function spiral(index: number): { lat: number; lng: number } {
  const angle = index * 2.399963229728653;
  const radius = 0.02 + index * 0.011;
  return { lat: Math.cos(angle) * radius, lng: Math.sin(angle) * radius };
}

/**
 * The synthetic pack.
 *
 * Two layers under different licences, exactly as a real build produces: a
 * permissive primary catalogue and a share-alike geographic supplement. Records
 * `0` and `1` of the supplement deliberately restate two primary records under
 * the same names and a shared open identifier, so the linker has something real
 * to collapse and the corroboration signal has something real to earn.
 */
export function syntheticPack(spec: SyntheticWorldSpec, scope: GeographicScope): RegionPack {
  const partition = partitionScope(scope);
  const cellId = partition.cells[0]?.id ?? 'g-0-0';
  const bounds = scopeBounds(scope);
  void bounds;

  const primary: SourceRecord[] = [];
  const supplemental: SourceRecord[] = [];

  for (let index = 0; index < spec.placeCount; index += 1) {
    const delta = spiral(index + 1);
    const category = SOURCE_CATEGORIES[index % SOURCE_CATEGORIES.length]!;
    primary.push({
      id: `places:${spec.id}-place-${index}`,
      layerId: 'places',
      sourceId: `${spec.id}-place-${index}`,
      name: `${spec.name} ${titleCase(category)} ${index + 1}`,
      alternateNames: index % 4 === 0 ? [`${spec.name} Alt ${index + 1}`] : [],
      coordinates: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
      sourceCategory: category,
      sourceCategoryPath: CATEGORY_PATHS[category] ?? [],
      planningRole: 'attraction',
      operatingStatus: 'open',
      // Two thirds carry a site, so the funnel has both cheap and expensive
      // subjects and the evidence signals are not uniform.
      websiteCandidates: index % 3 === 0 ? [] : [`https://example.org/${spec.id}/${index}`],
      ...(index % 5 === 0 ? { wikidataId: `Q${1000 + index}` } : {}),
      containment: {
        countryCode: spec.countryCode,
        localityName: spec.name,
        divisionIds: [`div-${spec.id}`],
      },
      attributes: index % 2 === 0 ? { operator: `${spec.name} Trust` } : {},
      sources: [
        { dataset: 'primary-catalogue', licenceId: 'CDLA-Permissive-2.0', recordId: `p${index}` },
      ],
      cellId,
    });
  }

  for (let index = 0; index < Math.max(2, Math.floor(spec.placeCount / 2)); index += 1) {
    const twin = index < 2 ? primary[index] : undefined;
    const delta = spiral(index + 40);
    const category = SOURCE_CATEGORIES[(index + 2) % SOURCE_CATEGORIES.length]!;
    supplemental.push({
      id: `land:${spec.id}-feature-${index}`,
      layerId: 'land',
      sourceId: `w${5_000_000 + index}@1`,
      name: twin ? twin.name : `${spec.name} Feature ${index + 1}`,
      alternateNames: [],
      coordinates: twin
        ? { lat: twin.coordinates.lat + 0.0004, lng: twin.coordinates.lng + 0.0004 }
        : { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
      sourceCategory: twin ? twin.sourceCategory : category,
      sourceCategoryPath: [],
      planningRole: 'attraction',
      websiteCandidates: [],
      // The shared identifier is what makes the link identity rather than a
      // guess, and it is the case a real build hits constantly.
      ...(twin?.wikidataId ? { wikidataId: twin.wikidataId } : index === 0 ? { wikidataId: 'Q1000' } : {}),
      containment: { countryCode: spec.countryCode, localityName: spec.name, divisionIds: [] },
      attributes: { ele: String(800 + index * 40) },
      sources: [
        {
          dataset: 'OpenStreetMap',
          licenceId: 'ODbL-1.0',
          recordId: `w${5_000_000 + index}@1`,
          updateTime: '2026-01-04T00:00:00Z',
        },
      ],
      sourceUrl: `https://www.openstreetmap.org/way/${5_000_000 + index}`,
      cellId,
    });
  }

  for (let index = 0; index < spec.foodVenues; index += 1) {
    const delta = spiral(index + 80);
    const category = FOOD_CATEGORIES[index % FOOD_CATEGORIES.length]!;
    primary.push({
      id: `places:${spec.id}-food-${index}`,
      layerId: 'places',
      sourceId: `${spec.id}-food-${index}`,
      name: `${spec.name} ${titleCase(category)} ${index + 1}`,
      alternateNames: [],
      coordinates: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
      sourceCategory: category,
      sourceCategoryPath: ['food_and_drink', category],
      planningRole: 'food',
      operatingStatus: 'open',
      websiteCandidates: [],
      containment: { countryCode: spec.countryCode, localityName: spec.name, divisionIds: [] },
      attributes: index % 3 === 0 ? { 'diet:vegetarian': 'yes' } : {},
      sources: [
        { dataset: 'primary-catalogue', licenceId: 'Apache-2.0', recordId: `f${index}` },
      ],
      cellId,
    });
  }

  /**
   * Four records the classifier has to refuse, and one that is permanently shut.
   *
   * Every one of these is a shape a live evaluation actually produced: a cash
   * machine filed under a pedestrian container, a business filed under a
   * services branch, a nightclub under an entertainment branch, and a
   * neighbourhood congregation under a cultural one.
   */
  for (const [index, category] of NOISE_CATEGORIES.entries()) {
    const delta = spiral(index + 120);
    primary.push({
      id: `places:${spec.id}-noise-${index}`,
      layerId: 'places',
      sourceId: `${spec.id}-noise-${index}`,
      name: `${spec.name} Noise ${index + 1}`,
      alternateNames: [],
      coordinates: { lat: spec.center.lat + delta.lat, lng: spec.center.lng + delta.lng },
      sourceCategory: category,
      sourceCategoryPath:
        category === 'atm'
          ? ['pedestrian']
          : category === 'insurance_agency'
            ? ['services_and_business', 'insurance_agency']
            : category === 'dance_club'
              ? ['arts_and_entertainment', 'nightlife_venue', 'dance_club']
              : ['cultural_and_historic', 'religious_organization', 'place_of_worship'],
      planningRole: 'excluded',
      websiteCandidates: [],
      containment: { countryCode: spec.countryCode, divisionIds: [] },
      attributes: {},
      sources: [{ dataset: 'primary-catalogue', licenceId: 'CDLA-Permissive-2.0' }],
      cellId,
    });
  }

  const closedDelta = spiral(140);
  primary.push({
    id: `places:${spec.id}-closed`,
    layerId: 'places',
    sourceId: `${spec.id}-closed`,
    name: `${spec.name} Closed Museum`,
    alternateNames: [],
    coordinates: { lat: spec.center.lat + closedDelta.lat, lng: spec.center.lng + closedDelta.lng },
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'excluded',
    operatingStatus: 'closed',
    websiteCandidates: [],
    containment: { countryCode: spec.countryCode, divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary-catalogue', licenceId: 'CDLA-Permissive-2.0' }],
    cellId,
  });

  /**
   * THE DIVISIONS LAYER, WHICH THIS FIXTURE USED NOT TO HAVE.
   *
   * A real pack always carries one, and the containment layer is built on it:
   * the divisions publish a name, a bounding box and a parent chain, and both
   * the destination's own identity and every candidate's locality are resolved
   * through them. A fixture pack without one modelled a population that does not
   * exist, and every record in it came out `membership_unknown` — which is the
   * honest verdict for a pack with no administrative geography and a wholly
   * misleading one for a test suite standing in for real ground.
   *
   * Two divisions, which is the minimum a real chain has: the country, and the
   * locality the world is. The locality's box is sized to contain every record
   * *and* the scope's centre, because a fixture whose scope centre falls outside
   * its own locality would be testing a coverage gap rather than a world.
   */
  const spread = [...primary, ...supplemental].map((record) => record.coordinates);
  const localityBounds = boundsAround([...spread, scope.center, spec.center]);
  const divisions: SourceRecord[] = [
    {
      id: `divisions:${spec.id}-country`,
      layerId: 'divisions',
      sourceId: `${spec.id}-country`,
      name: `${spec.name} Country`,
      alternateNames: [],
      coordinates: spec.center,
      bounds: grow(localityBounds, 20),
      sourceCategory: 'country',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      websiteCandidates: [],
      containment: { countryCode: spec.countryCode, divisionIds: [`div-${spec.id}-country`] },
      attributes: { subtype: 'country' },
      sources: [{ dataset: 'synthetic-divisions', licenceId: 'CDLA-Permissive-2.0' }],
      cellId,
    },
    {
      id: `divisions:${spec.id}`,
      layerId: 'divisions',
      sourceId: spec.id,
      name: spec.name,
      alternateNames: [],
      coordinates: spec.center,
      bounds: grow(localityBounds, 0.25),
      sourceCategory: 'locality',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      websiteCandidates: [],
      containment: {
        countryCode: spec.countryCode,
        regionName: `${spec.countryCode}-1`,
        localityName: spec.name,
        divisionIds: [`div-${spec.id}-country`, `div-${spec.id}`],
      },
      attributes: { subtype: 'locality' },
      sources: [{ dataset: 'synthetic-divisions', licenceId: 'CDLA-Permissive-2.0' }],
      cellId,
    },
  ];

  const layers: PackLayer[] = [
    {
      id: 'divisions',
      kind: 'administrative_divisions',
      catalog: 'synthetic',
      datasetPath: 'divisions/division',
      licenceId: 'CDLA-Permissive-2.0',
      records: divisions,
      featuresRead: divisions.length,
      featuresRetained: divisions.length,
      failedCellIds: [],
    },
    {
      id: 'places',
      kind: 'primary_places',
      catalog: 'synthetic',
      datasetPath: 'places/place',
      licenceId: 'CDLA-Permissive-2.0',
      records: primary,
      featuresRead: primary.length * 4,
      featuresRetained: primary.length,
      failedCellIds: [],
    },
    {
      id: 'land',
      kind: 'supplemental_geography',
      catalog: 'synthetic',
      datasetPath: 'base/land',
      licenceId: 'ODbL-1.0',
      records: supplemental,
      featuresRead: supplemental.length * 3,
      featuresRetained: supplemental.length,
      failedCellIds: [],
    },
  ];

  return assemblePack({
    id: `pack-${spec.id}`,
    scope,
    releases: [
      {
        catalog: 'synthetic',
        releaseId: '2026-07-22.0',
        schemaVersion: '1.0.0',
        resolvedAt: '2026-07-31T00:00:00.000Z',
      },
    ],
    partition,
    layers,
    diagnostics: {
      filesInspected: 2,
      rowGroupsInspected: 8,
      rowGroupsRead: 2,
      bytesTransferred: 1_200_000,
      durationMs: 1_000,
      budgetsExhausted: [],
      layerTimings: [
        { layerId: 'divisions', ms: 120 },
        { layerId: 'places', ms: 600 },
        { layerId: 'land', ms: 400 },
      ],
    },
    now: new Date('2026-07-31T00:00:00.000Z'),
  });
}

/** The smallest box containing every point. */
function boundsAround(points: readonly { lat: number; lng: number }[]) {
  const lats = points.map((point) => point.lat);
  const lngs = points.map((point) => point.lng);
  return {
    southWest: { lat: Math.min(...lats), lng: Math.min(...lngs) },
    northEast: { lat: Math.max(...lats), lng: Math.max(...lngs) },
  };
}

/** The same box with a margin in degrees, so a point on the edge is inside. */
function grow(
  bounds: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } },
  degrees: number,
) {
  return {
    southWest: {
      lat: Math.max(-90, bounds.southWest.lat - degrees),
      lng: Math.max(-180, bounds.southWest.lng - degrees),
    },
    northEast: {
      lat: Math.min(90, bounds.northEast.lat + degrees),
      lng: Math.min(180, bounds.northEast.lng + degrees),
    },
  };
}

function titleCase(value: string): string {
  return value
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * A provider set that goes through the backbone rather than around it.
 *
 * Discovery, food and constraints all derive from whatever the inventory
 * produced, so a change to the taxonomy table, the linker or the retention
 * policy shows up as a different compiled region rather than as nothing at all.
 */
export function packBackedProviders(
  spec: SyntheticWorldSpec,
  options: FakeResearchOptions = {},
): CompilerProviders {
  const base = fakeProviders(spec, options);
  let built: RegionPack | null = null;

  const regionPack: RegionPackProvider = {
    name: 'synthetic-pack',
    async getPack({ scope }) {
      built = syntheticPack(spec, scope);
      return { kind: 'ready', pack: built, source: 'built' };
    },
  };

  const places: PlaceDiscoveryProvider = {
    name: 'synthetic-pack-places',
    async discover({ scope, pack }) {
      if (!pack) {
        return {
          candidates: [],
          gaps: [{ subjectId: spec.id, reason: 'provider_error', detail: 'No pack was supplied.' }],
          calls: 0,
        };
      }
      const inventory = buildInventory({ pack, scope });
      /**
       * The duration override, applied here rather than in the pack.
       *
       * `buildInventory` derives a duration from the source taxonomy, which is
       * the behaviour under test everywhere else. A world that needs stops
       * longer than a day says so on its spec, and it is applied after the real
       * classification has run rather than by faking a category.
       */
      const candidates = spec.placeDurationMinutes
        ? inventory.candidates.map((candidate) => ({
            ...candidate,
            place: {
              ...candidate.place,
              typicalDurationMinutes: spec.placeDurationMinutes!,
            },
          }))
        : inventory.candidates;
      return {
        candidates,
        gaps: [],
        calls: 0,
        licences: inventory.licences,
      };
    },
  };

  const food: FoodDiscoveryProvider = {
    name: 'synthetic-pack-food',
    async discover({ scope, bases, places: known, maxVenues, pack }) {
      if (!pack) return { venues: [], gaps: [], calls: 0 };
      const inventory = buildInventory({ pack, scope });
      /**
       * The same anchoring the live provider does: a venue is priced against
       * whatever is nearest that the matrix already holds. A fixture that shared
       * one node with a base would exercise the path the real one does not.
       */
      const anchors = [
        ...bases.map((base) => ({ id: base.id, coordinates: base.coordinates })),
        ...known.map((place) => ({ id: place.id, coordinates: place.coordinates })),
      ];
      const venues = inventory.foodRecords
        .slice(0, Math.max(0, maxVenues))
        .map((record) =>
          foodVenueFromRecord({
            record,
            scope,
            routingId: nearestAnchorId(anchors, record.coordinates) ?? bases[0]?.id ?? spec.id,
          }),
        )
        .filter((venue): venue is NonNullable<typeof venue> => venue !== null);
      return {
        venues,
        gaps:
          venues.length === 0
            ? [{ subjectId: spec.id, reason: 'not_found' as const, detail: 'No food in this pack.' }]
            : [],
        calls: 0,
      };
    },
  };

  /**
   * Access and hours for whatever survived, at the world's stated coverage.
   *
   * Derived rather than looked up, because the places are no longer known in
   * advance — which is exactly the property that makes this world test the
   * backbone instead of a list.
   */
  const constraints: ConstraintResearchProvider = {
    name: 'synthetic-pack-constraints',
    async research({ places: subjects, maxSubjects }) {
      const allowed = subjects.slice(0, maxSubjects);
      const rules: AccessRule[] = [];
      const calendars: OperatingCalendar[] = [];
      const gaps: ProviderGap[] = [];

      for (const [index, place] of allowed.entries()) {
        if (index / Math.max(1, allowed.length) >= spec.accessCoverage) {
          gaps.push({
            subjectId: place.id,
            reason: 'no_official_source',
            detail: 'No managing authority publishes access information for this.',
          });
          continue;
        }
        /**
         * Parsed rather than constructed, so the fixtures inherit the schemas'
         * own defaults and refinements. A fixture that hand-writes every
         * defaulted field drifts from the schema silently; one that goes through
         * the parser cannot.
         */
        rules.push(
          accessRuleSchema.parse({
            id: `${spec.id}-rule-${index}`,
            label: `Access to ${place.name}`,
            placeIds: [place.id],
            months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            approachMode: spec.primaryMode === 'walk' ? 'walk' : 'drive',
            ...(spec.primaryMode === 'walk' ? { approachMinutes: 10 } : {}),
            privateVehicle: 'allowed',
            serviceRequirement: 'none',
            provenance: {
              kind: 'official',
              sourceName: 'Synthetic authority',
              sourceUrl: 'https://example.org/access',
              lastVerified: '2026-07-01',
              confidence: 0.9,
              volatility: 'seasonal_recurring',
              recheckNote: 'Synthetic access rule for tests.',
            },
          }),
        );

        if (index / Math.max(1, allowed.length) < spec.hoursCoverage) {
          calendars.push(
            operatingCalendarSchema.parse({
              kind: 'scheduled',
              placeId: place.id,
              periods: [
                {
                  label: 'Standard',
                  months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
                  windows: [{ openMinute: 9 * 60, closeMinute: 17 * 60 }],
                },
              ],
              closedAnnualDates: [],
              admission: {
                reservationRequired: false,
                timedEntry: false,
                permitRequired: false,
                walkInAllowed: true,
                capacityLimited: false,
              },
              daylightOnly: false,
              provenance: {
                kind: 'official',
                sourceName: 'Synthetic authority',
                sourceUrl: 'https://example.org/hours',
                lastVerified: '2026-07-01',
                confidence: 0.9,
                volatility: 'dynamic',
                recheckNote: 'Synthetic calendar for tests.',
              },
            }),
          );
        }
      }

      return { calendars, accessRules: rules, services: [], facts: [], gaps, calls: 0, pagesFetched: 0 };
    },
  };

  return { ...base, regionPack, places, food, constraints };
}

function nearestAnchorId(
  anchors: readonly { id: string; coordinates: { lat: number; lng: number } }[],
  point: { lat: number; lng: number },
): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of anchors) {
    const dLat = anchor.coordinates.lat - point.lat;
    const dLng = (anchor.coordinates.lng - point.lng) * Math.cos((point.lat * Math.PI) / 180);
    const distance = dLat * dLat + dLng * dLng;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = anchor.id;
    }
  }
  return best;
}

/** The scope hash a synthetic pack would be stored under. Used by store tests. */
export function syntheticScopeHash(scope: GeographicScope): string {
  return packScopeHash({
    destinationCandidateId: scope.destinationCandidateId,
    bounds: scopeBounds(scope),
  });
}

export const SYNTHETIC_PACK_SCHEMA_VERSION = REGION_PACK_VERSION;
