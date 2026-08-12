import {
  EMPTY_GEOGRAPHIC_EVIDENCE,
  INSIDE_RELATIONSHIPS,
  SCOPE_RELATIONSHIPS,
  TRIP_SCOPE_CONTRACT_VERSION,
  eligibilityFor,
  mergeGeographicEvidence,
  normaliseGeographicName,
  typedEvidenceFrom,
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

/**
 * The divisions a pack **names** but never published as records of their own.
 *
 * ---
 *
 * A pack's divisions layer is capped, and what a cap keeps is the leaves: on the
 * Tokyo pack stored on this machine it is 269 neighbourhoods and 47 microhoods,
 * one locality and three counties, out of 800 features read. Not one of the
 * wards those neighbourhoods sit in is a record, and neither is the destination.
 *
 * But every one of those 320 records publishes the ward it sits in — 68 of them
 * say `世田谷区` — **and** the division chain that ward sits in. So the pack
 * holds the ward's identity 68 times over and `DivisionDirectory`, which indexes
 * a division only under its *own* name, reads none of it. Measured: of 3,787
 * records, exactly 100 could resolve their published locality through the
 * directory, and **none of the 103 attractions could**. Every museum, temple and
 * park in the destination was therefore `membership_unknown`, and `inventory.ts`
 * demoted all 56 of them out of the anchor slot — a board for a world city with
 * nothing on it that could hold a morning.
 *
 * What this recovers is not an inference. A record inside `世田谷区` publishes a
 * chain that runs through `世田谷区`; siblings in different neighbourhoods of the
 * same ward publish chains that agree exactly as far as the ward and diverge
 * after it. So the **longest common prefix** of the chains published by
 * everything that names a locality *is* that locality's ancestry, exactly, with
 * no threshold and no positional assumption about what sits at which depth. A
 * lone contributor pins it too, once its own identifier — the last element of
 * its own chain, by the directory's own rule — is dropped from the end.
 *
 * Deliberately `divisionIds` and nothing else. Identifiers are read in the
 * positive direction only (`selectedDivisionIds` membership); no level of this
 * reaches the comparison that *refuses*. A recovered ancestry can therefore
 * place a record inside the destination and can never place one outside it,
 * which is the same asymmetry geometry already has here and for the same reason:
 * over-matching under-excludes, and that is the safe direction.
 */
export function namedDivisionChains(
  records: readonly SourceRecord[],
): ReadonlyMap<string, readonly string[]> {
  const contributors = new Map<string, SourceRecord[]>();
  for (const record of records) {
    if (record.planningRole !== 'administrative') continue;
    const locality = record.containment.localityName;
    if (!locality || record.containment.divisionIds.length === 0) continue;
    const key = normaliseGeographicName(locality);
    if (key.length === 0) continue;
    const bucket = contributors.get(key);
    if (bucket) bucket.push(record);
    else contributors.set(key, [record]);
  }

  const chains = new Map<string, readonly string[]>();
  for (const [key, bucket] of contributors) {
    const first = bucket[0]!.containment.divisionIds;
    let shared = first.length;
    for (const record of bucket) {
      const chain = record.containment.divisionIds;
      let common = 0;
      while (common < shared && common < chain.length && chain[common] === first[common]) {
        common += 1;
      }
      shared = common;
    }
    /*
     * A contributor is *inside* the locality, so its own identifier can never be
     * part of the locality's ancestry — and with one contributor the prefix is
     * its whole chain, own identifier included. Trimming from the end is what
     * makes a single retained division as usable as sixty-eight.
     */
    const own = new Set(
      bucket.map((record) => record.containment.divisionIds.at(-1)).filter(Boolean) as string[],
    );
    let end = shared;
    while (end > 0 && own.has(first[end - 1]!)) end -= 1;
    if (end > 0) chains.set(key, first.slice(0, end));
  }
  return chains;
}

/**
 * A DESTINATION PUBLISHED AT TWO LEVELS IS BOTH OF THEM.
 *
 * §12.1's "a city being reduced to an arbitrary suburb", as it actually arrives.
 * A catalogue routinely holds a metropolis twice: once as the first-level
 * division it *is* and once as a locality inside its own historic core. Overture
 * publishes `東京都 / Tokyo` as a `region` whose parent is Japan **and** as a
 * `locality` whose parent is Chiyoda ward; New York, Berlin, Seoul and Bangkok
 * all have the same pair. The destination index picks one of them — the locality,
 * on population — and `selectDivisions` then prefers whichever match sits at the
 * level the *breadth* guessed. So "Tokyo" resolves to a point inside one ward,
 * and every other ward of Tokyo is, on published evidence, somewhere else.
 *
 * The union is deliberately narrow, and the narrowness is what keeps it from
 * being the homonym trap `selectDivisions` is so careful about: a same-named
 * division only counts when it is **in the selected division's own published
 * chain**. Tokyo-the-region is an ancestor of Tokyo-the-locality, so it joins; a
 * same-named village in the same province is not an ancestor of anything, so it
 * does not. No radius, no level assumption, no place list — the destination's own
 * name matched against published names, filtered by published ancestry.
 */
function sameNamedAncestors(
  scope: GeographicScope,
  directory: DivisionDirectory,
  selected: readonly string[],
): string[] {
  if (selected.length === 0) return [];
  const ancestry = new Set(
    selected.flatMap((id) => [...(directory.entry(id)?.chain ?? [])]),
  );
  if (ancestry.size === 0) return [];
  return [scope.destinationName, ...(scope.administrative?.aliases ?? [])]
    .flatMap((name) => directory.named(name))
    .filter((entry) => !selected.includes(entry.id) && ancestry.has(entry.id))
    .map((entry) => entry.id);
}

export function buildTripScopeOverlay(input: BuildOverlayInput): TripScopeOverlay {
  const directory = DivisionDirectory.from(input.records);
  const chains = namedDivisionChains(input.records);
  const resolved = resolveScopeEvidence(input.scope, directory);
  const scopeEvidence = input.scopeEvidence
    ? mergeGeographicEvidence(resolved, { ...EMPTY_GEOGRAPHIC_EVIDENCE, ...input.scopeEvidence })
    : resolved;

  const resolvedContext = scopeContainmentContext({
    scope: input.scope,
    evidence: scopeEvidence,
    directory,
    ...(input.includedAreas ? { includedAreas: input.includedAreas } : {}),
    ...(input.boundaryEvidence ? { boundaryEvidence: input.boundaryEvidence } : {}),
  });

  /*
   * The destination's own division identity, where the scope was told it.
   *
   * `selectedDivisionIds` is "the identifiers of the division the destination
   * **is**", and `scope.administrative.divisionIds` is that same fact as the
   * destination index published it — the one source that does not have to
   * rediscover the destination from a pack that may not have retained it.
   * `selectDivisions` derives its answer from the directory alone and never
   * looks at the declared value, so a scope that knows exactly which division it
   * is was being made to prove it again from a capped divisions layer, and
   * failing.
   *
   * Unioned rather than preferred: both are statements about the same
   * destination, and a catalogue publishing a metropolis at two levels means
   * neither reading is the whole of it.
   */
  const declared = input.scope.administrative?.divisionIds ?? [];
  const identity = [
    ...new Set([
      ...resolvedContext.selectedDivisionIds,
      ...declared,
      ...sameNamedAncestors(input.scope, directory, [
        ...resolvedContext.selectedDivisionIds,
        ...declared,
      ]),
    ]),
  ];
  const context =
    identity.length === resolvedContext.selectedDivisionIds.length
      ? resolvedContext
      : { ...resolvedContext, selectedDivisionIds: identity };

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
    input.records.map((record) => subjectFor(record, chains)),
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
 *
 * `chains` is the ancestry the pack's own divisions publish for the locality
 * this record gives as its address (see `namedDivisionChains`). A place record
 * from a commercial catalogue carries an address and no identifiers at all —
 * 3,467 of the Tokyo pack's 3,787 records publish an empty chain — so without
 * this the strongest membership rung there is has nothing to compare and the
 * record falls to `membership_unknown` however well the destination is known.
 */
export function subjectFor(
  record: SourceRecord,
  chains?: ReadonlyMap<string, readonly string[]>,
): MembershipSubject & { id: string } {
  const typed = (record as SourceRecord & { geography?: GeographicEvidence }).geography;
  const locality = record.containment.localityName;
  const recovered = locality ? chains?.get(normaliseGeographicName(locality)) : undefined;
  const evidence = recovered
    ? mergeGeographicEvidence(typed ?? typedEvidenceFrom({ ...record.containment }), {
        ...EMPTY_GEOGRAPHIC_EVIDENCE,
        divisionIds: [...recovered],
      })
    : typed;
  return {
    id: record.id,
    coordinates: record.coordinates,
    ...(record.bounds ? { bounds: record.bounds } : {}),
    ...(evidence ? { evidence } : {}),
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
