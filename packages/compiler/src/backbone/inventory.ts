import {
  assessPlaceStanding,
  attributesExpectVisitors,
  authorityPageNamesSubject,
  composeExperienceSignificance,
  EXPERIENCE_CREDIBILITY_FLOOR,
  experienceSignificanceOf,
  hasLocalPlaceAttestation,
  foldForMatch,
  hasConferredDesignation,
  hasSignificanceEvidence,
  isAuthorityPublishedSite,
  isLatinScript,
  licence,
  parseOsmOpeningHours,
  PLACE_CATEGORY_LABELS,
  resolveRecordDisplayName,
  type CandidateLink,
  type ConfidenceSignal,
  type DataLicence,
  type FoodVenue,
  type GeographicScope,
  type LicenceId,
  type Place,
  type PlaceStanding,
  type PlanningRole,
  type ProviderRef,
  type RegionPack,
  type SourceRecord,
  VISITABLE_ROLES,
  placeInclusionTag,
  placeRoleTag,
  standingFields,
} from '@sidequest/core';
import { haversineKm } from '@sidequest/geo';
import { normalizeName } from '../dedupe';
import type { DiscoveredCandidate } from '../providers';
import { assessRecordEligibility, type CandidateEligibility } from './eligibility';
import { DivisionDirectory, withContainmentDecision } from './containment';
import { identityGroundVerdict } from './identity-ground';
import { collapseComponentIds, metresBetween, namesFromCollapsedTwins, supersededRecordIds } from './link';
import { buildTripScopeOverlay, decisionFor, type TripScopeOverlay } from './overlay';
import { classifySourceCategory, isProtectedAreaKind, type TaxonomyMatch } from './taxonomy';
import {
  admitByScope,
  areaOfRecord,
  assessVisitableSupply,
  balanceAcrossAreas,
  DEFAULT_BALANCE,
  hasMinimumIdentity,
  RejectionLedger,
  ROLE_QUOTA_SHARE,
  scopeRelationshipOf,
  VISITABLE_SLOTS,
  type BalanceDiagnostics,
  type InclusionReason,
  type PortfolioRejection,
  type PortfolioSlot,
  type RejectionCount,
  type RoleEligibility,
  type ScopeAdmission,
  type VisitableSupplyVerdict,
} from './balance';

/**
 * FROM A REGION PACK TO THINGS THE COMPILER CAN PLAN AROUND.
 *
 * This is where a normalised source record becomes a `Place`, and it is
 * deliberately the only place that conversion happens. Two consequences follow,
 * and both are the point:
 *
 * **No model call.** Category, interests, duration, intensity, exposure and cost
 * band all come from the source's own taxonomy through a lookup table. The
 * previous version asked a language model to classify every candidate in a
 * batched request that was the largest fixed cost in a compilation and that
 * timed out on the dense city it mattered most for. A controlled global
 * vocabulary does not need a model to be read.
 *
 * **No invented evidence.** Everything a `Place` requires and a source did not
 * supply resolves to the conservative value — `unknown` hours, `none` closure
 * risk, `moderate` parking — and the honest ones are visible to the quality
 * assessor as an absence rather than as a default it cannot tell from a fact.
 *
 * The corroboration rule from the research note is enforced here: several
 * upstream contributors *inside one conflated record* are not several sources.
 * `multiple_providers_agree` is emitted only when two records **from different
 * layers** were linked, because that is two catalogues finding the same thing.
 */

export interface InventoryLimits {
  /**
   * Hard ceiling on the things a traveller chooses between.
   *
   * One number across `attraction`, `outdoor`, `side_quest` and `market` rather
   * than four, because the split between them is a property of the region and
   * not a target: a coastal region is mostly outdoor and a capital is mostly
   * attractions, and four fixed ceilings would import a judgement about which
   * kind of place a destination ought to be. `ROLE_QUOTA_SHARE` divides it.
   */
  maxAttractions: number;
  /** Hard ceiling on support stops — the grocery, the visitor centre. */
  maxSupport: number;
  /** Hard ceiling on gateways: how you get in, and where a base can go. */
  maxGateways: number;
  maxFoodVenues: number;
  /**
   * How many candidates any one category may contribute before the rest are
   * held back.
   *
   * Density control, not taste. A dense scope returns four hundred historic
   * plaques and eleven museums, and a board built from the top of that list by
   * score alone is a board of plaques. Held-back candidates are counted, not
   * discarded silently.
   */
  maxPerCategory: number;
  /**
   * The largest share of a role's quota one geographic area may hold.
   *
   * See `balance.ts`. This is the number that stops a country being planned as
   * its largest city.
   */
  maxAreaShare: number;
}

export const DEFAULT_INVENTORY_LIMITS: InventoryLimits = {
  maxAttractions: 140,
  maxSupport: 25,
  maxGateways: 12,
  maxFoodVenues: 60,
  maxPerCategory: 22,
  maxAreaShare: DEFAULT_BALANCE.maxAreaShare,
};

/**
 * How many records sharing one knowledge-base identity turn "evidence about a
 * place" into "evidence about a shared entity". Two is a record and its twin
 * in another layer — one place said twice, the cross-layer transfer's own
 * case. Three and beyond is a value *stamped* across a set, and on measured
 * packs that population is rail lines, rivers and canals published in
 * segments, every one wearing the whole feature's article.
 */
export const SHARED_IDENTITY_FANOUT = 3;

/**
 * The seats one evidence-gated kind may hold when its records' layer cannot
 * carry the witness at all. A bound, not a quota to fill: enough for the kind
 * to be represented on a board beside the witnessed records, and small enough
 * that a class nobody can verify — a metropolis holds hundreds of worship
 * buildings and "historic sites" in exactly this position — cannot colonise a
 * role's pool on the strength of a channel outage.
 */
export const UNWITNESSED_KIND_SEATS = 3;

/**
 * The marker a degraded admission carries, in the tag channel every artifact
 * boundary already preserves. It states the cause, not a defect of the place:
 * the kind asks for significance evidence, the channel that could have
 * supplied it was structurally silent for this record's layer, and nothing
 * else vouched. Downstream layers read it to keep such a card out of any
 * classic seat and out of any automatic preselection — an unverified place is
 * offered, never sold.
 */
export const WITNESS_CHANNEL_SILENT_TAG = 'witness:channel_silent';

/**
 * The pool an evidence-gated record competes in when its witness channel was
 * silent: the taxonomy key that demanded the witness. The key, not the leaf,
 * so a catalogue's several spellings of one gated kind share one bound — and
 * the source's own leaf where no key exists, which no gated rule currently
 * produces and which fails safe into a per-leaf bound if one ever does.
 */
function witnessKindKeyOf(sourceCategory: string, taxonomy: { match: TaxonomyMatch }): string {
  return taxonomy.match.kind === 'no_recognised_category' ? sourceCategory : taxonomy.match.key;
}

/**
 * What a pool of one kind holds, and where it holds it.
 *
 * Per slot rather than one merged number, because the whole point of the
 * portfolio is that a shortage of attractions is not repaired by a surplus of
 * car parks. `byArea` is per pool for the same reason: "attractions by region"
 * and "support by region" are different measurements and a single spread figure
 * over both would be dominated by whichever the source happens to catalogue
 * densely.
 */
export interface PortfolioPool {
  slot: PortfolioSlot;
  role: PlanningRole;
  /** How many records were eligible for this slot before any quota. */
  available: number;
  kept: number;
  byArea: { areaId: string; kept: number; available: number }[];
  concentration: number;
  areaCapRelaxed: boolean;
}

/**
 * Every candidate the pack yielded, separated by the part it can play.
 *
 * The separation is the fix. Before it, `buildInventory` returned one
 * `candidates` array holding attractions, practical stops and airports
 * concatenated, and every consumer down to the board treated the whole of it as
 * things to do — which is how an international airport and two tour operators
 * became discovery cards. A caller now has to *ask* for supporting records by
 * name, and the type will not hand them over by accident.
 */
export interface CandidatePortfolio {
  pools: PortfolioPool[];
  /** Every refusal, by reason, so a thin board can explain itself. */
  rejected: RejectionCount[];
  /** Admitted records by why they were admitted. */
  inclusion: { reason: InclusionReason; count: number }[];
  /** How many admitted records nobody could establish membership for. */
  membershipUnverified: number;
  /**
   * Evidence-gated records admitted through the outage-aware degradation:
   * their kind demanded a witness, their layer publishes the witness channel
   * for nothing, and another layer proved the channel exists. Each carries
   * `WITNESS_CHANNEL_SILENT_TAG`. Reported so a board built over a silent
   * layer can say how much of itself is unverified rather than implying the
   * ground is thin.
   */
  unwitnessedAdmissions: number;
  /**
   * Attractions kept as discoveries because we could not place them well enough
   * to build a day around them.
   *
   * Reported rather than absorbed. This number used to be the size of a silent
   * deletion — every one of these was refused outright, which turned a gap in
   * our geography into an apparent absence of anything to do. A board that is
   * short on anchors and long on discoveries is a specific, explainable state,
   * and readiness reads this to say so.
   */
  anchorDemotions: number;
  /** Counting attractions apart from infrastructure, and the shortfall. */
  supply: VisitableSupplyVerdict;
}

export interface InventoryResult {
  /**
   * Things to do, and **only** things to do.
   *
   * Narrowed from "everything the pack yielded" deliberately, and the narrowing
   * is the defect fix rather than a tidy-up: this array is what becomes
   * `region.places`, the provisional board and the discovery board, and while it
   * carried gateways and practical stops there was no layer whose job it was to
   * take them out again.
   */
  candidates: DiscoveredCandidate[];
  /**
   * Practical stops and gateways, kept and addressed by name.
   *
   * Kept because they are real, useful geography that a day plan and a base
   * portfolio legitimately want, and separate because neither of those is a
   * discovery board. Every entry carries its role as a tag, so a consumer that
   * merges the two arrays still cannot present one as the other.
   */
  supporting: DiscoveredCandidate[];
  /** Records the food layer should turn into venues. Never `Place`s. */
  foodRecords: SourceRecord[];
  licences: DataLicence[];
  portfolio: CandidatePortfolio;
  diagnostics: {
    recordsConsidered: number;
    superseded: number;
    excludedByRole: number;
    heldBackByCategoryCap: number;
    /** Held back because their area had already taken its share. */
    heldBackByAreaCap: number;
    attractions: number;
    support: number;
    food: number;
    /**
     * What was kept, by planning role.
     *
     * The counts a supply verdict and a destination profile are built from. One
     * `attractions` number could not distinguish a city of museums from a coast
     * of beaches, and both were being described with the same sentence.
     */
    byRole: { role: PlanningRole; kept: number }[];
    /** How many candidates came from each area, so a concentration is visible. */
    byArea: { areaId: string; kept: number; available: number }[];
    /** Share of what was kept sitting in the single densest area. 0–1. */
    concentration: number;
    /** True when every other area ran dry, so the concentration is the region's. */
    areaCapRelaxed: boolean;
    /** How many attractions came from each layer, so thinness can be located. */
    byLayer: { layerId: string; kept: number }[];
    /**
     * What the knowledge-base channel actually reached, over the whole pack.
     *
     * Reported because it was previously impossible to see, and what it shows is
     * not a detail: on a real Osaka pack **15 of 1,840** place records carry any
     * significance evidence at all, and the knowledge-base channel supplies none
     * of it because the source layer publishes no identifier. A board built from
     * that is not ranking obscure places against famous ones — it is ranking
     * places nobody asked the question about.
     */
    knowledgeBase: KnowledgeBaseDiagnostics;
  };
}

/**
 * A record's role, from **one** source of truth.
 *
 * The pack carries a `planningRole` written when it was built, and the taxonomy
 * can compute one now. Reading both is how this file briefly lost twenty-two
 * parks: a fixture whose stored role said `attraction` was bucketed as one and
 * then ordered by a recomputed role that said `outdoor`, so the records fell
 * between the two and out of the inventory entirely.
 *
 * Recomputing is also the migration story. A pack built before the role split
 * has every candidate stored as `attraction`, because that was the only positive
 * role there was. Classifying at read time means those packs gain the split
 * without being rebuilt — the pack is immutable and its bytes do not change;
 * what changes is what we now understand them to say.
 *
 * The pack's own verdict still wins where it is a **refusal**. The normaliser
 * knows things the category table cannot: chiefly that the source marked a
 * record permanently closed, which is a fact about the world rather than about
 * its category.
 */
function roleOfRecord(record: SourceRecord): PlanningRole {
  if (
    record.planningRole === 'excluded' ||
    record.planningRole === 'administrative' ||
    record.planningRole === 'infrastructure'
  ) {
    return record.planningRole;
  }
  return classifySourceCategory({
    category: record.sourceCategory,
    path: record.sourceCategoryPath,
  }).role;
}

/**
 * The role decision, and where it came from.
 *
 * A seam, and an intentional one. `eligibility.ts` owns the decision — role,
 * confidence, basis and per-portfolio permission, from the source's own
 * vocabulary and the record's own status, before anything is ranked. This file
 * must not hold a second opinion about any of it; what it does is translate
 * those permissions into the pools it balances, and count what was refused.
 *
 * Injectable so a test can drive admission with a role the taxonomy would never
 * produce, and so the two layers can be exercised apart.
 */
export type EligibilityResolver = (
  record: SourceRecord,
  witness?: { placeAttested?: boolean },
) => RoleEligibility;

/**
 * From the six functional permissions to the five pools this file balances.
 *
 * The two vocabularies answer different questions and are deliberately not
 * merged: `attractionPortfolio` says *may this be counted as something to do*,
 * and `anchor` versus `discovery` says *which list does it compete in*. The tier
 * comes from the candidate role, which already carries it — a side quest is
 * defined by not being able to hold a day, so it can never land in the anchor
 * pool however well catalogued it is.
 */
function slotsFromPermissions(assessment: CandidateEligibility): PortfolioSlot[] {
  const slots: PortfolioSlot[] = [];
  if (assessment.eligibility.attractionPortfolio) {
    slots.push(assessment.role === 'side_quest' ? 'discovery' : 'anchor');
  }
  if (assessment.eligibility.foodPortfolio) slots.push('food');
  if (assessment.role === 'gateway') slots.push('gateway');
  else if (assessment.eligibility.supportPortfolio && assessment.role !== 'food') {
    /*
     * A restaurant is support in the permission table — it is routed, and it is
     * scheduled — and it is not a *practical stop*. Filing it here would put a
     * hundred kitchens in a pool sized for the grocery and the visitor centre,
     * and the food planner would then find them missing from its own.
     */
    slots.push('support');
  }
  return slots;
}

/** The classifier's refusals, mapped onto this file's reasons without inventing any. */
function rejectionFor(role: string | undefined): PortfolioRejection {
  switch (role) {
    case 'duplicate':
      return 'superseded_duplicate';
    case 'permanently_closed':
      return 'permanently_closed';
    case 'insufficient_identity':
      return 'identity_too_thin';
    default:
      return 'role_not_planned';
  }
}

export const DEFAULT_ELIGIBILITY: EligibilityResolver = (record, witness) => {
  const assessment = assessRecordEligibility(
    record,
    witness?.placeAttested !== undefined ? { placeAttested: witness.placeAttested } : undefined,
  );
  return {
    role: assessment.planningRole,
    confidence: assessment.roleConfidence,
    basis: assessment.roleBasis.decidedBy,
    eligibleFor: slotsFromPermissions(assessment),
    /*
     * The fine-grained role, carried through so the refusal reason is the one
     * the deciding layer gave rather than one this file guessed from a coarser
     * value. `permanently_closed` and `insufficient_identity` both collapse to
     * `excluded` in the pack vocabulary, and reporting them as the same thing
     * would lose the only part a traveller could act on.
     */
    candidateRole: assessment.role,
  };
};

export function buildInventory(input: {
  pack: RegionPack;
  scope: GeographicScope;
  limits?: Partial<InventoryLimits>;
  /** Defaults to the taxonomy table. See `EligibilityResolver`. */
  eligibility?: EligibilityResolver;
  /**
   * The trip-scope overlay. Built here when a caller does not supply one.
   *
   * Passing it matters when the trip has a regional expansion: `includedAreas`
   * is what makes `regional_expansion_member` and `optional_satellite`
   * producible at all, and expansion runs after the pack build, so only a caller
   * that has both can hand over an overlay that knows about them.
   */
  overlay?: TripScopeOverlay;
  /**
   * Names the traveller asked for, unfolded. Ranked first among records that
   * already qualified; see `rank`.
   */
  prioritizeNames?: readonly string[];
}): InventoryResult {
  const limits = { ...DEFAULT_INVENTORY_LIMITS, ...input.limits };
  const prioritized: ReadonlySet<string> =
    input.prioritizeNames && input.prioritizeNames.length > 0
      ? new Set(input.prioritizeNames.map(foldForMatch).filter((value) => value.length > 0))
      : EMPTY_PRIORITY;
  const resolveEligibility = input.eligibility ?? DEFAULT_ELIGIBILITY;
  const rawRecords = input.pack.layers.flatMap((layer) => layer.records);
  const superseded = supersededRecordIds(rawRecords, input.pack.links);
  /*
   * Membership travels with the entity, not with whichever record survived.
   *
   * A collapse survivor that publishes an address with no division evidence
   * fell to `membership_unknown` while the superseded twin the linker had
   * just proven is the same entity carried the division chain — so a landmark
   * lost the anchor slot to a gap in one catalogue's addressing. Where the
   * entity stands is a statement about the entity; see
   * `carryMembershipToCollapseSurvivors`.
   */
  const placedRecords = carryMembershipToCollapseSurvivors(
    rawRecords,
    input.pack.links,
    superseded,
  );

  /*
   * THE GATE.
   *
   * Every record entering the inventory carries a containment decision made
   * against *this* trip's scope, and it is made here rather than inherited from
   * the pack. A pack is shared ground; a verdict is one traveller's. Building
   * the overlay unconditionally — rather than reading a field a pack might carry
   * — is what makes it impossible for a source adapter, a fallback branch or a
   * warm cache row to hand a candidate downstream without a verdict.
   *
   * A record whose decision is missing is `membership_unknown`, which reaches a
   * provisional board and reaches neither a final attraction slot nor the
   * planner. Fail-closed, so a forgotten path is a thin board rather than a
   * wrong one.
   */
  const overlay =
    input.overlay ??
    buildTripScopeOverlay({
      scope: input.scope,
      records: placedRecords,
      roleEligible: (record) => resolveEligibility(record).eligibleFor.length > 0,
    });
  const records = placedRecords.map((record) =>
    withContainmentDecision(record, decisionFor(overlay, record.id)),
  );

  const crossLayer = crossLayerCorroboration(records, input.pack.links);
  /*
   * The region-namesake channel, from both of its honest sources: the
   * administrative geography wearing a record's name, and the ground's own
   * namesakes — other records named after the place, counted with the same
   * guards the retention channel applies (`groundNamesakeAttestations`). One
   * channel, `region_namesake`: it raises a standing and can never open the
   * witness gate, so it orders seats without repealing any admission rule.
   */
  const namesakes = regionNamesakes(input.pack);
  const groundVerdict = groundNamesakeWitnesses(records);
  const groundAttested = groundVerdict.attested;
  /*
   * Attestation survives the collapse, exactly as evidence and names do: the
   * ground very often names the *polygon* twin — the record carrying the
   * boundary its witnesses stand inside — while the collapse keeps the place
   * record. A statement about any member of a component the linker has proven
   * is one entity is a statement about its survivor.
   */
  carryMarksToCollapseSurvivors({
    records,
    links: input.pack.links,
    superseded,
    marked: groundAttested,
  });
  /*
   * The grade travels with the mark: the survivor of a proven component
   * speaks with its loudest member's witness count, never a lower one — the
   * headline theme park's polygon twin holds the precinct, the place record
   * won the collapse, and the bound's ground door reads the count.
   */
  const groundWitnessCounts = new Map(groundVerdict.witnessesByTarget);
  const groundPrecinctCounts = new Map(groundVerdict.precinctByTarget);
  for (const memberIds of collapseComponentsOf(records, input.pack.links)) {
    const survivorId = memberIds.find((id) => !superseded.has(id));
    if (survivorId === undefined) continue;
    const loudest = Math.max(0, ...memberIds.map((id) => groundVerdict.witnessesByTarget.get(id) ?? 0));
    if (loudest > (groundWitnessCounts.get(survivorId) ?? 0)) {
      groundWitnessCounts.set(survivorId, loudest);
    }
    const loudestRing = Math.max(
      0,
      ...memberIds.map((id) => groundVerdict.precinctByTarget.get(id) ?? 0),
    );
    if (loudestRing > (groundPrecinctCounts.get(survivorId) ?? 0)) {
      groundPrecinctCounts.set(survivorId, loudestRing);
    }
  }
  const groundWitnessCountOf = (record: SourceRecord): number =>
    groundWitnessCounts.get(record.id) ?? 0;
  const groundPrecinctCountOf = (record: SourceRecord): number =>
    groundPrecinctCounts.get(record.id) ?? 0;
  const namedInRegion = (record: SourceRecord): boolean =>
    namesakes.has(record.id) || groundAttested.has(record.id);
  /*
   * The names the collapse above would otherwise take with it.
   *
   * Computed here rather than inside `toCandidate` because it is a pack-wide
   * fact a lone record cannot see — the same reason `namesakes` and the
   * knowledge-base evidence are computed here. See `namesFromCollapsedTwins`.
   */
  const inheritedNames = namesFromCollapsedTwins(records, input.pack.links);

  /*
   * ONE STANDING, ONE SIGNIFICANCE, PER RECORD — computed here because two of
   * its channels (cross-layer corroboration, the region's own namesakes) are
   * pack-wide facts a lone record cannot see. Cached because the ranking below
   * asks repeatedly and the answer cannot change inside one build.
   */
  const classifyCache = new Map<string, ReturnType<typeof classifySourceCategory>>();
  const taxonomyOf = (record: SourceRecord) => {
    const cached = classifyCache.get(record.id);
    if (cached) return cached;
    const taxonomy = classifySourceCategory({
      category: record.sourceCategory,
      path: record.sourceCategoryPath,
      attributes: record.attributes,
    });
    classifyCache.set(record.id, taxonomy);
    return taxonomy;
  };

  /*
   * Knowledge-base evidence, resolved across layers before anything is scored.
   *
   * A third pack-wide channel, and the one the model was structurally blind on:
   * the primary place layer publishes no knowledge-base identifier at all, so
   * `record.wikidataId !== undefined` was a constant `false` for every record a
   * board is built from. See `resolveKnowledgeBaseEvidence` for the measurement
   * and for why the twin match requires name, kind and geometry together.
   *
   * `taxonomyOf(...).subrole` is the kind test rather than a second opinion
   * written here — the same archetype the eligibility and ranking layers read,
   * so a record cannot be one kind of thing for admission and another for
   * evidence.
   */
  const knowledgeBase = resolveKnowledgeBaseEvidence(
    records,
    (record) => taxonomyOf(record).subrole,
  );
  /*
   * Evidence survives the collapse, exactly as names do.
   *
   * The linker's components and the evidence resolution used to be blind to
   * each other, and the intersection deleted a headline attraction: on the live
   * Tokyo pack the land-use record of a famous theme park carries the knowledge
   * base entry *and* the encyclopaedia article, the transfer's one-recipient
   * rule handed both to the nearest same-named place record — and the collapse
   * then kept a *different* twin of the same component as the survivor, so the
   * entity the linker had just proven famous entered ranking with no evidence
   * at all and died in the tie-band. See `carryEvidenceToCollapseSurvivors`.
   */
  carryEvidenceToCollapseSurvivors({
    records,
    links: input.pack.links,
    superseded,
    evidence: knowledgeBase,
  });
  const knowledgeBaseOf = (record: SourceRecord): KnowledgeBaseEvidence =>
    knowledgeBase.get(record.id) ?? UNOBSERVABLE;

  /*
   * OPERATIONAL VISIT EVIDENCE IS AN ENTITY FACT, AND SO IS A HAZARD.
   *
   * Both survive the collapse on the same precedent as evidence, names and
   * membership. A famous park's polygon twin carries the posted hours and the
   * place record wins the collapse — the entity has hours whichever record
   * survived, and the witness bound's operational door must hear them. In the
   * other direction a glacier tongue's land twin says `natural=glacier` while
   * the survivor is a tour lister's `national_park` filing — the entity is a
   * hazardous approach whichever record survived, and the approach-hazard
   * gate must hear that too. Marks only ever spread from members to their
   * proven survivor; nothing is invented.
   */
  const visitorsExpectedIds = new Set<string>();
  const hazardEvidencedIds = new Set<string>();
  for (const record of records) {
    if (recordExpectsVisitors(record)) visitorsExpectedIds.add(record.id);
    if (taxonomyOf(record).hazardousAccess) hazardEvidencedIds.add(record.id);
  }
  carryMarksToCollapseSurvivors({
    records,
    links: input.pack.links,
    superseded,
    marked: visitorsExpectedIds,
  });
  carryMarksToCollapseSurvivors({
    records,
    links: input.pack.links,
    superseded,
    marked: hazardEvidencedIds,
  });
  const visitorsExpected = (record: SourceRecord): boolean =>
    visitorsExpectedIds.has(record.id);
  const hazardousApproach = (record: SourceRecord): boolean =>
    hazardEvidencedIds.has(record.id);

  const standingWith = (
    record: SourceRecord,
    publishedSites: readonly string[],
    /** Overridable so the witness view below can narrow it. Defaults to the pack's answer. */
    knowledge: KnowledgeBaseEvidence = knowledgeBaseOf(record),
  ): PlaceStanding => {
    return assessPlaceStanding({
      ...(knowledge.inKnowledgeBase !== undefined
        ? { inKnowledgeBase: knowledge.inKnowledgeBase }
        : {}),
      ...(knowledge.encyclopaedicArticle !== undefined
        ? { encyclopaedicArticle: knowledge.encyclopaedicArticle }
        : {}),
      knowledgeBaseNameCount: record.alternateNames.length,
      crossDatasetCorroboration: crossLayer.has(record.id),
      publishedSites,
      subjectName: record.name,
      classifyingValues: classifyingValuesOf(record),
      ...designatedExtentOf(record),
      /*
       * The naming statement, in both of its graded forms: the administrative
       * geography wearing the name, and the ground's own guarded witnesses
       * with their count. `assessPlaceStanding` reads the stronger one — the
       * split is what lets the witness bound's ground door see the grade
       * while a division namesake stays exactly what it was.
       */
      namedInRegionRecords: namedInRegion(record),
      groundWitnessCount: groundWitnessCountOf(record),
      recordedAttributeCount: Object.keys(record.attributes).length,
    });
  };
  /*
   * The ordering's standing. Same evidence, two exclusions, both of the same
   * shape — a statement that is not about *this record* may not order seats:
   *
   * - a government page that does not name the subject attests the operator
   *   (`subjectAddressedSites`), and the operator may not order seats;
   * - a knowledge-base identity fanned across `SHARED_IDENTITY_FANOUT`-or-more
   *   records attests the shared entity (`narrowedKnowledgeOf`), and on the
   *   stored dense-metro packs it was the whole of a tie band: canal and rail
   *   segments wearing one line's article ranked 0.61 beside — and, under a
   *   binding quota, *ahead of* — every genuinely-noted park, because the cut
   *   under a tie is a UUID lottery. The witness gate was already deaf to a
   *   fanned identity; the ordering and the stamped ranking fields now are
   *   too. The card's own standing (assessed inside `toCandidate`) keeps the
   *   operator channel for its trust line, where who runs a place is prose,
   *   not a rank.
   */
  const seatStandingOf = (record: SourceRecord): PlaceStanding =>
    standingWith(record, subjectAddressedSites(record), seatKnowledgeOf(record));
  const significanceCache = new Map<string, number>();
  const significanceOf = (record: SourceRecord): number => {
    const cached = significanceCache.get(record.id);
    if (cached !== undefined) return cached;
    const taxonomy = taxonomyOf(record);
    /*
     * The branch rescue's own witness, heard once for both of its effects:
     * the weight lift and the bound. Computed lazily — only a branch match
     * ever asks.
     */
    const branchRescued =
      taxonomy.match.kind === 'source_branch' &&
      hasSignificanceEvidence(witnessStandingOf(record));
    const value = experienceSignificanceOf({
      standing: seatStandingOf(record),
      /*
       * A witnessed branch match ranks at the unweighted-visitable floor.
       *
       * The branch-rescue admission (`attractionRole`) already ruled that a
       * place-attested record whose source named only a family is real and
       * vouched for — and then this ordering ranked it at the unrecognised
       * fragment's prior (0.15), so the admission was a seat that could never
       * be sat in: a destination's famous canal district reached `discovery`
       * through the rescue and composed 0.1. The witness converts
       * "unrecognised ground" into "a named place the world describes", and
       * the taxonomy's own convention for a visitable kind nobody weighted is
       * exactly `EXPERIENCE_CREDIBILITY_FLOOR`. Never below the rule's own
       * weight, and only where the same witness the rescue heard fired.
       */
      categoryWeight: attestedKindWeight(taxonomy, () => branchRescued),
      /*
       * The witness bound, wired where the seats are ordered. The gate below
       * still hears the witness in full — this changes what the gate's own
       * evidence is *worth as a rank* for the kinds that needed it, and only
       * where nothing operational says visitors are expected. See
       * `composeExperienceSignificance`.
       */
      /*
       * Landscape claims are witness-bounded too: a mapped outline admits a
       * mountain honestly, and an encyclopaedic entry — minted for every
       * named rise — must still not buy its seat without a designation or an
       * operator. Bound only; the admission gate for these stays the extent
       * plausibility test.
       */
      /*
       * A branch-rescued record is not double-locked. The unrecognised-
       * geography archetype demands a witness so a bare family word cannot be
       * offered; the rescue admits only records the wider world attests, and
       * bounding those on the same statement would make the rescue a seat
       * that can never be sat in twice over — the archetype has no leaf claim
       * for encyclopaedic notice to inflate, and its weight is the floor.
       */
      witnessRequired:
        (taxonomy.requiresSignificanceEvidence || taxonomy.landscapeClaim) && !branchRescued,
      commonplaceKind: taxonomy.commonplaceNotice,
      expectsVisitors: visitorsExpected(record),
      publishedSiteAtGate: taxonomy.plausiblyGated && record.websiteCandidates.length > 0,
      /*
       * For a paid-enclosure kind the annex tier IS the statement: a theme
       * park's same-named station, hotels and ticket office exist only around
       * an operation of standing, while a municipal park accretes same-named
       * ballfields by subdivision, not by operation. So enclosure kinds read
       * the full near count and open ground reads the beyond-boundary ring.
       */
      groundPrecinctWitnesses: taxonomy.paidEnclosure
        ? groundWitnessCountOf(record)
        : groundPrecinctCountOf(record),
    });
    significanceCache.set(record.id, value);
    return value;
  };

  /*
   * ONE IDENTIFIER ON MANY RECORDS IS ONE STATEMENT — ABOUT THE SHARED ENTITY.
   *
   * A mapping convention stamps a linear feature's knowledge-base identity onto
   * every constituent way: on the live Tokyo pack one freight line's article
   * sat on 25 separate "bridge" records, and after the fragment fold a single
   * survivor walked through the witness gate as an evidenced viewpoint and took
   * a classics seat — the article attests the *line*, and a line is a journey,
   * not a stop. So for the witness's purposes, an identifier or article whose
   * value fans out across `SHARED_IDENTITY_FANOUT`-or-more records vouches for
   * none of them individually. A pair stays untouched — a record and its twin
   * in another layer are one place said twice, which is the cross-layer
   * transfer's own precedent ("one identifier reaches at most one record").
   * Suppressed per channel, not per record: a crossing with its own unique
   * entry beside a fanned-out article keeps the entry's witness.
   *
   * The narrowing reaches the witness gates, the seat ordering, and the
   * ranking fields stamped onto a candidate — every consumer that decides who
   * is offered and in what order. A rank built on a fanned identity is a seat
   * taken on somebody else's name, which is how segment tie bands flushed
   * genuinely-noted canon under every binding quota on the stored dense-metro
   * packs. A narrowed channel is absent, never `false`: nothing here claims
   * the world has not noticed the shared entity.
   */
  const fannedIdentifiers = new Map<string, number>();
  const fannedArticles = new Map<string, number>();
  for (const record of records) {
    if (record.wikidataId !== undefined) {
      fannedIdentifiers.set(record.wikidataId, (fannedIdentifiers.get(record.wikidataId) ?? 0) + 1);
    }
    const article = record.attributes.wikipedia;
    if (article !== undefined) {
      fannedArticles.set(article, (fannedArticles.get(article) ?? 0) + 1);
    }
  }
  /** The record's knowledge, minus any channel whose value fans across the pack. */
  const seatKnowledgeOf = (record: SourceRecord): KnowledgeBaseEvidence => {
    const knowledge = knowledgeBaseOf(record);
    const identifierShared =
      record.wikidataId !== undefined &&
      (fannedIdentifiers.get(record.wikidataId) ?? 0) >= SHARED_IDENTITY_FANOUT;
    const articleShared =
      record.attributes.wikipedia !== undefined &&
      (fannedArticles.get(record.attributes.wikipedia) ?? 0) >= SHARED_IDENTITY_FANOUT;
    if (!identifierShared && !articleShared) return knowledge;
    return {
      origin: knowledge.origin,
      ...(knowledge.fromLayerId !== undefined ? { fromLayerId: knowledge.fromLayerId } : {}),
      /* Absent, never `false`: the channel was not observed for this record. */
      ...(!identifierShared && knowledge.inKnowledgeBase !== undefined
        ? { inKnowledgeBase: knowledge.inKnowledgeBase }
        : {}),
      ...(!articleShared && knowledge.encyclopaedicArticle !== undefined
        ? { encyclopaedicArticle: knowledge.encyclopaedicArticle }
        : {}),
    };
  };
  const witnessStandingOf = (record: SourceRecord): PlaceStanding =>
    standingWith(record, record.websiteCandidates, seatKnowledgeOf(record));

  /*
   * WHERE THE WITNESS QUESTION COULD NOT BE ASKED AT ALL.
   *
   * The strongest witness channels are the knowledge-base ones, and for the
   * primary place layer of the current catalogue release they are structurally
   * silent — zero identifiers across whole metropolitan boxes, measured in the
   * block comment beside `resolveKnowledgeBaseEvidence`. A gate calibrated as
   * if every layer could answer therefore refused every place-layer temple,
   * museum and historic site in every dense city, permanently, while the
   * layers that *do* carry identifiers walked their obscura through it.
   *
   * Both clauses are load-bearing. The first is the outage: this record's
   * layer answers the question for nothing, so its silence is not an
   * observation about the place. The second is the proof the channel exists at
   * all: some *other* layer in this pack does answer. A pack in which no layer
   * answers cannot tell "the catalogue has no channel" from "nobody has heard
   * of any of this", and the conservative reading — the hard refusal — stands.
   */
  const answeringLayers = new Set<string>();
  for (const record of records) {
    if (record.wikidataId !== undefined || record.attributes.wikipedia !== undefined) {
      answeringLayers.add(record.layerId);
    }
  }
  const witnessChannelSilent = (record: SourceRecord): boolean =>
    !answeringLayers.has(record.layerId) && answeringLayers.size > 0;

  /*
   * PAID ENCLOSURES, RESOLVED BEFORE ADMISSION.
   *
   * A record inside a theme park's footprint is part of the theme park: a live
   * board offered an island inside one as a free easy walk, to a traveller who
   * had excluded theme parks. The span guard refuses oversized bounds — a bad
   * polygon covering half a city must not swallow the city.
   */
  /*
   * AN ENCLOSURE MUST NEVER ABSORB THE SURVIVOR OF ITS OWN COMPONENT.
   *
   * The linker says a theme park's gate POI and its own grounds polygon are
   * one entity and elects the POI as survivor; the polygon is superseded; and
   * this list then offered the superseded polygon as an *absorber*, so the
   * survivor was refused `inside_paid_enclosure` against its own corpse and
   * the destination lost the attraction entirely — a canonical itinerary
   * anchor on a live anti-overfit metro build, to an intersection of two
   * individually-correct rules (the same collapse-blindness class
   * `carryEvidenceToCollapseSurvivors` and `foldAdjacentFragments` already
   * guard against). The polygon's *ground* is still real, though: the rides
   * inside it are inside it whether or not the polygon record won the
   * collapse, so a superseded enclosure keeps absorbing strangers and is
   * barred only from its own component — see `enclosureContaining`.
   */
  const enclosureComponentOf = collapseComponentIds(records, input.pack.links);
  const enclosures = records.filter((record) => {
    if (!record.bounds || !taxonomyOf(record).paidEnclosure) return false;
    const latSpan = record.bounds.northEast.lat - record.bounds.southWest.lat;
    const lngSpan = record.bounds.northEast.lng - record.bounds.southWest.lng;
    return latSpan > 0 && lngSpan > 0 && latSpan <= 0.06 && lngSpan <= 0.08;
  });
  /**
   * The smallest mapped ground allowed to absorb a record of an enclosure
   * kind, and how much larger than that record it must be. See
   * `enclosureContaining`: the floor is the same order as a real park's
   * shortest side and three orders above a ride's bounding box, and the ratio
   * makes "larger" unambiguous where two attractions' boxes overlap.
   */
  const ENCLOSURE_ABSORB_MIN_METRES = 400;
  const ENCLOSURE_ABSORB_RATIO = 4;
  const enclosureContaining = (record: SourceRecord): SourceRecord | undefined => {
    /*
     * AN ENCLOSURE KIND IS NOT EXEMPT FROM THE FOLD — ONLY THE ENCLOSURE IS.
     *
     * This used to return `undefined` for every record whose *kind* is a paid
     * enclosure, so that a theme park could not be folded into itself. The
     * exemption was far wider than its reason: a global catalogue files a big
     * park's individual rides under the park's own kind — on a fresh
     * dense-metro pack, fifteen `amusement_park` records were kept of which
     * most were single rides and a ticket booth, each a metre or three of
     * mapped ground inside a park over a kilometre across. They competed as
     * free-standing attractions, filled the `town_and_food` category cap to
     * exactly its limit, and pushed real neighbourhoods and the park's own
     * best-evidenced record's twin out of the shortlist.
     *
     * So the exemption is now the narrow true statement: an enclosure-kind
     * record is folded into a containing enclosure that is *unambiguously the
     * larger ground* — attraction-scale in its own right, and several times
     * this record's own mapped extent. Both bounds are needed: the scale floor
     * keeps one ride's metre-wide box from folding the ride beside it, and the
     * ratio keeps two adjacent same-scale parks, whose bounding boxes overlap,
     * from ever swallowing one another. A park POI twin (a point record wearing
     * the park's kind) folds into the park's own polygon, which is the record
     * carrying the boundary, the identifiers and the readable names — the
     * right survivor.
     */
    const own = taxonomyOf(record).paidEnclosure
      ? (mappedExtentMetres(record) ?? 0)
      : undefined;
    return enclosures.find(
      (enclosure) =>
        enclosure.id !== record.id &&
        (enclosureComponentOf.get(enclosure.id) === undefined ||
          enclosureComponentOf.get(enclosure.id) !== enclosureComponentOf.get(record.id)) &&
        (own === undefined ||
          (mappedExtentMetres(enclosure) ?? 0) >=
            Math.max(ENCLOSURE_ABSORB_MIN_METRES, own * ENCLOSURE_ABSORB_RATIO)) &&
        record.coordinates.lat >= enclosure.bounds!.southWest.lat &&
        record.coordinates.lat <= enclosure.bounds!.northEast.lat &&
        record.coordinates.lng >= enclosure.bounds!.southWest.lng &&
        record.coordinates.lng <= enclosure.bounds!.northEast.lng,
    );
  };

  /*
   * Adjacent fragments of one feature, folded before anything is ranked.
   *
   * The linker already folds records two catalogues agree are one entity; what
   * it cannot see is one catalogue publishing a feature in pieces — two halves
   * of the same nature forest were two board cards on a live build. Name
   * similarity plus adjacency plus same kind is the conservative version of
   * "the same place said twice", and the better-evidenced piece survives.
   */
  /*
   * Over the records the collapse kept, never over its casualties. The fold
   * used to run over every record, and where the better-evidenced fragment of
   * an adjacent pair *was* a superseded twin, the fold elected the corpse: the
   * twin was already refused as a duplicate, the survivor was then refused as
   * a fold, and the entity the linker had just consolidated vanished from
   * every pool. Three canonical landmarks on two stored dense-metro packs died
   * in exactly that intersection — the same collapse-blindness class as
   * `carryEvidenceToCollapseSurvivors`, one gate further down.
   */
  const adjacentFolds = foldAdjacentFragments(
    records.filter((record) => !superseded.has(record.id)),
    taxonomyOf,
    significanceOf,
  );

  /*
   * ADMISSION, IN A FIXED ORDER, BEFORE ANYTHING IS BALANCED.
   *
   * Each gate answers a different question and each refusal is counted with its
   * own reason, because "we found six things" and "we found six things and
   * refused four hundred that were outside the destination" are different
   * sentences and only one of them is usable.
   *
   * Nothing below this loop may re-admit a record it rejected. That is the
   * property the redistribution pass used to be able to violate: a quota that
   * went unfilled reached back into the pool, and a pool that still held
   * ineligible records would have handed them over.
   */
  const ledger = new RejectionLedger();
  const bySlot = new Map<PortfolioSlot, Map<PlanningRole, SourceRecord[]>>();
  const inclusionOf = new Map<string, InclusionReason>();
  const roleOf = new Map<string, PlanningRole>();
  const availableBySlot = new Map<PortfolioSlot, Map<PlanningRole, number>>();
  const inclusionCounts = new Map<InclusionReason, number>();
  let excludedByRole = 0;
  let membershipUnverified = 0;
  /** Attractions that could not anchor and were kept as discoveries. */
  let anchorDemotions = 0;
  /**
   * The pack's own administrative names, indexed, so a record's *name* can be
   * tested against the ground it stands on.
   *
   * Built from the same raw records the overlay builds its own from. Two
   * indexes rather than one shared instance is deliberate: the overlay's
   * directory is an input to a *membership verdict* and is constructed inside
   * it, and threading one out would make an internal of the containment layer
   * part of its signature for the sake of one caller. `DivisionDirectory.from`
   * is a single linear pass over records already in memory.
   */
  const divisions = DivisionDirectory.from(rawRecords);
  /** Records whose identity conflicts with their ground but who are vouched for. */
  const identityDowngraded = new Set<string>();
  /**
   * Evidence-gated records whose layer could not carry the witness, held for
   * the bounded pass below rather than refused outright. Keyed by the taxonomy
   * key that demanded the witness, so each gated kind competes with itself.
   */
  const unwitnessedByKind = new Map<
    string,
    { record: SourceRecord; admission: Extract<ScopeAdmission, { admitted: true }>; eligibility: RoleEligibility }[]
  >();
  /** Records admitted through the degraded path, so their cards carry the marker. */
  const witnessDegraded = new Set<string>();

  /**
   * The gates past the witness, shared verbatim by the ordinary pass and the
   * degraded one — one body, so the two admissions cannot drift. Returns
   * whether the record entered a pool; every refusal is counted inside.
   */
  const admitVetted = (
    record: SourceRecord,
    admission: Extract<ScopeAdmission, { admitted: true }>,
    eligibility: RoleEligibility,
  ): boolean => {
    const recordTaxonomy = taxonomyOf(record);
    /*
     * A MAGNITUDE TEST, NOT A PRESENCE TEST.
     *
     * This read `record.bounds === undefined`, i.e. "any polygon at all rescues
     * the claim" — and a bounding box a metre across is a point with floating
     * point noise on it. A live Tokyo board carried seven Peaks on the strength
     * of that: three road slopes and four park mounds, one of them captioned
     * "A peak. Recorded at 14 m." A mountain, a glacier, a volcano or a range
     * is *large* — that is the whole content of the claim — so the extent has
     * to be an extent, and `mappedExtentMetres` is the same hundred-metre floor
     * the description uses for the same reason.
     */
    if (
      recordTaxonomy.landscapeClaim &&
      mappedExtentMetres(record) === undefined &&
      !hasSignificanceEvidence(witnessStandingOf(record))
    ) {
      ledger.reject('implausible_landscape_claim', record.name);
      return false;
    }
    const enclosure = enclosureContaining(record);
    if (enclosure) {
      ledger.reject('inside_paid_enclosure', record.name);
      return false;
    }

    /*
     * 5e. DOES THE RECORD'S ASSERTED KIND AGREE WITH ITS OWN GROUND?
     *
     * The fourth plausibility gate, and the one whose absence put a mountain
     * gondola a hundred and fifty kilometres away, a national park eight
     * hundred, a cave nine hundred and a castle from another country onto three
     * delivered boards — each admitted on a source tag, each carrying nothing
     * but a name and a point, one of them holding a whole day. See
     * `identity-ground.ts` for what the verdict reads, why every input to it is
     * already on the record, and which comparison was built, measured and
     * removed for refusing real places.
     *
     * The consequence forks on whether *anything independent* vouches for the
     * record, because the two cases are genuinely different. A vouched-for
     * record whose ground nothing here could confirm is very often real — a
     * famous park whose catalogue row happens to be thin, a designated reserve
     * mapped as a point — and the honest response to it is not deletion but
     * demotion: it may be offered, and it may not be the reason a morning
     * exists. A record making the same claim with *no* evidence beyond its name
     * and position has nothing left to be right about, and stays out.
     *
     * Measured over the three stored packs the audited boards were built from,
     * this refuses 14, 5 and 35 records and moves no canonical-recall floor at
     * any stage.
     */
    const identity = identityGroundVerdict({
      record,
      directory: divisions,
      /*
       * Composed from three flags the taxonomy already owns, rather than from a
       * list written here: a mountain-scale landform (`landscapeClaim`), ground
       * whose approach is the hazard (`hazardousAccess` — an ice field, a lava
       * tube, a crater), and the conferred protected-area family. What the three
       * share is the only property this gate needs: none of them fits inside a
       * city neighbourhood. A list of my own would have been this bug's
       * offenders written down, which is the thing a generic rule must not be.
       */
      regionalExtentKind:
        recordTaxonomy.landscapeClaim ||
        recordTaxonomy.hazardousAccess ||
        isProtectedAreaKind({
          category: record.sourceCategory,
          path: record.sourceCategoryPath,
        }),
      mappedExtentMetres: mappedExtentMetres(record),
    });
    if (identity.kind === 'unsupported_ground_claim') {
      const vouchedFor =
        hasSignificanceEvidence(witnessStandingOf(record)) || crossLayer.has(record.id);
      if (!vouchedFor) {
        ledger.reject('identity_conflicts_with_ground', record.name);
        return false;
      }
      identityDowngraded.add(record.id);
    }

    /*
     * 6. Planning-role separation, intersected with what the scope permits.
     *
     * The intersection is where an adjacent gateway stops being a candidate: it
     * is eligible for the gateway slot by role and permitted only the gateway
     * slot by scope, so it lands in one pool and cannot reach any other. A
     * record whose role and scope permit nothing in common is refused with the
     * reason that says so rather than disappearing.
     */
    let slots = eligibility.eligibleFor.filter((slot) => admission.permits.includes(slot));

    /*
     * 6-. High-confidence admission, withheld from a contested identity.
     *
     * Before 6a rather than after it, so a record demoted here falls through
     * the same door an unplaceable attraction does and keeps its discovery
     * seat. The anchor slot is the only "high confidence" this pipeline has to
     * withhold: it is what makes a record the reason a day exists, and giving
     * four hours of a trip to a name standing somewhere it cannot be is the
     * finding this gate answers.
     */
    if (identityDowngraded.has(record.id)) {
      slots = slots.filter((slot) => slot !== 'anchor');
    }

    /*
     * 6a. An attraction we cannot place is demoted, not deleted.
     *
     * This is the single line that produced the worst board this product has
     * ever shown. `slotsFromPermissions` sends every attraction role except
     * `side_quest` to `anchor`, and `membership_unknown` permits `discovery`,
     * `food` and `support` — but not `anchor`. So wherever the divisions layer
     * could not place records, the intersection above came back empty for every
     * museum, temple, park and viewpoint, and those were all rejected as
     * `role_ineligible_for_slot` — while restaurants, shops and markets, whose
     * own slots *are* permitted, sailed through.
     *
     * The result was a Discovery Board for a major world city consisting of
     * forty-five places to eat in one outlying suburb, with nothing anywhere
     * saying that a categorical filter had been applied. A containment gap had
     * quietly become a claim about what there is to do.
     *
     * The honest reading of "we could not establish where this is" is not "this
     * is not an attraction". It is "we cannot build a day around this" — which
     * is exactly what the `anchor` slot means, and exactly what `discovery`
     * does not. So an attraction whose only refusal was the anchor slot lands in
     * the discovery pool instead, carrying its uncertainty, and the count of how
     * often that happened is reported rather than lost.
     *
     * What this does not do: it does not widen `outside_scope`, whose `permits`
     * is empty, so a record with positive evidence that it is somewhere else is
     * still refused here and is not rescued by this branch. It does not move
     * food or support into a visitable pool — those roles never asked for the
     * anchor slot. And it does not let an unplaceable record anchor a day:
     * `canAnchor` is unchanged and still requires positive membership.
     */
    if (
      eligibility.eligibleFor.includes('anchor') &&
      !slots.includes('anchor') &&
      admission.permits.includes('discovery') &&
      !slots.includes('discovery')
    ) {
      /*
       * Keyed on "lost its anchor slot", not on "lost every slot".
       *
       * The first version tested `slots.length === 0`, which closed the defect
       * for a museum and left it open for a market: a market is eligible for
       * `['anchor','food']`, so with unresolved membership it kept `['food']`,
       * was never demoted, and disappeared from the board exactly as before —
       * while still counting as somewhere to eat. One role's worth of the same
       * "the city came back as food" failure, surviving the fix for it.
       */
      slots = [...slots, 'discovery'];
      anchorDemotions += 1;
    }

    if (slots.length === 0) {
      ledger.reject('role_ineligible_for_slot', record.name);
      return false;
    }

    inclusionOf.set(record.id, admission.reason);
    roleOf.set(record.id, eligibility.role);
    inclusionCounts.set(admission.reason, (inclusionCounts.get(admission.reason) ?? 0) + 1);
    if (!admission.membershipVerified) membershipUnverified += 1;

    for (const slot of slots) {
      const roles = bySlot.get(slot) ?? new Map<PlanningRole, SourceRecord[]>();
      const bucket = roles.get(eligibility.role);
      if (bucket) bucket.push(record);
      else roles.set(eligibility.role, [record]);
      bySlot.set(slot, roles);

      const counts = availableBySlot.get(slot) ?? new Map<PlanningRole, number>();
      counts.set(eligibility.role, (counts.get(eligibility.role) ?? 0) + 1);
      availableBySlot.set(slot, counts);
    }
    return true;
  };

  for (const record of records) {
    // 1. Duplicate resolution. A superseded record is not a second candidate.
    if (superseded.has(record.id)) {
      ledger.reject('superseded_duplicate', record.name);
      continue;
    }
    // 1a. Adjacent fragments of one feature. Same refusal, found differently.
    if (adjacentFolds.has(record.id)) {
      ledger.reject('superseded_duplicate', record.name);
      continue;
    }

    // 2. Scope membership, from the strongest evidence the record carries.
    const admission = admitByScope(scopeRelationshipOf(record));
    if (!admission.admitted) {
      ledger.reject(admission.rejection, record.name);
      continue;
    }

    /*
     * 3–5. Closure, minimum identity and role eligibility, from one layer.
     *
     * All three in one call and deliberately: they are the same decision seen
     * from three angles, and splitting them across two files is how a record can
     * be refused by one and admitted by the other. `eligibility.ts` honours a
     * stated closure, refuses a row whose name is its own category, and returns
     * the permissions — this file only translates and counts.
     *
     * Closure being a *gate* rather than a rank penalty matters on its own.
     * `knownness` docks a closed record fifty points, which keeps it off a
     * crowded board and admits it to a sparse one — exactly backwards, because
     * the sparse region is where a traveller can least afford to drive to a shut
     * door.
     */
    /*
     * The witness handed over here is the full cross-layer standing — twin-
     * resolved knowledge-base entries and cross-dataset corroboration that a
     * record-local read inside `eligibility.ts` cannot see. Only place-attesting
     * channels count (`hasSignificanceEvidence`), so a landlord's asset list or
     * a namesake can never open the branch-match rescue. The overlay's earlier
     * `roleEligible` probe deliberately stays record-local: it runs before this
     * standing exists and is a conservative floor, never a promotion. Read
     * through the witness view, so an identifier a mapping convention stamped
     * across a whole linear feature cannot open the rescue either.
     */
    const eligibility = resolveEligibility(record, {
      placeAttested: hasSignificanceEvidence(witnessStandingOf(record)),
    });
    if (eligibility.eligibleFor.length === 0) {
      const rejection = rejectionFor(eligibility.candidateRole);
      if (rejection === 'role_not_planned') excludedByRole += 1;
      ledger.reject(rejection, record.name);
      continue;
    }

    /*
     * One narrowing the deciding layer cannot make, and it only ever refuses.
     *
     * That layer compares a name against the source's *leaf* category, which is
     * the right primary check. It does not see the category path, so a record
     * named after a branch — `Nature Reserve` under
     * `geographic_entities/nature_reserve` — survives it. A refinement that can
     * only reject is safe to compose; one that could promote would not be, and
     * this cannot: a record refused here is refused, never reclassified.
     */
    if (
      !hasMinimumIdentity({
        name: record.name,
        sourceCategory: record.sourceCategory,
        sourceCategoryPath: record.sourceCategoryPath,
      })
    ) {
      ledger.reject('identity_too_thin', record.name);
      continue;
    }

    /*
     * 5b–5d. THE PLAUSIBILITY GATES — category claims checked against evidence.
     *
     * Three refusals with one shape: the *category* says "offer this" and the
     * record's own evidence says the category is not enough. Each is a class
     * defect that reached a live board — a working railway viaduct as a
     * "Viewpoint", a business named after a famous distant mountain at the
     * mountain's category, an island inside a theme park as a free walk.
     * The gates read significance *evidence* (a knowledge base, a second
     * catalogue, an authority, the region's own naming) and never metadata
     * volume — a well-filled-in listing proves description, not significance.
     */
    const recordTaxonomy = taxonomyOf(record);
    /*
     * The landscape plausibility test runs before the witness gates so a
     * degenerate terrain claim is refused *as* one: a "mountain" whose outline
     * is a metre across is not a record short of a witness, it is a record
     * whose own geometry contradicts its category, and the refusal reason is
     * the sentence a coverage reader acts on. Same condition as the copy in
     * `admitVetted`, which still guards the degraded-admission path.
     */
    if (
      recordTaxonomy.landscapeClaim &&
      mappedExtentMetres(record) === undefined &&
      !hasSignificanceEvidence(witnessStandingOf(record))
    ) {
      ledger.reject('implausible_landscape_claim', record.name);
      continue;
    }
    /**
     * 5a½. THE APPROACH-HAZARD GATE — a seat needs somebody expecting you.
     *
     * A kind whose *approach* is the hazard (`hazardousAccess`: a glacier, a
     * volcano, a cave) can be entirely real and encyclopaedically noted and
     * still be nowhere to send an unguided first-time visitor: a live
     * road-region board stored a highland ice cap and a locked lava tube as
     * easy, paved, open-all-year outings, because the archetype's defaults
     * were the only access facts anybody held. Notice attests the feature;
     * the seat requires evidence that somebody operates the ground for
     * visitors — posted hours or a fee on the record, a designation over
     * drawn boundaries, an authority's own page for it — which is exactly
     * what a managed glacier walk or a guided cave publishes and an unstaffed
     * crater does not. No outage seat either: an approach nobody vouches for
     * is not admitted on the strength of a channel being silent.
     */
    /*
     * The gate hears the hazard from the whole entity, not one catalogue's
     * filing: `hazardousApproach` is the leaf, the record's own ground
     * attributes (`natural=glacier` under a tour lister's park filing), and
     * any collapsed twin's, carried to the survivor. The visit evidence is
     * entity-wide for the same reason — the managed cave's hours may sit on
     * the twin that lost the collapse.
     */
    if (
      hazardousApproach(record) &&
      !visitorsExpected(record) &&
      !hasLocalPlaceAttestation(witnessStandingOf(record))
    ) {
      ledger.reject('insufficient_significance_evidence', record.name);
      continue;
    }
    if (
      recordTaxonomy.requiresSignificanceEvidence &&
      !hasSignificanceEvidence(witnessStandingOf(record))
    ) {
      /*
       * THE GATE, MADE OUTAGE-AWARE — the refusal stands wherever the channel
       * could answer. Where it structurally could not (`witnessChannelSilent`),
       * refusing is not caution but a category error: on the live catalogue it
       * removed every place-layer worship building and museum-grade historic
       * site from every dense city while the layers that *do* publish
       * identifiers walked their obscura through. Those records are held for
       * the bounded, marked pass below rather than admitted here, so an
       * unverifiable kind can be represented without colonising a pool.
       */
      if (!witnessChannelSilent(record)) {
        ledger.reject('insufficient_significance_evidence', record.name);
        continue;
      }
      const kindKey = witnessKindKeyOf(record.sourceCategory, recordTaxonomy);
      const held = unwitnessedByKind.get(kindKey);
      const entry = { record, admission, eligibility };
      if (held) held.push(entry);
      else unwitnessedByKind.set(kindKey, [entry]);
      continue;
    }
    admitVetted(record, admission, eligibility);
  }

  /*
   * THE DEGRADED ADMISSION: top seats per gated kind, by significance prior.
   *
   * Ranked with the same `rank` the pools use — significance first, which for
   * records this evidence-starved is mostly the kind's own prior, then mapped
   * extent, then the id — so the choice is deterministic and two builds of one
   * pack agree. Every record that does not take a seat is refused with the
   * witness reason it would have got before this pass existed; a record a
   * later gate refuses spends no seat and is counted under that gate's reason.
   * Kinds are visited in sorted order for the same determinism.
   */
  for (const [, held] of [...unwitnessedByKind.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const byId = new Map(held.map((entry) => [entry.record.id, entry]));
    let seats = UNWITNESSED_KIND_SEATS;
    for (const ranked of rank(held.map((entry) => entry.record), EMPTY_PRIORITY, significanceOf)) {
      const entry = byId.get(ranked.id)!;
      /*
       * The seat bound exists so a class *nobody can verify* cannot colonise
       * a pool on the strength of a channel outage. A record the region's own
       * ground names is not that class: somebody outside the record vouched,
       * in the one channel the outage cannot silence. Attested records are
       * admitted beside the bounded unattested ones — still marked, still
       * barred from classic seats downstream, their number already bounded by
       * the attestation guards — and spend no outage seat.
       */
      const attested = groundAttested.has(entry.record.id);
      if (!attested && seats <= 0) {
        ledger.reject('insufficient_significance_evidence', entry.record.name);
        continue;
      }
      if (admitVetted(entry.record, entry.admission, entry.eligibility)) {
        witnessDegraded.add(entry.record.id);
        if (!attested) seats -= 1;
      }
    }
  }

  /** Records admitted to a slot under one role. */
  const admittedFor = (slot: PortfolioSlot, role: PlanningRole): SourceRecord[] =>
    bySlot.get(slot)?.get(role) ?? [];

  /**
   * Every record admitted to a slot, whatever role put it there.
   *
   * Food, support and gateways are pooled by slot rather than by role because
   * the slot is the thing being sized: a grocery arrives as `support` and a
   * market as `market`, and the food layer wants both. Visitable records stay
   * keyed by role, because their quotas are per role.
   */
  const allAdmittedFor = (slot: PortfolioSlot): SourceRecord[] => {
    const roles = bySlot.get(slot);
    if (!roles) return [];
    return [...roles.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .flatMap(([, records]) => records);
  };

  const categoryOf = (record: SourceRecord): string =>
    classifySourceCategory({
      category: record.sourceCategory,
      path: record.sourceCategoryPath,
    }).category;

  /*
   * Each visitable role balanced separately, against its own share of the quota.
   *
   * Separately rather than over one merged pool, because a merged round robin
   * would let a dense area's attractions crowd out a sparse area's *outdoors* —
   * the two are not substitutes, and the whole reason `outdoor` became its own
   * role is that the geographic layers carry it and the place layer does not.
   */
  const balanced: {
    slot: PortfolioSlot;
    role: PlanningRole;
    kept: SourceRecord[];
    available: number;
    diagnostics: BalanceDiagnostics;
  }[] = [];
  for (const role of VISITABLE_ROLES) {
    /*
     * Anchors compete with anchors and discoveries with discoveries: the slot a
     * record occupies decides which pool it is ranked inside. A side quest that
     * outranked a museum could never take its place, because they are never in
     * the same list.
     *
     * Read off the *record's admission*, not off its role. This loop used to say
     * `roleCanOccupy(role, 'anchor') ? 'anchor' : 'discovery'` — one slot per
     * role, decided by a table — and that made the demotion above unreachable: a
     * museum whose membership could not be resolved was admitted into the
     * discovery pool and then looked for in the anchor pool, so it vanished
     * between two correct-looking lines. Two tables meaning one thing is how
     * that happens; the record's own admission is the single source now.
     */
    const roleQuota = Math.max(1, Math.round(limits.maxAttractions * (ROLE_QUOTA_SHARE[role] ?? 0)));
    let remaining = roleQuota;
    // Anchor first: a role's quota is spent on things that can hold a day before
    // it is spent on things that cannot.
    for (const slot of VISITABLE_SLOTS) {
      if (remaining <= 0) break;
      const pool = rank(admittedFor(slot, role), prioritized, significanceOf);
      if (pool.length === 0) continue;
      const result = balanceAcrossAreas({
        ranked: pool,
        areaOf: areaOfRecord,
        categoryOf,
        limits: {
          quota: remaining,
          maxPerCategory: limits.maxPerCategory,
          maxAreaShare: limits.maxAreaShare,
        },
      });
      remaining -= result.kept.length;
      balanced.push({
        slot,
        role,
        kept: result.kept,
        available: pool.length,
        diagnostics: result.diagnostics,
      });
    }
  }

  /*
   * Unclaimed quota is redistributed rather than lost.
   *
   * A region with no markets should not produce a board twelve per cent shorter
   * than one that has them. The remainder is offered to every admitted
   * visitable record in **one merged rank order**, not role by role: the
   * role-ordered version handed the whole remainder to the first role's spare,
   * and on a stored dense-metro pack that seated a run of tie-band galleries
   * while a demoted landmark — `membership_unknown`, so its own role's quota
   * was spent by its anchor pool before the demoted-discovery pool was reached
   * — could never be seated at all, at any significance. Unclaimed seats go to
   * the strongest admitted records, whatever role they carry; deterministic,
   * and bounded by what admission actually holds, so it can only ever add
   * records that already qualified.
   */
  const visitable = balanced.flatMap((entry) => entry.kept);
  let slack = limits.maxAttractions - visitable.length;
  if (slack > 0) {
    const taken = new Set(visitable.map((record) => record.id));
    const categoryCounts = new Map<string, number>();
    for (const record of visitable) {
      const category = categoryOf(record);
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
    /*
     * The remainder is offered from the *admitted* pool and nowhere else.
     *
     * This is the line the invariant turns on. Reading the raw records here —
     * or any pool that admission did not filter — would let an unfilled quota
     * reach past every gate above and rescue exactly the records those gates
     * refused, which is how a shortage of attractions becomes a board of
     * infrastructure. Both visitable slots, for the same reason as the first
     * pass: the record's admission decides where it is, not a table keyed on
     * its role.
     */
    const spare = rank(
      VISITABLE_ROLES.flatMap((role) => VISITABLE_SLOTS.flatMap((slot) => admittedFor(slot, role))),
      prioritized,
      significanceOf,
    ).filter((record) => !taken.has(record.id));
    /*
     * By global rank under the *global* caps — never re-balanced as if the
     * remainder were a quota of its own. The first pass already paid for the
     * geographic spread; running the area machinery again over the slice
     * re-applied the share ceiling and the supply-proportional serving to a
     * handful of seats, and on a stored dense-metro pack that seated a dense
     * cell's 0.60 tail over a sparse cell's 0.69 landmark — the cell held few
     * spare records, so it was served once, and the record behind its first
     * was unreachable at any significance. The caps that are genuinely global
     * — the category cap and the area-share ceiling, both counted over
     * everything kept so far — still bind every appended record.
     */
    const areaCounts = new Map<string, number>();
    for (const record of visitable) {
      const area = areaOfRecord(record);
      areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
    }
    const areaCeiling = Math.max(1, Math.floor(limits.maxAttractions * limits.maxAreaShare));
    /*
     * Two passes, exactly as `balanceAcrossAreas` fills: the ceiling first,
     * and — only if seats remain that the ceiling alone is refusing — again
     * without it, because a region that really is one cell should produce a
     * plan for one cell rather than a shorter plan for the same cell.
     */
    for (const ceiling of [areaCeiling, Number.POSITIVE_INFINITY]) {
      for (const record of spare) {
        if (slack <= 0) break;
        if (taken.has(record.id)) continue;
        const category = categoryOf(record);
        if ((categoryCounts.get(category) ?? 0) >= limits.maxPerCategory) continue;
        const area = areaOfRecord(record);
        if ((areaCounts.get(area) ?? 0) >= ceiling) continue;
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
        taken.add(record.id);
        visitable.push(record);
        slack -= 1;
      }
      if (slack <= 0) break;
    }
  }

  /*
   * Support is balanced across areas, not taken off the top.
   *
   * "Support selected from route need" is what this approximates, and the
   * approximation is stated rather than pretended: a route does not exist this
   * early, so the closest honest proxy for "one near every part of the trip" is
   * one per area rather than twenty-five in whichever cell the source
   * catalogued most densely. A pharmacy beside the airport is not a stop on a
   * mountain day.
   */
  const supportBalance = balanceAcrossAreas({
    ranked: rank(allAdmittedFor('support'), prioritized, significanceOf),
    areaOf: areaOfRecord,
    categoryOf,
    limits: {
      quota: limits.maxSupport,
      maxPerCategory: limits.maxPerCategory,
      maxAreaShare: limits.maxAreaShare,
    },
  });
  const support = supportBalance.kept;

  /*
   * Gateways ranked by what the scope already says it needs.
   *
   * "Derived from base and transfer structure" — and the honest half of that is
   * available here: the scope carries the gateways the traveller or the resolver
   * already named, so a record matching one of those is the transfer structure
   * rather than a guess about it. The base structure is not available this early
   * and is not invented; what is left after the named ones is ranked and
   * balanced like everything else.
   */
  const gatewayBalance = balanceAcrossAreas({
    ranked: preferNamedGateways(rank(allAdmittedFor('gateway'), prioritized, significanceOf), input.scope),
    areaOf: areaOfRecord,
    categoryOf,
    limits: {
      quota: limits.maxGateways,
      maxPerCategory: limits.maxPerCategory,
      maxAreaShare: limits.maxAreaShare,
    },
  });
  const gateways = gatewayBalance.kept;

  /*
   * Food supply, and a grocery is part of it.
   *
   * `market` records hold two slots by design — somewhere to eat *and* a thing
   * to do — and so does a grocery, which is where an outdoor day is provisioned.
   * Before this, a supermarket classified `support` was never offered to the
   * food layer and *was* emitted as a discovery card: the worst of the three
   * available outcomes.
   */
  const foodPool = rank(allAdmittedFor('food'), prioritized, significanceOf);
  const food = foodPool.slice(0, limits.maxFoodVenues);

  /*
   * Interleaved across roles as well as categories on the way out.
   *
   * Every budget below this point — the coarse-candidate cap, the shortlist, the
   * board — cuts from the *top* of this list, so the order has to carry the
   * breadth rather than only the list. Rank order within a role is untouched.
   */
  const ordered = interleaveByRole(
    balanced.map((entry) => entry.role),
    visitable,
    (record) => roleOf.get(record.id) ?? roleOfRecord(record),
  );

  const asCandidate = (record: SourceRecord): DiscoveredCandidate =>
    toCandidate({
      record,
      scope: input.scope,
      crossLayerCorroborated: crossLayer.has(record.id),
      role: roleOf.get(record.id) ?? roleOfRecord(record),
      inclusion: inclusionOf.get(record.id) ?? 'membership_unknown',
      namedInRegionRecords: namedInRegion(record),
      groundWitnessCount: groundWitnessCountOf(record),
      /* Enclosure kinds read the annex tier — see `significanceOf`. */
      groundPrecinctWitnesses: taxonomyOf(record).paidEnclosure
        ? groundWitnessCountOf(record)
        : groundPrecinctCountOf(record),
      visitorsExpected: visitorsExpected(record),
      placeAttested: hasSignificanceEvidence(witnessStandingOf(record)),
      /*
       * The narrowed view, so the stamped ranking fields agree with the seats:
       * a place must not be ordered on one identity and captioned with the
       * prominence of another. A fanned channel is absent here, never false.
       */
      knowledgeBase: seatKnowledgeOf(record),
      namesFromTwins: inheritedNames.get(record.id) ?? [],
      ...(witnessDegraded.has(record.id) ? { witnessChannelSilent: true } : {}),
    });

  /*
   * Two arrays, and the split is the fix.
   *
   * `candidates` is what a board may show. `supporting` is real, useful and
   * addressed by name. Concatenating them was the whole defect: an
   * international airport reached a traveller's board not because anything
   * misclassified it but because one array was called `candidates` and nothing
   * downstream had any way to tell its halves apart.
   */
  const candidates = ordered.map(asCandidate);
  const supporting = [...support, ...gateways].map(asCandidate);

  const keptByLayer = new Map<string, number>();
  for (const record of [...visitable, ...support, ...gateways]) {
    keptByLayer.set(record.layerId, (keptByLayer.get(record.layerId) ?? 0) + 1);
  }

  const areaTotals = new Map<string, { kept: number; available: number }>();
  for (const entry of balanced) {
    for (const area of entry.diagnostics.byArea) {
      const running = areaTotals.get(area.areaId) ?? { kept: 0, available: 0 };
      running.kept += area.kept;
      running.available += area.available;
      areaTotals.set(area.areaId, running);
    }
  }
  const byArea = [...areaTotals.entries()]
    .map(([areaId, counts]) => ({ areaId, ...counts }))
    .sort((a, b) => b.kept - a.kept || a.areaId.localeCompare(b.areaId));
  const densest = byArea[0]?.kept ?? 0;

  /*
   * What the quotas cost, counted from what was admitted rather than from what
   * was read. A record refused by a gate above was never in a quota's way.
   */
  for (const entry of balanced) {
    for (let index = 0; index < entry.diagnostics.heldBackByCategory; index += 1) {
      ledger.reject('over_category_cap');
    }
    for (let index = 0; index < entry.diagnostics.heldBackByAreaShare; index += 1) {
      ledger.reject('over_area_share');
    }
    const overQuota = entry.available - entry.kept.length - entry.diagnostics.heldBackByAreaShare;
    for (let index = 0; index < Math.max(0, overQuota); index += 1) ledger.reject('over_role_quota');
  }

  const pools: PortfolioPool[] = [
    ...balanced.map((entry) => ({
      slot: entry.slot,
      role: entry.role,
      available: entry.available,
      kept: entry.kept.length,
      byArea: entry.diagnostics.byArea,
      concentration: entry.diagnostics.concentration,
      areaCapRelaxed: entry.diagnostics.areaCapRelaxed,
    })),
    {
      slot: 'food' as const,
      role: 'food' as const,
      available: foodPool.length,
      kept: food.length,
      byArea: areaBreakdown(food, foodPool),
      concentration: concentrationOf(food),
      areaCapRelaxed: false,
    },
    {
      slot: 'support' as const,
      role: 'support' as const,
      available: allAdmittedFor('support').length,
      kept: support.length,
      byArea: supportBalance.diagnostics.byArea,
      concentration: supportBalance.diagnostics.concentration,
      areaCapRelaxed: supportBalance.diagnostics.areaCapRelaxed,
    },
    {
      slot: 'gateway' as const,
      role: 'gateway' as const,
      available: allAdmittedFor('gateway').length,
      kept: gateways.length,
      byArea: gatewayBalance.diagnostics.byArea,
      concentration: gatewayBalance.diagnostics.concentration,
      areaCapRelaxed: gatewayBalance.diagnostics.areaCapRelaxed,
    },
  ].filter((pool) => pool.available > 0);

  const anchors = balanced
    .filter((entry) => entry.slot === 'anchor')
    .reduce((total, entry) => total + entry.kept.length, 0);
  const discoveries = balanced
    .filter((entry) => entry.slot === 'discovery')
    .reduce((total, entry) => total + entry.kept.length, 0);
  const anchorAreas = new Set(
    balanced.filter((entry) => entry.slot === 'anchor').flatMap((entry) => entry.kept.map(areaOfRecord)),
  );

  const supply = assessVisitableSupply({
    supply: {
      anchors,
      discoveries,
      visitable: visitable.length,
      supporting: support.length + gateways.length + food.length,
      categories: new Set(visitable.map(categoryOf)).size,
      areasWithAnchors: anchorAreas.size,
      concentration: visitable.length === 0 ? 0 : densest / visitable.length,
    },
    /*
     * Nights, plus the day you arrive. The scope is the only trip shape this
     * layer has, and a zero means "not established" rather than "no days" —
     * which `assessVisitableSupply` reads as "do not judge against a length".
     */
    tripDays: input.scope.nights > 0 ? input.scope.nights + 1 : 0,
  });

  return {
    candidates,
    supporting,
    foodRecords: food,
    licences: packLicences(input.pack),
    portfolio: {
      pools,
      rejected: ledger.entries(),
      inclusion: [...inclusionCounts.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
      membershipUnverified,
      anchorDemotions,
      unwitnessedAdmissions: witnessDegraded.size,
      supply,
    },
    diagnostics: {
      recordsConsidered: records.length,
      superseded: superseded.size,
      excludedByRole,
      heldBackByCategoryCap: balanced.reduce((total, e) => total + e.diagnostics.heldBackByCategory, 0),
      heldBackByAreaCap: balanced.reduce((total, e) => total + e.diagnostics.heldBackByAreaShare, 0),
      /**
       * Things to do. Never support, never gateways.
       *
       * The number that made board size look like supply once the two were
       * summed: a region with eleven attractions and thirty practical stops
       * reported forty-one, and everything downstream read that as how much
       * there was to do.
       */
      attractions: visitable.length,
      support: support.length + gateways.length,
      food: food.length,
      byRole: [
        ...balanced.map((entry) => ({ role: entry.role, kept: entry.kept.length })),
        { role: 'support' as const, kept: support.length },
        { role: 'gateway' as const, kept: gateways.length },
        { role: 'food' as const, kept: food.length },
      ].filter((entry) => entry.kept > 0),
      byArea,
      concentration: visitable.length === 0 ? 0 : densest / visitable.length,
      areaCapRelaxed: balanced.some((entry) => entry.diagnostics.areaCapRelaxed),
      byLayer: [...keptByLayer.entries()]
        .map(([layerId, kept]) => ({ layerId, kept }))
        .sort((a, b) => a.layerId.localeCompare(b.layerId)),
      /*
       * Measured over every record the pack held, not only the ones kept.
       *
       * The question this answers is "could the significance model see anything
       * about this destination", and narrowing it to survivors would answer a
       * different one — survivors are selected partly *by* significance, so a
       * kept-only count reports the selection back to itself.
       */
      knowledgeBase: knowledgeBaseDiagnostics(records, knowledgeBase),
    },
  };
}

/**
 * Records matching a gateway the scope already names, first.
 *
 * Name matching rather than geometry, because that is the evidence available:
 * the scope's gateways carry names and sometimes coordinates, and a record
 * whose name contains one of them is the same transfer point. Everything else
 * keeps its rank order, so this promotes rather than filters.
 */
function preferNamedGateways(
  ranked: readonly SourceRecord[],
  scope: GeographicScope,
): SourceRecord[] {
  const named = scope.gateways.map((gateway) => gateway.name.trim().toLowerCase()).filter(Boolean);
  if (named.length === 0) return [...ranked];
  const matches = (record: SourceRecord): boolean => {
    const haystack = [record.name, ...record.alternateNames].map((value) => value.toLowerCase());
    return named.some((name) => haystack.some((value) => value.includes(name)));
  };
  return [...ranked.filter(matches), ...ranked.filter((record) => !matches(record))];
}

function areaBreakdown(
  kept: readonly SourceRecord[],
  available: readonly SourceRecord[],
): { areaId: string; kept: number; available: number }[] {
  const totals = new Map<string, { kept: number; available: number }>();
  for (const record of available) {
    const entry = totals.get(areaOfRecord(record)) ?? { kept: 0, available: 0 };
    entry.available += 1;
    totals.set(areaOfRecord(record), entry);
  }
  for (const record of kept) {
    const entry = totals.get(areaOfRecord(record)) ?? { kept: 0, available: 0 };
    entry.kept += 1;
    totals.set(areaOfRecord(record), entry);
  }
  return [...totals.entries()]
    .map(([areaId, counts]) => ({ areaId, ...counts }))
    .filter((entry) => entry.kept > 0)
    .sort((a, b) => b.kept - a.kept || a.areaId.localeCompare(b.areaId));
}

function concentrationOf(records: readonly SourceRecord[]): number {
  if (records.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(areaOfRecord(record), (counts.get(areaOfRecord(record)) ?? 0) + 1);
  }
  return Math.max(...counts.values()) / records.length;
}

/**
 * Round-robin across roles, preserving each role's internal order.
 *
 * The counterpart to `interleaveByCategory`, one level up. Without it a
 * downstream truncation at forty would take forty attractions and no outdoors,
 * because the roles were concatenated — which is the same defect this file
 * fixes geographically, in the other dimension.
 *
 * **A permutation of its input, by construction.** That guarantee is the repair
 * rather than a tidy-up, because losing it is how the shortlist threw away what
 * the quotas had just chosen. `order` used to be trusted to name each bucket
 * once, and the caller hands it one entry per *pool* — so a role holding both an
 * anchor and a discovery pool appeared twice and produced two identical buckets.
 * Every round then emitted the same records once per copy while counting those
 * copies against the total it was waiting for, and stopped about half way.
 *
 * On the live Tokyo pack that turned 129 selected records into 132 emitted ones
 * holding **70 distinct places**: 35 attractions and 24 outdoors were discarded
 * *after* being chosen, including the highest-scoring outdoor record in the
 * entire pack and two of the destination's headline museums. No score ordered
 * that and no quota bounded it — a round index did, and every downstream layer
 * read the result as what the destination has to offer.
 *
 * So the buckets are built from the records and `order` only says which to serve
 * first. A role `order` does not mention still gets a bucket: dropping a record
 * because a caller's list was out of date is the same failure in other clothes.
 */
function interleaveByRole(
  order: readonly PlanningRole[],
  records: readonly SourceRecord[],
  roleOf: (record: SourceRecord) => PlanningRole,
): SourceRecord[] {
  const byRole = new Map<PlanningRole, SourceRecord[]>();
  for (const record of records) {
    const role = roleOf(record);
    const bucket = byRole.get(role);
    if (bucket) bucket.push(record);
    else byRole.set(role, [record]);
  }

  /*
   * Named roles first in the order given, then anything else in the order the
   * records themselves arrived — both halves deterministic, which is what a
   * compiled artifact's checksum rests on, and each role served exactly once.
   */
  const served = new Set<PlanningRole>();
  const buckets: SourceRecord[][] = [];
  for (const role of [...order, ...byRole.keys()]) {
    const bucket = byRole.get(role);
    if (!bucket || served.has(role)) continue;
    served.add(role);
    buckets.push(interleaveByCategory(bucket));
  }

  const ordered: SourceRecord[] = [];
  for (let round = 0; ordered.length < records.length; round += 1) {
    let progressed = false;
    for (const bucket of buckets) {
      const next = bucket[round];
      if (!next) continue;
      ordered.push(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  return ordered;
}

/**
 * The order records are considered in, and it is not a fit score.
 *
 * Fit needs a traveller and this runs before one is applied. What this orders
 * on is **significance** — what kind of thing it is, times what the world has
 * established about it (`quality/significance.ts`). The score used to be
 * `knownness()`, a weighted attribute count, and that was the §8.3 defect in
 * one function: a café with a website, posted hours and an operator outranked
 * every unevidenced temple in the city, because describing yourself thoroughly
 * scored better than mattering. Metadata volume reaches this ordering by no
 * path, and nothing below is a field count.
 *
 * ## Why anything sits between significance and the id
 *
 * Significance is rounded to two decimals, so it can take at most a hundred and
 * one values — and a dense city hands this function six hundred records of one
 * role. The bands are therefore enormous, and underneath the score the only
 * tiebreak used to be `id.localeCompare`, which over source identifiers is a
 * sort on hexadecimal. Measured on the live Tokyo pack: **six hundred parks tied
 * at 0.610**, ordered by UUID, with two of the city's headline gardens 74th and
 * 75th — behind a traffic-safety playground, a children's park and a hundred-
 * metre flower garden that happened to carry lower digits. Whatever else that
 * is, it is not a judgement, and everything downstream cuts from the top of it.
 *
 * So the band is ordered by **how much ground the source actually mapped**,
 * largest first, before the id is reached. Three properties make that safe:
 *
 * - It cannot promote anything. A record only ever moves within the set of
 *   records the significance model could not tell apart.
 * - It is a measurement of the thing, not of the listing. Nobody makes their
 *   park bigger by filling in a form, which is the line §8.3 draws — and it is
 *   the same magnitude, at the same hundred-metre floor, that the landscape gate
 *   above already trusts to tell a mountain from a mound.
 * - It is silent where it has nothing to say. A point feature has no outline and
 *   reads zero, so in a pool of them — a city's museums, its restaurants — the
 *   order is exactly what it was.
 *
 * Deterministic to the last tiebreak, because the pack's content hash depends on
 * it and so does the reproducibility of a compilation.
 */
function rank(
  records: readonly SourceRecord[],
  /**
   * Folded names the traveller asked for by hand.
   *
   * Ranked above everything else and nothing more than that. It changes the
   * order of records that have *already* passed every admission gate, so it
   * cannot rescue anything scope, closure, identity or role refused — which is
   * the property that keeps a recovery pass from being able to manufacture the
   * coverage it is measuring. Within the prioritised group the ordinary order
   * still applies, so it stays deterministic.
   */
  prioritized: ReadonlySet<string>,
  /** Significance per record, supplied by the build that holds the pack-wide evidence. */
  scoreOf: (record: SourceRecord) => number,
): SourceRecord[] {
  const named = (record: SourceRecord): boolean =>
    prioritized.size > 0 &&
    [record.name, ...record.alternateNames].some((value) => prioritized.has(foldForMatch(value)));
  return [...records]
    .map((record) => ({
      record,
      score: scoreOf(record),
      named: named(record),
      /* Unmapped is not "unknown size" — a point feature is small ground. */
      extent: mappedExtentMetres(record) ?? 0,
    }))
    .sort(
      (a, b) =>
        Number(b.named) - Number(a.named) ||
        b.score - a.score ||
        b.extent - a.extent ||
        a.record.id.localeCompare(b.record.id),
    )
    .map((entry) => entry.record);
}

/** Shared so the default path allocates nothing per call. */
const EMPTY_PRIORITY: ReadonlySet<string> = new Set<string>();

/**
 * Fragments of one feature, published as several adjacent records.
 *
 * The linker folds what two *catalogues* agree on; this folds what one
 * catalogue split — a nature forest mapped in two municipal parcels, a park
 * and its numbered extension. The test is deliberately three-legged, because
 * any leg alone over-merges: the names must be the same name or one must
 * contain the other (six characters minimum, so "Park East" cannot eat
 * "Park"), the kinds must agree, and the points must be within a couple of
 * hundred metres. The better-evidenced fragment survives; ties break on id so
 * two builds fold identically.
 */
const FRAGMENT_FOLD_METRES = 250;

export function foldAdjacentFragments(
  records: readonly SourceRecord[],
  taxonomyOf: (record: SourceRecord) => { category: string },
  scoreOf: (record: SourceRecord) => number,
): Set<string> {
  const byCategory = new Map<string, SourceRecord[]>();
  for (const record of records) {
    if (record.planningRole === 'administrative') continue;
    const key = taxonomyOf(record).category;
    const bucket = byCategory.get(key);
    if (bucket) bucket.push(record);
    else byCategory.set(key, [record]);
  }

  const sameFragmentName = (a: string, b: string): boolean => {
    if (a.length === 0 || b.length === 0) return false;
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return shorter.length >= 6 && longer.includes(shorter);
  };

  const folded = new Set<string>();
  for (const bucket of byCategory.values()) {
    if (bucket.length < 2) continue;
    const named = bucket.map((record) => ({ record, folded: normalizeName(record.name) }));
    for (let i = 0; i < named.length; i += 1) {
      for (let j = i + 1; j < named.length; j += 1) {
        const a = named[i]!;
        const b = named[j]!;
        if (folded.has(a.record.id) || folded.has(b.record.id)) continue;
        if (!sameFragmentName(a.folded, b.folded)) continue;
        const metres =
          haversineKm(
            { id: 'a', ...a.record.coordinates },
            { id: 'b', ...b.record.coordinates },
          ) * 1000;
        if (metres > FRAGMENT_FOLD_METRES) continue;
        const keepA =
          scoreOf(a.record) > scoreOf(b.record) ||
          (scoreOf(a.record) === scoreOf(b.record) &&
            a.record.id.localeCompare(b.record.id) <= 0);
        folded.add(keepA ? b.record.id : a.record.id);
      }
    }
  }
  return folded;
}

/**
 * The order candidates leave in, round-robin across categories.
 *
 * Rank order alone was correct and useless. A live New York build handed the
 * compiler a hundred candidates in pure rank order, the whole hundred were
 * municipal parks — the geographic layers tag them richly — and the traveller's
 * board came back with seventeen walks and two of everything else. Nothing had
 * gone wrong at any single step: the inventory was broad, and the *first
 * hundred* of it was not.
 *
 * So the order carries the breadth rather than only the list. Every downstream
 * truncation — the coarse-candidate budget, the shortlist, the board — now cuts
 * a representative slice instead of the top of one category. Within a category
 * the ranking is untouched.
 */
function interleaveByCategory(records: readonly SourceRecord[]): SourceRecord[] {
  const byCategory = new Map<string, SourceRecord[]>();
  for (const record of records) {
    const category = classifySourceCategory({
      category: record.sourceCategory,
      path: record.sourceCategoryPath,
    }).category;
    const bucket = byCategory.get(category);
    if (bucket) bucket.push(record);
    else byCategory.set(category, [record]);
  }

  /**
   * Categories ordered by how many they have, largest first, then by name.
   * Deterministic, and it puts the well-populated kinds at the front of each
   * round rather than letting insertion order decide.
   */
  const buckets = [...byCategory.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([, entries]) => entries);

  const ordered: SourceRecord[] = [];
  for (let round = 0; ordered.length < records.length; round += 1) {
    let progressed = false;
    for (const bucket of buckets) {
      const next = bucket[round];
      if (!next) continue;
      ordered.push(next);
      progressed = true;
    }
    if (!progressed) break;
  }
  return ordered;
}

/*
 * `knownness()` used to live here — six points for a website, five for an open
 * identifier, two per recorded attribute. It was the exact metadata-count
 * heuristic §8.3 bans, and it decided who won: a live metro build scored every
 * card "Strong fit" off a pool this function had ordered, museums losing to
 * pocket parks inside it. Ranking now reads `experienceSignificanceOf` — kind
 * times established evidence — and nothing in this file counts attributes into
 * an ordering again.
 */

/**
 * Whether an encyclopaedia holds an *article* about this record, not just a row.
 *
 * A different statement from `wikidataId`, and worth its own channel because
 * the two genuinely separate on real packs: a third of the knowledge-base
 * entries in a dense city carry no article, and the ones that do are the places
 * somebody sat down and wrote about. It is the signal that took over the
 * discriminating work the alternate-name count was doing — an article cannot be
 * produced by translating a row four times.
 */
function hasEncyclopaedicArticle(record: SourceRecord): boolean {
  return record.attributes.wikipedia !== undefined;
}

/**
 * Whether somebody operationally receives visitors at this record — posted
 * hours or an admission charge. The unlock for the witness bound in
 * `composeExperienceSignificance`: a gated structure with a ticket page and
 * posted hours keeps its full established rank; an article-only crossing ranks
 * as its kind. Deliberately *not* `websiteCandidates`: the primary catalogue
 * attaches a website to nearly everything, and on the stored pack a road
 * bridge's was a bus company's homepage — see `OPERATIONAL_VISIT_ATTRIBUTES`.
 */
/**
 * The kind weight a record ranks on, honouring the branch-rescue's verdict.
 *
 * A branch match borrows an archetype so the record has a duration and an
 * exposure at all; the borrowed *weight* is the unrecognised fragment's prior,
 * which is right for the unwitnessed crowd and wrong for the one appeal the
 * rescue accepts: a record the wider world attests (`placeAttested`, the same
 * witness `attractionRole` hears). For those, the taxonomy's own line for "a
 * visitable kind nobody weighted" — `EXPERIENCE_CREDIBILITY_FLOOR` — is the
 * honest prior: real, minor, and able to hear its evidence in full. Lazy on
 * the witness so the common path (a leaf or path match) never computes it.
 */
export function attestedKindWeight(
  taxonomy: { match: TaxonomyMatch; significanceWeight: number },
  placeAttested: () => boolean,
): number {
  if (taxonomy.match.kind !== 'source_branch') return taxonomy.significanceWeight;
  if (taxonomy.significanceWeight >= EXPERIENCE_CREDIBILITY_FLOOR) {
    return taxonomy.significanceWeight;
  }
  return placeAttested() ? EXPERIENCE_CREDIBILITY_FLOOR : taxonomy.significanceWeight;
}

export function recordExpectsVisitors(record: SourceRecord): boolean {
  if (!attributesExpectVisitors(Object.keys(record.attributes))) return false;
  /*
   * THE VALUE HAS TO SAY WHAT THE KEY CLAIMS.
   *
   * The key test alone read `fee=no` as a fee and `opening_hours=24/7` as a
   * door somebody opens — and on a live metro pack that made the operational
   * door a formality for exactly the commonplace kinds the witness bound
   * exists to grade: every riverside lawn tagged `24/7` with `fee=no`
   * composed as a gated attraction, while "this ground is never shut and
   * nobody charges" is the *opposite* statement. A stated fee, charge or
   * admission counts unless the statement is the negative; posted hours
   * count unless they say the ground never closes.
   */
  const denies = (value: string | undefined): boolean =>
    value !== undefined && /^(no|none|free)$/i.test(value.trim());
  const paid = ['fee', 'charge', 'admission'].some(
    (key) => record.attributes[key] !== undefined && !denies(record.attributes[key]),
  );
  const hours = record.attributes.opening_hours;
  const gatedHours = hours !== undefined && hours.trim() !== '24/7';
  return paid || gatedHours;
}

// ---------------------------------------------------------------------------
// Knowledge-base evidence
// ---------------------------------------------------------------------------

/**
 * ============================================================================
 * WHERE A RECORD'S KNOWLEDGE-BASE EVIDENCE CAME FROM — INCLUDING "NOWHERE, AND
 * WE COULD NOT HAVE ASKED".
 * ============================================================================
 *
 * ## The failure this exists for
 *
 * `assessPlaceStanding` was handed `inKnowledgeBase: record.wikidataId !==
 * undefined` for every record in the pack. For the *primary place layer* that
 * expression is not a measurement — it is a constant. Measured against the real
 * catalogue (Overture release 2026-07-22.0, anonymous range reads, all
 * overlapping row groups decoded):
 *
 * | box    | place records in box | with a knowledge-base id | with an article |
 * |--------|---------------------:|-------------------------:|----------------:|
 * | Tokyo  |              272,018 |                        0 |               0 |
 * | Osaka  |               92,042 |                        0 |               0 |
 * | Lisbon |               43,228 |                        0 |               0 |
 *
 * Zero, and not because those cities are obscure: the places schema for this
 * release publishes **no place-level `wikidata` leaf and no `source_tags` map at
 * all**. The only such leaf anywhere in the theme is `brand.wikidata`, which is
 * a statement about a *corporation*. So the strongest global channel in the
 * significance model was structurally silent for the layer that supplies the
 * board, in every destination, permanently — and the model could not tell that
 * from having looked and found nothing. `assessPlaceStanding`'s hiddenness
 * block says as much out loud: "having looked for a knowledge-base entry and
 * found none is itself the globally-obscure half of the claim." We never looked.
 *
 * ## What is done about it, and what deliberately is not
 *
 * The supplemental geography layers **do** carry the identifier — 2,866 of
 * 31,563 records in the Tokyo box, 1,142 of 14,517 in Osaka, 596 of 11,575 in
 * Lisbon — and in the clearest case an identifier sits on a communication tower
 * in the infrastructure layer while the place catalogue holds the observation
 * deck two metres away. So evidence a twin publishes is carried onto the record
 * it describes.
 *
 * **How far it reaches, stated plainly, because it is small.** Run over real
 * records at the retention this pack builder currently ships (4,000 records,
 * 1,840 of them places):
 *
 * | box    | places gaining a twin's evidence | places with any evidence, before → after |
 * |--------|---------------------------------:|-----------------------------------------:|
 * | Tokyo  |                                4 |                               152 → 152 |
 * | Osaka  |                                2 |                                 15 → 15 |
 * | Lisbon |                               11 |                               152 → 152 |
 *
 * The "after" column is the honest headline: at today's budget the transfer
 * moves **no** record from unevidenced to evidenced, because the handful it
 * reaches were already carrying corroboration or a designation. Raise the
 * retention to 12,000 and Osaka goes 181 → 247 and Lisbon 149 → 166, which is
 * the direction this becomes worth something in — the mechanism is here so the
 * evidence is not thrown away when the budgets that currently hide it are
 * lifted, and so the *shape* of the silence is finally reportable.
 *
 * **It does not rescue famous landmarks, and must never be sold as if it did.**
 * Of fifteen canonical Tokyo subjects, the retained transfer touches one — a
 * park inside a palace's grounds. The reason is structural rather than tunable:
 * *the two layers do not name the same things*. Where the geographic layer
 * holds the landmark — the great city gardens are land-use polygons with
 * identifiers and English alternates — the place catalogue holds its gate, the
 * café by the entrance and the bus stop; where the place catalogue holds the
 * landmark — the temples, the national museums — no geographic twin carries an
 * identifier at all. Recall of famous places is a different problem with a
 * different fix, and a reader who mistakes this for it will stop looking for
 * the real one.
 *
 * **And it is not evenly distributed.** Unbounded by retention, the largest
 * beneficiary in a Japanese box is the municipal school system, whose every
 * building carries a bot-minted identifier: 300 of 859 name-agreeing pairs in
 * the Tokyo box are one civic record matching another. Schools sit below
 * `EXPERIENCE_CREDIBILITY_FLOOR`, so `composeExperienceSignificance` scales
 * their evidence contribution towards nothing and the damage is bounded by a
 * mechanism that already exists — but the bound is doing real work here, and
 * anyone loosening it should know this channel is leaning on it.
 *
 * ## Why all three of name, kind and geometry are required
 *
 * Any one alone, and any two of the three, produce false transfers at a rate
 * that would make this worse than silence. Name plus proximity alone, measured
 * on the same Tokyo box, matches a ramen restaurant to the river it is named
 * after at 94 m, a second-hand shop to a school, a railway station to the power
 * station across the road, and — at the box's most famous address — a bridge to
 * a railway stop 360 m away. Requiring the two records to be the same *kind* of
 * thing removes every one of those, because a restaurant is not a river and a
 * bridge is not a stop.
 *
 * The transfers that survive all three tests are the ones a person would make:
 * a municipal park and its own polygon, a botanical garden, a zoo, a named
 * bridge, a moat, a canal.
 *
 * ## The conflation guard
 *
 * One identifier reaches at most one record — the nearest. Without it, 6.7% of
 * transferred identifiers in Tokyo and 8.1% in Lisbon were claimed by several
 * records at once, and an identifier spread across several records is the exact
 * shape of §8.3's "one source becoming global truth". Losing a legitimate second
 * claimant (a long river has several representative points) costs an absent
 * channel, which this model is built to carry; inventing one costs a card that
 * says a place matters because its neighbour does.
 * ============================================================================
 */

/** Where a record's knowledge-base evidence came from, or why there is none. */
export type KnowledgeBaseOrigin =
  /** The record's own layer published the identifier. */
  | 'own_layer'
  /** An independently-published twin in a different layer published it. */
  | 'cross_layer'
  /**
   * The record's layer published no knowledge-base identifier for anything, so
   * this absence is not an observation about the place. Distinct from `absent`
   * because "we asked and nobody has heard of it" and "we could not ask" are
   * different sentences, and only the first is evidence.
   */
  | 'unobservable'
  /** The layer answers the question and the answer for this record is no. */
  | 'absent';

export interface KnowledgeBaseEvidence {
  /**
   * Absent — not `false` — when the origin is `unobservable`.
   *
   * `assessPlaceStanding` treats an absent channel as "nothing established" and
   * a `false` as an observation, and the two must not be conflated at the one
   * layer where the observation was never possible.
   */
  inKnowledgeBase?: boolean;
  encyclopaedicArticle?: boolean;
  origin: KnowledgeBaseOrigin;
  /** The layer the evidence was carried from. Set only for `cross_layer`. */
  fromLayerId?: string;
}

const UNOBSERVABLE: KnowledgeBaseEvidence = Object.freeze({ origin: 'unobservable' });

/**
 * How far a twin's own representative point may sit from the record it
 * describes, before its published extent is taken into account.
 *
 * A place catalogue records a garden at its entrance and a land-use catalogue
 * records the same garden at the centroid of its polygon; on the measured boxes
 * that separation runs to about 250 m for true pairs. Beyond it the pair is
 * carried only by the twin's *published* boundary — never by an assumed radius,
 * which is proximity wearing a better name.
 */
const KNOWLEDGE_TWIN_BASE_METRES = 250;

/** The most a published boundary may widen the search. */
const KNOWLEDGE_TWIN_MAX_METRES = 2_000;

function twinRadiusMetres(donor: SourceRecord): number {
  if (!donor.bounds) return KNOWLEDGE_TWIN_BASE_METRES;
  const diagonal = metresBetween(donor.bounds.southWest, donor.bounds.northEast);
  return Math.min(KNOWLEDGE_TWIN_MAX_METRES, Math.max(KNOWLEDGE_TWIN_BASE_METRES, diagonal / 2));
}

function foldedNamesOf(record: SourceRecord): Set<string> {
  const names = new Set<string>();
  for (const name of [record.name, ...record.alternateNames]) {
    const folded = normalizeName(name);
    if (folded.length > 1) names.add(folded);
  }
  return names;
}

/** About a kilometre of latitude, and the blocking key for twin search. */
function twinBucketKey(point: { lat: number; lng: number }): string {
  return `${Math.round(point.lat * 100)}:${Math.round(point.lng * 100)}`;
}

/**
 * Every record's knowledge-base evidence, resolved once over the whole pack.
 *
 * Pack-wide by necessity: whether a layer can answer the question at all is a
 * property of the layer's records taken together, and a twin lives in a
 * different layer by definition. See the block comment above for what this
 * reaches, what it does not, and why each of the three match tests is required.
 *
 * Exported so the transfer can be measured against real pack records rather than
 * inferred from a live build nobody can afford to run in a test.
 */
export function resolveKnowledgeBaseEvidence(
  records: readonly SourceRecord[],
  kindOf: (record: SourceRecord) => string,
): Map<string, KnowledgeBaseEvidence> {
  const evidence = new Map<string, KnowledgeBaseEvidence>();

  /*
   * Which layers answer the question at all, observed rather than declared.
   *
   * A layer none of whose records carries an identifier did not answer it for
   * any of them. A layer that publishes the column but happens to hold no
   * entries inside this box is indistinguishable from one that publishes no
   * column — correctly so, since in both cases we hold no observation and the
   * honest verdict is the same.
   */
  const answering = new Set<string>();
  for (const record of records) {
    if (record.wikidataId !== undefined || record.attributes.wikipedia !== undefined) {
      answering.add(record.layerId);
    }
  }

  const donors: SourceRecord[] = [];
  const recipients = new Map<string, SourceRecord[]>();
  for (const record of records) {
    if (record.wikidataId !== undefined) {
      evidence.set(record.id, {
        inKnowledgeBase: true,
        encyclopaedicArticle: hasEncyclopaedicArticle(record),
        origin: 'own_layer',
      });
      donors.push(record);
      continue;
    }
    evidence.set(
      record.id,
      answering.has(record.layerId)
        ? {
            inKnowledgeBase: false,
            encyclopaedicArticle: hasEncyclopaedicArticle(record),
            origin: 'absent',
          }
        : UNOBSERVABLE,
    );
    const key = twinBucketKey(record.coordinates);
    const bucket = recipients.get(key);
    if (bucket) bucket.push(record);
    else recipients.set(key, [record]);
  }

  /*
   * One identifier, one recipient — the nearest. Resolved by walking donors and
   * keeping the best candidate per identifier rather than per record, so a
   * namesake three hundred metres away cannot take an identifier that a record
   * three metres away also matched.
   */
  const claim = new Map<string, { recipient: SourceRecord; donor: SourceRecord; metres: number }>();
  for (const donor of donors) {
    const identifier = donor.wikidataId;
    if (identifier === undefined) continue;
    const donorNames = foldedNamesOf(donor);
    if (donorNames.size === 0) continue;
    const donorKind = kindOf(donor);
    const radius = twinRadiusMetres(donor);
    const lat = Math.round(donor.coordinates.lat * 100);
    const lng = Math.round(donor.coordinates.lng * 100);
    /*
     * Two cells out rather than one. A blocking cell is about a kilometre and
     * `twinRadiusMetres` can legitimately reach two, so a one-cell net would
     * silently refuse the pairs the radius was widened for.
     */
    const reach = Math.min(2, Math.ceil(radius / 1_000));
    for (let dLat = -reach; dLat <= reach; dLat += 1) {
      for (let dLng = -reach; dLng <= reach; dLng += 1) {
        for (const recipient of recipients.get(`${lat + dLat}:${lng + dLng}`) ?? []) {
          // (1) A different layer. Same-layer namesakes are the dedupe layer's
          //     business and carry no independent publication.
          if (recipient.layerId === donor.layerId) continue;
          // (2) The same kind of thing. This is the test that refuses a
          //     restaurant the identifier of the river it was named after.
          if (kindOf(recipient) !== donorKind) continue;
          // (3) The same name, in any script either side publishes — allowing
          //     exactly one trailing character of difference. A geographic
          //     layer names the feature with its class suffix fused into the
          //     word — the waterway carries one extra character naming what
          //     kind of water it is — while the place catalogue names the
          //     ground itself, and on a live metro pack that single character
          //     kept an encyclopaedic identity from ever reaching the famous
          //     district it attests: the witness stayed on the water layer and
          //     the district died at eligibility as unrecognisable. The kind
          //     test (2), the radius (4) and the one-recipient conflation
          //     guard still hold, so a one-character cousin that is genuinely
          //     a different thing still has to be the same kind of thing in
          //     the same place — and win the nearest-claim — to inherit
          //     anything.
          let named = false;
          for (const name of foldedNamesOf(recipient)) {
            if (
              donorNames.has(name) ||
              (name.length >= 3 && donorNames.has(name.slice(0, -1)))
            ) {
              named = true;
              break;
            }
            for (const donorName of donorNames) {
              if (donorName.length >= 3 && donorName.slice(0, -1) === name) {
                named = true;
                break;
              }
            }
            if (named) break;
          }
          if (!named) continue;
          // (4) Close enough that they can be one thing.
          const metres = metresBetween(recipient.coordinates, donor.coordinates);
          if (metres > radius) continue;

          const held = claim.get(identifier);
          if (
            !held ||
            metres < held.metres ||
            // A tie broken on the id, so the choice cannot depend on iteration
            // order and two builds of the same ground hash identically.
            (metres === held.metres && recipient.id < held.recipient.id)
          ) {
            claim.set(identifier, { recipient, donor, metres });
          }
        }
      }
    }
  }

  for (const { recipient, donor } of claim.values()) {
    evidence.set(recipient.id, {
      inKnowledgeBase: true,
      /*
       * The article travels with the identifier, from the same twin, or not at
       * all. Reading the recipient's own `wikipedia` attribute here would let a
       * record claim an article on evidence the transfer did not establish.
       */
      encyclopaedicArticle: hasEncyclopaedicArticle(donor),
      origin: 'cross_layer',
      fromLayerId: donor.layerId,
    });
  }

  return evidence;
}

/**
 * A COLLAPSE MUST NOT DELETE THE EVIDENCE THE LINKER JUST ESTABLISHED.
 *
 * `supersededRecordIds` keeps one record out of a group the linker said is one
 * entity, and `resolveKnowledgeBaseEvidence`'s conflation guard hands each
 * identifier to exactly one recipient. Run independently, the two compose into
 * a deletion: the identifier lands on the component member nearest its donor,
 * the collapse keeps a *different* member, and the surviving record of a place
 * the linker has just proven has an encyclopaedia entry enters ranking with no
 * evidence at all.
 *
 * Measured, not hypothetical: on the live Tokyo pack of 2026-08-13 a world
 * famous theme park was published as one land-use polygon (carrying the
 * knowledge-base identifier and the article) and three place-catalogue twins.
 * All four collapsed into one survivor; the evidence had landed on a collapsed
 * twin; the survivor scored kind-only and the destination lost the attraction
 * entirely — not to a judgement, to an intersection of two correct rules.
 *
 * So the survivor of each collapsing component inherits the strongest
 * knowledge-base evidence any member of its component holds, on the exact
 * precedent of `namesFromCollapsedTwins`: the linker asserted these records
 * are one thing, so a statement about any of them is a statement about the
 * survivor. Never a downgrade — a survivor whose own channel already answers
 * keeps its answer — and never an invention: only evidence a member actually
 * carried moves, and it moves to exactly one record, which preserves the
 * conflation guard's meaning now that the other claimants are out of every
 * pool.
 */
export function carryEvidenceToCollapseSurvivors(input: {
  records: readonly SourceRecord[];
  links: readonly CandidateLink[];
  superseded: ReadonlySet<string>;
  evidence: Map<string, KnowledgeBaseEvidence>;
}): void {
  const { records, links, superseded, evidence } = input;
  const present = new Map(records.map((record) => [record.id, record]));

  /* Union-find over the collapsing links, same membership as the collapse. */
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const link of links) {
    if (link.kind !== 'same_entity' && link.kind !== 'probable_same_entity') continue;
    const ids = link.recordIds.filter((id) => present.has(id));
    for (let index = 1; index < ids.length; index += 1) {
      const a = find(ids[0]!);
      const b = find(ids[index]!);
      if (a !== b) parent.set(b, a);
    }
  }

  const components = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const bucket = components.get(root);
    if (bucket) bucket.push(id);
    else components.set(root, [id]);
  }

  /** Strongest first: an article outranks a bare entry outranks nothing. */
  const strengthOf = (entry: KnowledgeBaseEvidence | undefined): number => {
    if (!entry?.inKnowledgeBase) return 0;
    return entry.encyclopaedicArticle ? 2 : 1;
  };

  for (const memberIds of components.values()) {
    const survivorId = memberIds.find((id) => !superseded.has(id));
    if (survivorId === undefined) continue;
    const own = evidence.get(survivorId);
    let best: { entry: KnowledgeBaseEvidence; fromId: string } | undefined;
    for (const memberId of memberIds) {
      if (memberId === survivorId) continue;
      const entry = evidence.get(memberId);
      if (strengthOf(entry) === 0) continue;
      if (
        best === undefined ||
        strengthOf(entry) > strengthOf(best.entry) ||
        (strengthOf(entry) === strengthOf(best.entry) && memberId < best.fromId)
      ) {
        best = { entry: entry!, fromId: memberId };
      }
    }
    if (!best || strengthOf(own) >= strengthOf(best.entry)) continue;
    evidence.set(survivorId, {
      inKnowledgeBase: true,
      encyclopaedicArticle: best.entry.encyclopaedicArticle ?? false,
      origin: 'cross_layer',
      fromLayerId: best.entry.fromLayerId ?? present.get(best.fromId)?.layerId ?? '?',
    });
  }
}

/**
 * The collapse's components, walked the way the collapse walks them.
 *
 * Shared by every carry below so no two of them can disagree about membership:
 * `same_entity` and `probable_same_entity` links whose both ends are present.
 */
function collapseComponentsOf(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
): string[][] {
  const present = new Set(records.map((record) => record.id));
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };
  for (const link of links) {
    if (link.kind !== 'same_entity' && link.kind !== 'probable_same_entity') continue;
    const ids = link.recordIds.filter((id) => present.has(id));
    for (let index = 1; index < ids.length; index += 1) {
      const a = find(ids[0]!);
      const b = find(ids[index]!);
      if (a !== b) parent.set(b, a);
    }
  }
  const components = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    const bucket = components.get(root);
    if (bucket) bucket.push(id);
    else components.set(root, [id]);
  }
  return [...components.values()];
}

/**
 * A mark on any member of a collapsing component reaches its survivor.
 *
 * The same statement `carryEvidenceToCollapseSurvivors` makes about
 * knowledge-base evidence, for a set-shaped mark: the linker has proven these
 * records are one thing, so an attestation of any of them is an attestation of
 * the one that survives. Mutates `marked` in place; never removes a mark.
 */
export function carryMarksToCollapseSurvivors(input: {
  records: readonly SourceRecord[];
  links: readonly CandidateLink[];
  superseded: ReadonlySet<string>;
  marked: Set<string>;
}): void {
  for (const memberIds of collapseComponentsOf(input.records, input.links)) {
    const survivorId = memberIds.find((id) => !input.superseded.has(id));
    if (survivorId === undefined || input.marked.has(survivorId)) continue;
    if (memberIds.some((id) => id !== survivorId && input.marked.has(id))) {
      input.marked.add(survivorId);
    }
  }
}

/**
 * WHERE THE ENTITY STANDS IS A STATEMENT ABOUT THE ENTITY.
 *
 * A collapse survivor that publishes an address with no division evidence
 * falls to `membership_unknown` — demoted out of the anchor slot, invisible to
 * the planner — while the superseded twin the linker has proven is the same
 * entity carries the division chain the overlay needs. Measured on a stored
 * §29-A pack: a destination's headline observation tower survived its collapse
 * with an empty chain, read `membership_unknown` against a division-shaped
 * trip scope, and lost its anchor seat to the demotion — while its superseded
 * twin held the whole ancestry.
 *
 * So a survivor with no division evidence inherits its component's, on the
 * exact precedent of `namesFromCollapsedTwins` and
 * `carryEvidenceToCollapseSurvivors`. Never a downgrade — a survivor with any
 * division evidence of its own keeps it untouched — and never an invention:
 * only containment a member actually carried moves, chosen deterministically
 * (the longest chain, ties to the lower id), and locality follows only when
 * the survivor has none. Runs before the overlay is built, which is the whole
 * point: the overlay must judge the entity's ground, not one catalogue's
 * addressing gap.
 */
export function carryMembershipToCollapseSurvivors(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
  superseded: ReadonlySet<string>,
): SourceRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  const patched = new Map<string, SourceRecord>();
  for (const memberIds of collapseComponentsOf(records, links)) {
    const survivorId = memberIds.find((id) => !superseded.has(id));
    if (survivorId === undefined) continue;
    const survivor = byId.get(survivorId);
    if (!survivor || survivor.containment.divisionIds.length > 0) continue;
    let donor: SourceRecord | undefined;
    for (const id of memberIds) {
      if (id === survivorId) continue;
      const member = byId.get(id);
      if (!member || member.containment.divisionIds.length === 0) continue;
      if (
        !donor ||
        member.containment.divisionIds.length > donor.containment.divisionIds.length ||
        (member.containment.divisionIds.length === donor.containment.divisionIds.length &&
          member.id < donor.id)
      ) {
        donor = member;
      }
    }
    if (!donor) continue;
    patched.set(survivorId, {
      ...survivor,
      containment: {
        ...survivor.containment,
        divisionIds: [...donor.containment.divisionIds],
        ...(survivor.containment.localityName === undefined &&
        donor.containment.localityName !== undefined
          ? { localityName: donor.containment.localityName }
          : {}),
      },
    });
  }
  if (patched.size === 0) return [...records];
  return records.map((record) => patched.get(record.id) ?? record);
}

/** What the evidence pass reached, so a reader can see it rather than infer it. */
export interface KnowledgeBaseDiagnostics {
  /** Records that carried an identifier in their own layer. */
  ownLayer: number;
  /** Records that gained one from a twin, and which layer each came from. */
  crossLayer: number;
  crossLayerByDonorLayer: { layerId: string; gained: number }[];
  /** Records whose layer answers the question and has no entry for them. */
  unevidenced: number;
  /**
   * Records whose layer publishes no knowledge-base identifier at all.
   *
   * The number §8.3 needs and nothing previously reported: an inventory where
   * this is the whole of the pack is not an inventory of obscure places, it is
   * an inventory nobody asked the question about.
   */
  unobservable: number;
}

function knowledgeBaseDiagnostics(
  records: readonly SourceRecord[],
  evidence: ReadonlyMap<string, KnowledgeBaseEvidence>,
): KnowledgeBaseDiagnostics {
  let ownLayer = 0;
  let crossLayer = 0;
  let unevidenced = 0;
  let unobservable = 0;
  const byDonor = new Map<string, number>();
  for (const record of records) {
    const entry = evidence.get(record.id);
    switch (entry?.origin) {
      case 'own_layer':
        ownLayer += 1;
        break;
      case 'cross_layer':
        crossLayer += 1;
        byDonor.set(entry.fromLayerId ?? '?', (byDonor.get(entry.fromLayerId ?? '?') ?? 0) + 1);
        break;
      case 'unobservable':
        unobservable += 1;
        break;
      default:
        unevidenced += 1;
    }
  }
  return {
    ownLayer,
    crossLayer,
    crossLayerByDonorLayer: [...byDonor]
      .map(([layerId, gained]) => ({ layerId, gained }))
      .sort((a, b) => b.gained - a.gained || a.layerId.localeCompare(b.layerId)),
    unevidenced,
    unobservable,
  };
}

/**
 * Vocabulary keys whose *values* name a class rather than describe an instance.
 *
 * Passed to the standing assessor, which keeps only the values that name a
 * conferred status — a reserve, a protected area, a listing. Everything else in
 * them is a kind of thing and is ignored there, so widening this list can add
 * evidence and cannot invent it.
 *
 * It exists because the assessor was only ever shown the record's own category
 * and category path, and a designation is very often recorded one level down:
 * a record classified `park` by its catalogue carries `leisure=nature_reserve`
 * among its attributes, and on real packs that is the single most common way a
 * designation is stated at all. The local-significance channel was therefore
 * silent across whole regions while the evidence for it sat in the record.
 */
const CLASSIFYING_ATTRIBUTE_KEYS = [
  'boundary',
  'heritage',
  'historic',
  'landuse',
  'leisure',
  'natural',
  'protect_class',
  'protection_title',
  'site_type',
  'tourism',
] as const;

/**
 * The ground a designation would have been conferred on, when there is any.
 *
 * Spread rather than assigned so an absent outline stays absent: a point
 * feature has no extent, and writing `0` would say "somebody measured this and
 * it is nothing" about a measurement nobody took. `assessPlaceStanding` reads
 * it as the second half of `hasConferredDesignation` — the half that separates
 * a designated area from a shop filed under a park word.
 */
function designatedExtentOf(record: SourceRecord): { mappedExtentMetres?: number } {
  const extent = mappedExtentMetres(record);
  return extent === undefined ? {} : { mappedExtentMetres: extent };
}

/**
 * THE SITES A SEAT IS ALLOWED TO HEAR ABOUT — the operator channel may not
 * order seats.
 *
 * `authority_publication` observes that a record's published address sits on a
 * government domain, and what that attests is the OPERATOR — who runs the
 * place — never the place (`SIGNIFICANCE_CHANNELS`, `attests: 'its_operator'`).
 * The witness gates already refuse it (`hasSignificanceEvidence` reads only
 * place-attesting channels), but the *ordering* still heard it at weight 0.5,
 * and on the live Tokyo pack of 2026-08-13 that one channel lifted 299 of
 * 3,680 place records — the whole top of the attraction pool was "things a
 * government runs": a mint's branch office and a ministry's registry row of a
 * memorial stone outranked every unevidenced temple and museum in the city,
 * and the memorial's inflated standing then defeated the fit layer's
 * evidence-limited label cap and read "Top pick for you" on a real board.
 *
 * So the standing that *orders seats and stamps ranking fields* is assessed
 * over only the sites that are addressed to the subject: a page whose path
 * names the place (in any of the record's names — the primary is CJK on the
 * packs this matters for, and the romanised alternate is the one a URL can
 * carry) is a statement about the place; a bare government host is a statement
 * about its landlord. Non-authority sites pass through untouched — they never
 * fire an authority channel, so keeping them changes nothing and drops
 * nothing.
 *
 * The FULL standing — bare operator pages included — still feeds the witness
 * gates (where the operator channel already has no vote) and the card's
 * description, whose trust line about who runs a place is honest copy rather
 * than a rank.
 */
export function subjectAddressedSites(record: {
  name: string;
  alternateNames: readonly string[];
  websiteCandidates: readonly string[];
}): string[] {
  return record.websiteCandidates.filter((url) => {
    if (!isAuthorityPublishedSite(url)) return true;
    return [record.name, ...record.alternateNames].some((name) =>
      authorityPageNamesSubject(name, [url]),
    );
  });
}

/** Everything the record says about *what class of thing* it is. */
function classifyingValuesOf(record: SourceRecord): string[] {
  return [
    record.sourceCategory,
    ...record.sourceCategoryPath,
    ...CLASSIFYING_ATTRIBUTE_KEYS.flatMap((key) => {
      const value = record.attributes[key];
      return value === undefined ? [] : [`${key}=${value}`];
    }),
  ];
}

/**
 * Records that two different layers independently found.
 *
 * The only thing in this pipeline that earns `multiple_providers_agree`. A
 * conflated catalogue listing four contributors inside one row does not, because
 * we did not watch it conflate them and cannot say they agreed.
 */
function crossLayerCorroboration(
  records: readonly SourceRecord[],
  links: readonly CandidateLink[],
): Set<string> {
  const layerOf = new Map(records.map((record) => [record.id, record.layerId]));
  const corroborated = new Set<string>();
  for (const link of links) {
    if (link.kind !== 'same_entity' && link.kind !== 'probable_same_entity') continue;
    const layers = new Set(link.recordIds.map((id) => layerOf.get(id)).filter(Boolean));
    // Two *distinct layers*, stated positively — the architecture test reads
    // this guard structurally, and corroboration without it is the defect the
    // rule exists to police.
    const independentSources = layers.size >= 2;
    if (!independentSources) continue;
    for (const id of link.recordIds) corroborated.add(id);
  }
  return corroborated;
}

/**
 * Records the region's own geography is named for.
 *
 * A local-significance channel that no single record can see, and one that owes
 * nothing to a knowledge base: when the administrative layer draws an area
 * carrying a place's name, or a record's own containing locality or neighbourhood
 * is called what the record is called, the place is what the surrounding ground
 * is named after. That is somebody local having decided it matters, recorded in
 * the geography rather than in a listing — which is exactly the evidence the old
 * metadata-count model had no channel for.
 *
 * Fold-matched, so casing, accents and punctuation do not decide it.
 */
function regionNamesakes(pack: RegionPack): Set<string> {
  const areaNames = new Set<string>();
  for (const layer of pack.layers) {
    if (layer.kind !== 'administrative_divisions') continue;
    for (const record of layer.records) areaNames.add(foldForMatch(record.name));
  }

  const namesakes = new Set<string>();
  for (const layer of pack.layers) {
    if (layer.kind === 'administrative_divisions') continue;
    for (const record of layer.records) {
      const folded = foldForMatch(record.name);
      if (folded.length === 0) continue;
      const containers = [
        record.containment.neighbourhoodName,
        record.containment.localityName,
      ].filter((name): name is string => name !== undefined);
      if (areaNames.has(folded) || containers.some((name) => foldForMatch(name) === folded)) {
        namesakes.add(record.id);
      }
    }
  }
  return namesakes;
}

// ---------------------------------------------------------------------------
// Ground-namesake attestation — the other half of the region_namesake channel
// ---------------------------------------------------------------------------

/**
 * RECORDS THE GROUND ITSELF IS NAMED AFTER, HEARD AT SEAT TIME.
 *
 * The failure this closes, measured on two stored §29-A packs: every
 * evidence-starved record of a gated kind ties at its kind prior, so the
 * degraded per-kind seats — and the cut under every witnessed tie band — were
 * decided by lexicographic UUID order. The destination's headline sacred sites
 * sat at ranks 31, 78 and 80 of 94 *inside their own kind* while three
 * arbitrary halls took the seats.
 *
 * What the pack itself publishes is not a tie: other records carry the
 * landmark's name inside their own — its gate, its garden, the tea house at
 * its door — and none carries the name of any of its six hundred
 * neighbourhood twins. People name things after the landmark next to them.
 * That is `region_namesake` evidence (`SIGNIFICANCE_CHANNELS`, attests
 * `its_name`): a statement made by records *other than* this one, which a
 * mapper cannot manufacture by filling their own listing in more completely —
 * the §8.3 line — and which raises a standing without ever opening the
 * witness gate, so no admission rule is weakened by hearing it.
 *
 * The retention layer already computes this channel over the full decoded
 * ground (`GroundNamesakeLedger`, in the provider that builds packs). This
 * function asks the same question of the one population a stored pack still
 * holds — its own retained records — so a pack can be re-seated offline
 * without recompiling. The witness thresholds differ from the retention
 * ledger's for a stated reason: retention scans hundreds of thousands of
 * decoded rows and can demand a crowd, while a pack retains a few thousand
 * survivors — every one of which has itself been kept over the ground's
 * commodity rows, so each retained namesake is a stronger statement and there
 * are structurally fewer of them. Measured on two stored §29-A packs, the
 * true pairs come in exactly two shapes, and each is a rule:
 *
 * - **A member of the complex.** One record standing *on* the ground, wearing
 *   the name — a temple's own sacred tree at 78 m, its own cemetery parcel at
 *   64 m, a gallery at a bridge's abutment at 56 m. Distance is measured the
 *   way the knowledge-twin transfer measures it (`twinRadiusMetres`): a base
 *   of `GROUND_NAMESAKE_MEMBER_BASE_METRES`, widened by the witness's own
 *   published boundary — a polygon is recorded at its centroid, hundreds of
 *   metres from the point record of the thing it belongs to — and never by an
 *   assumed radius.
 * - **A named precinct.** At least `GROUND_NAMESAKE_MIN_WITNESSES` distinct
 *   namesakes within `GROUND_NAMESAKE_PRECINCT_METRES` — a landmark's outer
 *   grounds and stadium were measured at 1.5 km from the record they are
 *   named for. The bound is the twin transfer's own outer bound; one namesake
 *   at that distance is an echo and attests nothing.
 *
 * And the guards, each closing a measured false-positive class:
 *
 * - **Brands.** One key worn by several *target* records standing further
 *   apart than the precinct bound is a chain's name, not a place — a branch
 *   store attested by the branch beside it would be a "complex" in every
 *   city. Such a key attests no one (the ledger's own brand refusal, applied
 *   to targets).
 * - **Generic names.** A key embedded more than
 *   `GENERIC_NAME_EMBEDDING_CEILING` times is a common word unless its
 *   embeddings cluster (`GROUND_NAMESAKE_NEAR_SHARE` inside the precinct): a
 *   name-giver's namesakes surround it, a common noun is uniform over a city.
 * - **The geography's own names.** A key equal to the record's containment
 *   names — or to the name of *any* administrative division in the pack —
 *   never attests. A record wearing a district's name took the name from the
 *   geography, and its "namesakes" are the district's: on the measured packs
 *   this class was station areas, a ward's landfill and district rows filed
 *   as historic sites, each "attested" by every shop named after the
 *   neighbourhood around it. Which way a naming ran is not in the record, so
 *   a shared administrative name attests nothing (the seat layer's
 *   public-housing lesson). Divisions are witnesses for others, never targets.
 * - **Strict embedding.** An equal name is a duplicate, not a namesake.
 * - **Joined renderings.** A primary published as two scripts joined by a
 *   slash or a parenthesis yields its segments, because no namesake's name
 *   can embed the joined form whole.
 * - **Witnesses are heard under every rendering they publish** — primary,
 *   joined-rendering segments and alternates — exactly as targets are keyed,
 *   with one vote per witness per key. A catalogue that retains a landmark
 *   under one script and its namesakes under another is otherwise a channel
 *   outage for precisely the records the channel exists to hear. See
 *   `witnessRenderingKeysOf`.
 */
export const GROUND_NAMESAKE_MEMBER_BASE_METRES = 250;

/** The twin transfer's outer bound, and this channel's: nothing reaches past it. */
export const GROUND_NAMESAKE_PRECINCT_METRES = 2_000;

/** Distinct precinct namesakes required when no witness stands on the complex. */
export const GROUND_NAMESAKE_MIN_WITNESSES = 2;

/** Embeddings beyond this are a common word unless they cluster. */
export const GENERIC_NAME_EMBEDDING_CEILING = 64;

/** The share of a busy key's embeddings that must stand inside the radius. */
export const GROUND_NAMESAKE_NEAR_SHARE = 0.5;

/*
 * Key eligibility is script-aware for the reason the authority-page test has a
 * minimum: a short Latin run collides by accident, while an ideographic script
 * carries a word per character — and a measured ground's own palace is exactly
 * two characters long.
 */
const ATTESTATION_KEY_MIN_CHARS = 2;
const ATTESTATION_ASCII_KEY_MIN_CHARS = 8;
const WITNESS_NAME_MIN_CHARS = 3;
/** Names are scanned for embedded keys up to this many folded characters. */
const WITNESS_SCAN_MAX_CHARS = 40;

/** A name as the attestation index reads it: folded, no separators at all. */
function groundNameKeyOf(name: string): string {
  return foldForMatch(name).replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * How far a record's word reaches for the member test, the twin transfer's
 * way: its own published boundary and nothing assumed. A polygon is recorded
 * at its centroid, hundreds of metres from the point record of the thing it
 * belongs to.
 */
function boundaryReach(record: SourceRecord): number {
  if (!record.bounds) return GROUND_NAMESAKE_MEMBER_BASE_METRES;
  const diagonal = metresBetween(record.bounds.southWest, record.bounds.northEast);
  return Math.min(
    GROUND_NAMESAKE_PRECINCT_METRES,
    Math.max(GROUND_NAMESAKE_MEMBER_BASE_METRES, diagonal / 2),
  );
}

function attestationKeyEligible(key: string): boolean {
  if (/^[\x20-\x7e]*$/.test(key)) return key.length >= ATTESTATION_ASCII_KEY_MIN_CHARS;
  return key.length >= ATTESTATION_KEY_MIN_CHARS;
}

/**
 * The renderings a joined primary carries, or nothing for a plain name.
 * Parenthesised groups and slash joiners both yield their segments; the
 * eligibility guards downstream are unchanged, so this widens what can be
 * heard, never what is believed.
 */
function renderingSegmentsOf(name: string): string[] {
  const segments: string[] = [];
  const groups = [...name.matchAll(/[(（]([^)）]+)[)）]/gu)];
  if (groups.length > 0) {
    for (const group of groups) segments.push(group[1]!);
    segments.push(name.replace(/[(（][^)）]*[)）]/gu, ' '));
  } else {
    segments.push(name);
  }
  const rendered = segments.flatMap((segment) => segment.split(/[/／]/));
  return rendered.length > 1 ? rendered : [];
}

/**
 * EVERY RENDERING A WITNESS PUBLISHES, HEARD — one vote per witness per key.
 *
 * The witness scan used to read `record.name` alone, while the *target* side
 * already heard the primary, its joined-rendering segments and the published
 * alternates. That asymmetry is a measured §29-A defect: on the stored
 * second-metropolis pack, the destination's headline castle is retained under
 * its catalogue's Latin-only primary, its six in-precinct namesakes name the
 * complex in the local script — and the one retained record that bridges the
 * two renderings, the castle's own park polygon 145 m away, carries the Latin
 * rendering *as a published alternate name*. The channel was deaf to it, so
 * the record the ground names six times composed at its bare kind prior and
 * lost the anchor band to a tie-band lottery of galleries.
 *
 * Hearing a witness under every rendering it publishes is the same rule the
 * target keys already follow — "widens what can be *heard*, never what is
 * believed": every guard downstream (strict embedding, division and
 * containment bans, the brand refusal, the generic-name clustering) is
 * unchanged, and the `matched` set spans all of one witness's renderings, so
 * a record with four translations of one name still counts as one witness
 * for any key — a mapper cannot raise a count by translating their own
 * listing more times.
 */
function witnessRenderingKeysOf(record: SourceRecord): string[] {
  const keys = new Set<string>();
  const consider = (text: string): void => {
    const key = groundNameKeyOf(text);
    if (key.length >= WITNESS_NAME_MIN_CHARS) keys.add(key);
  };
  consider(record.name);
  for (const segment of renderingSegmentsOf(record.name)) consider(segment);
  for (const alternate of record.alternateNames) consider(alternate);
  return [...keys];
}

/** The keys under which a record may be recognised as a name-giver. */
function groundAttestationKeysOf(record: SourceRecord): string[] {
  const banned = new Set(
    [record.containment.neighbourhoodName, record.containment.localityName]
      .filter((name): name is string => typeof name === 'string')
      .map((name) => groundNameKeyOf(name)),
  );
  const keys = new Set<string>();
  const consider = (text: string): void => {
    const key = groundNameKeyOf(text);
    if (attestationKeyEligible(key) && !banned.has(key)) keys.add(key);
  };
  consider(record.name);
  for (const segment of renderingSegmentsOf(record.name)) consider(segment);
  for (const alternate of record.alternateNames) consider(alternate);
  return [...keys];
}

/**
 * Which records the pack's own ground attests, by the rule above.
 *
 * Deterministic by construction — counting distinct entries is independent of
 * arrival order — and linear in the records whatever the names look like: for
 * each leading two characters the index holds the distinct key lengths that
 * occur under them, so each position of each name probes one substring per
 * length rather than a candidate list that goes quadratic on uniform names.
 */
export function groundNamesakeAttestations(records: readonly SourceRecord[]): Set<string> {
  return groundNamesakeWitnesses(records).attested;
}

/**
 * The attestation verdict *with its grade*: how many distinct guard-passing
 * witnesses stand near each attested target, under its loudest key.
 *
 * The ground publishes a graded signal, and flattening it to one bit is the
 * exact defect the pack builder's retention ledger already names: a landmark
 * the surrounding ground names eight times tied with a pond named twice, and
 * the tie broke on an id lottery. The retention layer therefore orders on the
 * measured near-witness count — and the seat layer, which re-asks the same
 * question of a stored pack's retained records, flattened the same answer.
 *
 * The count is per attested target, the loudest guard-passing key (the same
 * read as the retention ledger's `witnessesByTarget`), and only for targets
 * the boolean verdict already accepts: every guard — brands, generic names,
 * the geography's own names, strict embedding — runs before anything is
 * counted, so a grade can never admit what the attestation refused.
 */
export interface GroundWitnessVerdict {
  /** Record ids the ground attests, exactly `groundNamesakeAttestations`. */
  attested: Set<string>;
  /** Distinct near witnesses per attested id, under its loudest key. ≥ 1. */
  witnessesByTarget: Map<string, number>;
  /**
   * Distinct near witnesses standing *beyond* the member bound, per attested
   * id — the precinct pointing at a landmark, with the complex's own
   * furniture excluded. The distinction is measured, not stylistic: a
   * multi-facility municipal park is "witnessed" by its own named ballfields
   * and plot numbers standing inside its own boundary, while a destination's
   * great shrine is named by a stadium and outer gardens two kilometres out.
   * A door that cannot tell those apart is no door; see the commonplace-kind
   * ground door in `composeExperienceSignificance`.
   */
  precinctByTarget: Map<string, number>;
}

export function groundNamesakeWitnesses(records: readonly SourceRecord[]): GroundWitnessVerdict {
  /* Any administrative division's name is the geography's, and attests nothing. */
  const divisionKeys = new Set<string>();
  for (const record of records) {
    if (record.planningRole !== 'administrative') continue;
    const key = groundNameKeyOf(record.name);
    if (key.length > 0) divisionKeys.add(key);
  }

  const targetsByKey = new Map<
    string,
    { id: string; lat: number; lng: number; reach: number }[]
  >();
  for (const record of records) {
    if (record.planningRole === 'administrative') continue;
    for (const key of groundAttestationKeysOf(record)) {
      if (divisionKeys.has(key)) continue;
      const sites = targetsByKey.get(key) ?? [];
      sites.push({
        id: record.id,
        lat: record.coordinates.lat,
        lng: record.coordinates.lng,
        reach: boundaryReach(record),
      });
      targetsByKey.set(key, sites);
    }
  }

  /* The brand refusal: a key worn by targets standing apart names a chain. */
  for (const [key, sites] of targetsByKey) {
    let brand = false;
    for (let index = 1; index < sites.length && !brand; index += 1) {
      if (metresBetween(sites[index]!, sites[0]!) > GROUND_NAMESAKE_PRECINCT_METRES) brand = true;
    }
    if (brand) targetsByKey.delete(key);
  }

  const gramLengths = new Map<string, number[]>();
  for (const key of targetsByKey.keys()) {
    const gram = key.slice(0, 2);
    const lengths = gramLengths.get(gram) ?? [];
    if (!lengths.includes(key.length)) lengths.push(key.length);
    gramLengths.set(gram, lengths);
  }
  for (const lengths of gramLengths.values()) lengths.sort((a, b) => a - b);

  const member = new Set<string>();
  const near = new Map<string, number>();
  const ring = new Map<string, number>();
  const total = new Map<string, number>();
  for (const witness of records) {
    const reach = boundaryReach(witness);
    /*
     * Spans every rendering of this witness, so a key heard under two of its
     * renderings is still one witness's statement. See `witnessRenderingKeysOf`.
     */
    const matched = new Set<string>();
    for (const witnessKey of witnessRenderingKeysOf(witness)) {
      const limit = Math.min(witnessKey.length - 1, WITNESS_SCAN_MAX_CHARS);
      for (let index = 0; index < limit; index += 1) {
        const lengths = gramLengths.get(witnessKey.slice(index, index + 2));
        if (!lengths) continue;
        for (const length of lengths) {
          /* Strict embedding only: an equal name is a duplicate, not a namesake. */
          if (length >= witnessKey.length || index + length > witnessKey.length) break;
          const key = witnessKey.slice(index, index + length);
          if (matched.has(key)) continue;
          const sites = targetsByKey.get(key);
          if (!sites) continue;
          matched.add(key);
          for (const site of sites) {
            if (site.id === witness.id) continue;
            const label = `${site.id} ${key}`;
            total.set(label, (total.get(label) ?? 0) + 1);
            const metres = metresBetween(witness.coordinates, site);
            if (metres <= GROUND_NAMESAKE_PRECINCT_METRES) {
              near.set(label, (near.get(label) ?? 0) + 1);
              /*
               * Beyond the member bound and inside the precinct: the ring of
               * witnesses that are not the complex's own furniture. Two
               * exclusions, both measured: distance (a witness standing on
               * the complex is a member, not the city pointing), and the
               * *annex shape* — a witness whose name merely extends the
               * target's own name from its first character ("<target> South
               * End", "<target> Fishing Area", "<target> Plot 23") is the
               * complex's own signage wherever it stands, which is how a
               * scattered multi-facility park counted its own point-mapped
               * facilities as a precinct. A witness that embeds the name
               * mid-way ("Silfra, <target>") is naming itself by the
               * landmark, which is the statement the ring exists to hear.
               */
              if (metres > Math.max(reach, site.reach) && index > 0) {
                ring.set(label, (ring.get(label) ?? 0) + 1);
              }
            }
            /*
             * On the complex when either published boundary closes the gap: a
             * garden polygon is recorded at its centroid, and equally the
             * name-giver's own polygon may be the boundary its witness stands
             * inside. Both are the twin transfer's rule, in both directions.
             */
            if (metres <= Math.max(reach, site.reach)) member.add(label);
          }
        }
      }
    }
  }

  const attested = new Set<string>();
  const witnessesByTarget = new Map<string, number>();
  const precinctByTarget = new Map<string, number>();
  for (const [label, nearCount] of near) {
    if (nearCount < GROUND_NAMESAKE_MIN_WITNESSES && !member.has(label)) continue;
    const totalCount = total.get(label) ?? nearCount;
    if (
      totalCount <= GENERIC_NAME_EMBEDDING_CEILING ||
      nearCount / totalCount >= GROUND_NAMESAKE_NEAR_SHARE
    ) {
      const id = label.slice(0, label.indexOf(' '));
      attested.add(id);
      /* The graded read: the target's loudest guard-passing key, per tier. */
      witnessesByTarget.set(id, Math.max(witnessesByTarget.get(id) ?? 0, nearCount));
      const ringCount = ring.get(label) ?? 0;
      if (ringCount > (precinctByTarget.get(id) ?? 0)) precinctByTarget.set(id, ringCount);
    }
  }
  return { attested, witnessesByTarget, precinctByTarget };
}

// ---------------------------------------------------------------------------
// Record → Place
// ---------------------------------------------------------------------------

export function toCandidate(input: {
  record: SourceRecord;
  scope: GeographicScope;
  crossLayerCorroborated: boolean;
  /** The role admission settled on. Stamped onto the place, never re-derived. */
  role: PlanningRole;
  /** Why this record is here at all. Required, so an external one must justify itself. */
  inclusion: InclusionReason;
  /**
   * Local-significance evidence the *pack* holds and a single record cannot.
   *
   * Optional because a caller with one record in hand genuinely does not know
   * it, and an absent channel has to stay absent rather than default to false
   * dressed up as a fact — see `assessPlaceStanding`.
   */
  namedInRegionRecords?: boolean;
  /**
   * The graded ground-witness count the pack holds for this entity — guard-
   * passed, loudest key, collapse-carried. A pack-wide fact for the same
   * reason as `namedInRegionRecords`; absent means the channel is silent for
   * this caller, never zero-as-a-fact.
   */
  groundWitnessCount?: number;
  /**
   * The beyond-boundary tier of the same graded verdict: distinct witnesses
   * standing outside the entity's own boundary and inside the precinct. Read
   * by the commonplace-kind ground door; see `GroundWitnessVerdict`.
   */
  groundPrecinctWitnesses?: number;
  /**
   * Whether the *entity* operationally expects visitors — the record's own
   * posted hours or fee, or a collapsed twin's, carried to the survivor.
   * Optional so a caller with one record in hand falls back to the record's
   * own attributes, which is what the field always read.
   */
  visitorsExpected?: boolean;
  /**
   * Whether the witness view attested this record — the same statement the
   * eligibility rescue heard (`placeAttested`). Read by the ranking weight
   * only, and only for a branch-matched kind: see `attestedKindWeight`.
   * Absent means unwitnessed, which keeps the borrowed prior.
   */
  placeAttested?: boolean;
  /**
   * Names published by the records this one collapsed, which it does not carry.
   *
   * Another pack-wide fact, and the one that decides whether a card can be
   * read: the twin the linker dropped is very often the record holding the
   * romanised or English name. See `namesFromCollapsedTwins`. Absent means "no
   * twin, or nothing new", which is the same card as before this existed.
   */
  namesFromTwins?: readonly string[];
  /**
   * Knowledge-base evidence the *pack* resolved, which a lone record cannot.
   *
   * Optional for the same reason `namedInRegionRecords` is: a caller holding one
   * record genuinely cannot say whether its layer publishes the identifier at
   * all, let alone whether a twin in another layer does. Omitting it falls back
   * to what the record itself carries, which for a primary place record is
   * structurally nothing — see `resolveKnowledgeBaseEvidence`.
   */
  knowledgeBase?: KnowledgeBaseEvidence;
  /**
   * True when this record was admitted through the outage-aware witness
   * degradation: its kind demands significance evidence, its layer publishes
   * the witness channel for nothing, and nothing else vouched. Stamps
   * `WITNESS_CHANNEL_SILENT_TAG` so every consumer can tell an unverified
   * admission from an established one.
   */
  witnessChannelSilent?: boolean;
}): DiscoveredCandidate {
  const { record, scope, crossLayerCorroborated, role, inclusion } = input;
  const knowledge: KnowledgeBaseEvidence = input.knowledgeBase ?? {
    inKnowledgeBase: record.wikidataId !== undefined,
    encyclopaedicArticle: hasEncyclopaedicArticle(record),
    origin: record.wikidataId !== undefined ? 'own_layer' : 'absent',
  };
  const taxonomy = classifySourceCategory({
    category: record.sourceCategory,
    path: record.sourceCategoryPath,
    attributes: record.attributes,
  });

  /**
   * FOUR DIFFERENT THINGS THAT USED TO BE ONE NUMBER.
   *
   * `popularity` was derived from *attribute count* — how many fields the source
   * happened to fill in, plus websites, plus a Wikidata id, over six — and then
   * a later pass narrowed it to knowledge-base evidence but left three more
   * fields reading off it: `hiddenGemScore = 1 − popularity`,
   * `crowdLevel = popularity > 0.7`, and a `source.confidence` of `0.7` that was
   * derived from nothing at all. One variable wearing four hats cannot let the
   * board's "must-see classics" and "hidden gems" disagree, because they were
   * the two ends of the same figure.
   *
   * `assessPlaceStanding` separates them. What is passed in here is *evidence*,
   * never a score: the policy for turning any of it into a number lives in one
   * module so that this producer and the live fallback cannot drift apart, as
   * they had — the other one was computing popularity as `tagCount / 5`.
   *
   * Two things worth naming about the arguments:
   *
   * `crossLayerCorroborated`, not the count of `record.sources`. A conflated
   * catalogue merges several contributors into one row and we did not watch it
   * merge them; only two *layers* finding the same thing is agreement, which is
   * the rule the confidence signals below are already held to.
   *
   * `attributes` and `alternateNames` reach `evidenceRichness` and stop there.
   * They are why the hours are known, the website is linkable and the card can
   * be read in English, and none of that is evidence that anybody cares about
   * the place. The name count in particular was still deciding the ordering one
   * rung below the gate it had already been thrown out of; it now counts as
   * what it is, which is two more facts somebody wrote down.
   */
  const standingFrom = (publishedSites: readonly string[]) =>
    assessPlaceStanding({
      /*
       * Spread rather than assigned, because an *absent* knowledge-base channel
       * and a `false` one are different claims. The primary place layer publishes
       * no knowledge-base identifier in any destination, so writing `false` there
       * would state "we looked and no encyclopaedia has heard of this" about a
       * question the source cannot answer — the exact invention §8.3 forbids, in
       * the direction that flatters nothing and is still a lie.
       */
      ...(knowledge.inKnowledgeBase !== undefined
        ? { inKnowledgeBase: knowledge.inKnowledgeBase }
        : {}),
      ...(knowledge.encyclopaedicArticle !== undefined
        ? { encyclopaedicArticle: knowledge.encyclopaedicArticle }
        : {}),
      knowledgeBaseNameCount: record.alternateNames.length,
      crossDatasetCorroboration: crossLayerCorroborated,
      publishedSites,
      subjectName: record.name,
      classifyingValues: classifyingValuesOf(record),
      ...designatedExtentOf(record),
      ...(input.namedInRegionRecords !== undefined
        ? { namedInRegionRecords: input.namedInRegionRecords }
        : {}),
      ...(input.groundWitnessCount !== undefined
        ? { groundWitnessCount: input.groundWitnessCount }
        : {}),
      recordedAttributeCount: Object.keys(record.attributes).length,
      /*
       * The only crowd evidence a pack carries. A `seasonal` tag says a year's
       * visitors arrive inside a short window; it says nothing about how many
       * there are, which is why it lands on `moderate` and never on `busy`.
       * Everything else stays absent rather than being guessed from prominence.
       */
      crowd: { seasonalConcentration: record.attributes.seasonal !== undefined },
    });
  const standing = standingFrom(record.websiteCandidates);
  /*
   * The standing the *ranking fields* are stamped from — same evidence minus
   * the pages that attest only a landlord. `standingFields` below writes
   * `localSignificance` and `hiddenness` onto the place, the fit scorer's
   * evidence-limited cap reads exactly those fields to decide whether a top
   * label is even reachable, and a memorial stone whose one page is a
   * ministry's registry row wore "Top pick for you" on a real board because a
   * bare government host was allowed to stand in for local significance. The
   * card's *description* still reads the full standing: who runs a place is an
   * honest sentence, not a rank. See `subjectAddressedSites`.
   */
  const seatStanding = standingFrom(subjectAddressedSites(record));
  /*
   * Kind × established evidence, composed once so the stamped score and the
   * stamped bound cannot disagree — including the witness bound, which must
   * stamp the same number the seat ordering ranked on, and whose verdict the
   * caption layer reads as `significanceBounded`.
   */
  const branchRescued =
    taxonomy.match.kind === 'source_branch' && input.placeAttested === true;
  /*
   * The urban-district reading below applies only to the *geography* branches
   * — the families whose archetype is unrecognised ground. A witnessed record
   * under an entertainment branch is still whatever the branch says it is.
   */
  const namedDistrict =
    branchRescued &&
    taxonomy.match.kind === 'source_branch' &&
    (taxonomy.match.key === 'geographic_entities' || taxonomy.match.key === 'natural_features') &&
    record.containment.localityName !== undefined;
  const seatSignificance = composeExperienceSignificance({
    standing: seatStanding,
    categoryWeight: attestedKindWeight(taxonomy, () => branchRescued),
    /* A branch-rescued record is not double-locked — see `significanceOf`. */
    witnessRequired:
      (taxonomy.requiresSignificanceEvidence || taxonomy.landscapeClaim) && !branchRescued,
    commonplaceKind: taxonomy.commonplaceNotice,
    expectsVisitors: input.visitorsExpected ?? recordExpectsVisitors(record),
    publishedSiteAtGate: taxonomy.plausiblyGated && record.websiteCandidates.length > 0,
    ...(input.groundPrecinctWitnesses !== undefined
      ? { groundPrecinctWitnesses: input.groundPrecinctWitnesses }
      : {}),
  });

  /*
   * The traveller-facing name, resolved once, here.
   *
   * The record's own `name` is the source's primary — the local script by
   * design — and a live English-interface board rendered a wall of it while
   * the records *held* romanised alternates, verified present and unused.
   * `display` leads; the native form travels beside it on `names.local` so a
   * card can render both (and set a `lang` attribute where a language is
   * known); `names.canonical` keeps the source's own name for provenance.
   *
   * The alternates a *collapsed twin* published are offered alongside the
   * record's own, because on a dense non-Latin pack that is where the readable
   * name lives: 71 of 123 Tokyo cards led in a script the reader cannot read
   * while the land-use record the linker had just dropped held the romanised
   * name for the same park. Names only, never data — see
   * `namesFromCollapsedTwins`.
   */
  const names = namesOf(record, input.namesFromTwins);

  const place: Place = {
    id: record.id,
    regionId: `compiled-${scope.destinationCandidateId}`,
    name: names.display,
    names,
    ...(taxonomy.displayKind ? { displayKind: taxonomy.displayKind } : {}),
    locality: localityOf(record, scope),
    shortDescription: describe(record, taxonomy, names),
    coordinates: record.coordinates,
    /**
     * The classifying category, plus the *names* of the attributes the source
     * recorded. Names, never values: which attributes exist is a quality signal
     * the assessor already reads, while a table of somebody's attribute values
     * would be a redistribution of their database.
     */
    tags: [
      `${record.layerId}=${record.sourceCategory}`,
      /*
       * The two facts a card cannot reconstruct and must not assume.
       *
       * A `Place` records what kind of thing something is; it has never
       * recorded what part it plays in a trip, and an airport and a market town
       * are both `town_and_food`. So the role travels with the place, written
       * once here and read wherever a card is built — and with it, the reason
       * this record is inside the traveller's destination at all.
       */
      placeRoleTag(role),
      placeInclusionTag(inclusion),
      ...Object.keys(record.attributes).map((key) => `attr:${key}`),
      ...(record.websiteCandidates.length > 0 ? ['attr:website'] : []),
      ...(record.wikidataId ? ['attr:wikidata'] : []),
      ...(input.witnessChannelSilent ? [WITNESS_CHANNEL_SILENT_TAG] : []),
    ],
    /*
     * Carried through rather than left on the source record.
     *
     * The backbone already linked this place to an open identifier — that is
     * what `attr:wikidata` above is counting — and dropping the identifier while
     * keeping a tag saying it existed meant imagery had to fall back to
     * searching a name it already had a key for.
     *
     * **The record's own identifier, never a transferred one**, and the
     * asymmetry with `inKnowledgeBase` above is deliberate. A transferred
     * identifier is evidence, bounded by `MAX_SINGLE_CHANNEL_WEIGHT` and
     * combined with five other channels before it moves anything. This field is
     * a *lookup key*: imagery resolves a photograph from it, so a transfer that
     * is right about significance and wrong about identity puts somebody else's
     * building on the card. Same evidence, different blast radius.
     */
    ...(record.wikidataId ? { wikidataId: record.wikidataId } : {}),
    source: {
      name: sourceNameOf(record),
      kind: 'osm',
      ...(officialUrlOf(record) ? { url: officialUrlOf(record)! } : {}),
      /*
       * Computed, where this was the constant `0.7`.
       *
       * A hardcoded confidence is a claim that somebody measured our confidence,
       * and it is listed in `provisional.ts` among the defensible defaults that
       * become assertions the moment they reach a card. It now moves with how
       * much the source actually recorded and whether a second catalogue agreed.
       */
      confidence: standing.sourceConfidence,
      lastVerified: (record.sources[0]?.updateTime ?? '').slice(0, 10) || '2026-01-01',
      element: {
        elementId: record.sourceId,
        database: record.layerId,
        licenceId: record.sources[0]?.licenceId ?? 'ODbL-1.0',
        ...(record.sources[0]?.updateTime ? { sourceTimestamp: record.sources[0].updateTime } : {}),
        ...(record.sourceUrl ? { url: record.sourceUrl } : {}),
      },
    },
    relationship: 'satellite',
    /*
     * A WITNESSED NAMED DISTRICT IS AN URBAN PLACE, NOT OPEN GROUND.
     *
     * The unrecognised-geography archetype borrows "easy walk" because that
     * is the one honest claim about *unspecified ground* — and it is the
     * wrong pool for the records the branch rescue admits inside a city: a
     * destination's famous canal quarter, filed by the catalogue as bare
     * geography, competed against municipal parks under a walking heading
     * and paid a lawn category's saturation for it. Where the geography
     * itself places the record inside a stated locality, named ground the
     * world attests is a district — the town-and-food family — and where no
     * locality contains it, it stays what the archetype says: ground.
     */
    category: namedDistrict ? 'town_and_food' : taxonomy.category,
    interests: namedDistrict
      ? ['food_and_towns']
      : taxonomy.interests.length > 0
        ? taxonomy.interests
        : ['scenic_viewpoints'],
    typicalDurationMinutes: taxonomy.typicalDurationMinutes,
    /**
     * Which of the required practical fields below are the archetype's guess.
     *
     * Every entry here is filled from the category table when the record
     * offers nothing better, and a live road-region board printed those
     * guesses as facts — a highland ice field as paved, easy, open all year
     * and busy. The marker is the general fix: the guess still ships (the
     * schema requires a value) and the card layer can now say "not verified"
     * instead of asserting it. Cost is unmarked where the source stated a
     * fee; season is unmarked where the source stated seasonality; crowd is
     * unmarked where real crowd evidence produced `crowdExpectation`.
     */
    estimatedDefaults: [
      'access' as const,
      ...(record.attributes.seasonal ? [] : ['seasonal_access' as const]),
      'physical_intensity' as const,
      ...(seatStanding.crowdExpectation !== undefined ? [] : ['crowd_level' as const]),
      ...(record.attributes.fee !== undefined ? [] : ['cost_level' as const]),
    ],
    /*
     * The archetype's constant, and marked as one. It rendered as a measured
     * fact — "Time there: 1 hr 30 min" for a river — and the marker is what
     * lets a card write "about" instead.
     */
    durationBasis: 'category_estimate',
    /*
     * Reconciled with the record's own fee evidence: a card must not say free
     * beside a description that says it charges. Only ever raised — a stated
     * fee proves a charge; a category's price band cannot prove one away.
     */
    costLevel:
      record.attributes.fee === 'yes' && taxonomy.costLevel === 0 ? 1 : taxonomy.costLevel,
    physicalIntensity: taxonomy.physicalIntensity,
    /*
     * Popularity, hidden-gem and crowd are *reads* of the standing above, and
     * the optional separated scores travel beside them. One spread rather than
     * three assignments, so this producer cannot invent a fallback of its own.
     * Read off `seatStanding`: these are the fields fit and the board rank and
     * gate labels on, and the operator channel may not decide significance.
     */
    ...standingFields(seatStanding),
    /*
     * Kind × established evidence, the §8.3 dimension. Computed beside the
     * standing it reads so the two can never disagree about their inputs —
     * including the witness bound, which must stamp the same number the seat
     * ordering ranked on. See `composeExperienceSignificance`.
     */
    experienceSignificance: seatSignificance.score,
    /*
     * The bound's verdict, stamped beside the score it capped: a rank the
     * model refused to let the evidence buy must not be captioned as an
     * established name or grouped as a classic. See the place schema.
     */
    ...(seatSignificance.witnessBounded ? { significanceBounded: true } : {}),
    /*
     * Whether "check its hours" is even a sensible sentence for this kind of
     * thing. A gated kind with unknown hours is a real warning; a river given
     * the same warning tells the traveller the machine does not know what a
     * river is — which a compiled build did, on every geographic feature.
     */
    hoursExpectation:
      taxonomy.plausiblyGated || record.attributes.fee === 'yes' ? 'gated' : 'open_ground',
    weather: {
      exposure: taxonomy.exposure,
      precipitation: taxonomy.exposure === 'indoor' ? 'low' : 'high',
      wind: taxonomy.exposure === 'exposed_outdoor' ? 'moderate' : 'low',
      heat: taxonomy.exposure === 'indoor' ? 'low' : 'moderate',
      cold: taxonomy.exposure === 'indoor' ? 'low' : 'moderate',
      visibilityDependent: taxonomy.visibilityDependent,
      poorWeatherBackup: taxonomy.poorWeatherBackup,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    /**
     * Open all year unless a source said otherwise.
     *
     * `seasonal` on a record is the mapper's own tag and is honoured; anything
     * else would be us inventing a snow gate. A real closure arrives later,
     * from an official page, with a date and a citation.
     */
    seasonalAccess: {
      openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      closureRisk: record.attributes.seasonal ? 'seasonal' : 'none',
    },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: scope.transport.carAvailable ? 'moderate' : 'hard',
      remoteNoServices: false,
    },
    travelFromBase: { distanceKm: 0, driveMinutes: 0, driveIsScenic: false },
  };

  const signals: ConfidenceSignal[] = crossLayerCorroborated
    ? ['multiple_providers_agree']
    : ['single_provider_only'];

  return {
    place,
    providerRefs: providerRefsOf(record),
    facts: [],
    confidenceSignals: signals,
  };
}

/**
 * One provider reference per distinct upstream dataset.
 *
 * Distinct, because a conflated record can list the same dataset twice — once
 * for the record and once for a derived property — and counting that as two
 * sources would make conflation look like corroboration.
 */
function providerRefsOf(record: SourceRecord): ProviderRef[] {
  const seen = new Set<string>();
  const refs: ProviderRef[] = [];
  for (const source of record.sources) {
    if (seen.has(source.dataset)) continue;
    seen.add(source.dataset);
    refs.push({
      provider: source.dataset,
      externalId: source.recordId ?? record.sourceId,
      ...(record.sourceUrl ? { url: record.sourceUrl } : {}),
    });
  }
  if (refs.length === 0) {
    refs.push({ provider: record.layerId, externalId: record.sourceId });
  }
  return refs;
}

/**
 * The operator's own domain where the source carried one.
 *
 * A link back into the source database is not an official site, and treating it
 * as one is how a research funnel spends its budget reading a map viewer.
 */
function officialUrlOf(record: SourceRecord): string | undefined {
  const candidate = record.websiteCandidates[0];
  if (!candidate) return undefined;
  if (/openstreetmap\.org|wikidata\.org|wikipedia\.org/i.test(candidate)) return undefined;
  return candidate;
}

function sourceNameOf(record: SourceRecord): string {
  const datasets = [...new Set(record.sources.map((source) => source.dataset))];
  return datasets.length > 0 ? datasets.join(', ') : record.layerId;
}

/**
 * The traveller-facing name set for a record, resolved once and read twice.
 *
 * The admission gate needs `names.local` to know whether "Known locally as …"
 * is a sentence this record can support, and `toCandidate` needs the same set
 * to build the card. Sharing the function is what keeps the gate's judgement
 * and the card's copy the same judgement.
 */
function namesOf(
  record: SourceRecord,
  fromTwins: readonly string[] = [],
): ReturnType<typeof resolveRecordDisplayName> {
  /**
   * The tagged English name, where a normaliser stashed one.
   *
   * `englishNames` is the resolver's brand-spelling tier: a name the source
   * *tagged* as English outranks a Latin-script primary, which is what stops
   * a flagship international brand rendering under a romanisation the brand
   * itself does not use. The tag does not survive into `SourceRecord` as a
   * field, so a normaliser that holds one stashes it in the free attribute
   * map under the vocabulary's own key. Only the tagged value is passed —
   * inferring "the first alternate must be the English one" would promote a
   * romanisation into a claim the source never made.
   */
  const tagged = record.attributes['name:en'];
  /*
   * What the card already prints beside the heading. A catalogue disambiguates
   * its rows by appending the containing division in brackets, and repeating
   * the locality inside the name is a property of somebody's index rather than
   * of the place — two live cards led with a ward name in brackets over a card
   * whose next line was the same locality. The resolver strips only a bracket
   * these names account for; anything that distinguishes one thing from another
   * survives.
   */
  const containing = [
    record.containment.neighbourhoodName,
    record.containment.localityName,
    record.containment.regionName,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  return resolveRecordDisplayName({
    name: record.name,
    alternateNames: [...record.alternateNames, ...fromTwins],
    source: sourceNameOf(record),
    ...(containing.length > 0 ? { redundantParentheticals: containing } : {}),
    ...(tagged !== undefined && tagged.length > 0 ? { englishNames: [tagged] } : {}),
  });
}

/**
 * WHERE A CARD SAYS THIS PLACE IS.
 *
 * A specificity chain — neighbourhood, then locality, then region, then the
 * destination the traveller actually asked for — and it used to take the first
 * entry that existed regardless of what it was written in. On a Tokyo pack that
 * is `世田谷区`, printed under an English heading beside a name §8.6's
 * resolution had already worked to make readable. A reader who cannot read the
 * script learns nothing at all from the most specific answer, and "Tokyo" is
 * less precise but is information.
 *
 * So: the most specific entry this interface's reader can actually read, tested
 * with `isLatinScript` — the naming module's own test, rather than a second
 * definition of "readable" living here.
 *
 * When nothing in the chain qualifies the original answer stands. §8.6 says not
 * to erase native names, and a locality in local script is better than a card
 * that does not say where it is.
 */
function localityOf(record: SourceRecord, scope: GeographicScope): string {
  const chain = [
    record.containment.neighbourhoodName,
    record.containment.localityName,
    record.containment.regionName,
    scope.destinationName,
  ].filter((value): value is string => value !== undefined && value.length > 0);
  return chain.find((value) => isLatinScript(value)) ?? chain[0] ?? scope.destinationName;
}

/**
 * EVERY SENTENCE A PACK RECORD CAN HONESTLY SUPPORT, BEYOND ITS OWN CATEGORY.
 *
 * Split out from `describe` because it is not only copy: it is the answer to
 * "is there anything to say about this at all", and §8.7 makes that a
 * *ranking* question rather than a wording one — *"If there is not enough
 * evidence to describe an obscure POI meaningfully, that itself is a
 * ranking/evidence signal."* Producing the sentences and judging the emptiness
 * from one function is what stops the two answers drifting apart, which is
 * exactly how fifty-two of ninety-nine live cards came to read "A plaza." while
 * a guard elsewhere believed it was preventing that.
 *
 * Never fabricated flavour, and **never provenance either**: every entry
 * restates something a source recorded *about the place*, not about the record.
 * The quality assessor treats a description over forty characters as one of
 * seven evidence marks, so a template that always produced a flowing sentence
 * would hand every candidate that mark and make the signal meaningless — which
 * is what the removed witness fallback did, on 45 of the 72 places of the three
 * stored journeys.
 */
function describedFacts(record: SourceRecord, names: { local?: string }): string[] {
  const facts: string[] = [];

  /*
   * A conferred status is the most interesting fact a pack record can carry:
   * somebody official decided this place matters, and that is the question a
   * description exists to answer.
   */
  if (
    hasConferredDesignation({
      classifyingValues: classifyingValuesOf(record),
      ...designatedExtentOf(record),
    })
  ) {
    facts.push('Holds a protected or heritage designation.');
  }
  if (names.local) facts.push(`Known locally as ${names.local}.`);
  const operator = record.attributes.operator;
  if (operator) facts.push(`Run by ${operator}.`);
  const elevation = record.attributes.ele;
  if (elevation && /^\d{2,5}$/.test(elevation)) facts.push(`Recorded at ${elevation} m.`);
  const fee = record.attributes.fee;
  if (fee === 'yes') facts.push('The map data records a charge to enter.');
  else if (fee === 'no') facts.push('The map data records no charge to enter.');

  /*
   * How big the thing is, from its own mapped outline.
   *
   * A sourced fact the pack has always carried and the description never read,
   * and the one a traveller most wants when the noun is "forest" or "park": a
   * thirty-metre patch of trees and a wood you can spend a morning in are the
   * same word. Below a hundred metres nothing is said, because at that size the
   * outline is as likely to be a mapping artefact as a measurement.
   */
  const extent = mappedExtentMetres(record);
  if (extent !== undefined) facts.push(`Mapped at roughly ${extent} m across.`);

  /*
   * WHEN NOTHING ELSE IS TRUE, SAY NOTHING ELSE.
   *
   * This branch used to push a `witnessSentence` — "Recorded in an open
   * knowledge base under this name.", "Named in the area's own published
   * geography.", "Published by a public authority as one of the places it
   * runs.", "Nothing beyond its name and position is published about it." — on
   * the reasoning that §8.7's banned bare-noun form ("A lake.", "A viewpoint.")
   * had to be prevented, and that a true sentence about provenance was the only
   * honest thing left to say.
   *
   * It is honest and it is not a description. Measured on the three stored
   * journeys of 2026-08-26: 45 of 72 compiled places carried one of those four
   * sentences, and on **all 45** it was the only thing said after the category
   * noun. So the card read "A museum in <locality>. Recorded in an open
   * knowledge base under this name." — §8.7's named failure with a clause about
   * our database bolted on, telling a traveller nothing about what the place is
   * or why to go. Worse, it was spliced verbatim into the fit model's "you
   * marked X, and that is what this delivers: …" sentence, so a provenance
   * clause was rendered as the offer.
   *
   * §8.7 makes the emptiness a **ranking** question, not a wording one, and the
   * ranking channel already exists: the quality assessor counts a description
   * over forty characters as one of its evidence marks, and a bare opening
   * ("An easy walk in <locality>.") does not reach forty. So the thinness now
   * reads as thinness instead of buying the mark with a sentence that says we
   * know nothing. The `nothingIsPublishedAboutIt` predicate — which is what the
   * pre-selection pass actually gates an anchor slot on — reads the standing
   * model directly and is unaffected by this sentence existing or not.
   */
  return facts;
}

/**
 * The longer side of the record's own outline, in metres, when it is big enough
 * to be worth stating. Undefined for a point feature or a hair-width polygon.
 */
function mappedExtentMetres(record: SourceRecord): number | undefined {
  const bounds = record.bounds;
  if (!bounds) return undefined;
  const latMetres = (bounds.northEast.lat - bounds.southWest.lat) * 111_320;
  const midLat = ((bounds.northEast.lat + bounds.southWest.lat) / 2) * (Math.PI / 180);
  const lngMetres = (bounds.northEast.lng - bounds.southWest.lng) * 111_320 * Math.cos(midLat);
  const longest = Math.max(latMetres, lngMetres);
  if (!Number.isFinite(longest) || longest < 100) return undefined;
  /* Two significant figures: the outline does not support more than that. */
  const rounded = longest >= 1000 ? Math.round(longest / 100) * 100 : Math.round(longest / 10) * 10;
  return rounded;
}

/**
 * A description built from facts, and refused rather than shortened when there
 * are none.
 *
 * Deliberately not prose, and never fabricated flavour. What this produces
 * grows only when the source actually recorded something worth saying — a
 * designation, an operator, an elevation, an extent, a native name — so its
 * length tracks evidence rather than style.
 *
 * The opening sentence is still the category, because a reader needs to know
 * what kind of thing they are looking at before anything else — but it is never
 * the *whole* description, because a description that is only a category is
 * §8.7's named failure. `describedFacts` always returns at least one sentence,
 * so the banned form cannot be produced from here.
 *
 * Two lessons from the live board are baked in: the noun is the type-truthful
 * one ("river", never "lake" for a river), and the article agrees with it —
 * "A easy walk." shipped, and `an` before a vowel is not a nicety when it is
 * the first word a traveller reads.
 */
function describe(
  record: SourceRecord,
  taxonomy: { category: Place['category']; displayKind?: string },
  names: { local?: string },
): string {
  const label = (taxonomy.displayKind ?? PLACE_CATEGORY_LABELS[taxonomy.category]).toLowerCase();
  const article = /^[aeiou]/.test(label) ? 'An' : 'A';
  const where =
    record.containment.neighbourhoodName ??
    record.containment.localityName ??
    record.containment.regionName ??
    undefined;
  const opening = where ? `${article} ${label} in ${where}.` : `${article} ${label}.`;
  return [opening, ...describedFacts(record, names)].join(' ').slice(0, 280);
}

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/**
 * Every licence the pack's records actually carry, unioned from the records
 * rather than from the layer.
 *
 * Layer-level would be a shortcut and a wrong one: a places layer holds records
 * under three different licences depending on which upstream contributor
 * supplied them, and a screen that shows one of them has under-attributed the
 * other two.
 */
export function packLicences(pack: RegionPack): DataLicence[] {
  const byId = new Map<LicenceId, Set<string>>();
  for (const layer of pack.layers) {
    for (const record of layer.records) {
      for (const source of record.sources) {
        const applies = byId.get(source.licenceId) ?? new Set<string>();
        applies.add(layer.kind === 'primary_places' ? 'places' : 'geography');
        byId.set(source.licenceId, applies);
      }
    }
  }
  const licences = [...byId.entries()].map(([id, applies]) => licence(id, [...applies].sort()));
  return licences.sort((a, b) => a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

const FOOD_SERVICE_BY_CATEGORY: Record<string, FoodVenue['serviceType']> = {
  restaurant: 'restaurant',
  pizza_restaurant: 'restaurant',
  seafood_restaurant: 'restaurant',
  italian_restaurant: 'restaurant',
  japanese_restaurant: 'restaurant',
  chinese_restaurant: 'restaurant',
  mexican_restaurant: 'restaurant',
  indian_restaurant: 'restaurant',
  thai_restaurant: 'restaurant',
  french_restaurant: 'restaurant',
  bar: 'restaurant',
  pub: 'restaurant',
  brewery: 'restaurant',
  wine_bar: 'restaurant',
  cafe: 'cafe',
  coffee_shop: 'cafe',
  tea_room: 'cafe',
  bakery: 'bakery',
  patisserie: 'bakery',
  dessert_shop: 'bakery',
  ice_cream_shop: 'bakery',
  fast_food: 'takeaway',
  fast_food_restaurant: 'takeaway',
  sandwich_shop: 'takeaway',
  food_truck: 'takeaway',
  food_court: 'food_hall',
  food_hall: 'food_hall',
  market: 'market',
  marketplace: 'market',
  farmers_market: 'market',
  public_market: 'market',
  supermarket: 'grocery',
  grocery_store: 'grocery',
  convenience_store: 'grocery',
  greengrocer: 'grocery',
  deli: 'grocery',
  delicatessen: 'grocery',
  butcher: 'grocery',
  organic_grocery_store: 'grocery',
};

const FOOD_SERVICE_WORDS: Record<FoodVenue['serviceType'], string> = {
  restaurant: 'A restaurant',
  cafe: 'A café',
  bakery: 'A bakery',
  market: 'A market',
  grocery: 'A food shop',
  food_hall: 'A food hall',
  takeaway: 'A takeaway',
};

const FOOD_MEAL_PERIODS: Record<FoodVenue['serviceType'], FoodVenue['mealPeriods']> = {
  restaurant: ['lunch', 'dinner'],
  cafe: ['breakfast', 'lunch', 'coffee'],
  bakery: ['breakfast', 'coffee'],
  market: ['lunch', 'groceries'],
  grocery: ['groceries'],
  food_hall: ['lunch', 'dinner'],
  takeaway: ['lunch', 'dinner'],
};

const FOOD_SERVICE_MINUTES: Record<FoodVenue['serviceType'], number> = {
  restaurant: 75,
  cafe: 30,
  bakery: 15,
  market: 40,
  grocery: 20,
  food_hall: 45,
  takeaway: 20,
};

const DIET_ATTRIBUTES: readonly [string, FoodVenue['dietary'][number]['need']][] = [
  ['diet:vegetarian', 'vegetarian'],
  ['diet:vegan', 'vegan'],
  ['diet:gluten_free', 'gluten_free'],
  ['diet:halal', 'halal'],
];

/**
 * A pack record turned into a venue, and honest about what it does not know.
 *
 * Hours start `unknown`, which the food planner refuses to schedule; price is
 * inferred from the format and labelled as such; dietary claims come only from
 * an explicit attribute and never reach the level a traveller with an allergy
 * should act on. All three defaults are the cautious one, and all three are the
 * ones the research funnel may later improve.
 */
export function foodVenueFromRecord(input: {
  record: SourceRecord;
  scope: GeographicScope;
  routingId: string;
  /**
   * How far the door really is from the node it shares.
   *
   * Zero was hard-coded here, and the schema's own contract — the door walk is
   * "authored, and small by construction" — was the only statement that it
   * could not be. Nothing read it, so a venue snapped to a node kilometres away
   * still claimed to be standing on it, and the itinerary printed the walk to
   * the *node* under the venue's name. The caller now measures it; the default
   * is the honest one only for a venue genuinely at its node.
   */
  walkMinutesFromRouting?: number;
}): FoodVenue | null {
  const { record, scope, routingId } = input;
  const serviceType = resolveServiceType(record);
  if (!serviceType) return null;

  /**
   * A shop nobody has confirmed the hours of is not a provisioning stop.
   *
   * The food schema holds two rules that meet here: a venue that serves
   * groceries must be one you can actually take food away from, and a
   * provisioning stop must have confirmed hours — because it is scheduled
   * *before* the food is needed, so a wrong guess strands the whole of the next
   * day. Together they make an unconfirmed grocery unrepresentable, which is the
   * schema being right rather than the schema being awkward.
   *
   * Building one anyway produced a food dataset the region's own integrity gate
   * rejected, which is how this surfaced. So it is not built: the region has no
   * provisioning stop, the gap is reported, and a later run that confirms hours
   * can have one.
   */
  const posted = record.attributes.opening_hours
    ? parseOsmOpeningHours(record.attributes.opening_hours)
    : null;
  const hasSchedule = posted?.kind === 'scheduled';
  const provisioningType = serviceType === 'grocery' || serviceType === 'market';
  if (provisioningType && !hasSchedule) return null;

  const dietary: FoodVenue['dietary'] = [];
  for (const [key, need] of DIET_ATTRIBUTES) {
    const value = record.attributes[key];
    if (value === 'yes' || value === 'only') {
      dietary.push({
        need,
        evidence: 'menu_lists_options',
        note: 'The source database records this as available. Confirm with the venue if it matters.',
      });
    }
  }

  const website = record.websiteCandidates[0];

  return {
    id: `food-${record.id}`,
    regionId: `compiled-${scope.destinationCandidateId}`,
    name: record.name,
    locality: localityOf(record, scope),
    shortDescription: `${FOOD_SERVICE_WORDS[serviceType]} recorded in ${sourceNameOf(record)} for ${localityOf(record, scope)}.`.slice(0, 280),
    coordinates: record.coordinates,
    tags: [`${record.layerId}=${record.sourceCategory}`],
    source: {
      name: sourceNameOf(record),
      kind: 'osm',
      ...(website ? { url: website } : record.sourceUrl ? { url: record.sourceUrl } : {}),
      confidence: 0.6,
      lastVerified: (record.sources[0]?.updateTime ?? '').slice(0, 10) || '2026-01-01',
      element: {
        elementId: record.sourceId,
        database: record.layerId,
        licenceId: record.sources[0]?.licenceId ?? 'ODbL-1.0',
        ...(record.sources[0]?.updateTime ? { sourceTimestamp: record.sources[0].updateTime } : {}),
        ...(record.sourceUrl ? { url: record.sourceUrl } : {}),
      },
    },
    serviceType,
    mealPeriods: FOOD_MEAL_PERIODS[serviceType],
    cuisines: record.attributes.cuisine ? [record.attributes.cuisine.split(';')[0]!] : [],
    priceBand: 'moderate',
    priceEvidence: 'format_inferred',
    serviceMinutes: FOOD_SERVICE_MINUTES[serviceType],
    reservation: { requirement: 'unknown' },
    takeaway: record.attributes.takeaway === 'yes' ? 'confirmed' : 'unknown',
    /**
     * Provisioning stays `none` while hours are unknown — the food schema
     * refuses a provisioning stop without confirmed hours, and rightly: a packed
     * lunch nobody could buy strands the whole of the next day.
     */
    /**
     * You can only be relied on to buy food somewhere that is open.
     *
     * The schema enforces this and it is right to: a provisioning stop is
     * scheduled *before* the food is needed, so a wrong guess about its hours
     * strands the whole of the next day. Without confirmed hours the venue still
     * exists — it is simply somewhere to eat rather than somewhere to stock up.
     */
    provisioning: !hasSchedule
      ? ('none' as const)
      : provisioningType
        ? ('packed_meals' as const)
        : serviceType === 'bakery'
          ? ('snacks' as const)
          : ('none' as const),
    dietary,
    /**
     * Posted hours where a mapper wrote them, honestly unknown otherwise.
     *
     * `unverified` and `estimated`, never `published`: a tag on an open map is a
     * person writing down what they saw, which is real evidence and is not the
     * operator's own statement. The research funnel can still upgrade it, and
     * until it does the copy tells the traveller to check.
     */
    hours:
      posted && posted.kind === 'scheduled'
        ? {
            kind: 'scheduled' as const,
            hoursConfidence: 'unverified' as const,
            periods: posted.periods,
            closedAnnualDates: [],
            provenance: {
              kind: 'estimated' as const,
              sourceName: sourceNameOf(record),
              confidence: 0.5,
              volatility: 'dynamic' as const,
              recheckNote: 'These hours were recorded by a mapper, not the venue. Check before you go.',
            },
          }
        : {
            kind: 'unknown' as const,
            hoursConfidence: 'unverified' as const,
            note: 'Nobody publishes hours for this that we could read.',
            provenance: {
              kind: 'estimated' as const,
              sourceName: sourceNameOf(record),
              confidence: 0.3,
              volatility: 'dynamic' as const,
              recheckNote: 'We have no confirmed hours for this. Check before you go.',
            },
          },
    routingId,
    walkMinutesFromRouting: input.walkMinutesFromRouting ?? 0,
  };
}

function resolveServiceType(record: SourceRecord): FoodVenue['serviceType'] | null {
  const direct = FOOD_SERVICE_BY_CATEGORY[normalise(record.sourceCategory)];
  if (direct) return direct;
  for (let index = record.sourceCategoryPath.length - 1; index >= 0; index -= 1) {
    const segment = FOOD_SERVICE_BY_CATEGORY[normalise(record.sourceCategoryPath[index]!)];
    if (segment) return segment;
  }
  /**
   * A record the food branch claimed but whose leaf we do not recognise.
   *
   * `restaurant` is the safe landing: its meal periods are the narrowest, its
   * provisioning is `none`, and nothing downstream will rely on it for a packed
   * lunch. Returning null instead would silently drop somewhere to eat.
   */
  return record.planningRole === 'food' ? 'restaurant' : null;
}

function normalise(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}
