import {
  RELATIONSHIP_ADMISSION,
  SCOPE_RELATIONSHIPS,
  type ContainmentDecision,
  type PlanningRole,
  type ScopeRelationship,
  type SourceRecord,
} from '@sidequest/core';

/**
 * WHY A COUNTRY WAS BEING PLANNED AS ITS LARGEST CITY.
 *
 * A live Kyrgyzstan compilation reached a real itinerary and twenty-four of its
 * kept places were Bishkek city venues. Nothing had gone wrong at any single
 * step. The region pack was geographically even — `extractLayer` distributes
 * retention per partition cell, deliberately — and then `buildInventory`
 * re-sorted the whole pack **globally** by how much was known about each record
 * and took the top hundred and forty.
 *
 * That sort is the defect, and it is worth being precise about why, because the
 * ranking itself is sound. `knownness` counts a published website, an open
 * identifier, posted hours, a named operator, a resolved locality, a real
 * taxonomy path. Every one of those is a measurement of **how thoroughly
 * somebody catalogued the record**, and cataloguing effort concentrates where
 * commerce does. A capital museum scores twenty-something. A trailhead in a
 * national park scores two. So a global sort does not rank places by how good
 * they are, or by how well they suit a traveller — it ranks them by urbanity,
 * and then the per-cell balancing the pack layer had already paid for is thrown
 * away in one `.sort()`.
 *
 * This module puts the geography back. The rule is a floor and a ceiling around
 * a round robin:
 *
 * - **Floor.** Every area with anything in it is served in every round, so a
 *   province with four candidates contributes all four before the capital's
 *   hundred-and-first is considered.
 * - **Ceiling.** No area may take more than `maxAreaShare` of a role's quota
 *   while any other area still has something to offer. A capital genuinely does
 *   have more to do than a village and is allowed to say so — up to a point that
 *   is stated rather than emergent.
 * - **Round robin between them**, which distributes the middle proportionally to
 *   what each area actually holds rather than to how well it is catalogued.
 *
 * What this deliberately does **not** do: lower the bar. Nothing here promotes a
 * weak record, changes a rank, or invents a candidate to fill a quota. It
 * changes only *which* of the records that already qualified are the ones a
 * downstream truncation sees — which is exactly the failure, because every
 * budget below this point cuts from the top of the list.
 *
 * Areas are partition cells. That is a proxy for a travel region and is
 * knowingly imperfect — a dense metro is one cell and sparse ground is twenty —
 * but it is the only geographic grouping that exists this early, it costs
 * nothing, and it is a great deal better than none. The ceiling is what stops
 * the proxy's asymmetry from mattering: twenty sparse cells cannot swamp a
 * capital because each is subject to the same round robin, and a capital cannot
 * swamp them because of the cap.
 */

export interface BalanceLimits {
  /** How many records to keep in total. */
  quota: number;
  /** How many any one category may contribute before the rest are held back. */
  maxPerCategory: number;
  /**
   * The largest share of the quota one area may hold while another still has
   * something to offer. 0–1.
   *
   * Not a third. A capital really is where most of a country's museums are, and
   * a rule that pretended otherwise would be the mirror image of the bug — a
   * board that sends somebody to four provincial towns and skips the national
   * gallery. What the cap buys is that the *rest* of the country is present at
   * all, which is what the measurement showed was missing.
   */
  maxAreaShare: number;
}

export const DEFAULT_BALANCE: Omit<BalanceLimits, 'quota' | 'maxPerCategory'> = {
  maxAreaShare: 0.45,
};

export interface BalanceDiagnostics {
  /** Kept per area, largest first. The number that proves the spread. */
  byArea: { areaId: string; kept: number; available: number }[];
  /** Held back because their category was already well represented. */
  heldBackByCategory: number;
  /**
   * Held back because their area had already taken its share.
   *
   * Reported rather than silent: a cap that costs something and says nothing is
   * indistinguishable from a bug, and this one is doing the most work.
   */
  heldBackByAreaShare: number;
  /**
   * Whether the ceiling had to be lifted to fill the quota.
   *
   * True means every other area ran dry — so the concentration that results is a
   * property of the region rather than of our ranking, and the copy can say so.
   */
  areaCapRelaxed: boolean;
  /** Share of what was kept that sits in the single densest area. 0–1. */
  concentration: number;
}

export interface BalanceResult<T> {
  kept: T[];
  diagnostics: BalanceDiagnostics;
}

export interface BalanceInput<T> {
  /** Already ranked, best first, by whatever the caller ranks on. */
  ranked: readonly T[];
  areaOf: (item: T) => string;
  categoryOf: (item: T) => string;
  limits: BalanceLimits;
}

/**
 * Take `quota` items, spread across areas, respecting the category cap.
 *
 * Deterministic to the last tiebreak. Areas are visited in a fixed order —
 * most-available first, then by id — so two runs over the same pack produce the
 * same list, which is what makes a compiled artifact's checksum mean anything.
 */
export function balanceAcrossAreas<T>(input: BalanceInput<T>): BalanceResult<T> {
  const { ranked, areaOf, categoryOf, limits } = input;
  const quota = Math.max(0, Math.trunc(limits.quota));

  const pools = new Map<string, T[]>();
  for (const item of ranked) {
    const area = areaOf(item);
    const pool = pools.get(area);
    if (pool) pool.push(item);
    else pools.set(area, [item]);
  }

  const areas = [...pools.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([areaId]) => areaId);

  const cursor = new Map<string, number>(areas.map((area) => [area, 0]));
  const takenPerArea = new Map<string, number>(areas.map((area) => [area, 0]));
  const categoryCounts = new Map<string, number>();
  const kept: T[] = [];
  let heldBackByCategory = 0;
  let heldBackByAreaShare = 0;
  let areaCapRelaxed = false;

  /**
   * The next item from an area that the category cap will accept.
   *
   * Advancing the cursor past a saturated category rather than stopping is the
   * point: a capital whose museums are full still has its markets, and skipping
   * the area entirely would hand its whole remaining share to somewhere else.
   */
  const nextFrom = (area: string): T | null => {
    const pool = pools.get(area) ?? [];
    let index = cursor.get(area) ?? 0;
    while (index < pool.length) {
      const item = pool[index]!;
      const category = categoryOf(item);
      if ((categoryCounts.get(category) ?? 0) >= limits.maxPerCategory) {
        heldBackByCategory += 1;
        index += 1;
        continue;
      }
      cursor.set(area, index + 1);
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      takenPerArea.set(area, (takenPerArea.get(area) ?? 0) + 1);
      return item;
    }
    cursor.set(area, index);
    return null;
  };

  const fill = (areaCeiling: number): void => {
    let progressed = true;
    while (kept.length < quota && progressed) {
      progressed = false;
      for (const area of areas) {
        if (kept.length >= quota) break;
        if ((takenPerArea.get(area) ?? 0) >= areaCeiling) continue;
        const item = nextFrom(area);
        if (!item) continue;
        kept.push(item);
        progressed = true;
      }
    }
  };

  const ceiling = Math.max(1, Math.floor(quota * limits.maxAreaShare));
  fill(ceiling);

  /*
   * The quota is not full and the cap is why.
   *
   * Every area is either exhausted or at its ceiling. If anything is left
   * anywhere, the honest answer is to take it and record that the cap was
   * lifted — an empty slot on a board is not a principled outcome, and a region
   * that really is one city should produce a plan for one city rather than a
   * shorter plan for the same city.
   */
  if (kept.length < quota) {
    const remaining = areas.some((area) => (cursor.get(area) ?? 0) < (pools.get(area)?.length ?? 0));
    if (remaining) {
      /*
       * The ceiling cost nothing in the end: everything it held back was taken
       * in the second pass, so `heldBackByAreaShare` stays zero. What is worth
       * recording is that the cap had to be lifted at all, because that means
       * the concentration in the result is a property of the region rather than
       * of our ranking — and the copy can say so.
       */
      areaCapRelaxed = true;
      fill(quota);
    }
  }

  /*
   * What the ceiling actually cost, counted from the pools rather than
   * accumulated in the loop: an item skipped in one round and taken in the next
   * is not a cost, and counting it as one would overstate the cap on every run.
   */
  if (!areaCapRelaxed) {
    heldBackByAreaShare = areas.reduce((total, area) => {
      const taken = takenPerArea.get(area) ?? 0;
      const seen = cursor.get(area) ?? 0;
      const available = pools.get(area)?.length ?? 0;
      return total + (taken >= ceiling ? available - seen : 0);
    }, 0);
  }

  const byArea = areas
    .map((areaId) => ({
      areaId,
      kept: takenPerArea.get(areaId) ?? 0,
      available: pools.get(areaId)?.length ?? 0,
    }))
    .filter((entry) => entry.kept > 0)
    .sort((a, b) => b.kept - a.kept || a.areaId.localeCompare(b.areaId));

  const densest = byArea[0]?.kept ?? 0;

  return {
    kept,
    diagnostics: {
      byArea,
      heldBackByCategory,
      heldBackByAreaShare,
      areaCapRelaxed,
      concentration: kept.length === 0 ? 0 : densest / kept.length,
    },
  };
}

/**
 * The area a record belongs to.
 *
 * `cellId` is on every normalised source record because the pack layer needed it
 * to report what a partial build missed. Reusing it here rather than clustering
 * afresh keeps this free — and means the two layers agree about what "an area"
 * is, which they would not if each computed its own.
 */
export function areaOfRecord(record: SourceRecord): string {
  return record.cellId;
}

/**
 * Per-role quotas, as a share of what the trip can actually hold.
 *
 * Expressed as a table rather than as one number because the roles are not
 * interchangeable: a day needs one or two anchors, several smaller things, one
 * or two meals and, on an outdoor day, a shop. Handing every role the same
 * ceiling produced a board with sixty restaurants and eleven things to do.
 */
export const ROLE_QUOTA_SHARE: Partial<Record<PlanningRole, number>> = {
  attraction: 0.42,
  outdoor: 0.3,
  side_quest: 0.16,
  market: 0.12,
};

// ---------------------------------------------------------------------------
// Admission: what may be balanced at all
// ---------------------------------------------------------------------------

/**
 * WHY BALANCING IS NOT WHERE ADMISSION HAPPENS.
 *
 * A live compilation put an international airport, a driver-for-hire and two
 * tour operators on a traveller's discovery board. None of that was a
 * classification failure — the taxonomy already maps `airport` to `gateway` and
 * the `travel_and_transportation` branch to `support`, and the pack schema
 * already declares which roles a traveller chooses *between*. The defect was
 * that **nothing enforced the distinction**: the inventory kept supporting
 * records deliberately, concatenated them onto the visitable ones, and handed
 * the whole list out under one name.
 *
 * So the rule this half of the file exists to make structural:
 *
 * > Balancing decides *which* of the records that already qualified survive a
 * > truncation. It never decides whether a record qualified. A record that
 * > cannot be an attraction must not be rescued into one by a quota that went
 * > unfilled.
 *
 * Admission runs first, in a fixed order, and every refusal is counted with a
 * reason rather than dropped:
 *
 * 1. duplicate resolution — a superseded record is not a second candidate
 * 2. **scope membership** — is this even in the destination
 * 3. closure, where a source stated it
 * 4. minimum identity — a row whose name is its own category is not a place
 * 5. role eligibility — which portfolio slots this role may occupy at all
 * 6. planning-role separation into pools
 * 7. *then* balance, inside each pool, against that pool's own quota
 */

/**
 * Why a record that is not plainly inside the destination is on the board.
 *
 * Typed rather than free text, and required rather than optional: "23 places
 * from another state" was possible precisely because inclusion needed no
 * justification. Every admitted record now carries the sentence that admitted
 * it, and the two external reasons are the only two that exist.
 */
export const INCLUSION_REASONS = SCOPE_RELATIONSHIPS;
export type InclusionReason = ScopeRelationship;

/** The portfolios a candidate can occupy. Not roles: a role maps onto these. */
export const PORTFOLIO_SLOTS = ['anchor', 'discovery', 'food', 'support', 'gateway'] as const;
export type PortfolioSlot = (typeof PORTFOLIO_SLOTS)[number];

/** Slots whose occupants a traveller chooses between and a board displays. */
export const VISITABLE_SLOTS: readonly PortfolioSlot[] = ['anchor', 'discovery'];

export function isVisitableSlot(slot: PortfolioSlot): boolean {
  return VISITABLE_SLOTS.includes(slot);
}

export type ScopeAdmission =
  | {
      admitted: true;
      /** Which slots this relationship permits. Never wider than the role's. */
      permits: readonly PortfolioSlot[];
      reason: InclusionReason;
      /** True when the record is outside the destination and kept anyway. */
      external: boolean;
      /** False when nobody could establish membership either way. */
      membershipVerified: boolean;
    }
  | { admitted: false; rejection: 'outside_scope' };

/**
 * What a scope relationship permits, and it is narrower than it looks.
 *
 * `adjacent_gateway` is the one that matters: a ferry terminal one division
 * over is a real and useful record, and it is *not* something to do. Permitting
 * it into the gateway slot only is what makes "an airport cannot be an
 * attraction" a property of the type rather than of somebody remembering.
 *
 * The vocabulary and the yes/no answers are the containment layer's —
 * `admitsToInventory` and `admitsToVisitableSlot` — and a test asserts this
 * agrees with both for every relationship. What this adds is what those two
 * cannot express: *which* slots survive, and the typed reason an admitted
 * record carries onto a card.
 */
export function admitByScope(relationship: ScopeRelationship): ScopeAdmission {
  const admission = RELATIONSHIP_ADMISSION[relationship];
  if (
    !admission.provisionalBoardEligible &&
    !admission.finalBoardEligible &&
    !admission.plannerEligible
  ) {
    return { admitted: false, rejection: 'outside_scope' };
  }
  return {
    admitted: true,
    permits: SLOTS_BY_RELATIONSHIP[relationship],
    reason: relationship,
    external: EXTERNAL_RELATIONSHIPS.includes(relationship),
    membershipVerified: relationship !== 'membership_unknown',
  };
}

/**
 * Which portfolio slots each relationship permits.
 *
 * The yes/no answers are the containment contract's — `RELATIONSHIP_ADMISSION`
 * in `@sidequest/core` — and this table adds only what that one cannot express:
 * *which* slots survive. A test asserts the two agree for every relationship, so
 * a new member of the vocabulary cannot be admitted here without the contract
 * agreeing that it may be admitted at all.
 *
 * Two rows carry the whole point of the file:
 *
 * - **`adjacent_gateway` permits `gateway` and nothing else.** A ferry terminal
 *   one division over is a real and useful record and is *not* something to do.
 *   This line is what makes "an airport cannot be an attraction" a property of
 *   the type rather than of somebody remembering.
 * - **`membership_unknown` permits `discovery`, `food` and `support`, and not
 *   `anchor`.** Admitted, labelled, and never the thing a morning is built
 *   around. Refusing it outright would empty the board for every pack built
 *   before containment existed; letting it anchor would be the defect the
 *   vocabulary exists to end.
 */
const SLOTS_BY_RELATIONSHIP: Readonly<Record<ScopeRelationship, readonly PortfolioSlot[]>> = {
  inside_scope: PORTFOLIO_SLOTS,
  inside_selected_division: PORTFOLIO_SLOTS,
  inside_selected_region: PORTFOLIO_SLOTS,
  regional_expansion_member: PORTFOLIO_SLOTS,
  adjacent_gateway: ['gateway'],
  /*
   * Offered, shown, and not planned around until something includes it — at
   * which point the overlay re-decides it as `regional_expansion_member`.
   */
  optional_satellite: ['discovery', 'food', 'support'],
  membership_unknown: ['discovery', 'food', 'support'],
  outside_scope: [],
};

const EXTERNAL_RELATIONSHIPS: readonly ScopeRelationship[] = [
  'regional_expansion_member',
  'adjacent_gateway',
  'optional_satellite',
];

/**
 * The relationship a record carries, read from the trip-scope overlay.
 *
 * A record the overlay never saw is `membership_unknown`. That default is
 * deliberate and fail-closed: it is what makes a new ingestion path that forgets
 * to register its candidates produce a visibly thin board rather than an
 * invisibly wrong one. It is *not* a fallback that admits — `membership_unknown`
 * cannot anchor and cannot reach the planner.
 *
 * A record carrying its own decision (from `admitLateCandidate`) is accepted, so
 * a caller that has already been through the gate need not hold the overlay.
 */
export function scopeRelationshipOf(record: unknown): ScopeRelationship {
  const decision = (record as { containmentDecision?: ContainmentDecision } | null | undefined)
    ?.containmentDecision?.relationship;
  const flat = (record as { scopeRelationship?: unknown } | null | undefined)?.scopeRelationship;
  const value = decision ?? flat;
  return typeof value === 'string' && KNOWN_RELATIONSHIPS.has(value)
    ? (value as ScopeRelationship)
    : 'membership_unknown';
}

/** Every relationship the contract declares. One list, in `@sidequest/core`. */
const KNOWN_RELATIONSHIPS: ReadonlySet<string> = new Set<string>(SCOPE_RELATIONSHIPS);

// ---------------------------------------------------------------------------
// Role eligibility
// ---------------------------------------------------------------------------

/**
 * A deterministic role decision, and what it was decided from.
 *
 * The shape the eligibility layer produces. Kept as an interface here rather
 * than imported so that the portfolio can be tested — and can run — without the
 * classifier, and so that the two agree on one vocabulary instead of two.
 */
export interface RoleEligibility {
  role: PlanningRole;
  /** 0–1. How sure the decision is, never how good the place is. */
  confidence: number;
  /** What decided it: an exact category, a branch, a stored role, a default. */
  basis: string;
  /** Every slot this record may occupy. Empty means it is not planned around. */
  eligibleFor: readonly PortfolioSlot[];
  /**
   * The deciding layer's own finer role, kept verbatim where there is one.
   *
   * Typed as a string rather than as that layer's enum on purpose: this module
   * is the generic one and must not depend on the classifier, and the only thing
   * done with the value is to name a refusal accurately. `permanently_closed`
   * and `insufficient_identity` both collapse to `excluded` in the pack
   * vocabulary, and reporting them as one loses the only part anybody can act
   * on.
   */
  candidateRole?: string;
}

/**
 * Which portfolios a planning role may occupy.
 *
 * The single table the whole "an airport is not a museum" invariant rests on.
 * `market` is the only role in two slots, and deliberately: it is somewhere to
 * eat *and* a thing to do, which is why it is its own role.
 *
 * Anything not listed occupies nothing. `lodging`, `administrative`,
 * `infrastructure` and `excluded` are real, kept, useful records that no
 * portfolio has a slot for — which is a different statement from throwing them
 * away, and the pack keeps them either way.
 */
const SLOTS_BY_ROLE: Partial<Record<PlanningRole, readonly PortfolioSlot[]>> = {
  attraction: ['anchor'],
  outdoor: ['anchor'],
  market: ['anchor', 'food'],
  side_quest: ['discovery'],
  food: ['food'],
  support: ['support'],
  gateway: ['gateway'],
};

export function slotsForRole(role: PlanningRole): readonly PortfolioSlot[] {
  return SLOTS_BY_ROLE[role] ?? [];
}

/** Whether a role may hold a given portfolio slot. The invariant, as a function. */
export function roleCanOccupy(role: PlanningRole, slot: PortfolioSlot): boolean {
  return slotsForRole(role).includes(slot);
}

/**
 * The eligibility a bare role implies, for callers that have no classifier.
 *
 * Deliberately reports its own confidence as an absence of evidence rather than
 * as certainty: a role read off a stored field is a role somebody wrote down,
 * not a role anybody checked.
 */
export function eligibilityForRole(role: PlanningRole, basis = 'planning_role'): RoleEligibility {
  return { role, confidence: 0.5, basis, eligibleFor: slotsForRole(role) };
}

// ---------------------------------------------------------------------------
// Refusals, counted
// ---------------------------------------------------------------------------

/**
 * Why a record is not in the portfolio.
 *
 * Every one of these is a refusal somebody could otherwise mistake for an empty
 * region. A board of six that can say "eleven were outside the destination and
 * forty were infrastructure" is a different product from a board of six.
 */
export const PORTFOLIO_REJECTIONS = [
  'superseded_duplicate',
  'outside_scope',
  /** The role has no portfolio slot at all: a pylon, a boundary, a hotel. */
  'role_not_planned',
  /** The role exists but may not hold the slot that was asked for. */
  'role_ineligible_for_slot',
  'permanently_closed',
  /** A row whose name is its own category. Not an identity. */
  'identity_too_thin',
  'over_role_quota',
  'over_category_cap',
  'over_area_share',
] as const;
export type PortfolioRejection = (typeof PORTFOLIO_REJECTIONS)[number];

export interface RejectionCount {
  reason: PortfolioRejection;
  count: number;
  /** A few names, so a diagnostic can be read rather than only counted. */
  examples: string[];
}

/**
 * A tally of refusals that stays deterministic and bounded.
 *
 * Bounded because a whole-country pack rejects tens of thousands of records and
 * a diagnostic that carried all of their names would be larger than the
 * artifact it describes.
 */
export class RejectionLedger {
  private readonly counts = new Map<PortfolioRejection, { count: number; examples: string[] }>();

  constructor(private readonly maxExamples = 3) {}

  reject(reason: PortfolioRejection, name?: string): void {
    const entry = this.counts.get(reason) ?? { count: 0, examples: [] };
    entry.count += 1;
    if (name && entry.examples.length < this.maxExamples) entry.examples.push(name);
    this.counts.set(reason, entry);
  }

  total(): number {
    let total = 0;
    for (const entry of this.counts.values()) total += entry.count;
    return total;
  }

  countOf(reason: PortfolioRejection): number {
    return this.counts.get(reason)?.count ?? 0;
  }

  /** Ordered by the declared vocabulary, so two runs report identically. */
  entries(): RejectionCount[] {
    return PORTFOLIO_REJECTIONS.filter((reason) => this.counts.has(reason)).map((reason) => {
      const entry = this.counts.get(reason)!;
      return { reason, count: entry.count, examples: [...entry.examples] };
    });
  }
}

// ---------------------------------------------------------------------------
// Minimum identity
// ---------------------------------------------------------------------------

/**
 * Whether a row names a *thing* rather than a kind of thing.
 *
 * Open catalogues are full of rows whose name is the category again —
 * `Parking`, `Viewpoint`, `Restaurant` — because a mapper recorded a feature
 * and had no name to give it. Those are real geography and they are not
 * candidates: a card that says "Viewpoint" and nothing else cannot be chosen
 * between, and a board of them looks full while offering nothing.
 *
 * The check compares against the *source's own* category vocabulary rather than
 * against a word list, so it names no language and no destination. A record
 * genuinely named after its category loses, which is the conservative side of
 * the trade and is counted rather than silent.
 */
export function hasMinimumIdentity(input: {
  name: string;
  sourceCategory: string;
  sourceCategoryPath?: readonly string[];
}): boolean {
  const name = identityKey(input.name);
  if (name.length < 2) return false;
  if (name === identityKey(input.sourceCategory)) return false;
  for (const segment of input.sourceCategoryPath ?? []) {
    if (name === identityKey(segment)) return false;
  }
  return true;
}

function identityKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

// ---------------------------------------------------------------------------
// Supply: counting attractions apart from infrastructure
// ---------------------------------------------------------------------------

/**
 * WHAT A BOARD IS ALLOWED TO IMPLY.
 *
 * The second half of the same defect. Once supporting records could reach the
 * board, board *size* stopped measuring anything: twenty-four cards of which
 * one is an airport and three are tour operators reads as a rich destination
 * and is a thin one. Worse, the thinness is invisible precisely where it
 * matters most, because the sparsest regions are the ones whose supporting
 * records outnumber their attractions.
 *
 * So the counts are kept apart, and the honest board size is derived from the
 * visitable ones alone. A board of six that says there were only six is a
 * better product than a board of twenty-four that is mostly infrastructure.
 */
export interface VisitableSupply {
  /** Candidates eligible to hold a morning. */
  anchors: number;
  /** Smaller visitable things: worth ten minutes, not worth a morning. */
  discoveries: number;
  /** What a traveller actually chooses between. */
  visitable: number;
  /** Food, practical stops and gateways. Never something to do. */
  supporting: number;
  /** Distinct place categories among the visitable ones. One is not a trip. */
  categories: number;
  /** Areas holding at least one anchor. One is a city break, not a region. */
  areasWithAnchors: number;
  /** Share of visitable supply sitting in the single densest area. 0–1. */
  concentration: number;
}

export const SUPPLY_SHORTFALLS = [
  /** Fewer anchors than there are days. Some day has nothing to be about. */
  'anchors_below_days',
  /** Fewer than half. Not a trip, whatever else is on the board. */
  'anchors_critical',
  /** Everything visitable is the same kind of thing. A day, repeated. */
  'single_category',
  /** Everything visitable is in one area. */
  'single_area',
  /** More infrastructure than attractions. The shape that hid the shortage. */
  'support_outnumbers_visitable',
] as const;
export type SupplyShortfall = (typeof SUPPLY_SHORTFALLS)[number];

export interface VisitableSupplyVerdict {
  supply: VisitableSupply;
  /** Every shortfall named separately, in the declared order. */
  shortfalls: SupplyShortfall[];
  /**
   * The largest board that would not overstate what is here.
   *
   * Equal to the visitable supply, always. Stated as a number rather than left
   * implicit because it is the thing every downstream truncation must be
   * bounded by, and because "the board may not be padded" is easier to test as
   * an inequality than as a convention.
   */
  maxHonestBoardSize: number;
  /** True when the portfolio holds more supporting records than visitable ones. */
  supportHeavy: boolean;
  /** One sentence with a real number in it. Names no destination. */
  summary: string;
}

/**
 * The shortage, reported rather than filled.
 *
 * Thresholds are stated rather than tuned: a day needs something to be about,
 * so the anchor count is measured against the number of days, and half of that
 * is where a trip stops being one. Nothing here removes a candidate or lowers a
 * bar — it only refuses to let board size stand in for supply.
 */
export function assessVisitableSupply(input: {
  supply: VisitableSupply;
  /** Days the trip has to fill. Zero means the trip length is not yet known. */
  tripDays: number;
}): VisitableSupplyVerdict {
  const { supply } = input;
  const tripDays = Math.max(0, Math.trunc(input.tripDays));
  const shortfalls: SupplyShortfall[] = [];

  if (tripDays > 0 && supply.anchors < tripDays) shortfalls.push('anchors_below_days');
  if (tripDays > 0 && supply.anchors < Math.ceil(tripDays / 2)) shortfalls.push('anchors_critical');
  if (supply.visitable > 0 && supply.categories <= 1) shortfalls.push('single_category');
  if (supply.anchors > 0 && supply.areasWithAnchors <= 1) shortfalls.push('single_area');
  const supportHeavy = supply.supporting > supply.visitable;
  if (supportHeavy) shortfalls.push('support_outnumbers_visitable');

  const ordered = SUPPLY_SHORTFALLS.filter((shortfall) => shortfalls.includes(shortfall));

  return {
    supply,
    shortfalls: ordered,
    maxHonestBoardSize: supply.visitable,
    supportHeavy,
    summary: supplySummary(supply, tripDays, supportHeavy),
  };
}

function supplySummary(supply: VisitableSupply, tripDays: number, supportHeavy: boolean): string {
  if (supply.visitable === 0) {
    return supply.supporting > 0
      ? `Nothing here is something to do. We found ${supply.supporting} practical records — transport, shops, services — and no attractions.`
      : 'We found nothing here we would put on a board.';
  }
  const head = `${supply.visitable} ${supply.visitable === 1 ? 'thing' : 'things'} to do, ${supply.anchors} of which could hold a morning`;
  const days = tripDays > 0 ? `, across ${tripDays} ${tripDays === 1 ? 'day' : 'days'}` : '';
  const tail = supportHeavy
    ? `. ${supply.supporting} further records are transport, shops and services, and are not counted as things to do.`
    : '.';
  return `${head}${days}${tail}`;
}
