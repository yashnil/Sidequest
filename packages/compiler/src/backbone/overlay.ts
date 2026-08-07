import {
  EMPTY_GEOGRAPHIC_EVIDENCE,
  INSIDE_RELATIONSHIPS,
  SCOPE_RELATIONSHIPS,
  TRIP_SCOPE_CONTRACT_VERSION,
  eligibilityFor,
  mergeGeographicEvidence,
  type ContainmentDecision,
  type GeographicEvidence,
  type GeographicScope,
  type ScopeRelationship,
  type SourceRecord,
} from '@sidequest/core';
import {
  DivisionDirectory,
  decideContainment,
  partitionByContainment,
  scopeContainmentContext,
  scopeIdentityKnown,
  type BoundaryEvidence,
  type ContainmentDiagnostics,
  type IncludedArea,
  type MembershipSubject,
  type ScopeContainmentContext,
} from './containment';

/**
 * THE TRIP-SCOPE OVERLAY — WHERE MEMBERSHIP IS ACTUALLY DECIDED.
 *
 * ---
 *
 * ## Why this is a separate layer rather than a step inside the pack build
 *
 * A region pack is **traveller-independent ground**: normalised records, typed
 * geographic evidence, geometry, categories, provenance. It is cached on a key
 * made of the destination candidate and the bounds, and two travellers going to
 * the same city are meant to share one row. `pack-repository.test.ts` asserts
 * that collision *as a feature* — `nights: 3` and `nights: 9` produce one
 * `scopeHash`, "same ground, different traveller".
 *
 * The old containment layer ran **inside** that build and took the traveller's
 * reach radius as an input (112 km at three nights, 220 km at nine). So the two
 * travellers computed different gateway and satellite sets, one of them was
 * written into the shared row, and the second silently received the first's
 * answer. The cache key was right and the thing it was keying was not.
 *
 * There is a second, sharper reason. `optional_satellite` requires an area
 * something asked for, and regional expansion is what asks — but
 * `building_region_pack` runs *before* `expanding_region`, and `includedAreas`
 * is part of `scopeFingerprint`, which keys the pack cache. Populating it at
 * pack build would force a pack rebuild per traveller and destroy the sharing
 * property outright. It is a layering violation, not a plumbing gap.
 *
 * So: the pack holds evidence, and this holds verdicts. The overlay is built
 * after the destination identity, the scope strategy, the regional expansion and
 * the base/satellite strategy are all known, and it is keyed by all of them.
 *
 * ## The gate property
 *
 * Every candidate-producing path — the primary catalogue, the supplemental
 * geography layers, the divisions layer, the Overpass fallback, authored
 * fixtures, regional-expansion bases, gateway discovery, food candidates,
 * support candidates, warm pack reuse and cached candidate lists — resolves its
 * eligibility through `decisionFor`. A record this overlay has never seen gets
 * `membership_unknown` **and no final-board or planner eligibility**, so a new
 * adapter that forgets to register its candidates produces a visibly thin board
 * rather than an invisibly wrong one.
 *
 * That is the whole of "no adapter, fallback, source family or branch may grant
 * board eligibility directly": there is no code path that returns eligibility
 * without going through here, and `architecture.test.ts` proves it.
 */

/**
 * Re-exported from the contract it belongs to.
 *
 * The number lives in `@sidequest/core` because `scopeFingerprint` — the key of
 * every scoped artifact — has to carry it, and that derivation is in core. One
 * declaration, two readers.
 */
export { TRIP_SCOPE_CONTRACT_VERSION };

export interface OverlayIntegrity {
  /** Records the overlay decided on. */
  considered: number;
  /** How the decisions came out, by relationship. */
  byRelationship: { relationship: ScopeRelationship; count: number }[];
  /** Removed as `outside_scope`, with what removed them. */
  outOfScope: number;
  /** Admitted but withheld from final slots because nobody could place them. */
  membershipUnknown: number;
  /** Kept as ways in and out, never as things to do. */
  gateways: number;
  /** Deliberately included by regional expansion. */
  expansionMembers: number;
  /** Offered as optional side trips, and still labelled as such. */
  satellites: number;
  /**
   * True when the destination's own identity could not be established.
   *
   * A coverage failure, and reported as one. It never promotes anything: the
   * escape that said "if we could not identify the destination, let anything
   * anchor" converted a starved divisions budget into a membership claim, and it
   * is gone.
   */
  scopeIdentityUnknown: boolean;
  /** How many divisions the directory could be built from. 0 is a thin build. */
  divisionsAvailable: number;
}

export interface TripScopeOverlay {
  contractVersion: typeof TRIP_SCOPE_CONTRACT_VERSION;
  scopeId: string;
  scopeRevision: number;
  /** The context every decision was made against. Kept for diagnostics. */
  context: ScopeContainmentContext;
  decisions: ReadonlyMap<string, ContainmentDecision>;
  diagnostics: ContainmentDiagnostics;
  integrity: OverlayIntegrity;
}

export interface BuildOverlayInput {
  scope: GeographicScope;
  /** Every record the trip might use, from every ingestion path. */
  records: readonly SourceRecord[];
  /**
   * Areas something explicitly asked for.
   *
   * Empty is the ordinary case and means no satellite and no expansion member
   * can be produced. Adjacency never fills this.
   */
  includedAreas?: readonly IncludedArea[];
  /** Supplied by the role layer. Containment never guesses role eligibility. */
  roleEligible?: (record: SourceRecord) => boolean;
  /** Where the scope's own identity was resolved, when a caller already knows. */
  scopeEvidence?: Partial<GeographicEvidence>;
  boundaryEvidence?: BoundaryEvidence;
}

/**
 * The destination's own identity, resolved the same way every candidate is.
 *
 * The scope carries a name, a centre and — for a city — a circle, so on its own
 * it cannot say which first-level division the destination is in, which is
 * precisely the comparison that excludes a record from the next one along.
 * Looking the *scope centre* up in the same directory every record is looked up
 * in puts both sides of the comparison on the same evidence rather than assuming
 * one of them.
 *
 * Done here rather than mid-pack-build, which is where it used to happen on a
 * 0.08 share of the extraction budget. Starve that share and rung 2 never ran,
 * everything fell to unknown, and one budget-starved build reproduced the whole
 * defect. Here it runs against whatever divisions the pack *did* keep, and when
 * there are none it says so through `scopeIdentityUnknown` instead of degrading
 * into a promotion.
 */
function resolveScopeEvidence(
  scope: GeographicScope,
  directory: DivisionDirectory,
): GeographicEvidence {
  const covering = directory.covering(scope.center);
  if (covering.length === 0) return { ...EMPTY_GEOGRAPHIC_EVIDENCE };
  /*
   * Every division covering the centre, merged outermost-in.
   *
   * All of them rather than the innermost, because the destination *is* the
   * chain: a candidate agreeing at any level of it is agreeing about the
   * destination. Taking only the innermost would make a neighbourhood the
   * destination's identity and refuse the rest of its own city.
   */
  return [...covering]
    .reverse()
    .map((entry) =>
      mergeGeographicEvidence(entry.evidence, {
        ...EMPTY_GEOGRAPHIC_EVIDENCE,
        divisionIds: [...entry.chain],
      }),
    )
    .reduce(mergeGeographicEvidence, { ...EMPTY_GEOGRAPHIC_EVIDENCE });
}

export function buildTripScopeOverlay(input: BuildOverlayInput): TripScopeOverlay {
  const directory = DivisionDirectory.from(input.records);
  const resolved = resolveScopeEvidence(input.scope, directory);
  const scopeEvidence = input.scopeEvidence
    ? mergeGeographicEvidence(resolved, { ...EMPTY_GEOGRAPHIC_EVIDENCE, ...input.scopeEvidence })
    : resolved;

  const context = scopeContainmentContext({
    scope: input.scope,
    evidence: scopeEvidence,
    directory,
    ...(input.includedAreas ? { includedAreas: input.includedAreas } : {}),
    ...(input.boundaryEvidence ? { boundaryEvidence: input.boundaryEvidence } : {}),
  });

  /*
   * The role factor, resolved once per record rather than searched per subject.
   *
   * `partitionByContainment` runs two passes over the whole set, so a linear
   * scan inside the callback is quadratic — and a country pack is 3,200 records,
   * which is ten million comparisons for an answer that is a map lookup.
   */
  const roleByRecordId = input.roleEligible
    ? new Map(input.records.map((record) => [record.id, input.roleEligible!(record)]))
    : undefined;

  const partition = partitionByContainment(
    input.records.map(subjectFor),
    context,
    roleByRecordId
      ? { roleEligible: (subject) => roleByRecordId.get(subject.id) ?? true }
      : {},
  );

  const decisions = new Map<string, ContainmentDecision>();
  for (const entry of [...partition.admitted, ...partition.removed]) {
    if (entry.subject.id) decisions.set(entry.subject.id, entry.decision);
  }

  const counts = new Map<ScopeRelationship, number>();
  for (const decision of decisions.values()) {
    counts.set(decision.relationship, (counts.get(decision.relationship) ?? 0) + 1);
  }

  return {
    contractVersion: TRIP_SCOPE_CONTRACT_VERSION,
    scopeId: context.scopeId,
    scopeRevision: context.scopeRevision,
    context,
    decisions,
    diagnostics: partition.diagnostics,
    integrity: {
      considered: decisions.size,
      byRelationship: partition.diagnostics.byRelationship,
      outOfScope: counts.get('outside_scope') ?? 0,
      membershipUnknown: counts.get('membership_unknown') ?? 0,
      gateways: counts.get('adjacent_gateway') ?? 0,
      expansionMembers: counts.get('regional_expansion_member') ?? 0,
      satellites: counts.get('optional_satellite') ?? 0,
      scopeIdentityUnknown: !scopeIdentityKnown(context),
      divisionsAvailable: directory.size,
    },
  };
}

/**
 * A record, as something containment can judge.
 *
 * Typed evidence is preferred where the record carries it, and the flat
 * `containment` shape is the fallback — which is what makes a pack written
 * before typed evidence existed usable without a migration.
 */
export function subjectFor(record: SourceRecord): MembershipSubject & { id: string } {
  const typed = (record as SourceRecord & { geography?: GeographicEvidence }).geography;
  return {
    id: record.id,
    coordinates: record.coordinates,
    ...(record.bounds ? { bounds: record.bounds } : {}),
    ...(typed ? { evidence: typed } : {}),
    containment: record.containment,
    planningRole: record.planningRole,
    name: record.name,
  };
}

/**
 * The decision for one record, and the fail-closed default.
 *
 * A record this overlay never saw is `membership_unknown` with **no** final
 * board and **no** planner eligibility. That default is the gate: it is what
 * makes forgetting to register a new source produce a short board rather than a
 * wrong one, and it is why no consumer needs to know which adapter a candidate
 * came from.
 */
export function decisionFor(
  overlay: TripScopeOverlay | undefined,
  recordId: string,
): ContainmentDecision {
  const found = overlay?.decisions.get(recordId);
  if (found) return found;
  return {
    candidateId: recordId,
    scopeId: overlay?.scopeId ?? 'unknown',
    scopeRevision: overlay?.scopeRevision ?? 0,
    relationship: 'membership_unknown',
    basis: 'no_evidence',
    confidence: 'none',
    scopeEvidence: overlay?.context.evidence ?? { ...EMPTY_GEOGRAPHIC_EVIDENCE },
    candidateEvidence: { ...EMPTY_GEOGRAPHIC_EVIDENCE },
    levels: [],
    geometry: 'boundary_unavailable',
    diagnosticDistanceKm: 0,
    /*
     * Both factors false, not one.
     *
     * A record the overlay never saw has no role permission either — nobody
     * asked the role layer about it — and hard-coding the role half to `true`
     * here would leave the one production reader of `provisionalBoardEligible`
     * admitting a record on a boolean no gate had narrowed. Unreachable today,
     * because the id mapping is total; a fail-closed default that is only
     * *nearly* closed is not one.
     */
    eligibility: eligibilityFor('membership_unknown', false),
    reason: 'This candidate never reached the containment gate, so nothing is known about it.',
  };
}

/**
 * Decide one late-arriving candidate against an existing overlay.
 *
 * For paths that produce candidates *after* the overlay was built — an
 * expansion base geocoded by name, a gateway discovered while planning. It
 * writes the decision back so the overlay stays the single record of what was
 * judged, and so the integrity counts a traveller reads include it.
 */
export function admitLateCandidate(
  overlay: TripScopeOverlay,
  subject: MembershipSubject & { id: string },
  options: { roleEligible?: boolean } = {},
): ContainmentDecision {
  const decision = decideContainment(subject, overlay.context, options);
  (overlay.decisions as Map<string, ContainmentDecision>).set(subject.id, decision);
  /*
   * Every counter, not the five scalars. `byRelationship` is what a panel reads
   * to say "and eleven were ways in and out", and leaving it at the value the
   * first pass produced made it disagree with `considered` after any late
   * admission — a board explaining itself with two different totals.
   */
  const counts = new Map<ScopeRelationship, number>();
  for (const entry of overlay.decisions.values()) {
    counts.set(entry.relationship, (counts.get(entry.relationship) ?? 0) + 1);
  }
  overlay.integrity.considered = overlay.decisions.size;
  overlay.integrity.byRelationship = SCOPE_RELATIONSHIPS.filter((relationship) =>
    counts.has(relationship),
  ).map((relationship) => ({ relationship, count: counts.get(relationship)! }));
  overlay.integrity.outOfScope = counts.get('outside_scope') ?? 0;
  overlay.integrity.membershipUnknown = counts.get('membership_unknown') ?? 0;
  overlay.integrity.gateways = counts.get('adjacent_gateway') ?? 0;
  overlay.integrity.expansionMembers = counts.get('regional_expansion_member') ?? 0;
  overlay.integrity.satellites = counts.get('optional_satellite') ?? 0;
  return decision;
}

/** Whether a decision places the candidate positively inside the chosen ground. */
export function isInside(decision: ContainmentDecision): boolean {
  return INSIDE_RELATIONSHIPS.includes(decision.relationship);
}
