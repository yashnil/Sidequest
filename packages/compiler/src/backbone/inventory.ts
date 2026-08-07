import {
  licence,
  parseOsmOpeningHours,
  PLACE_CATEGORY_LABELS,
  type CandidateLink,
  type ConfidenceSignal,
  type DataLicence,
  type FoodVenue,
  type GeographicScope,
  type LicenceId,
  type Place,
  type PlanningRole,
  type ProviderRef,
  type RegionPack,
  type SourceRecord,
  VISITABLE_ROLES,
  placeInclusionTag,
  placeRoleTag,
} from '@sidequest/core';
import type { DiscoveredCandidate } from '../providers';
import { assessRecordEligibility, type CandidateEligibility } from './eligibility';
import { withContainmentDecision } from './containment';
import { supersededRecordIds } from './link';
import { buildTripScopeOverlay, decisionFor, type TripScopeOverlay } from './overlay';
import { classifySourceCategory } from './taxonomy';
import {
  admitByScope,
  areaOfRecord,
  assessVisitableSupply,
  balanceAcrossAreas,
  DEFAULT_BALANCE,
  hasMinimumIdentity,
  RejectionLedger,
  ROLE_QUOTA_SHARE,
  roleCanOccupy,
  scopeRelationshipOf,
  type BalanceDiagnostics,
  type InclusionReason,
  type PortfolioRejection,
  type PortfolioSlot,
  type RejectionCount,
  type RoleEligibility,
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
export type EligibilityResolver = (record: SourceRecord) => RoleEligibility;

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

export const DEFAULT_ELIGIBILITY: EligibilityResolver = (record) => {
  const assessment = assessRecordEligibility(record);
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
}): InventoryResult {
  const limits = { ...DEFAULT_INVENTORY_LIMITS, ...input.limits };
  const resolveEligibility = input.eligibility ?? DEFAULT_ELIGIBILITY;
  const rawRecords = input.pack.layers.flatMap((layer) => layer.records);

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
      records: rawRecords,
      roleEligible: (record) => resolveEligibility(record).eligibleFor.length > 0,
    });
  const records = rawRecords.map((record) =>
    withContainmentDecision(record, decisionFor(overlay, record.id)),
  );

  const superseded = supersededRecordIds(records, input.pack.links);
  const crossLayer = crossLayerCorroboration(records, input.pack.links);

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

  for (const record of records) {
    // 1. Duplicate resolution. A superseded record is not a second candidate.
    if (superseded.has(record.id)) {
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
    const eligibility = resolveEligibility(record);
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
     * 6. Planning-role separation, intersected with what the scope permits.
     *
     * The intersection is where an adjacent gateway stops being a candidate: it
     * is eligible for the gateway slot by role and permitted only the gateway
     * slot by scope, so it lands in one pool and cannot reach any other. A
     * record whose role and scope permit nothing in common is refused with the
     * reason that says so rather than disappearing.
     */
    const slots = eligibility.eligibleFor.filter((slot) => admission.permits.includes(slot));
    if (slots.length === 0) {
      ledger.reject('role_ineligible_for_slot', record.name);
      continue;
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
     * role occupies decides which pool it is ranked inside. A side quest that
     * outranked a museum could never take its place, because they are never in
     * the same list.
     */
    const slot: PortfolioSlot = roleCanOccupy(role, 'anchor') ? 'anchor' : 'discovery';
    const pool = rank(admittedFor(slot, role));
    if (pool.length === 0) continue;
    const share = ROLE_QUOTA_SHARE[role] ?? 0;
    const result = balanceAcrossAreas({
      ranked: pool,
      areaOf: areaOfRecord,
      categoryOf,
      limits: {
        quota: Math.max(1, Math.round(limits.maxAttractions * share)),
        maxPerCategory: limits.maxPerCategory,
        maxAreaShare: limits.maxAreaShare,
      },
    });
    balanced.push({
      slot,
      role,
      kept: result.kept,
      available: pool.length,
      diagnostics: result.diagnostics,
    });
  }

  /*
   * Unclaimed quota is redistributed rather than lost.
   *
   * A region with no markets should not produce a board twelve per cent shorter
   * than one that has them. The redistribution is deterministic — roles in their
   * declared order, each offered the whole remainder — and is bounded by what
   * each role actually holds, so it can only ever add records that already
   * qualified.
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
    for (const role of VISITABLE_ROLES) {
      if (slack <= 0) break;
      /*
       * The remainder is offered from the *admitted* pool and nowhere else.
       *
       * This is the line the invariant turns on. Reading the raw records here —
       * or any pool that admission did not filter — would let an unfilled quota
       * reach past every gate above and rescue exactly the records those gates
       * refused, which is how a shortage of attractions becomes a board of
       * infrastructure.
       */
      const slot: PortfolioSlot = roleCanOccupy(role, 'anchor') ? 'anchor' : 'discovery';
      const pool = rank(admittedFor(slot, role));
      const spare = pool.filter((record) => !taken.has(record.id));
      if (spare.length === 0) continue;
      const result = balanceAcrossAreas({
        ranked: spare,
        areaOf: areaOfRecord,
        categoryOf,
        limits: { quota: slack, maxPerCategory: limits.maxPerCategory, maxAreaShare: limits.maxAreaShare },
      });
      /*
       * The category cap is global, so the redistribution has to respect what
       * the first pass already spent. `balanceAcrossAreas` counts from zero, so
       * the surviving records are filtered against the running totals here
       * rather than trusting its own tally.
       */
      for (const record of result.kept) {
        if (slack <= 0) break;
        const category = categoryOf(record);
        if ((categoryCounts.get(category) ?? 0) >= limits.maxPerCategory) continue;
        categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
        taken.add(record.id);
        visitable.push(record);
        slack -= 1;
      }
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
    ranked: rank(allAdmittedFor('support')),
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
    ranked: preferNamedGateways(rank(allAdmittedFor('gateway')), input.scope),
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
  const foodPool = rank(allAdmittedFor('food'));
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
 */
function interleaveByRole(
  roles: readonly PlanningRole[],
  records: readonly SourceRecord[],
  roleOf: (record: SourceRecord) => PlanningRole,
): SourceRecord[] {
  const buckets = roles.map((role) =>
    interleaveByCategory(records.filter((record) => roleOf(record) === role)),
  );
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
 * Fit needs a traveller and this runs before one is applied; what this orders on
 * is *how much is known* — how many attributes the source recorded, whether
 * anyone published a site, whether an open identifier exists, whether the source
 * says it is open. A record's existence confidence is deliberately absent: it
 * says the thing probably exists, which every record here already claims.
 *
 * Deterministic to the last tiebreak, because the pack's content hash depends on
 * it and so does the reproducibility of a compilation.
 */
function rank(records: readonly SourceRecord[]): SourceRecord[] {
  return [...records]
    .map((record) => ({ record, score: knownness(record) }))
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .map((entry) => entry.record);
}

/**
 * Scored by *kinds* of evidence, not by how many attributes a layer happens to
 * publish.
 *
 * The first version counted attributes, and that turned out to be a layer bias
 * rather than a quality signal: the geographic layers carry a bag of upstream
 * tags and the primary place catalogue carries none, so a live New York run
 * ranked fourteen small municipal parks above every museum in Manhattan. What is
 * counted now is present in both vocabularies — a published site, an open
 * identifier, posted hours, a named operator, a known address, a real taxonomy
 * path — so a record is ranked on what is known about it rather than on which
 * schema it arrived in.
 */
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

function knownness(record: SourceRecord): number {
  const other = Object.keys(record.attributes).filter(
    (key) => key !== 'operator' && key !== 'opening_hours' && key !== 'website',
  ).length;
  return (
    (record.websiteCandidates.length > 0 ? 6 : 0) +
    (record.wikidataId ? 5 : 0) +
    (record.attributes.opening_hours ? 4 : 0) +
    (record.attributes.operator ? 3 : 0) +
    // Somebody put this in an addressable place: a real locality, not a bbox.
    (record.containment.localityName || record.containment.neighbourhoodName ? 2 : 0) +
    // A category path of any depth means a classified record rather than a blob.
    (record.sourceCategoryPath.length >= 2 ? 2 : 0) +
    (record.bounds ? 2 : 0) +
    (record.alternateNames.length > 0 ? 1 : 0) +
    Math.min(4, other) * 2 +
    (record.operatingStatus === 'closed' ? -50 : 0)
  );
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
    if (layers.size < 2) continue;
    for (const id of link.recordIds) corroborated.add(id);
  }
  return corroborated;
}

// ---------------------------------------------------------------------------
// Record → Place
// ---------------------------------------------------------------------------

function toCandidate(input: {
  record: SourceRecord;
  scope: GeographicScope;
  crossLayerCorroborated: boolean;
  /** The role admission settled on. Stamped onto the place, never re-derived. */
  role: PlanningRole;
  /** Why this record is here at all. Required, so an external one must justify itself. */
  inclusion: InclusionReason;
}): DiscoveredCandidate {
  const { record, scope, crossLayerCorroborated, role, inclusion } = input;
  const taxonomy = classifySourceCategory({
    category: record.sourceCategory,
    path: record.sourceCategoryPath,
  });

  /**
   * How completely the source describes this, as a weak proxy and labelled one.
   *
   * There is no rating and no review count anywhere in the open stack, which is
   * a feature: there is no popularity number to mistake for quality. What there
   * is, is how much somebody bothered to record — a place many people care about
   * carries a site, an operator, posted hours. It never outranks what the
   * traveller said they came for.
   */
  const richness = Math.min(
    1,
    (Object.keys(record.attributes).length + record.websiteCandidates.length + (record.wikidataId ? 1 : 0)) / 6,
  );
  const popularity = Math.min(0.9, 0.2 + richness * 0.6);

  const place: Place = {
    id: record.id,
    regionId: `compiled-${scope.destinationCandidateId}`,
    name: record.name,
    locality: localityOf(record, scope),
    shortDescription: describe(record, taxonomy.category),
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
    ],
    /*
     * Carried through rather than left on the source record.
     *
     * The backbone already linked this place to an open identifier — that is
     * what `attr:wikidata` above is counting — and dropping the identifier while
     * keeping a tag saying it existed meant imagery had to fall back to
     * searching a name it already had a key for.
     */
    ...(record.wikidataId ? { wikidataId: record.wikidataId } : {}),
    source: {
      name: sourceNameOf(record),
      kind: 'osm',
      ...(officialUrlOf(record) ? { url: officialUrlOf(record)! } : {}),
      confidence: 0.7,
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
    category: taxonomy.category,
    interests: taxonomy.interests.length > 0 ? taxonomy.interests : ['scenic_viewpoints'],
    typicalDurationMinutes: taxonomy.typicalDurationMinutes,
    costLevel: taxonomy.costLevel,
    physicalIntensity: taxonomy.physicalIntensity,
    crowdLevel: popularity > 0.7 ? 'busy' : 'quiet',
    popularityScore: popularity,
    hiddenGemScore: Math.max(0.1, 1 - popularity - 0.1),
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

function localityOf(record: SourceRecord, scope: GeographicScope): string {
  return (
    record.containment.neighbourhoodName ??
    record.containment.localityName ??
    record.containment.regionName ??
    scope.destinationName
  );
}

/**
 * A description built from facts, and short when there are none.
 *
 * Deliberately not prose. The quality assessor treats a description over forty
 * characters as one of seven evidence marks, so a template that always produced
 * a flowing sentence would hand every candidate that mark and make the signal
 * meaningless. What this produces instead grows only when the source actually
 * recorded something — an operator, an elevation, a boundary — so its length
 * tracks evidence rather than style.
 */
function describe(record: SourceRecord, category: Place['category']): string {
  const label = PLACE_CATEGORY_LABELS[category].toLowerCase();
  const where =
    record.containment.localityName ?? record.containment.regionName ?? undefined;
  const parts = [where ? `A ${label} in ${where}.` : `A ${label}.`];

  const operator = record.attributes.operator;
  if (operator) parts.push(`Run by ${operator}.`);
  const elevation = record.attributes.ele;
  if (elevation && /^\d{2,5}$/.test(elevation)) parts.push(`Recorded at ${elevation} m.`);
  const fee = record.attributes.fee;
  if (fee === 'yes') parts.push('The map data records a charge to enter.');
  else if (fee === 'no') parts.push('The map data records no charge to enter.');

  return parts.join(' ').slice(0, 280);
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
    walkMinutesFromRouting: 0,
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
