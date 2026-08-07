import {
  compareAtLevel,
  eligibilityFor,
  hasGeographicEvidence,
  isSubdivisionCode,
  mergeGeographicEvidence,
  normaliseGeographicName,
  sameGeographicName,
  typedEvidenceFrom,
  CONTAINMENT_CONFIDENCE_BY_BASIS,
  EMPTY_GEOGRAPHIC_EVIDENCE,
  EXCLUDED_RELATIONSHIPS,
  EXTERNAL_RELATIONSHIPS,
  INSIDE_RELATIONSHIPS,
  RELATIONSHIP_ADMISSION,
  SCOPE_RELATIONSHIPS,
  admitsToInventory,
  canAnchor,
  type ContainmentDecision,
  type ContainmentEvidenceBasis,
  type Coordinates,
  type ExternalInclusionReason,
  type GatewayPlanningReason,
  type GeoBounds,
  type GeographicEvidence,
  type GeographicLevel,
  type GeographicScope,
  type LevelVerdict,
  type PlanningRole,
  type DestinationEntityType,
  type ScopeBreadth,
  type ScopeRelationship,
  type SourceRecord,
} from '@sidequest/core';
import { boundsContain } from './partition';

/**
 * WHETHER A RECORD BELONGS TO THE DESTINATION, RATHER THAN MERELY BEING NEAR IT.
 *
 * This file decides one thing and publishes it as one type. The vocabulary, the
 * admission table and the eligibility rules live in `@sidequest/core`
 * (`schemas/containment.ts`); what lives here is the *deciding*.
 *
 * ---
 *
 * ## What changed, and why the change is structural rather than a retune
 *
 * The previous version had a fourth rung: "no administrative evidence, and
 * beyond a tuned per-breadth radius, therefore `outside_scope`". A measured
 * probe over the packs stored on this machine (recorded in
 * `phase-12-containment-probe.md`) established what that costs. Over 5,520
 * candidate records in three live packs:
 *
 * - **0 %** carried a source-provided division identity, so the division rung
 *   never fired at all;
 * - **1.5 %–5.9 %** carried a region name, so the administrative rung fired for
 *   about one record in twenty;
 * - **83 %–98 %** carried a locality name, which the design forbade from
 *   refusing (correctly: a metropolis is recorded under its boroughs);
 * - therefore **more than nine in ten** candidates of a city trip were decided
 *   by `withinCore` — that is, by distance alone, positively inside the radius
 *   and negatively outside it.
 *
 * So the fallback was not a rare backstop. It was the main path.
 *
 * ## The three corrections
 *
 * 1. **Distance is diagnostic only.** It is recorded on every decision, it
 *    orders diagnostics, and it is structurally unable to change a relationship.
 *    Beyond-everything with no conflicting evidence is `membership_unknown` —
 *    admitted, labelled, and not anchorable — rather than deleted.
 *
 * 2. **Names are typed.** Country, region, county, locality, neighbourhood,
 *    alias and display name are separate, and comparison happens within a level
 *    with a three-valued result. A country-name match cannot prove membership in
 *    a selected city, which it previously could, because the destination's whole
 *    published hierarchy was unioned into the region accept-set.
 *
 * 3. **The divisions layer is used as a directory, not only as a point lookup.**
 *    It publishes, for every division, a name, a box and a full parent chain of
 *    identifiers. A candidate's own `address.locality` — the one dense field —
 *    can therefore be *resolved to a division identity* and compared against the
 *    destination's chain. That is what distinguishes a borough of the selected
 *    city from a township in the next state along, on published evidence, with
 *    no distance and no name list.
 *
 * ## What is deliberately absent
 *
 * `reachRadiusKm` is not an input. Reach is a property of a traveller —
 * 112 km at three nights, 220 km at nine — and membership is a property of the
 * ground. While reach was a containment input, two travellers to one city
 * computed different gateway and satellite sets at pack build and the second
 * silently received the first's cached answer, because the pack cache key is
 * traveller-independent by design. Consumers apply their own reach to the
 * `diagnosticDistanceKm` this file records.
 *
 * Nothing in this file names a destination, a country, a region or a category.
 */

export type {
  ContainmentDecision,
  ContainmentEvidenceBasis,
  GatewayPlanningReason,
  ScopeRelationship,
};
export {
  EXCLUDED_RELATIONSHIPS,
  EXTERNAL_RELATIONSHIPS,
  INSIDE_RELATIONSHIPS,
  RELATIONSHIP_ADMISSION,
  SCOPE_RELATIONSHIPS,
  admitsToInventory,
  canAnchor,
  eligibilityFor,
};

// ---------------------------------------------------------------------------
// The destination, as something a record can be compared against
// ---------------------------------------------------------------------------

/**
 * How the scope's shape came to exist.
 *
 * A reach circle is a statement about the traveller; a boundary is a statement
 * about the destination. Only the second may be read as geometry, and today
 * almost nothing produces one: every city, town, county and district in the
 * destination index publishes a centre and no polygon.
 */
export type BoundaryEvidence = 'published_boundary' | 'measured_extent' | 'reach_circle';

/** An area something explicitly asked to include. Never produced by adjacency. */
export interface IncludedArea {
  id: string;
  name: string;
  /** Why it is in the trip. Typed, so downstream can reason rather than parse. */
  reason: ExternalInclusionReason;
  /** Whether inclusion is settled or still an offer the traveller may take. */
  status: 'included' | 'optional';
  center?: Coordinates;
  /** Only used to *resolve* which requested area a record serves. */
  radiusKm?: number;
  /** Division identifiers for the area, where the expansion resolved any. */
  divisionIds?: readonly string[];
}

/** How close a candidate must be to a requested area to be serving it. */
export const DEFAULT_INCLUDED_AREA_RADIUS_KM = 25;

export interface ScopeContainmentContext {
  scopeId: string;
  scopeRevision: number;
  breadth: ScopeBreadth;
  centre: Coordinates;
  /** The destination's own extent, when one was measured. Never a reach circle. */
  boundary?: GeoBounds;
  boundaryEvidence: BoundaryEvidence;
  /** The destination's own typed geographic evidence. */
  evidence: GeographicEvidence;
  /** The level the destination itself sits at. Aliases compare only here. */
  aliasLevel: GeographicLevel;
  /** Whether agreeing at region is membership. See `scopeIsAdministrativeRegion`. */
  regionIsMembership: boolean;
  /**
   * The identifiers of the division the destination **is**, where one exists.
   *
   * Not the destination's whole parent chain, and the difference decides
   * everything: a candidate inside the selected *country's* division is inside
   * the country, not inside the city. Matching the chain admitted every record
   * on the continent.
   *
   * Empty for a destination that is not a division at all — a park, an island, a
   * corridor. For those, membership comes from the published boundary those
   * entity types actually have, and a city's absence of one is why a city needs
   * the division instead.
   */
  selectedDivisionIds: readonly string[];
  /** The divisions the pack published, indexed by identity, name and box. */
  directory?: DivisionDirectory;
  /** Areas something explicitly asked for. Empty means no satellite is possible. */
  includedAreas: readonly IncludedArea[];
  /** Gateway names or ids the traveller fixed. */
  namedGateways: readonly string[];
  /** Set by the collection pass. Unknown alone must not finalise a gateway. */
  scopeContainsGateway?: boolean;
  crossesWaterOrAir: boolean;
}

/**
 * Which administrative levels disqualify at a given breadth.
 *
 * A country contains many regions, so a region disagreement says nothing about a
 * country trip. A city does not contain two first-level divisions, so a region
 * disagreement is decisive — and that single line is what excludes a record from
 * a neighbouring first-level division without measuring a distance or knowing a
 * name.
 *
 * Locality and county are deliberately absent everywhere. A metropolitan
 * destination is routinely recorded under the names of its constituent boroughs
 * and spans several counties, and treating either as disqualifying would delete
 * most of a real city. Both are used to *upgrade* a verdict, never to refuse one
 * — except through the directory, where a locality name is resolved to a
 * division whose published *region* is then compared, which is a region
 * disagreement rather than a locality one.
 */
const DISQUALIFYING_LEVELS: Record<ScopeBreadth, readonly GeographicLevel[]> = {
  local: ['country', 'region'],
  city: ['country', 'region'],
  subregion: ['country', 'region'],
  region: ['country', 'region'],
  country: ['country'],
  multi_country: [],
};

/**
 * Whether agreeing at region *is* membership for this destination.
 *
 * Keyed on what the destination **is**, not on how broad it is, and the
 * distinction is load-bearing. `subregion` breadth covers both a state and a
 * national park: for the state, a record agreeing at region is inside it; for
 * the park, a record agreeing at region is merely in the same state, and
 * admitting it would put the gateway town's museum inside the park.
 *
 * An administrative region is a thing whose *boundary is the region* — a
 * subregion, a state or province, a country. An island, a protected area, a
 * corridor, a city and a neighbourhood are not, however much ground they cover,
 * and for those membership needs geometry or division identity.
 *
 * `unknown` falls back to breadth, because a destination we could not classify
 * should behave like the breadth it was measured at rather than like a park.
 */
const ADMINISTRATIVE_REGION_ENTITY_TYPES: readonly DestinationEntityType[] = [
  'subregion',
  'state_or_province',
  'country',
  'multi_country',
];

const REGION_IS_MEMBERSHIP_BREADTHS: readonly ScopeBreadth[] = [
  'subregion',
  'region',
  'country',
  'multi_country',
];

export function scopeIsAdministrativeRegion(input: {
  entityType: DestinationEntityType;
  breadth: ScopeBreadth;
}): boolean {
  if (input.entityType === 'unknown') return REGION_IS_MEMBERSHIP_BREADTHS.includes(input.breadth);
  return ADMINISTRATIVE_REGION_ENTITY_TYPES.includes(input.entityType);
}

export function aliasLevelFor(breadth: ScopeBreadth): GeographicLevel {
  if (breadth === 'local' || breadth === 'city') return 'locality';
  if (breadth === 'subregion' || breadth === 'region') return 'region';
  return 'country';
}

// ---------------------------------------------------------------------------
// The division directory
// ---------------------------------------------------------------------------

export interface DivisionEntry {
  id: string;
  name: string;
  /** Other spellings the source published for this same division. */
  aliases: readonly string[];
  level?: GeographicLevel;
  /** Division identifiers, outermost first, including this division's own. */
  chain: readonly string[];
  evidence: GeographicEvidence;
  bounds?: GeoBounds;
  /** Box area in square degrees. Ordering only — never a membership input. */
  area: number;
}

/** Which of our levels a source's division subtype corresponds to. */
const DIVISION_SUBTYPE_LEVELS: Record<string, GeographicLevel> = {
  country: 'country',
  dependency: 'country',
  region: 'region',
  macroregion: 'region',
  county: 'county',
  localadmin: 'county',
  locality: 'locality',
  borough: 'locality',
  macrohood: 'neighbourhood',
  neighborhood: 'neighbourhood',
  neighbourhood: 'neighbourhood',
  microhood: 'neighbourhood',
};

/**
 * The divisions a pack published, usable three ways.
 *
 * The probe found the divisions layer being used for exactly one of them — a
 * point-in-box lookup — and being capped at 110–320 records for a whole country,
 * so that lookup reached the destination centre and almost nothing else. The
 * *names* it publishes were never indexed, and the parent chains it publishes
 * were projected only onto records that happened to fall inside a retained box.
 *
 * Indexed by name, a division layer of 320 records answers "is this locality
 * inside the selected one" for the 83–98 % of candidates that publish a locality
 * name, which is the dense field. That is why this is a directory rather than a
 * lookup.
 */
export class DivisionDirectory {
  private readonly byId = new Map<string, DivisionEntry>();
  private readonly byNormalisedName = new Map<string, DivisionEntry[]>();
  private readonly boxes: DivisionEntry[] = [];

  static from(records: readonly SourceRecord[]): DivisionDirectory {
    const directory = new DivisionDirectory();
    for (const record of records) {
      if (record.planningRole !== 'administrative') continue;
      const subtype = record.attributes.subtype;
      const chain = record.containment.divisionIds;
      /*
       * The division's own identifier is the last element of its published
       * chain. Where a source publishes no chain we fall back to the record id,
       * so a directory built from a thinner catalogue still answers by name.
       */
      const ownId = chain.length > 0 ? chain[chain.length - 1]! : record.id;
      const entry: DivisionEntry = {
        id: ownId,
        name: record.name,
        aliases: [...record.alternateNames],
        ...(subtype && DIVISION_SUBTYPE_LEVELS[subtype]
          ? { level: DIVISION_SUBTYPE_LEVELS[subtype]! }
          : {}),
        chain: chain.length > 0 ? chain : [ownId],
        evidence: evidenceFromDivision(record, subtype),
        ...(record.bounds ? { bounds: record.bounds } : {}),
        area: record.bounds
          ? Math.abs(record.bounds.northEast.lat - record.bounds.southWest.lat) *
            Math.abs(record.bounds.northEast.lng - record.bounds.southWest.lng)
          : Number.POSITIVE_INFINITY,
      };
      directory.add(entry);
    }
    directory.boxes.sort((a, b) => a.area - b.area);
    return directory;
  }

  private add(entry: DivisionEntry): void {
    const existing = this.byId.get(entry.id);
    /* Longest chain wins: it is the one that knows the most about the parentage. */
    if (!existing || existing.chain.length < entry.chain.length) this.byId.set(entry.id, entry);
    /*
     * Every published spelling, not only the primary one.
     *
     * A catalogue records the same division under a local-script name in one
     * layer and an English one in another, and a directory that indexed only
     * primaries would read a translation as two places. Over-matching here
     * under-excludes, which is the safe direction.
     */
    for (const value of [entry.name, ...entry.aliases]) {
      const key = normaliseGeographicName(value);
      if (key.length === 0) continue;
      const bucket = this.byNormalisedName.get(key);
      if (bucket) {
        if (!bucket.includes(entry)) bucket.push(entry);
      } else {
        this.byNormalisedName.set(key, [entry]);
      }
    }
    if (entry.bounds) this.boxes.push(entry);
  }

  get size(): number {
    return this.byId.size;
  }

  entry(id: string): DivisionEntry | undefined {
    return this.byId.get(id);
  }

  /**
   * Divisions published under this name.
   *
   * Plural on purpose. "Springfield" names dozens of places, and a directory
   * that returned one of them would be guessing. The caller decides what to do
   * with an ambiguous answer, and the honest answer to an ambiguous name is
   * usually `membership_unknown`.
   */
  named(name: string | undefined, level?: GeographicLevel): DivisionEntry[] {
    if (!name) return [];
    const bucket = this.byNormalisedName.get(normaliseGeographicName(name)) ?? [];
    return level ? bucket.filter((entry) => entry.level === level) : [...bucket];
  }

  /** Divisions whose published box contains this point, smallest first. */
  covering(point: Coordinates): DivisionEntry[] {
    return this.boxes.filter((entry) => entry.bounds && boundsContain(entry.bounds, point));
  }
}

function evidenceFromDivision(record: SourceRecord, subtype: string | undefined): GeographicEvidence {
  const level = subtype ? DIVISION_SUBTYPE_LEVELS[subtype] : undefined;
  const base = typedEvidenceFrom({
    ...(record.containment.countryCode ? { countryCode: record.containment.countryCode } : {}),
    ...(record.containment.regionName ? { regionName: record.containment.regionName } : {}),
    ...(record.containment.localityName ? { localityName: record.containment.localityName } : {}),
    ...(record.containment.neighbourhoodName
      ? { neighbourhoodName: record.containment.neighbourhoodName }
      : {}),
    divisionIds: record.containment.divisionIds,
  });
  /* The division's own name belongs at the division's own level, and nowhere else. */
  if (!level) return mergeGeographicEvidence(base, { ...EMPTY_GEOGRAPHIC_EVIDENCE, unleveledNames: [record.name] });
  const own: GeographicEvidence = { ...EMPTY_GEOGRAPHIC_EVIDENCE };
  if (level === 'country') own.countryNames = [record.name];
  else if (level === 'region') own.regionNames = [record.name];
  else if (level === 'county') own.countyNames = [record.name];
  else if (level === 'locality') own.localityNames = [record.name];
  else own.neighbourhoodNames = [record.name];
  return mergeGeographicEvidence(base, own);
}

// ---------------------------------------------------------------------------
// Building the context
// ---------------------------------------------------------------------------

interface ScopeWithIdentity {
  boundaryEvidence?: BoundaryEvidence;
  administrativeBoundary?: GeoBounds;
  administrative?: {
    countryCode?: string;
    regionCode?: string;
    regionName?: string;
    localityName?: string;
    aliases?: readonly string[];
    hierarchy?: readonly string[];
    divisionIds?: readonly string[];
  };
}

export function scopeContainmentContext(input: {
  scope: GeographicScope;
  /** Resolved elsewhere — from the index entry, or from the divisions layer. */
  evidence?: Partial<GeographicEvidence>;
  boundaryEvidence?: BoundaryEvidence;
  includedAreas?: readonly IncludedArea[];
  directory?: DivisionDirectory;
}): ScopeContainmentContext {
  const { scope } = input;
  const extra = scope as GeographicScope & ScopeWithIdentity;

  const boundaryEvidence: BoundaryEvidence =
    input.boundaryEvidence ??
    extra.boundaryEvidence ??
    (scope.shape.kind === 'bounds' ? 'measured_extent' : 'reach_circle');

  /*
   * The *unclipped* published extent wins over the shape.
   *
   * `deriveShape` intersects a published boundary with the trip's reach, which
   * is right for choosing what to compile and wrong for judging what belongs:
   * the clipped box is a subset of the boundary, so it can confirm membership
   * and can never refute it — and using it as a border makes a *wider* trip
   * stricter, which is CS-9.
   */
  const boundary =
    extra.administrativeBoundary ?? (scope.shape.kind === 'bounds' ? scope.shape.bounds : undefined);

  const aliasLevel = aliasLevelFor(scope.breadth);
  const regionIsMembership = scopeIsAdministrativeRegion({
    entityType: scope.destinationEntityType,
    breadth: scope.breadth,
  });

  /*
   * The destination's own typed evidence.
   *
   * Its published `administrativeAreas` hierarchy is *not* poured into a level.
   * The two producers of that array disagree about its direction — one emits
   * coarse-to-fine, the other fine-to-coarse and flattens country, state, county
   * and city into it — so the only honest place for it is `unleveledNames`,
   * where it can corroborate and cannot refuse. That one line is CS-11.
   */
  const declared = extra.administrative ?? {};
  const scopeName = scope.destinationName;
  const own: GeographicEvidence = {
    ...EMPTY_GEOGRAPHIC_EVIDENCE,
    aliases: [scopeName, ...(declared.aliases ?? [])],
    ...(declared.regionCode ? { regionCode: declared.regionCode } : {}),
  };
  if (aliasLevel === 'country') own.countryNames = [scopeName];
  else if (aliasLevel === 'region') own.regionNames = [scopeName];
  else own.localityNames = [scopeName];

  const evidence = [
    typedEvidenceFrom({
      ...(declared.countryCode ?? scope.countryCode
        ? { countryCode: (declared.countryCode ?? scope.countryCode)! }
        : {}),
      ...(declared.regionCode
        ? { regionName: declared.regionCode }
        : declared.regionName
          ? { regionName: declared.regionName }
          : {}),
      ...(declared.localityName ? { localityName: declared.localityName } : {}),
      divisionIds: declared.divisionIds ?? [],
      unleveledNames: declared.hierarchy ?? [],
    }),
    own,
    { ...EMPTY_GEOGRAPHIC_EVIDENCE, ...input.evidence },
  ].reduce(mergeGeographicEvidence);

  return {
    scopeId: scope.destinationCandidateId,
    scopeRevision: scope.revision ?? 0,
    breadth: scope.breadth,
    centre: scope.center,
    ...(boundary && boundaryEvidence !== 'reach_circle' ? { boundary } : {}),
    boundaryEvidence,
    evidence,
    aliasLevel,
    regionIsMembership,
    selectedDivisionIds: selectDivisions({
      directory: input.directory,
      centre: scope.center,
      names: [scope.destinationName, ...evidence.aliases],
      evidence,
      aliasLevel,
      regionIsMembership,
    }),
    ...(input.directory ? { directory: input.directory } : {}),
    includedAreas: input.includedAreas ?? [],
    namedGateways: scope.gateways.flatMap((gateway) => [gateway.id, gateway.name]),
    crossesWaterOrAir:
      scope.transport.acceptsWaterOrAirTransfers === true ||
      scope.destinationEntityType === 'island' ||
      scope.destinationEntityType === 'archipelago',
  };
}

/**
 * The division the destination **is**, where the layer published one.
 *
 * Three ways of identifying it, in order of how much they claim:
 *
 * 1. **By name.** A covering division published under the destination's own name
 *    or one of its aliases is the destination. This is the only route that works
 *    for a country, whose covering division at its own level is itself.
 * 2. **The innermost covering locality, for a locality-breadth destination.** A
 *    town *is* the locality containing its centre, by definition of being a town.
 * 3. **The covering division at the scope's own level, for an administrative
 *    region.** A province is the province containing its centre.
 *
 * And one deliberate absence: a **park, an island or a corridor gets nothing**.
 * None of them is a division, and taking the region that contains one would make
 * every record in that region "inside the park" — which is exactly the answer
 * that put a gateway town's museum inside a protected area. Those entity types
 * are the ones that publish a real boundary, so they lose nothing by it.
 */
function selectDivisions(input: {
  directory?: DivisionDirectory;
  centre: Coordinates;
  names: readonly string[];
  /** What the destination is already known to be. Never a guess from position. */
  evidence: GeographicEvidence;
  aliasLevel: GeographicLevel;
  regionIsMembership: boolean;
}): string[] {
  const directory = input.directory;
  if (!directory || directory.size === 0) return [];

  /*
   * BY NAME FIRST, AND ON REAL DATA THAT IS THE ONLY ONE THAT FIRES.
   *
   * The probe over stored packs found that the divisions layer publishes
   * **points, not polygons**: every retained division record's bounding box is a
   * few metres across, centred on a representative point. So a
   * point-in-box lookup over that layer answers for essentially nothing —
   * which is exactly why not one candidate in three live packs carried a
   * division identity, and why the `ContainmentIndex` box lookup in the pack
   * builder had been a silent no-op since it was written.
   *
   * What the layer does publish, densely and reliably, is a **name**, a set of
   * alternate names, and a full parent chain. So identity resolution is a name
   * lookup, on both sides of the comparison, and the box pass below is kept for
   * the catalogues that do publish extents.
   */
  /*
   * A name lookup over a whole country's divisions finds homonyms, and a
   * homonym selected as *the destination* corrupts every candidate at once: the
   * records around it become high-confidence members, and the records genuinely
   * in the destination lose their only positive rung.
   *
   * So a candidate for "the division the destination is" has to be consistent
   * with what we already know the destination to be. Country code and ISO 3166-2
   * are the two values available on both sides, they are codes rather than
   * labels, and a division that disagrees with either is a different place with
   * the same name.
   */
  const consistent = (entry: DivisionEntry): boolean => {
    const country = compareAtLevel('country', entry.evidence, input.evidence);
    if (country === 'disagree') return false;
    return compareAtLevel('region', entry.evidence, input.evidence) !== 'disagree';
  };

  const named = input.names.flatMap((name) => directory.named(name)).filter(consistent);
  if (named.length > 0) {
    const atLevel = named.filter((entry) => entry.level === input.aliasLevel);
    const chosen = atLevel.length > 0 ? atLevel : named;
    /*
     * An ambiguous name resolves to nothing rather than to a guess — unless
     * every reading agrees, in which case the ambiguity does not matter.
     */
    if (chosen.length === 1) return [chosen[0]!.id];
    const ids = [...new Set(chosen.map((entry) => entry.id))];
    if (ids.length === 1) return ids;
  }

  const covering = directory.covering(input.centre);
  if (covering.length === 0) return [];

  const byName = covering.filter((entry) =>
    input.names.some(
      (name) =>
        sameGeographicName(entry.name, name) ||
        entry.aliases.some((alias) => sameGeographicName(alias, name)),
    ),
  );
  if (byName.length > 0) return byName.map((entry) => entry.id);

  if (input.aliasLevel === 'locality') {
    const locality = covering.find((entry) => entry.level === 'locality');
    if (locality) return [locality.id];
  }
  if (input.regionIsMembership) {
    const atLevel = covering.find((entry) => entry.level === input.aliasLevel);
    if (atLevel) return [atLevel.id];
  }
  return [];
}

/**
 * Whether the destination's own identity is knowable at all from what we hold.
 *
 * Reported, and never used to promote anything. A build that could not identify
 * its own destination has a coverage problem, and the honest consequence is a
 * board that says so.
 */
export function scopeIdentityKnown(context: ScopeContainmentContext): boolean {
  /*
   * COMPARABLE identity, not "we have a name for it".
   *
   * `scopeContainmentContext` always writes the destination's own name into a
   * level and into its aliases, and `hasGeographicEvidence` is true as soon as
   * any name array is non-empty — and a destination name is required by the
   * schema. So this used to be structurally incapable of returning false, and
   * the one signal by which a starved build is distinguishable from a good one
   * reported nothing on every build ever made.
   *
   * What makes an identity usable is a value the *other* side can be compared
   * against: a country code, an ISO 3166-2 code, or the identity of a division
   * the destination is. A name on its own compares only against another name,
   * and the destination's own name is exactly what a record in the next town
   * along will not carry.
   */
  const evidence = context.evidence;
  return (
    evidence.countryCode !== undefined ||
    evidence.regionCode !== undefined ||
    context.selectedDivisionIds.length > 0
  );
}

// ---------------------------------------------------------------------------
// The assessment
// ---------------------------------------------------------------------------

/**
 * The shape containment needs. A `SourceRecord` satisfies it structurally, and
 * so does anything else that knows where it is and what a source said about it.
 */
export interface MembershipSubject {
  coordinates: Coordinates;
  bounds?: GeoBounds;
  /** Typed geographic evidence. Built by `subjectEvidence` from a record. */
  evidence?: GeographicEvidence;
  containment?: {
    countryCode?: string | undefined;
    regionName?: string | undefined;
    localityName?: string | undefined;
    neighbourhoodName?: string | undefined;
    divisionIds: readonly string[];
  };
  planningRole: PlanningRole;
  name?: string;
  id?: string;
}

/** A subject's typed evidence, from whichever shape it carries. */
export function subjectEvidence(subject: MembershipSubject): GeographicEvidence {
  if (subject.evidence) return subject.evidence;
  if (!subject.containment) return { ...EMPTY_GEOGRAPHIC_EVIDENCE };
  return typedEvidenceFrom({
    ...(subject.containment.countryCode ? { countryCode: subject.containment.countryCode } : {}),
    ...(subject.containment.regionName ? { regionName: subject.containment.regionName } : {}),
    ...(subject.containment.localityName ? { localityName: subject.containment.localityName } : {}),
    ...(subject.containment.neighbourhoodName
      ? { neighbourhoodName: subject.containment.neighbourhoodName }
      : {}),
    divisionIds: subject.containment.divisionIds,
  });
}

/**
 * Role eligibility, supplied by the role layer. Containment never guesses it.
 *
 * Optional, and the default is `true`, and that pairing needs defending in a
 * layer whose whole design is fail-closed.
 *
 * The reason it is not `false`: this function answers **where a record is**, and
 * a caller may legitimately want that answer alone — a diagnostic, an exclusion
 * report, a map of what a scope covers. Defaulting to `false` would make every
 * such caller silently read "nothing is eligible for anything", which is a
 * different lie from the one it prevents.
 *
 * The reason the default is not a hole: eligibility is a **conjunction**, and a
 * caller that wants it must supply both factors. `buildInventory` supplies it,
 * every production overlay in the adapter layer supplies it, and
 * `architecture.test.ts` asserts that every `buildTripScopeOverlay` call site
 * outside a test does. A forgotten factor is a failing build rather than a
 * permissive board.
 */
export interface DecisionOptions {
  roleEligible?: boolean;
}

export function decideContainment(
  subject: MembershipSubject,
  context: ScopeContainmentContext,
  options: DecisionOptions = {},
): ContainmentDecision {
  const evidence = subjectEvidence(subject);
  const roleEligible = options.roleEligible ?? true;
  const diagnosticDistanceKm = haversineKm(context.centre, subject.coordinates);

  /*
   * The directory pass, before any comparison.
   *
   * A candidate's own locality name is the one dense field it carries, and on
   * its own it is only a string. Resolved against the divisions the pack
   * published, it becomes an identity with a parent chain — which is what makes
   * a borough of the selected city and a township in the next state along
   * distinguishable on published evidence rather than on a radius.
   */
  /*
   * TWO EVIDENCE SETS, AND THE SPLIT IS THE POINT.
   *
   * `publishedEvidence` is what a **source published about this record**: its
   * own address, plus the identity of any division published under the name that
   * address gives. That is the only material allowed to *refuse*, because it is
   * the only material that is a statement about the record.
   *
   * `supportingEvidence` adds what the record's *position* implies — the
   * divisions whose published bounding boxes contain it. A bounding box
   * over-approximates a real boundary, so being inside one is support for a
   * positive and is never a refutation. Two adjacent first-level divisions have
   * overlapping boxes almost everywhere; letting a box create a conflict deleted
   * records from the middle of the destination and reported it as
   * belongs-elsewhere.
   *
   * The asymmetry is deliberate and is stated in the header: geometry is used in
   * the positive direction only.
   */
  const named = resolveByName(evidence, context);
  const publishedEvidence = named ? mergeGeographicEvidence(evidence, named.evidence) : evidence;
  const byBox = resolveByBox(subject.coordinates, context);
  const candidateEvidence = byBox
    ? mergeGeographicEvidence(publishedEvidence, byBox.evidence)
    : publishedEvidence;
  const resolved = named ?? byBox;

  const geometry =
    context.boundary === undefined || context.boundaryEvidence === 'reach_circle'
      ? ('boundary_unavailable' as const)
      : boundsContain(context.boundary, subject.coordinates)
        ? ('inside_boundary' as const)
        : ('outside_boundary' as const);

  /* Refusals read the published set; positives read the supported one. */
  const levels = compareLevels(publishedEvidence, context);
  const disqualifying = DISQUALIFYING_LEVELS[context.breadth];
  const conflict = levels.find(
    (verdict) => verdict.comparison === 'disagree' && disqualifying.includes(verdict.level),
  );

  const build = (
    relationship: ScopeRelationship,
    basis: ContainmentEvidenceBasis,
    reason: string,
    extra: Partial<ContainmentDecision> = {},
  ): ContainmentDecision => ({
    candidateId: subject.id ?? '',
    ...(subject.name ? { candidateName: subject.name } : {}),
    scopeId: context.scopeId,
    scopeRevision: context.scopeRevision,
    relationship,
    basis,
    confidence: CONTAINMENT_CONFIDENCE_BY_BASIS[basis],
    scopeEvidence: context.evidence,
    candidateEvidence,
    levels,
    geometry,
    diagnosticDistanceKm,
    eligibility: eligibilityFor(relationship, roleEligible),
    reason,
    ...extra,
  });

  /*
   * A disagreement at a level the destination cannot span is decisive, and it is
   * decisive *before* any positive is looked for — which is what makes the
   * exclusion generic rather than a threshold somebody tuned.
   */
  if (conflict) {
    /*
     * A refuted record may still be a **gateway** or a **named** inclusion, and
     * may not be admitted by geometry.
     *
     * The distinction is the whole of the rule. An island's mainland ferry
     * terminal is in another region and is legitimately part of the trip,
     * because something typed says so — a gateway role, or an area whose name or
     * published division identity this record carries. A record that merely sits
     * within some radius of an included area's centre has nothing typed saying
     * so, and admitting it would let a coordinate overrule a source's own
     * statement that the record is in a different country.
     *
     * That was reachable on essentially every trip: every expansion base becomes
     * an included area centred on its own coordinates, and when the model
     * proposes no base the fallback base *is* the destination centre — so there
     * was a 25 km disc around every destination inside which a proven
     * administrative refusal became a plannable, anchorable member.
     */
    const external = externalRole(subject, context, build, candidateEvidence, {
      geometryMayAdmit: false,
    });
    if (external) return external;
    return build(
      'outside_scope',
      resolved ? 'division_identity' : 'typed_administrative_names',
      `The source places this in a different ${conflict.level} from the selected destination.`,
    );
  }

  /* Geometry: a point inside the destination's own published extent. */
  if (geometry === 'inside_boundary') {
    return build(
      'inside_scope',
      'selected_boundary_geometry',
      'Inside the published extent of the selected destination.',
    );
  }

  /*
   * Division identity: the record's published chain contains the division the
   * destination **is**.
   *
   * Against `selectedDivisionIds` and not against the scope's whole chain. The
   * chain runs country → region → county → destination, and matching any of it
   * would make every record in the country "inside the city".
   *
   * Read from `publishedEvidence`, so that a division whose *box* happens to
   * contain the point cannot be reported as published identity. A box match is a
   * real positive and it is a geometric one; it gets its own basis below, and
   * conflating the two would make a coarse over-approximation indistinguishable
   * from a source's own statement.
   */
  if (
    context.selectedDivisionIds.length > 0 &&
    publishedEvidence.divisionIds.some((id) => context.selectedDivisionIds.includes(id))
  ) {
    return build(
      context.regionIsMembership ? 'inside_selected_region' : 'inside_selected_division',
      'division_identity',
      'The source publishes the selected destination in this record’s parent chain.',
    );
  }

  /*
   * A division whose box contains the candidate and whose chain contains the
   * destination. Geometry, but of the *division* rather than of the scope, which
   * is the one polygon this product actually has.
   */
  if (byBox?.matchesScope) {
    return build(
      context.regionIsMembership ? 'inside_selected_region' : 'inside_selected_division',
      'selected_division_geometry',
      'Inside the published boundary of a division the destination is part of.',
    );
  }

  const agrees = (level: GeographicLevel): boolean =>
    levels.some((verdict) => verdict.level === level && verdict.comparison === 'agree');

  /* The destination is a locality and the record says it is in that locality. */
  if (!context.regionIsMembership && (agrees('locality') || agrees('neighbourhood'))) {
    return build(
      'inside_selected_division',
      'typed_administrative_names',
      'The source places this in the selected locality.',
    );
  }

  /* The destination is a region and the record says it is in that region. */
  if (context.regionIsMembership) {
    if (agrees('region') || agrees('county') || agrees('locality')) {
      return build(
        'inside_selected_region',
        'typed_administrative_names',
        'The source places this inside the selected region.',
      );
    }
    if (context.breadth === 'country' && agrees('country')) {
      return build(
        'inside_selected_region',
        'typed_administrative_names',
        'The source places this inside the selected country.',
      );
    }
  }

  const external = externalRole(subject, context, build, candidateEvidence, {
    geometryMayAdmit: true,
  });
  if (external) return external;

  /*
   * The honest unknown.
   *
   * Not a rejection and not a promotion. Everything from here reaches the pack
   * and a provisional board carrying its uncertainty, and nothing from here
   * reaches a final attraction slot or the planner. There is no distance below
   * which this becomes `inside_scope` and none above which it becomes
   * `outside_scope`, because distance is not an argument of membership.
   */
  return build(
    'membership_unknown',
    hasGeographicEvidence(candidateEvidence) ? 'typed_administrative_names' : 'no_evidence',
    'Nobody published enough to place this relative to the selected destination.',
  );
}

/**
 * A gateway, an expansion member, or a satellite — or none of them.
 *
 * All three are ways of being legitimately outside, and all three are
 * deliberately narrow. A gateway must actually be a gateway. An expansion member
 * and a satellite must have been *asked for*: adjacency produces neither,
 * because a product that promoted whatever happened to be nearby is the product
 * that produced a board of somewhere else.
 */
function externalRole(
  subject: MembershipSubject,
  context: ScopeContainmentContext,
  build: (
    relationship: ScopeRelationship,
    basis: ContainmentEvidenceBasis,
    reason: string,
    extra?: Partial<ContainmentDecision>,
  ) => ContainmentDecision,
  evidence: GeographicEvidence,
  options: { geometryMayAdmit: boolean },
): ContainmentDecision | null {
  if (subject.planningRole === 'gateway') {
    const named =
      subject.name !== undefined &&
      context.namedGateways.some((entry) => sameGeographicName(entry, subject.name));
    /*
     * A gateway the traveller named is not up for debate. Otherwise a gateway
     * outside the destination is only needed when the destination has none of
     * its own — and *that* is a property of the whole set, so it is decided in
     * `partitionByContainment` and passed back in. Assessing a single record
     * without it produces the provisional answer, which the collection pass
     * confirms or demotes.
     */
    if (named || context.scopeContainsGateway !== true) {
      const gatewayReason: GatewayPlanningReason = named
        ? 'traveller_named_gateway'
        : context.crossesWaterOrAir
          ? 'water_or_air_crossing_required'
          : 'no_gateway_inside_scope';
      return build(
        'adjacent_gateway',
        'explicit_trip_relationship',
        'Outside the destination, and how the trip gets in or out.',
        { gatewayReason },
      );
    }
  }

  const area = includedAreaFor(subject, context, evidence, options.geometryMayAdmit);
  if (area) {
    return build(
      area.status === 'included' ? 'regional_expansion_member' : 'optional_satellite',
      'explicit_trip_relationship',
      area.status === 'included'
        ? 'In an area this trip deliberately includes.'
        : 'Outside the destination, in an area offered as an optional side trip.',
      { inclusionReason: area.reason, servesAreaId: area.id },
    );
  }

  return null;
}

/**
 * Which requested area a record serves, if any.
 *
 * Name and division identity first, geometry last. The radius here is not a
 * membership test: the area was *already* included by an explicit decision, and
 * this only asks which of several included areas a record belongs to. An
 * unmatched record does not become a satellite; it becomes `membership_unknown`.
 */
function includedAreaFor(
  subject: MembershipSubject,
  context: ScopeContainmentContext,
  evidence: GeographicEvidence,
  geometryMayAdmit: boolean,
): IncludedArea | null {
  /*
   * Typed first: the record's published division identity, then its published
   * area name. Both are statements a source made about this record.
   */
  for (const area of context.includedAreas) {
    if (area.divisionIds?.some((id) => evidence.divisionIds.includes(id))) return area;
    const names = [...evidence.localityNames, ...evidence.neighbourhoodNames, ...evidence.countyNames];
    if (names.some((name) => sameGeographicName(name, area.name))) return area;
  }
  /*
   * Geometry last, and **only where nothing published refutes the record**.
   *
   * A named area with a centre and a radius is how a regional expansion asks for
   * ground whose individual villages nobody's address mentions — "include the
   * lake loop" — and refusing to use it would make that request unanswerable.
   * What it may not do is overrule evidence: a record the sources place in
   * another country is in another country however close it is to a circle
   * somebody drew, and this is the branch that used to say otherwise.
   */
  if (!geometryMayAdmit) return null;
  for (const area of context.includedAreas) {
    if (!area.center) continue;
    const radius = area.radiusKm ?? DEFAULT_INCLUDED_AREA_RADIUS_KM;
    if (haversineKm(area.center, subject.coordinates) <= radius) return area;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The directory pass
// ---------------------------------------------------------------------------

interface DirectoryResolution {
  evidence: GeographicEvidence;
  via: 'covering_box' | 'published_name';
  matchesScope: boolean;
}

/**
 * Turn a candidate's names into published division identity where we can.
 *
 * Two ways in, and the order is deliberate. A division whose *box* contains the
 * point is the stronger answer, because a box is a measurement; a division whose
 * *name* matches the candidate's own locality is weaker, because names repeat —
 * so an ambiguous name resolves to nothing rather than to a guess, and the
 * candidate keeps whatever it had.
 */
function resolveByName(
  evidence: GeographicEvidence,
  context: ScopeContainmentContext,
): DirectoryResolution | null {
  const directory = context.directory;
  if (!directory || directory.size === 0) return null;

  const matches = (entry: DivisionEntry): boolean =>
    context.selectedDivisionIds.some((id) => entry.chain.includes(id));

  /*
   * At the level the address claimed first, and unlevelled second.
   *
   * A catalogue's idea of which level a settlement sits at is not stable — the
   * same place is a `locality` in one country's chain and a `localadmin` or a
   * `county` in another's, and the record's address says only "locality"
   * whatever the divisions layer decided to call it. Insisting on the level
   * would throw away a correct identity for a vocabulary disagreement, which is
   * the CS-11 mistake in miniature.
   *
   * The unlevelled pass is safe because the ambiguity rule below is what does
   * the protecting: a name matching several divisions resolves to nothing unless
   * every reading agrees about the scope.
   */
  const claimed = [
    evidence.neighbourhoodNames[0],
    evidence.localityNames[0],
    evidence.countyNames[0],
  ];
  const levelled = [
    ...directory.named(claimed[0], 'neighbourhood'),
    ...directory.named(claimed[1], 'locality'),
    ...directory.named(claimed[2], 'county'),
  ];
  const named =
    levelled.length > 0 ? levelled : claimed.flatMap((name) => directory.named(name));
  if (named.length === 1) {
    const entry = named[0]!;
    return {
      evidence: mergeGeographicEvidence(entry.evidence, {
        ...EMPTY_GEOGRAPHIC_EVIDENCE,
        divisionIds: [...entry.chain],
      }),
      via: 'published_name',
      matchesScope: matches(entry),
    };
  }
  /*
   * Several divisions share this name.
   *
   * If *all* of them agree about the scope, or none does, the ambiguity does not
   * change the answer — but it very much changes the **evidence**. Homonyms
   * differ in country code, region code and parent chain, and an earlier version
   * returned `named[0].evidence`, which is whichever the directory happened to
   * index first. That evidence went into the one set allowed to *refuse*, so a
   * legitimate record twelve kilometres inside the destination was deleted
   * because an unrelated same-named township elsewhere in the pack sorted first
   * — and the verdict flipped with the retention budget, which is exactly the
   * "two builds of one destination produce different boards" failure the typed
   * evidence work exists to end.
   *
   * So only what is true of **every** reading survives: the intersection of
   * their chains, and nothing else. A shared ancestor is a fact about the name;
   * one homonym's region code is not.
   */
  if (named.length > 1) {
    const all = named.every(matches);
    const none = named.every((entry) => !matches(entry));
    if (all || none) {
      const shared = named
        .map((entry) => new Set(entry.chain))
        .reduce((left, right) => new Set([...left].filter((id) => right.has(id))));
      return {
        evidence: { ...EMPTY_GEOGRAPHIC_EVIDENCE, divisionIds: [...shared] },
        via: 'published_name',
        matchesScope: all,
      };
    }
  }
  return null;
}

/**
 * The box pass.
 *
 * Kept as its own function because a box match is a *geometric* answer and
 * deserves its own evidence basis, and because the assemble path resolves boxes
 * for records it has not yet turned into subjects.
 */
export function resolveByBox(
  point: Coordinates,
  context: ScopeContainmentContext,
): DirectoryResolution | null {
  const directory = context.directory;
  if (!directory || directory.size === 0) return null;
  const covering = directory.covering(point);
  if (covering.length === 0) return null;
  const innermost = covering[0]!;
  const matchesScope =
    context.selectedDivisionIds.length > 0 &&
    covering.some((entry) => context.selectedDivisionIds.some((id) => entry.chain.includes(id)));
  const evidence = covering
    .map((entry) => entry.evidence)
    .reduce(mergeGeographicEvidence, {
      ...EMPTY_GEOGRAPHIC_EVIDENCE,
      divisionIds: [...innermost.chain],
    });
  return { evidence, via: 'covering_box', matchesScope };
}

// ---------------------------------------------------------------------------
// Level comparison
// ---------------------------------------------------------------------------

const COMPARED_LEVELS: readonly GeographicLevel[] = [
  'country',
  'region',
  'county',
  'locality',
  'neighbourhood',
];

function compareLevels(
  candidate: GeographicEvidence,
  context: ScopeContainmentContext,
): LevelVerdict[] {
  const verdicts: LevelVerdict[] = [];
  for (const level of COMPARED_LEVELS) {
    const comparison = compareAtLevel(level, candidate, context.evidence, {
      aliasLevel: context.aliasLevel,
    });
    if (comparison === 'not_comparable') continue;
    const expected = firstValueAt(context.evidence, level);
    const found = firstValueAt(candidate, level);
    verdicts.push({
      level,
      comparison,
      ...(expected ? { expected } : {}),
      ...(found ? { found } : {}),
    });
  }
  return verdicts;
}

function firstValueAt(evidence: GeographicEvidence, level: GeographicLevel): string | undefined {
  switch (level) {
    case 'country':
      return evidence.countryCode ?? evidence.countryNames[0];
    case 'region':
      return evidence.regionCode ?? evidence.regionNames[0];
    case 'county':
      return evidence.countyNames[0];
    case 'locality':
      return evidence.localityNames[0];
    case 'neighbourhood':
      return evidence.neighbourhoodNames[0];
  }
}

// ---------------------------------------------------------------------------
// Collection-level answers
// ---------------------------------------------------------------------------

export interface ContainmentDiagnostics {
  considered: number;
  /** By relationship, so an exclusion is a number rather than an absence. */
  byRelationship: { relationship: ScopeRelationship; count: number }[];
  /** By what decided it, so a region decided on nothing can say so. */
  byBasis: { basis: ContainmentEvidenceBasis; count: number }[];
  /** What the exclusions were decided on, so a wrong one can be traced. */
  excluded: {
    id: string;
    name: string;
    relationship: ScopeRelationship;
    basis: ContainmentEvidenceBasis;
    diagnosticDistanceKm: number;
  }[];
  /** True when the destination's own identity could not be established. */
  scopeIdentityUnknown: boolean;
}

export interface ContainmentPartition<T> {
  admitted: { subject: T; decision: ContainmentDecision }[];
  removed: { subject: T; decision: ContainmentDecision }[];
  diagnostics: ContainmentDiagnostics;
}

/**
 * Containment for a whole set, which is the supported entry point.
 *
 * Two passes, because one of the answers is a property of the set rather than of
 * a record: whether the destination contains a way in of its own. A city with
 * its own station does not need the airport in the next region promoted into the
 * plan, and a record cannot know that about itself.
 */
export function partitionByContainment<T extends MembershipSubject>(
  subjects: readonly T[],
  context: ScopeContainmentContext,
  options: {
    roleEligible?: (subject: T) => boolean;
    keep?: (subject: T, decision: ContainmentDecision) => boolean;
  } = {},
): ContainmentPartition<T> {
  const decide = (subject: T, ctx: ScopeContainmentContext) =>
    decideContainment(subject, ctx, {
      ...(options.roleEligible ? { roleEligible: options.roleEligible(subject) } : {}),
    });

  const first = subjects.map((subject) => ({ subject, decision: decide(subject, context) }));

  const containsGateway = first.some(
    (entry) =>
      entry.subject.planningRole === 'gateway' &&
      INSIDE_RELATIONSHIPS.includes(entry.decision.relationship),
  );

  const resolved: ScopeContainmentContext = { ...context, scopeContainsGateway: containsGateway };
  const assessed = containsGateway
    ? subjects.map((subject) => ({ subject, decision: decide(subject, resolved) }))
    : first;

  const admitted: ContainmentPartition<T>['admitted'] = [];
  const removed: ContainmentPartition<T>['removed'] = [];
  for (const entry of assessed) {
    const keep = options.keep?.(entry.subject, entry.decision);
    if (keep === true || (keep === undefined && admitsToInventory(entry.decision.relationship))) {
      admitted.push(entry);
    } else {
      removed.push(entry);
    }
  }

  const byRelationship = new Map<ScopeRelationship, number>();
  const byBasis = new Map<ContainmentEvidenceBasis, number>();
  for (const entry of assessed) {
    byRelationship.set(
      entry.decision.relationship,
      (byRelationship.get(entry.decision.relationship) ?? 0) + 1,
    );
    byBasis.set(entry.decision.basis, (byBasis.get(entry.decision.basis) ?? 0) + 1);
  }

  return {
    admitted,
    removed,
    diagnostics: {
      considered: subjects.length,
      byRelationship: SCOPE_RELATIONSHIPS.filter((relationship) =>
        byRelationship.has(relationship),
      ).map((relationship) => ({ relationship, count: byRelationship.get(relationship)! })),
      byBasis: [...byBasis.entries()]
        .map(([basis, count]) => ({ basis, count }))
        .sort((a, b) => a.basis.localeCompare(b.basis)),
      excluded: removed
        .map((entry) => ({
          id: entry.subject.id ?? '',
          name: entry.subject.name ?? '',
          relationship: entry.decision.relationship,
          basis: entry.decision.basis,
          diagnosticDistanceKm: Math.round(entry.decision.diagnosticDistanceKm * 10) / 10,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      scopeIdentityUnknown: !scopeIdentityKnown(context),
    },
  };
}

/**
 * Whether a record stays in the pack even when it is not a candidate.
 *
 * Administrative geography is the evidence containment is decided *from*, so a
 * division from a neighbouring area is not noise — it is how a record near the
 * edge gets a locality at all. Dropping it would remove the thing that makes the
 * next verdict possible.
 *
 * Everything else stays too, and that is the pack/overlay split: a pack is
 * traveller-independent ground, and a verdict about one traveller's destination
 * has no business deciding what is in it.
 */
export function retainsInPack(): boolean {
  return true;
}

// ---------------------------------------------------------------------------
// Carrying the decision on a record
// ---------------------------------------------------------------------------

export function withContainmentDecision<T extends SourceRecord>(
  record: T,
  decision: ContainmentDecision,
): T {
  return { ...record, containmentDecision: decision } as T;
}

export function containmentDecisionOf(record: SourceRecord): ContainmentDecision | undefined {
  return (record as SourceRecord & { containmentDecision?: ContainmentDecision }).containmentDecision;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;

export function haversineKm(from: Coordinates, to: Coordinates): number {
  const dLat = toRadians(to.lat - from.lat);
  const dLng = toRadians(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export { isSubdivisionCode, sameGeographicName as sameName };
