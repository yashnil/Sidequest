import { describe, expect, it } from 'vitest';
import {
  geographicScopeSchema,
  type GeographicScope,
  type PlanningRole,
  type SourceRecord,
} from '@sidequest/core';
import { assemblePack } from './assemble';
import type { PortfolioSlot } from './balance';
import {
  assessRecordEligibility,
  assessRoleEligibility,
  CANDIDATE_ROLES,
  ELIGIBILITY_SLOTS,
  isAttractionRole,
  ROLE_PERMISSIONS,
  roleForClassification,
  type CandidateRole,
  type SlotPermissions,
} from './eligibility';
import { buildInventory, DEFAULT_ELIGIBILITY } from './inventory';
import { partitionScope } from './partition';
import { classifySourceCategory, knownCategoryKeys, type TaxonomyClassification } from './taxonomy';

/**
 * THE ROLE TAXONOMY, ROW BY ROW, AND THE THREE THINGS THAT MAY NOT OVERRIDE IT.
 *
 * ---
 *
 * ## Why this file is a table over *roles* and `eligibility.test.ts` is a table
 * over *categories*
 *
 * The two are different axes and only one of them was covered. The category
 * table asserts that every word a source publishes lands on the right role —
 * twelve dozen rows, and it is the right shape for "does `chauffeur_service`
 * still mean transport". What it never states is the other half: given a role,
 * **what is that role allowed to do**. That half is `ROLE_PERMISSIONS`, and a
 * category table can only reach the rows some category happens to produce. Six
 * of the twenty-one roles are reachable from no word in today's vocabulary — two
 * attraction tiers the table has simply not grown into, and four refusals that
 * are facts about a record rather than about a category — so a category-driven
 * test cannot see them at all, and an edit that quietly granted `classic` a food
 * slot would have been invisible.
 *
 * So this table is total over `CANDIDATE_ROLES`, by the type. A role added
 * without a row here does not compile.
 *
 * ## Why it also asserts portfolio slots
 *
 * `ROLE_PERMISSIONS` answers six functional questions; `buildInventory` turns
 * those into the five pools it balances. That translation is where a permission
 * either survives or quietly evaporates, and it is the step the live defect
 * happened *after*: the roles were computed correctly and then had nowhere to
 * go. Asserting the permission row alone would prove the decision and not its
 * effect, so every row also states the slots the production resolver derives,
 * and the assertion runs through `DEFAULT_ELIGIBILITY` — the real one — rather
 * than through a copy of its logic.
 */

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * How a role is reached, because not every role is reached the same way.
 *
 * Four of the six refusals have nothing to do with a category — a closure is a
 * fact about the world, a duplicate a fact about link resolution, an unnamed row
 * a fact about the record — and a table that could only speak in categories
 * would have to leave them out. Each variant names the *evidence* that produces
 * the role, so the row documents the mechanism rather than only the answer.
 */
type Reach =
  /** The source's own vocabulary, through `classifySourceCategory`. */
  | { via: 'source_category'; category: string; path?: readonly string[] }
  /** The source says it has shut. */
  | { via: 'record_status'; category: string }
  /** Link resolution says another record carries this entity. */
  | { via: 'link_resolution'; category: string }
  /** No name a traveller could be shown. */
  | { via: 'missing_identity'; category: string; name: string }
  /** A stored pack role, honoured as a refusal. */
  | { via: 'stored_pack_role'; category: string; packRole: PlanningRole }
  /**
   * A classification no word in today's vocabulary produces.
   *
   * Two roles are in this state and both deliberately — `classic` and `discovery`
   * are the tiers left over once every gated sub-two-hour leaf turns out to be
   * cultural or scenic. They are kept because the table will grow and because
   * folding them into each other would say "nobody has written much about this"
   * about a ticketed attraction. A row driven from a hand-built archetype is the
   * only way to assert their permissions at all, and the test below also asserts
   * that no vocabulary key reaches them — so the day one does, this file says so.
   */
  | { via: 'archetype_only'; classification: TaxonomyClassification };

interface RoleRow {
  /** The complete permission row, written out rather than derived. */
  permissions: SlotPermissions;
  /** The pools `buildInventory` puts this role in, in the order it emits them. */
  slots: readonly PortfolioSlot[];
  /** The coarse role a pack may store. Never used for a permission. */
  planningRole: PlanningRole;
  reach: Reach;
  /**
   * A role whose observed slots stand in for this one's, where no record can
   * express this role.
   *
   * Sound only when the two permission rows are identical *and* neither role is
   * one the mapping special-cases — it reads the role itself for exactly three
   * of them (`side_quest` picks `discovery` over `anchor`, `gateway` picks its
   * own pool, `food` is kept out of the practical-stop pool). The test asserts
   * both premises rather than trusting them.
   */
  slotsProvenBy?: CandidateRole;
}

const NOTHING: SlotPermissions = {
  provisionalBoard: false,
  attractionPortfolio: false,
  foodPortfolio: false,
  supportPortfolio: false,
  routingSupport: false,
  finalItinerary: false,
};

const VISITABLE: SlotPermissions = {
  ...NOTHING,
  provisionalBoard: true,
  attractionPortfolio: true,
  finalItinerary: true,
};

const UTILITY: SlotPermissions = { ...NOTHING, supportPortfolio: true, routingSupport: true };

/**
 * The roles whose slot mapping reads the role and not only the permissions.
 *
 * Named here because `slotsProvenBy` is only valid for roles outside this set.
 */
const ROLE_SENSITIVE_SLOTS: readonly CandidateRole[] = ['side_quest', 'gateway', 'food'];

/**
 * An urban archetype short enough not to hold a morning and gated enough to be a
 * destination. The only shape that reaches `classic`, and no leaf has it.
 */
const GATED_SHORT_URBAN: TaxonomyClassification = {
  role: 'attraction',
  subrole: 'urban_place',
  match: { kind: 'source_leaf_category', key: 'a_gated_short_urban_leaf' },
  category: 'town_and_food',
  interests: ['food_and_towns'],
  typicalDurationMinutes: 90,
  physicalIntensity: 'easy',
  exposure: 'mixed',
  visibilityDependent: false,
  poorWeatherBackup: true,
  costLevel: 2,
  plausiblyGated: true,
};

/** The same, ungated: real, worth going to, and nobody sells a ticket for it. */
const UNGATED_SHORT_URBAN: TaxonomyClassification = {
  ...GATED_SHORT_URBAN,
  match: { kind: 'source_leaf_category', key: 'an_ungated_short_urban_leaf' },
  plausiblyGated: false,
};

/**
 * Every role, its permissions, its pools and the evidence that produces it.
 *
 * `Record<CandidateRole, RoleRow>` is what makes this total: a new member of
 * `CANDIDATE_ROLES` without a row is a type error, and a row for a role that no
 * longer exists is one too. The runtime check below catches the third case a
 * type cannot — a key that is not a role at all.
 */
const ROLE_TABLE: Record<CandidateRole, RoleRow> = {
  itinerary_anchor: {
    permissions: VISITABLE,
    slots: ['anchor'],
    planningRole: 'attraction',
    reach: { via: 'source_category', category: 'museum', path: ['arts_and_entertainment', 'museum'] },
  },
  classic: {
    permissions: VISITABLE,
    slots: ['anchor'],
    planningRole: 'attraction',
    reach: { via: 'archetype_only', classification: GATED_SHORT_URBAN },
    slotsProvenBy: 'itinerary_anchor',
  },
  /**
   * The candidate role `discovery` occupies the *anchor* pool, and that is not a
   * mistake.
   *
   * Two vocabularies share the word and mean unrelated things: the role is a
   * tier — "real, and nobody has written much about it" — while the pool is a
   * shape, and `discovery` the pool holds the things that cannot hold a morning.
   * Only `side_quest` is defined by that inability, so only `side_quest` lands
   * there. Asserted rather than left to be rediscovered.
   */
  discovery: {
    permissions: VISITABLE,
    slots: ['anchor'],
    planningRole: 'attraction',
    reach: { via: 'archetype_only', classification: UNGATED_SHORT_URBAN },
    slotsProvenBy: 'itinerary_anchor',
  },
  side_quest: {
    permissions: VISITABLE,
    slots: ['discovery'],
    planningRole: 'side_quest',
    reach: { via: 'source_category', category: 'memorial' },
  },
  outdoor: {
    permissions: VISITABLE,
    slots: ['anchor'],
    planningRole: 'outdoor',
    reach: { via: 'source_category', category: 'hiking_trail', path: ['active_life', 'hiking_trail'] },
  },
  cultural: {
    permissions: VISITABLE,
    slots: ['anchor'],
    planningRole: 'attraction',
    reach: { via: 'source_category', category: 'historic_site', path: ['cultural_and_historic', 'historic_site'] },
  },
  scenic: {
    permissions: VISITABLE,
    slots: ['anchor'],
    planningRole: 'outdoor',
    reach: { via: 'source_category', category: 'viewpoint', path: ['natural_features', 'viewpoint'] },
  },
  /** The one row true in both families, which is why it is its own role. */
  market: {
    permissions: { ...VISITABLE, foodPortfolio: true },
    slots: ['anchor', 'food'],
    planningRole: 'market',
    reach: { via: 'source_category', category: 'night_market', path: ['food_and_drink', 'night_market'] },
  },
  food: {
    permissions: {
      ...NOTHING,
      foodPortfolio: true,
      supportPortfolio: true,
      routingSupport: true,
      finalItinerary: true,
    },
    slots: ['food'],
    planningRole: 'food',
    reach: { via: 'source_category', category: 'restaurant', path: ['eat_and_drink', 'restaurant'] },
  },

  gateway: {
    permissions: UTILITY,
    slots: ['gateway'],
    planningRole: 'gateway',
    reach: {
      via: 'source_category',
      category: 'international_airport',
      path: ['travel_and_transportation', 'transportation', 'international_airport'],
    },
  },
  transport: {
    permissions: UTILITY,
    slots: ['support'],
    planningRole: 'support',
    reach: {
      via: 'source_category',
      category: 'chauffeur_service',
      path: ['travel_and_transportation', 'transportation_service', 'chauffeur_service'],
    },
  },
  /**
   * Routable and invisible — and today the routing permission has no consumer.
   *
   * `routingSupport` is the only true in this row and the portfolio has no
   * routing pool, so a car park is refused from the inventory rather than kept
   * as a graph node. Recorded here as an expectation so the gap is visible: it
   * is the conservative direction (a car park on nobody's board) and it is not
   * what the permission row says the record is *for*.
   */
  infrastructure: {
    permissions: { ...NOTHING, routingSupport: true },
    slots: [],
    planningRole: 'infrastructure',
    reach: { via: 'source_category', category: 'parking' },
  },
  support_stop: {
    permissions: UTILITY,
    slots: ['support'],
    planningRole: 'support',
    reach: { via: 'source_category', category: 'visitor_center' },
  },
  lodging_support: {
    permissions: UTILITY,
    slots: ['support'],
    planningRole: 'lodging',
    reach: { via: 'source_category', category: 'hotel', path: ['accommodation', 'hotel'] },
  },
  food_support: {
    permissions: { ...UTILITY, foodPortfolio: true },
    slots: ['food', 'support'],
    planningRole: 'support',
    reach: { via: 'source_category', category: 'grocery_store' },
  },

  generic_commercial: {
    permissions: NOTHING,
    slots: [],
    planningRole: 'excluded',
    reach: { via: 'source_category', category: 'gym', path: ['active_life', 'gym'] },
  },
  administrative_object: {
    permissions: NOTHING,
    slots: [],
    planningRole: 'administrative',
    reach: { via: 'stored_pack_role', category: 'locality', packRole: 'administrative' },
  },
  duplicate: {
    permissions: NOTHING,
    slots: [],
    planningRole: 'excluded',
    reach: { via: 'link_resolution', category: 'waterfall' },
    /*
     * Link resolution is not an input to the production resolver — a superseded
     * record is refused by the inventory's first gate, before eligibility is
     * consulted at all — so no record can be made to express this role through
     * `DEFAULT_ELIGIBILITY`. `generic_commercial` carries the identical
     * permission row and is reachable, so its observed slots settle this one.
     */
    slotsProvenBy: 'generic_commercial',
  },
  permanently_closed: {
    permissions: NOTHING,
    slots: [],
    planningRole: 'excluded',
    reach: { via: 'record_status', category: 'museum' },
  },
  insufficient_identity: {
    permissions: NOTHING,
    slots: [],
    planningRole: 'excluded',
    reach: { via: 'missing_identity', category: 'restaurant', name: 'Restaurant' },
  },
  insufficient_travel_value: {
    permissions: NOTHING,
    slots: [],
    planningRole: 'excluded',
    reach: { via: 'source_category', category: 'bus_stop' },
  },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scopeFor(overrides: Partial<GeographicScope> = {}): GeographicScope {
  return geographicScopeSchema.parse({
    schemaVersion: 1,
    revision: 1,
    destinationCandidateId: 'relation/1',
    destinationName: 'Testville',
    destinationEntityType: 'city',
    breadth: 'city',
    center: { lat: 40.7, lng: -74 },
    bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
    timeZones: ['UTC'],
    shape: {
      kind: 'bounds',
      bounds: { southWest: { lat: 40.6, lng: -74.1 }, northEast: { lat: 40.8, lng: -73.9 } },
    },
    includedAreas: [],
    excludedAreas: [],
    gateways: [],
    transport: {
      primaryMode: 'drive',
      allowedModes: ['drive', 'walk'],
      carAvailable: true,
      acceptsWaterOrAirTransfers: true,
      basis: 'default',
      note: 'Test transport.',
    },
    maxBaseChanges: 0,
    nights: 4,
    rationale: 'A test scope.',
    confidence: { level: 'high', signals: [], note: 'Test.' },
    decidedBy: [],
    confirmedByUser: true,
    ...overrides,
  });
}

/**
 * A record shaped the way a place normaliser emits one, and placed inside the
 * destination.
 *
 * The containment block matters: these tests are about the *role* half of the
 * eligibility conjunction, so the geographic half has to be satisfied and out of
 * the way. A record with an empty containment block is honestly
 * `membership_unknown`, which would refuse it for a reason this file is not
 * about and would make a green test prove the wrong thing.
 */
function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'places:a',
    layerId: 'places',
    sourceId: 'a',
    name: 'A Named Thing',
    alternateNames: [],
    coordinates: { lat: 40.7, lng: -74 },
    sourceCategory: 'museum',
    sourceCategoryPath: ['arts_and_entertainment', 'museum'],
    planningRole: 'attraction',
    websiteCandidates: [],
    containment: { countryCode: 'AA', localityName: 'Testville', divisionIds: [] },
    attributes: {},
    sources: [{ dataset: 'primary', licenceId: 'CDLA-Permissive-2.0' }],
    cellId: 'g-0-0',
    ...overrides,
  };
}

function divisions(): SourceRecord[] {
  const wide = { southWest: { lat: 39.5, lng: -75 }, northEast: { lat: 41.9, lng: -72.9 } };
  return [
    record({
      id: 'divisions:country',
      layerId: 'divisions',
      sourceId: 'country',
      name: 'Testland',
      bounds: { southWest: { lat: 30, lng: -85 }, northEast: { lat: 50, lng: -65 } },
      sourceCategory: 'country',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      containment: { countryCode: 'AA', divisionIds: ['div-country'] },
      attributes: { subtype: 'country' },
      sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
    }),
    record({
      id: 'divisions:testville',
      layerId: 'divisions',
      sourceId: 'testville',
      name: 'Testville',
      bounds: wide,
      sourceCategory: 'locality',
      sourceCategoryPath: [],
      planningRole: 'administrative',
      containment: {
        countryCode: 'AA',
        regionName: 'AA-1',
        localityName: 'Testville',
        divisionIds: ['div-country', 'div-testville'],
      },
      attributes: { subtype: 'locality' },
      sources: [{ dataset: 'divisions', licenceId: 'CDLA-Permissive-2.0' }],
    }),
  ];
}

function packWith(records: readonly SourceRecord[]) {
  const scope = scopeFor();
  return assemblePack({
    id: 'pack-role-coverage',
    scope,
    releases: [{ catalog: 'test', releaseId: '2026-01-01.0', resolvedAt: '2026-01-01T00:00:00Z' }],
    partition: partitionScope(scope),
    layers: [
      {
        id: 'divisions',
        kind: 'administrative_divisions' as const,
        catalog: 'test',
        datasetPath: 'divisions/division',
        licenceId: 'CDLA-Permissive-2.0' as const,
        records: divisions(),
        featuresRead: 2,
        featuresRetained: 2,
        failedCellIds: [],
      },
      {
        id: 'places',
        kind: 'primary_places' as const,
        catalog: 'test',
        datasetPath: 'places/place',
        licenceId: 'CDLA-Permissive-2.0' as const,
        records: [...records],
        featuresRead: records.length,
        featuresRetained: records.length,
        failedCellIds: [],
      },
    ],
    diagnostics: {
      filesInspected: 1,
      rowGroupsInspected: 1,
      rowGroupsRead: 1,
      bytesTransferred: 1,
      durationMs: 1,
      budgetsExhausted: [],
      layerTimings: [],
    },
    now: new Date('2026-01-02T00:00:00Z'),
  });
}

/** The record a reach describes, where a record can describe it at all. */
function recordFor(reach: Reach, id = 'x1'): SourceRecord | null {
  const base = {
    id: `places:${id}`,
    sourceId: id,
    name: 'A Named Thing',
    sourceCategoryPath: [] as string[],
  };
  switch (reach.via) {
    case 'source_category':
      return record({
        ...base,
        sourceCategory: reach.category,
        sourceCategoryPath: [...(reach.path ?? [])],
      });
    case 'record_status':
      return record({ ...base, sourceCategory: reach.category, operatingStatus: 'closed' });
    case 'missing_identity':
      return record({ ...base, sourceCategory: reach.category, name: reach.name });
    case 'stored_pack_role':
      return record({ ...base, sourceCategory: reach.category, planningRole: reach.packRole });
    case 'link_resolution':
    case 'archetype_only':
      return null;
  }
}

/** The assessment a reach produces, through whichever entry point it needs. */
function assess(reach: Reach) {
  if (reach.via === 'archetype_only') return null;
  if (reach.via === 'link_resolution') {
    return assessRecordEligibility(record({ sourceCategory: reach.category }), { superseded: true });
  }
  return assessRecordEligibility(recordFor(reach)!);
}

// ---------------------------------------------------------------------------
// The table, asserted
// ---------------------------------------------------------------------------

describe('the complete role taxonomy', () => {
  it('has a row for every role and no row for anything else', () => {
    expect(Object.keys(ROLE_TABLE).sort()).toEqual([...CANDIDATE_ROLES].sort());
    expect(CANDIDATE_ROLES).toHaveLength(21);
  });

  it.each(CANDIDATE_ROLES)('%s: the whole permission row, every slot answered', (role) => {
    const row = ROLE_TABLE[role];
    expect(ROLE_PERMISSIONS[role]).toEqual(row.permissions);
    // Written out rather than spread, so a seventh slot fails here first.
    for (const slot of ELIGIBILITY_SLOTS) {
      expect(typeof row.permissions[slot], `${role}.${slot}`).toBe('boolean');
    }
    expect(Object.keys(row.permissions).sort()).toEqual([...ELIGIBILITY_SLOTS].sort());
  });

  it.each(CANDIDATE_ROLES)('%s: the declared evidence really produces it', (role) => {
    const row = ROLE_TABLE[role];
    if (row.reach.via === 'archetype_only') {
      expect(roleForClassification(row.reach.classification).role).toBe(role);
      return;
    }
    const assessment = assess(row.reach)!;
    expect(assessment.role).toBe(role);
    expect(assessment.eligibility).toEqual(row.permissions);
    expect(assessment.planningRole).toBe(row.planningRole);
  });

  /**
   * The permissions, turned into pools by the resolver the inventory actually
   * uses.
   *
   * `DEFAULT_ELIGIBILITY` rather than a reimplementation of it: the defect this
   * whole layer exists to close was not a wrong decision, it was a correct
   * decision that never reached the pools, so a test that recomputed the mapping
   * would assert exactly the part that was never broken.
   */
  it.each(CANDIDATE_ROLES)('%s: occupies exactly the pools its permissions allow', (role) => {
    const row = ROLE_TABLE[role];
    const subject = recordFor(row.reach);
    if (subject) {
      const resolved = DEFAULT_ELIGIBILITY(subject);
      expect(resolved.candidateRole).toBe(role);
      expect(resolved.eligibleFor).toEqual(row.slots);
      expect(resolved.role).toBe(row.planningRole);
      return;
    }

    /*
     * No record can express this role, so a role that shares its permission row
     * stands in — and both premises of that substitution are asserted rather
     * than assumed.
     */
    const twin = row.slotsProvenBy;
    expect(twin, `${role} needs a slotsProvenBy`).toBeDefined();
    expect(ROLE_PERMISSIONS[twin!]).toEqual(ROLE_PERMISSIONS[role]);
    expect(ROLE_SENSITIVE_SLOTS).not.toContain(role);
    expect(ROLE_SENSITIVE_SLOTS).not.toContain(twin!);
    const observed = DEFAULT_ELIGIBILITY(recordFor(ROLE_TABLE[twin!].reach)!);
    expect(observed.eligibleFor).toEqual(row.slots);
  });

  /**
   * The invariant, stated over the table rather than over a handful of rows.
   *
   * Anything that is not an attraction role reaches no traveller-facing slot and
   * no pool a board is built from — whatever its category, its evidence or its
   * archetype. `market` is an attraction role and is meant to be here.
   */
  it('lets nothing outside the attraction family reach a visitable slot or pool', () => {
    const leaked: string[] = [];
    for (const role of CANDIDATE_ROLES) {
      if (isAttractionRole(role)) continue;
      const row = ROLE_TABLE[role];
      if (row.permissions.provisionalBoard || row.permissions.attractionPortfolio) {
        leaked.push(`${role}: permissions`);
      }
      if (row.slots.includes('anchor') || row.slots.includes('discovery')) {
        leaked.push(`${role}: pools`);
      }
    }
    expect(leaked).toEqual([]);
  });

  /**
   * `classic` and `discovery` are unreachable from today's vocabulary, and that
   * is asserted rather than assumed.
   *
   * The comment in `eligibility.ts` says every gated sub-two-hour leaf we list
   * turns out to be cultural or scenic. If a table edit changes that, this fails
   * and the change is visible — which is the point of writing the claim down.
   */
  it('says out loud which roles no published category reaches', () => {
    const { leaves, branches } = knownCategoryKeys();
    const produced = new Set(
      [...leaves, ...branches].map(
        (key) => assessRoleEligibility({ sourceCategory: key, name: 'A Named Thing' }).role,
      ),
    );
    const unreachable = CANDIDATE_ROLES.filter((role) => !produced.has(role));
    expect([...unreachable].sort()).toEqual([
      'administrative_object',
      'classic',
      'discovery',
      'duplicate',
      'insufficient_identity',
      'permanently_closed',
    ]);
    for (const role of unreachable) {
      expect(ROLE_TABLE[role].reach.via, role).not.toBe('source_category');
    }
  });
});

// ---------------------------------------------------------------------------
// The named cases, driven from real source vocabulary
// ---------------------------------------------------------------------------

/**
 * The words a global place catalogue and an open map vocabulary publish for the
 * utility half, and what each is allowed to be.
 *
 * Driven through `classifySourceCategory` rather than asserted against the
 * permission table directly, because the table being right is only half the
 * claim: the other half is that a real record carrying these words arrives at
 * the right row. Every entry also asserts the *match kind*, so a word that
 * quietly stopped matching and started falling through to the unknown-category
 * rule fails here instead of passing for the wrong reason.
 */
const UTILITY_VOCABULARY: readonly {
  what: string;
  category: string;
  path?: readonly string[];
  role: CandidateRole;
}[] = [
  { what: 'an international airport', category: 'international_airport', path: ['travel_and_transportation', 'transportation', 'international_airport'], role: 'gateway' },
  { what: 'a domestic airport', category: 'airport', path: ['travel_and_transportation', 'airport'], role: 'gateway' },
  { what: 'a driver for hire', category: 'chauffeur_service', path: ['travel_and_transportation', 'transportation_service', 'chauffeur_service'], role: 'transport' },
  { what: 'a taxi service', category: 'taxi_service', path: ['travel_and_transportation', 'taxi_service'], role: 'transport' },
  { what: 'a taxi rank', category: 'taxi_stand', role: 'transport' },
  { what: 'a private transfer', category: 'private_transfer_service', path: ['travel_and_transportation', 'private_transfer_service'], role: 'transport' },
  { what: 'an airport shuttle', category: 'airport_shuttle_service', role: 'transport' },
  { what: 'a car hire desk', category: 'car_rental_agency', path: ['travel_and_transportation', 'car_rental_agency'], role: 'transport' },
  { what: 'a scooter hire shop', category: 'scooter_rental', role: 'transport' },
  { what: 'a transport company', category: 'transportation_service', path: ['travel_and_transportation', 'transportation_service'], role: 'transport' },
  { what: 'a tour operator', category: 'tour_operator', path: ['travel_and_transportation', 'travel_services', 'tour_operator'], role: 'transport' },
  { what: 'a car park', category: 'parking', role: 'infrastructure' },
  { what: 'a hotel', category: 'hotel', path: ['accommodation', 'hotel'], role: 'lodging_support' },
  { what: 'a resort', category: 'resort', path: ['accommodation', 'resort'], role: 'lodging_support' },
  { what: 'a supermarket', category: 'supermarket', role: 'food_support' },
  { what: 'a grocery', category: 'grocery_store', role: 'food_support' },
  { what: 'a convenience shop', category: 'convenience_store', role: 'food_support' },
  { what: 'a pharmacy', category: 'pharmacy', role: 'support_stop' },
  { what: 'a visitor centre', category: 'visitor_center', role: 'support_stop' },
  { what: 'a tourist information point', category: 'information', role: 'support_stop' },
];

describe('the utility vocabulary a source actually publishes', () => {
  it.each(UTILITY_VOCABULARY)('$what is $role and reaches no visitable slot', (entry) => {
    const taxonomy = classifySourceCategory({
      category: entry.category,
      ...(entry.path ? { path: entry.path } : {}),
    });
    expect(taxonomy.match.kind, entry.category).not.toBe('no_recognised_category');

    const assessment = assessRoleEligibility({
      sourceCategory: entry.category,
      ...(entry.path ? { sourceCategoryPath: entry.path } : {}),
      name: 'A Named Thing',
    });
    expect(assessment.role, entry.what).toBe(entry.role);
    expect(assessment.eligibility, entry.what).toEqual(ROLE_TABLE[entry.role].permissions);
    expect(assessment.eligibility.provisionalBoard, entry.what).toBe(false);
    expect(assessment.eligibility.attractionPortfolio, entry.what).toBe(false);
    expect(isAttractionRole(assessment.role), entry.what).toBe(false);

    const resolved = DEFAULT_ELIGIBILITY(
      record({
        sourceCategory: entry.category,
        sourceCategoryPath: [...(entry.path ?? [])],
        name: 'A Named Thing',
      }),
    );
    expect(resolved.eligibleFor, entry.what).toEqual(ROLE_TABLE[entry.role].slots);
    expect(resolved.eligibleFor, entry.what).not.toContain('anchor');
    expect(resolved.eligibleFor, entry.what).not.toContain('discovery');
  });
});

// ---------------------------------------------------------------------------
// The three overrides
// ---------------------------------------------------------------------------

describe('what may not override a role', () => {
  /**
   * PREVENTS: a record beats every museum in the region on how completely the
   * source describes it, and is offered as a thing to do.
   *
   * This is the first of the three promotions the live Bali run actually used.
   * The airport carried a site, posted hours, a named operator, an open
   * identifier and two contributing datasets — the maximum of every signal
   * `knownness` rewards, and more than any museum in the region has. The bare
   * record below carries none of them. If completeness could promote anything,
   * these two would differ.
   */
  it('a maximally complete utility record still reaches no visitable slot', () => {
    const complete = record({
      id: 'places:rich',
      sourceId: 'rich',
      name: 'A Named Airport',
      sourceCategory: 'international_airport',
      sourceCategoryPath: ['travel_and_transportation', 'transportation', 'international_airport'],
      planningRole: 'gateway',
      operatingStatus: 'open',
      websiteCandidates: ['https://example.org/airport'],
      wikidataId: 'Q123456',
      alternateNames: ['A Second Name'],
      bounds: { southWest: { lat: 40.69, lng: -74.01 }, northEast: { lat: 40.71, lng: -73.99 } },
      attributes: {
        opening_hours: '24/7',
        operator: 'An Airport Authority',
        website: 'https://example.org/airport',
        wheelchair: 'yes',
        ele: '4',
      },
      sources: [
        { dataset: 'meta', licenceId: 'CDLA-Permissive-2.0', existenceConfidence: 0.99 },
        { dataset: 'OpenStreetMap', licenceId: 'ODbL-1.0', recordId: 'w1@1' },
      ],
    });
    const bare = record({
      id: 'places:bare',
      sourceId: 'bare',
      name: 'A Named Airport',
      sourceCategory: 'international_airport',
      sourceCategoryPath: ['travel_and_transportation', 'transportation', 'international_airport'],
    });

    const rich = assessRecordEligibility(complete);
    const plain = assessRecordEligibility(bare);
    expect(rich.role).toBe('gateway');
    expect(rich.role).toBe(plain.role);
    expect(rich.eligibility).toEqual(plain.eligibility);
    expect(rich.roleConfidence).toBe(plain.roleConfidence);
    expect(rich.eligibility.provisionalBoard).toBe(false);
    expect(rich.eligibility.attractionPortfolio).toBe(false);
    expect(rich.eligibility.finalItinerary).toBe(false);
    expect(DEFAULT_ELIGIBILITY(complete).eligibleFor).toEqual(['gateway']);

    // And the same, once it has been through the whole inventory rather than the
    // classifier alone: the completeness the ranking rewards buys it a place in
    // the supporting array and nothing on the board.
    const inventory = buildInventory({ pack: packWith([complete, bare]), scope: scopeFor() });
    expect(inventory.candidates).toEqual([]);
    expect(inventory.supporting.map((entry) => entry.place.name)).toContain('A Named Airport');
  });

  /**
   * PREVENTS: a traveller who ticked "food and towns" is shown an airport,
   * ranked *up*, because the airport's archetype had to borrow a category and
   * `town_and_food` was the nearest thing.
   *
   * The borrowing is real and is asserted here rather than fixed, because the
   * fix is not to invent a category for airports — it is that the interest
   * cannot reach the decision. The assertion is in three parts: the utility
   * records really do inherit the interest a traveller would match on; the
   * decision function has nowhere to put a traveller; and a board built from a
   * pack of nothing but interest-matching utility records is empty.
   */
  it('a traveller whose interests match a utility archetype still gets none of it', () => {
    const matching = [
      { id: 'g1', name: 'A Named Airport', category: 'international_airport' },
      { id: 't1', name: 'A Named Driver Service', category: 'chauffeur_service' },
      { id: 't2', name: 'A Named Tours Company', category: 'tour_operator' },
      { id: 'l1', name: 'A Named Hotel', category: 'hotel' },
      { id: 's1', name: 'A Named Pharmacy', category: 'pharmacy' },
      { id: 's2', name: 'A Named Visitor Centre', category: 'visitor_center' },
      { id: 'f1', name: 'A Named Grocery', category: 'grocery_store' },
      { id: 'p1', name: 'A Named Car Park', category: 'parking' },
    ];

    for (const entry of matching) {
      const assessment = assessRoleEligibility({
        sourceCategory: entry.category,
        name: entry.name,
      });
      /*
       * The inheritance itself: every one of these carries the town-and-food
       * category and the food-and-towns interest, which is exactly what ranked
       * an airport up for a traveller who asked for towns and food.
       */
      expect(assessment.taxonomy.category, entry.category).toBe('town_and_food');
      expect(assessment.taxonomy.interests, entry.category).toContain('food_and_towns');
      // And it buys nothing, because the interest is not an input.
      expect(assessment.eligibility.attractionPortfolio, entry.category).toBe(false);
      expect(assessment.eligibility.provisionalBoard, entry.category).toBe(false);
    }

    const inventory = buildInventory({
      pack: packWith(
        matching.map((entry, index) =>
          record({
            id: `places:${entry.id}`,
            sourceId: entry.id,
            name: entry.name,
            sourceCategory: entry.category,
            sourceCategoryPath: ['travel_and_transportation', entry.category],
            coordinates: { lat: 40.7 + index * 0.002, lng: -74 + index * 0.002 },
          }),
        ),
      ),
      scope: scopeFor(),
    });
    expect(inventory.candidates).toEqual([]);
    expect(inventory.portfolio.supply.supply.visitable).toBe(0);
    expect(inventory.portfolio.supply.supply.supporting).toBeGreaterThan(0);
  });

  /**
   * PREVENTS: a region with almost nothing to do reports a full board, because
   * the attraction quota nobody filled reached into the support and gateway
   * pools to finish the job.
   *
   * `backbone.test.ts` already holds the containment half of this — "never lets
   * an unfilled quota rescue a record admission refused" — and asserts that the
   * survivors all carry a visitable role. This is the role half and is stated as
   * two properties that one does not reach:
   *
   * 1. **The shortage is reported, not filled.** The supply verdict names the
   *    shortfalls and caps the honest board size at what is actually there.
   * 2. **The board size is invariant under the quota.** Raising `maxAttractions`
   *    from three to three hundred changes nothing, which is the only form of
   *    "the remainder was not taken from somewhere else" that cannot be
   *    satisfied by a coincidence of pool sizes.
   */
  it('a region with almost no attractions stays short and says so', () => {
    const attractions = [
      { id: 'm1', name: 'A Named Museum', category: 'museum', path: ['arts_and_entertainment', 'museum'] },
      { id: 'v1', name: 'A Named Lookout', category: 'viewpoint', path: ['natural_features', 'viewpoint'] },
    ].map((entry, index) =>
      record({
        id: `places:${entry.id}`,
        sourceId: entry.id,
        name: entry.name,
        sourceCategory: entry.category,
        sourceCategoryPath: entry.path,
        coordinates: { lat: 40.7 + index * 0.01, lng: -74 + index * 0.01 },
        cellId: index % 2 === 0 ? 'g-0-0' : 'g-1-0',
      }),
    );

    /*
     * Thirty practical records, every one of them better catalogued than either
     * attraction, and every one from a real global business vocabulary.
     */
    const utility = [
      'international_airport', 'ferry_terminal', 'bus_station', 'train_station',
      'chauffeur_service', 'tour_operator', 'taxi_service', 'car_rental_agency',
      'private_transfer_service', 'scooter_rental', 'travel_agency', 'shuttle_service',
      'pharmacy', 'gas_station', 'visitor_center', 'campground', 'information',
      'parking', 'parking', 'parking', 'supermarket', 'grocery_store',
      'convenience_store', 'hotel', 'hostel', 'resort', 'restaurant', 'cafe',
      'bakery', 'bar',
    ].map((category, index) =>
      record({
        id: `places:u${index}`,
        sourceId: `u${index}`,
        name: `A Named Practical Record ${index}`,
        sourceCategory: category,
        sourceCategoryPath: ['travel_and_transportation', category],
        coordinates: { lat: 40.71 + index * 0.002, lng: -73.98 - index * 0.002 },
        cellId: index % 2 === 0 ? 'g-0-0' : 'g-1-0',
        attributes: { operator: 'An Authority', opening_hours: 'Mo-Su 00:00-24:00', ele: '3' },
        websiteCandidates: [`https://example.org/u${index}`],
        wikidataId: `Q${9000 + index}`,
      }),
    );

    const pack = packWith([...attractions, ...utility]);
    const inventory = buildInventory({ pack, scope: scopeFor(), limits: { maxAttractions: 300 } });

    // 1. Short, and short by exactly the visitable supply.
    expect(inventory.candidates).toHaveLength(2);
    expect(inventory.diagnostics.attractions).toBe(2);
    expect(inventory.portfolio.supply.maxHonestBoardSize).toBe(2);

    // 2. The shortage is reported rather than filled.
    expect(inventory.portfolio.supply.shortfalls).toContain('anchors_below_days');
    expect(inventory.portfolio.supply.supportHeavy).toBe(true);
    expect(inventory.portfolio.supply.summary).toContain('2 things to do');

    // 3. The unclaimed quota did not reach the support or gateway pools, which
    //    were full and ranked above both attractions.
    const poolFor = (slot: PortfolioSlot) =>
      inventory.portfolio.pools.filter((pool) => pool.slot === slot);
    expect(poolFor('support').some((pool) => pool.available > 0)).toBe(true);
    expect(poolFor('gateway').some((pool) => pool.available > 0)).toBe(true);
    const visitableKept = inventory.portfolio.pools
      .filter((pool) => pool.slot === 'anchor' || pool.slot === 'discovery')
      .reduce((total, pool) => total + pool.kept, 0);
    expect(visitableKept).toBe(2);

    // 4. And the board size does not move with the quota.
    for (const maxAttractions of [3, 40, 300]) {
      const other = buildInventory({ pack, scope: scopeFor(), limits: { maxAttractions } });
      expect(other.candidates.map((entry) => entry.place.name), `quota ${maxAttractions}`).toEqual(
        inventory.candidates.map((entry) => entry.place.name),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Visitor centres
// ---------------------------------------------------------------------------

/**
 * A VISITOR CENTRE, BOTH WAYS.
 *
 * The mechanism the code has for "separate attraction evidence" is the source
 * publishing a **different leaf** for the record, and that is the whole of it.
 * `classifySourceCategory` matches the leaf before it walks the path, so a
 * `visitor_center` leaf wins over every branch above it — which is what makes
 * the default direction the safe one: an attraction branch cannot promote a
 * visitor centre, and a national park's visitor centre carries more published
 * evidence than most museums do.
 *
 * The promotion therefore requires the catalogue to say the record *is* a
 * museum, a historic site or a gallery, at leaf level, for that record. It is
 * not a second signal layered on top of the visitor-centre answer, and there is
 * deliberately no channel for one: a per-record override that could turn a
 * support stop into an attraction is the shape of the defect this layer closes.
 */
describe('a visitor centre', () => {
  it('is support by default, under any branch and however completely catalogued', () => {
    const cases: readonly { category: string; path?: readonly string[] }[] = [
      { category: 'visitor_center' },
      { category: 'information' },
      { category: 'trailhead' },
      // Filed under an attraction branch, which is where a catalogue usually
      // puts one. The leaf still wins.
      { category: 'visitor_center', path: ['attractions_and_activities', 'visitor_center'] },
      // Leaf unknown, path names the visitor centre: the innermost segment that
      // matches is the visitor centre, not the branch above it.
      { category: 'a_word_no_catalogue_publishes', path: ['attractions_and_activities', 'visitor_center'] },
    ];

    for (const entry of cases) {
      const assessment = assessRoleEligibility({
        sourceCategory: entry.category,
        ...(entry.path ? { sourceCategoryPath: entry.path } : {}),
        name: 'A Named Visitor Centre',
      });
      expect(assessment.role, entry.category).toBe('support_stop');
      expect(assessment.roleBasis.kind, entry.category).toBe('visitor_information');
      expect(assessment.eligibility.provisionalBoard, entry.category).toBe(false);
      expect(assessment.eligibility.attractionPortfolio, entry.category).toBe(false);
      expect(assessment.eligibility.supportPortfolio, entry.category).toBe(true);
    }

    // The completeness that would promote it if anything could.
    const catalogued = record({
      name: 'A Named Visitor Centre',
      sourceCategory: 'visitor_center',
      sourceCategoryPath: ['attractions_and_activities', 'visitor_center'],
      websiteCandidates: ['https://example.org/centre'],
      wikidataId: 'Q222222',
      attributes: { opening_hours: 'Mo-Su 09:00-17:00', operator: 'A Parks Authority', ele: '120' },
    });
    expect(assessRecordEligibility(catalogued).role).toBe('support_stop');
    expect(DEFAULT_ELIGIBILITY(catalogued).eligibleFor).toEqual(['support']);
  });

  it('is an attraction only when the source publishes an attraction leaf for it', () => {
    /*
     * The same building, catalogued by a source that files it as what it is
     * rather than as what it does. Nothing about the record changes except the
     * leaf — the name, the branch and the evidence are identical — so the leaf
     * is demonstrably the whole of the difference.
     */
    const asCentre = record({
      name: 'A Named Heritage Centre',
      sourceCategory: 'visitor_center',
      sourceCategoryPath: ['cultural_and_historic', 'visitor_center'],
      attributes: { opening_hours: 'Mo-Su 09:00-17:00', operator: 'A Trust' },
    });
    const asMuseum = record({
      ...asCentre,
      sourceCategory: 'history_museum',
      sourceCategoryPath: ['cultural_and_historic', 'history_museum'],
    });

    expect(assessRecordEligibility(asCentre).role).toBe('support_stop');
    expect(assessRecordEligibility(asCentre).eligibility.attractionPortfolio).toBe(false);
    expect(DEFAULT_ELIGIBILITY(asCentre).eligibleFor).toEqual(['support']);

    const promoted = assessRecordEligibility(asMuseum);
    expect(promoted.role).toBe('itinerary_anchor');
    expect(promoted.roleBasis.match).toEqual({
      kind: 'source_leaf_category',
      key: 'history_museum',
    });
    expect(promoted.eligibility.attractionPortfolio).toBe(true);
    expect(DEFAULT_ELIGIBILITY(asMuseum).eligibleFor).toEqual(['anchor']);

    // And end to end: one of the two is on the board and the other is not.
    const inventory = buildInventory({
      pack: packWith([
        { ...asCentre, id: 'places:centre', sourceId: 'centre' },
        { ...asMuseum, id: 'places:museum', sourceId: 'museum', coordinates: { lat: 40.705, lng: -74.005 } },
      ]),
      scope: scopeFor(),
    });
    expect(inventory.candidates.map((entry) => entry.place.name)).toEqual(['A Named Heritage Centre']);
    expect(inventory.supporting.map((entry) => entry.place.name)).toEqual(['A Named Heritage Centre']);
  });
});

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

/**
 * A ROLE IS A FLOOR, AND NOT ONLY WHEN IT IS `excluded`.
 *
 * The archetype refines the role and may never appeal against it. Until this
 * held for the whole utility half, the only thing keeping a `support` record out
 * of the anchor pool was that no rule in the category table happened to pair a
 * support role with an outdoor or cultural archetype — a property of the table,
 * one spread away from not holding, and worth exactly as much as somebody
 * remembering it during a table edit.
 *
 * The classifications below cannot be produced by today's vocabulary, which is
 * the point: they are what a plausible future edit produces.
 */
describe('a utility role floors a visitable archetype', () => {
  const archetype = (
    role: PlanningRole,
    subrole: TaxonomyClassification['subrole'],
    overrides: Partial<TaxonomyClassification> = {},
  ): TaxonomyClassification => ({
    role,
    subrole,
    match: { kind: 'source_leaf_category', key: 'a_leaf' },
    category: 'day_hike',
    interests: ['hiking'],
    // Three hours: long enough to be an anchor if anything could make it one.
    typicalDurationMinutes: 180,
    physicalIntensity: 'moderate',
    exposure: 'exposed_outdoor',
    visibilityDependent: true,
    poorWeatherBackup: false,
    costLevel: 0,
    plausiblyGated: true,
    ...overrides,
  });

  const cases: readonly { role: PlanningRole; subrole: TaxonomyClassification['subrole']; expected: CandidateRole }[] = [
    { role: 'support', subrole: 'outdoor_nature', expected: 'support_stop' },
    { role: 'support', subrole: 'cultural', expected: 'support_stop' },
    { role: 'support', subrole: 'urban_place', expected: 'support_stop' },
    { role: 'support', subrole: 'market', expected: 'support_stop' },
    { role: 'gateway', subrole: 'scenic', expected: 'gateway' },
    { role: 'gateway', subrole: 'urban_place', expected: 'gateway' },
    { role: 'lodging', subrole: 'cultural', expected: 'lodging_support' },
    { role: 'infrastructure', subrole: 'scenic', expected: 'infrastructure' },
    { role: 'administrative', subrole: 'urban_place', expected: 'administrative_object' },
    { role: 'food', subrole: 'market', expected: 'food' },
  ];

  it.each(cases)('$role + $subrole resolves to $expected, never to an attraction', (entry) => {
    const resolved = roleForClassification(archetype(entry.role, entry.subrole));
    expect(resolved.role).toBe(entry.expected);
    expect(isAttractionRole(resolved.role)).toBe(false);
    expect(ROLE_PERMISSIONS[resolved.role].attractionPortfolio).toBe(false);
    expect(ROLE_PERMISSIONS[resolved.role].provisionalBoard).toBe(false);
  });

  it('still lets a visitable role through the same archetypes', () => {
    expect(roleForClassification(archetype('outdoor', 'outdoor_nature')).role).toBe('outdoor');
    expect(roleForClassification(archetype('attraction', 'cultural')).role).toBe('itinerary_anchor');
    expect(roleForClassification(archetype('market', 'market')).role).toBe('market');
    expect(roleForClassification(archetype('side_quest', 'urban_place')).role).toBe('side_quest');
  });
});
