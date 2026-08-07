import { isVisitableRole, type PlanningRole, type SourceRecord } from '@sidequest/core';
import {
  classifySourceCategory,
  type TaxonomyClassification,
  type TaxonomyMatch,
  type TaxonomySubrole,
} from './taxonomy';

/**
 * WHAT A CANDIDATE MAY BE USED FOR, DECIDED ONCE AND BEFORE ANY SCORE.
 *
 * ---
 *
 * ## The defect this file exists to make impossible
 *
 * A live Bali compilation produced twenty-four travel candidates, and among them
 * were an international airport, a driver-for-hire and a tour agency.
 *
 * The interesting part is that **nothing misclassified them**. `taxonomy.ts`
 * called the airport a `gateway` and the driver a `support` stop, which are the
 * right answers. The pack stored those answers. The inventory recomputed them
 * and agreed. Then `buildInventory` did this:
 *
 * ```ts
 * const candidates = [...ordered, ...support, ...gateways].map(toCandidate);
 * ```
 *
 * — and `toCandidate` returns a `DiscoveredCandidate`, which has a `place`, some
 * provider refs, some facts and some confidence signals. It has nowhere to put a
 * role. So the correct answer was computed, used to *select* twenty-five support
 * stops and twelve gateways, and then dropped on the floor. Every layer after
 * that point — the shortlist, the quality filter, the board — saw an
 * undifferentiated list and had no way to tell an airport from a museum.
 *
 * Worse, the two archetypes that carry these records assign
 * `category: 'town_and_food'` and `interests: ['food_and_towns']`, so an airport
 * arrives at the board looking like a town centre, and a traveller who ticked
 * "food and towns" has it ranked *up*. And the inventory's own ordering is
 * `knownness` — how completely a source describes something — which an
 * international airport wins outright against every museum in the region.
 *
 * So the three failure modes are not hypothetical, they are the observed
 * mechanism:
 *
 * - **prominence** promoted it (an airport is the best-catalogued record in Bali);
 * - **source completeness** promoted it (site, hours, operator, open identifier);
 * - **traveller interest** promoted it (`food_and_towns`, inherited from an
 *   archetype that needed *some* category and had none that fitted).
 *
 * Every one of those is a *score*. None of them can be fixed by a better score,
 * because a score is a number and the answer needed is a permission. Hence this
 * file: a deterministic permission, computed from the source's own vocabulary
 * and the record's own status, before anything is ranked.
 *
 * ---
 *
 * ## Why the pack's role enum was not widened
 *
 * `PLANNING_ROLES` has eleven members and this vocabulary has twenty. Widening
 * the enum was the obvious move and is the wrong one, for three reasons:
 *
 * 1. **`PLANNING_ROLES` is persisted.** It is a field on `sourceRecordSchema`,
 *    written into every region pack, and packs are immutable and never rewritten
 *    — only superseded. Old packs must keep parsing, and they would; but every
 *    pack built before the change would carry the coarse vocabulary while new
 *    ones carried the fine one, so every consumer would have to handle both
 *    forever. That is a migration whose cost never ends.
 *
 * 2. **Half of this vocabulary is not a property of a category at all.**
 *    `duplicate` is a fact about link resolution, `permanently_closed` about the
 *    source's status field, `insufficient_identity` about the record's name. None
 *    of them is knowable when a pack is built from a taxonomy, and freezing a
 *    per-compilation judgement into a shared, traveller-independent, immutable
 *    artifact is exactly the mistake the pack/region split exists to prevent.
 *
 * 3. **A derived layer can be revised; a persisted one cannot.** Getting the
 *    boundary between `support_stop` and `transport` wrong is a table edit here
 *    and a schema version bump there.
 *
 * So the pack keeps its eleven values unchanged, `TaxonomySubrole` adds the
 * category detail as a *derived* field, and this file composes the two with the
 * record's own status into a permission. `planningRoleOf` maps back, so a caller
 * that only has the coarse vocabulary is never handed a value it cannot store.
 */

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * Roles a traveller chooses between: things to do, and one thing to eat.
 *
 * `itinerary_anchor`, `classic` and `discovery` are *tiers* rather than kinds,
 * and the kind is always carried separately as `roleBasis.kind`, so nothing is
 * lost when a tier wins. What separates them is how much of a day the archetype
 * can hold, whether anybody gates and tickets that kind of thing, and whether
 * the source named a thing or only a family — all read from the category, and
 * none of them from a traveller, a score or an attribute count.
 *
 * The permissions of all eight are identical bar `market`, which is the point:
 * the tier is what a card says, not what a candidate is allowed to do.
 */
export const ATTRACTION_ROLES = [
  /** Can hold a morning: a museum, a major hike, a park worth the drive. */
  'itinerary_anchor',
  /** A destination in its own right, ticketed or gated, but not a whole morning. */
  'classic',
  /** Real, worth going to, and nobody has written much about it. */
  'discovery',
  /** Worth ten minutes of detour, never worth building a day around. */
  'side_quest',
  /** Weather-, season- and daylight-bound: trails, water, terrain, wildlife. */
  'outdoor',
  /** Museums, historic buildings, monuments. */
  'cultural',
  /** Viewpoints, scenic routes, ways up. */
  'scenic',
  /** Somewhere to eat *and* a thing to do. Holds both relevances at once. */
  'market',
] as const;

/** Somewhere to eat, and only that. Markets are in both families deliberately. */
export const FOOD_ROLES = ['food', 'market', 'food_support'] as const;

/** Real, useful, and never a reason to go anywhere. */
export const UTILITY_ROLES = [
  /** How you arrive and where a base goes: airports, terminals, stations. */
  'gateway',
  /** Movement somebody sells: drivers, transfers, hire cars, tour desks. */
  'transport',
  /** Built, mapped, never scheduled: parking, pylons, pipelines. */
  'infrastructure',
  /** Visitor centres, pharmacies, fuel, campgrounds, civic premises. */
  'support_stop',
  /** Somewhere to sleep. A base, not a visit. */
  'lodging_support',
  /** Groceries, convenience shops, delis: where an outdoor day is provisioned. */
  'food_support',
] as const;

/** Not a travel candidate, and the reason it is not is worth keeping. */
export const REJECTED_ROLES = [
  /** A business. Mapped, real, and not a destination. */
  'generic_commercial',
  /** A boundary, a division, a named area used for containment. */
  'administrative_object',
  /** Another record already carries this entity. */
  'duplicate',
  /** The source says this has permanently closed. */
  'permanently_closed',
  /** No usable name: the record cannot be offered to anybody. */
  'insufficient_identity',
  /** Street furniture, or a category nobody published that we recognise. */
  'insufficient_travel_value',
] as const;

export const CANDIDATE_ROLES = [
  ...ATTRACTION_ROLES,
  'food',
  ...UTILITY_ROLES,
  ...REJECTED_ROLES,
] as const;

export type AttractionRole = (typeof ATTRACTION_ROLES)[number];
export type CandidateRole = (typeof CANDIDATE_ROLES)[number];

const ATTRACTION_ROLE_SET: ReadonlySet<string> = new Set(ATTRACTION_ROLES);
const FOOD_ROLE_SET: ReadonlySet<string> = new Set(FOOD_ROLES);
const REJECTED_ROLE_SET: ReadonlySet<string> = new Set(REJECTED_ROLES);

export function isAttractionRole(role: CandidateRole): boolean {
  return ATTRACTION_ROLE_SET.has(role);
}

/** True for the three roles a meal or a provisioning stop can come from. */
export function isFoodRole(role: CandidateRole): boolean {
  return FOOD_ROLE_SET.has(role);
}

export function isRejectedRole(role: CandidateRole): boolean {
  return REJECTED_ROLE_SET.has(role);
}

// ---------------------------------------------------------------------------
// What a role is allowed to be used for
// ---------------------------------------------------------------------------

/**
 * The six questions a downstream layer asks, named so it cannot ask a seventh.
 *
 * Six separate permissions rather than one boolean, because the answers really
 * do differ: a market belongs on the board *and* in the food portfolio, a
 * restaurant belongs in a day but not on the board, and a car park belongs in
 * the routing graph and nowhere a traveller can see.
 */
export const ELIGIBILITY_SLOTS = [
  /** A card on the Discovery Board, offered to the traveller to tick. */
  'provisionalBoard',
  /** Counted as something to do, and as supply when we say a region is thin. */
  'attractionPortfolio',
  /** Considered for a meal or for provisioning. */
  'foodPortfolio',
  /** Kept as a stop that makes a day work without being its reason. */
  'supportPortfolio',
  /** A node in the travel-time graph. Never rendered as a plan item. */
  'routingSupport',
  /** May be scheduled into a day of the finished itinerary. */
  'finalItinerary',
] as const;
export type EligibilitySlot = (typeof ELIGIBILITY_SLOTS)[number];

export type SlotPermissions = Readonly<Record<EligibilitySlot, boolean>>;

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

/**
 * A market is the one entry that is true in both families at once.
 *
 * Not a special case bolted on: it is why `market` is its own role rather than a
 * kind of food or a kind of attraction. Filed under food it never reaches the
 * board, so a traveller who came for markets is never offered one; filed under
 * attractions it never reaches a meal, so the food planner walks them past it.
 * The permission table is the only place that can say "both", and it does.
 */
const MARKET_PERMISSIONS: SlotPermissions = { ...VISITABLE, foodPortfolio: true };

const UTILITY: SlotPermissions = {
  ...NOTHING,
  supportPortfolio: true,
  routingSupport: true,
};

/**
 * The whole enforcement surface, in one table.
 *
 * Deliberately a table and not a function: a reader can check every row against
 * the rules in one screen, and a new role cannot be added without a row, because
 * the type is total.
 */
export const ROLE_PERMISSIONS: Readonly<Record<CandidateRole, SlotPermissions>> = {
  itinerary_anchor: VISITABLE,
  classic: VISITABLE,
  discovery: VISITABLE,
  side_quest: VISITABLE,
  outdoor: VISITABLE,
  cultural: VISITABLE,
  scenic: VISITABLE,
  market: MARKET_PERMISSIONS,

  /**
   * A meal is scheduled and routed; it is not something to tick on a board.
   *
   * The board answers "what is there to do here", and a hundred restaurants is
   * not an answer to it — that is the food planner's question, asked once the
   * day already has a shape. This is also what stops a region's food count
   * masking an attraction shortage.
   */
  food: {
    ...NOTHING,
    foodPortfolio: true,
    supportPortfolio: true,
    routingSupport: true,
    finalItinerary: true,
  },

  /**
   * A gateway anchors a region; it does not occupy a day.
   *
   * `finalItinerary` is false even though a traveller does in fact go to the
   * airport, because an arrival is produced by the trip's own shape — dates,
   * times, the base portfolio — rather than by a candidate competing for a slot.
   * A gateway that could be scheduled is a gateway that can be scheduled *twice*.
   */
  gateway: UTILITY,
  transport: UTILITY,
  /** Routable, and invisible. A car park is not a stop on anybody's day. */
  infrastructure: { ...NOTHING, routingSupport: true },
  support_stop: UTILITY,
  lodging_support: UTILITY,
  food_support: { ...UTILITY, foodPortfolio: true },

  generic_commercial: NOTHING,
  administrative_object: NOTHING,
  duplicate: NOTHING,
  permanently_closed: NOTHING,
  insufficient_identity: NOTHING,
  insufficient_travel_value: NOTHING,
};

/**
 * Back to the vocabulary a pack can store.
 *
 * Lossy on purpose and in one direction only. A caller writing a `SourceRecord`
 * needs one of eleven values; a caller deciding what to show needs one of
 * twenty. Nothing reads this to make a permission decision — that is what
 * `ROLE_PERMISSIONS` is for — so the loss costs nothing.
 */
export function planningRoleOf(role: CandidateRole): PlanningRole {
  switch (role) {
    case 'itinerary_anchor':
    case 'classic':
    case 'discovery':
    case 'cultural':
      return 'attraction';
    case 'side_quest':
      return 'side_quest';
    case 'outdoor':
    case 'scenic':
      return 'outdoor';
    case 'market':
      return 'market';
    case 'food':
      return 'food';
    case 'gateway':
      return 'gateway';
    case 'transport':
    case 'support_stop':
    case 'food_support':
      return 'support';
    case 'lodging_support':
      return 'lodging';
    case 'infrastructure':
      return 'infrastructure';
    case 'administrative_object':
      return 'administrative';
    default:
      return 'excluded';
  }
}

// ---------------------------------------------------------------------------
// The assessment
// ---------------------------------------------------------------------------

/** Why a role a caller might have expected was not the answer. */
export const ROLE_REJECTION_REASONS = [
  /** The source's category is a way of getting somewhere, not somewhere to go. */
  'transport_category',
  /** The source's category is a business. */
  'commercial_category',
  /** The source's category is practical: provisioning, information, civic. */
  'support_category',
  /** The source's category is built infrastructure. */
  'infrastructure_category',
  /** The source's category is somewhere to sleep. */
  'lodging_category',
  /** The source's category is a meal, not a thing to do. */
  'food_category',
  /** The source's category is a boundary or a division. */
  'administrative_category',
  /** Nobody published a category we recognise, and absence is not evidence. */
  'no_recognised_category',
  /** The source says this is permanently closed. */
  'record_permanently_closed',
  /** Another record already carries this entity. */
  'superseded_by_link',
  /** The record has no name a traveller could be shown. */
  'no_usable_name',
  /** Short and ungated: a stop, never a morning. */
  'cannot_hold_a_day',
  /** The taxonomy already refused this record, and a refusal is a floor. */
  'not_a_travel_candidate',
] as const;
export type RoleRejectionReason = (typeof ROLE_REJECTION_REASONS)[number];

export interface RoleRejection {
  role: CandidateRole;
  reason: RoleRejectionReason;
}

/**
 * What decided the role, kept so a card, a log and a coverage report can all
 * say the same thing.
 *
 * `decidedBy` is deliberately coarser than `match`: a record can be refused for
 * a reason that has nothing to do with its category, and flattening the two
 * would make "we did not recognise the category" indistinguishable from "the
 * source says it shut".
 */
export interface RoleBasis {
  decidedBy:
    | 'record_operating_status'
    | 'link_resolution'
    | 'missing_identity'
    | 'stored_pack_role'
    | 'source_category';
  /** How the source's own vocabulary matched. */
  match: TaxonomyMatch;
  /** The category archetype. Always present, even when a refusal won. */
  kind: TaxonomySubrole;
}

export interface CandidateEligibility {
  role: CandidateRole;
  /**
   * How much the role is worth, 0–1, and it is about the *evidence* rather than
   * about the place.
   *
   * A leaf match is the source naming exactly what this is; a branch match is
   * the source naming a family and us inferring the rest; no match at all is a
   * refusal, and its confidence is low because the refusal is the conservative
   * answer rather than a discovery. Nothing may read this as fit, quality,
   * popularity or importance — there is no such number anywhere in this stack,
   * which is a feature.
   */
  roleConfidence: number;
  roleBasis: RoleBasis;
  /** Roles this record does not hold, and why it does not hold them. */
  rejectedRoles: readonly RoleRejection[];
  eligibility: SlotPermissions;
  /** The coarse role a pack can store. Never used for a permission. */
  planningRole: PlanningRole;
  /** The full classification, so a caller need not run the taxonomy twice. */
  taxonomy: TaxonomyClassification;
}

/**
 * Everything the decision is allowed to read.
 *
 * Note what is absent: there is no `TravelerProfile`, no fit score, no
 * popularity, no richness, no attribute count and no provider count. That is not
 * an oversight to be corrected later — it is the enforcement. A traveller cannot
 * turn an airport into a viewpoint if the function that decides never learns who
 * the traveller is, and a well-catalogued car park cannot outrank a museum if
 * the function never learns how well catalogued anything is.
 */
export interface RoleEligibilityInput {
  /** The source's own leaf category, verbatim. */
  sourceCategory: string;
  /** The source's category path, outermost first. */
  sourceCategoryPath?: readonly string[];
  /** The record's name, so an unnamed record can be refused rather than shown. */
  name?: string;
  /** The source's own status. Never guessed, and honoured when present. */
  operatingStatus?: 'open' | 'closed';
  /**
   * The role stored on the pack, and only `administrative` is read from it.
   *
   * The asymmetry first: a stored *positive* is never honoured. A pack built
   * before a role existed stored everything positive as `attraction`, so
   * trusting one would freeze an old vocabulary into every future compilation.
   *
   * Of the stored refusals, only `administrative` is honoured, and the reason is
   * that it is the one refusal the category table cannot reach. A division is
   * published by the divisions layer with no business category at all, so
   * nothing here could recognise it; whereas the *other* refusal a normaliser
   * writes — `excluded` for a record the source says has shut — is carried
   * independently as `operatingStatus` and is honoured above, from the fact
   * rather than from a role somebody derived from it.
   *
   * A stored `excluded` is deliberately **not** honoured beyond that, and the
   * asymmetry cuts both ways for the same reason: `excluded` is the largest and
   * least stable bucket in the pack vocabulary, so a pack built before `market`
   * or `outdoor` existed carries stale refusals, and reading them would freeze
   * an old table's mistakes into a new compilation exactly as reading a stale
   * positive would. The category is recomputed instead, which is the whole point
   * of the classification being derived. An audit of the normaliser confirms the
   * only `excluded` it writes that the table would not reproduce is closure.
   */
  packRole?: PlanningRole;
  /** True when link resolution decided another record carries this entity. */
  superseded?: boolean;
}

/**
 * A minute count under which a category cannot hold a morning.
 *
 * Two hours, and it is a property of the *archetype* rather than of the place: a
 * museum's two hours and a day hike's three are what the table says that kind of
 * thing takes, so nothing here is a claim about any particular one. It is the
 * only threshold in this file, and it separates `itinerary_anchor` from the
 * kinds below it — never a utility role from an attraction one, because no
 * duration may ever do that.
 */
const ANCHOR_MINUTES = 120;

const CONFIDENCE_BY_MATCH: Record<TaxonomyMatch['kind'], number> = {
  source_leaf_category: 0.95,
  source_category_path: 0.8,
  source_branch: 0.6,
  no_recognised_category: 0.25,
};

/**
 * The one entry point. Deterministic, total, and free.
 *
 * Runs before candidate scoring, before the shortlist and before the board —
 * which is the only ordering under which "high prominence cannot override an
 * ineligible role" can be true, because after scoring there is a number and
 * numbers compare.
 */
export function assessRoleEligibility(input: RoleEligibilityInput): CandidateEligibility {
  const taxonomy = classifySourceCategory({
    category: input.sourceCategory,
    ...(input.sourceCategoryPath ? { path: input.sourceCategoryPath } : {}),
  });

  const resolved = resolveRole(input, taxonomy);
  return {
    role: resolved.role,
    roleConfidence: resolved.confidence,
    roleBasis: {
      decidedBy: resolved.decidedBy,
      match: taxonomy.match,
      kind: taxonomy.subrole,
    },
    rejectedRoles: rejectionsFor(resolved.role, resolved.reason),
    eligibility: ROLE_PERMISSIONS[resolved.role],
    planningRole: planningRoleOf(resolved.role),
    taxonomy,
  };
}

/** The same assessment, read straight off a normalised pack record. */
export function assessRecordEligibility(
  record: SourceRecord,
  options?: { superseded?: boolean },
): CandidateEligibility {
  return assessRoleEligibility({
    sourceCategory: record.sourceCategory,
    sourceCategoryPath: record.sourceCategoryPath,
    name: record.name,
    ...(record.operatingStatus ? { operatingStatus: record.operatingStatus } : {}),
    packRole: record.planningRole,
    ...(options?.superseded ? { superseded: true } : {}),
  });
}

/** Whether a record may be used for one particular thing. The whole point. */
export function isEligibleFor(
  eligibility: CandidateEligibility,
  slot: EligibilitySlot,
): boolean {
  return eligibility.eligibility[slot];
}

interface Resolution {
  role: CandidateRole;
  confidence: number;
  decidedBy: RoleBasis['decidedBy'];
  reason: RoleRejectionReason;
}

/**
 * Refusals first, then the category. The order is the guarantee.
 *
 * A refusal cannot be outvoted by a category, and a category cannot be outvoted
 * by anything at all — because nothing else is in scope. There is no branch
 * below that reads a score, a profile or an attribute count, so the three rules
 * the brief calls out (prominence, completeness, interest) hold structurally
 * rather than by anybody remembering them.
 */
function resolveRole(
  input: RoleEligibilityInput,
  taxonomy: TaxonomyClassification,
): Resolution {
  if (input.operatingStatus === 'closed') {
    return {
      role: 'permanently_closed',
      confidence: 1,
      decidedBy: 'record_operating_status',
      reason: 'record_permanently_closed',
    };
  }

  if (input.superseded === true) {
    return {
      role: 'duplicate',
      confidence: 1,
      decidedBy: 'link_resolution',
      reason: 'superseded_by_link',
    };
  }

  /**
   * A record with no name cannot be offered to anybody.
   *
   * "No name" also covers a record named after its own category — a listing
   * whose name is the word `Restaurant` is a row in a database, not a place a
   * traveller can be told to go to. The comparison is against the source's own
   * category string, so it names nothing and holds in every language the
   * catalogue publishes a category in.
   */
  const name = (input.name ?? '').trim();
  if (name.length < 2 || normaliseWord(name) === normaliseWord(input.sourceCategory)) {
    return {
      role: 'insufficient_identity',
      confidence: 1,
      decidedBy: 'missing_identity',
      reason: 'no_usable_name',
    };
  }

  if (input.packRole === 'administrative') {
    return {
      role: 'administrative_object',
      confidence: 1,
      decidedBy: 'stored_pack_role',
      reason: 'administrative_category',
    };
  }

  const confidence = CONFIDENCE_BY_MATCH[taxonomy.match.kind];
  return {
    ...roleForClassification(taxonomy),
    confidence,
    decidedBy: 'source_category',
  };
}

/**
 * The category archetype, turned into a permission-bearing role.
 *
 * Every utility and rejected branch is decided by the subrole alone. Only after
 * all of those have been ruled out does the attraction tier get to run — which
 * is the sentence that makes "a scenic airport viewpoint is never inferred from
 * the airport category" true: `gateway_air` returns before any code that could
 * produce `scenic` is reached.
 *
 * Exported so the floor below can be tested against a classification the current
 * table cannot produce. That is the only reason: nothing outside this file may
 * decide a role, and `assessRoleEligibility` remains the entry point.
 */
export function roleForClassification(
  taxonomy: TaxonomyClassification,
): { role: CandidateRole; reason: RoleRejectionReason } {
  /**
   * The taxonomy's own refusal is a floor, and this is the line that makes it
   * one.
   *
   * `excluded` is the pack vocabulary's "not a trip", and a subrole is a
   * *refinement* of a role, never an appeal against it. Without this, annotating
   * the education branch as `civic` — which it is — would quietly turn a school
   * into a support stop, because `civic` is otherwise a supporting archetype.
   * A refinement that can promote is not a refinement.
   */
  if (taxonomy.role === 'excluded') {
    return taxonomy.subrole === 'commerce'
      ? { role: 'generic_commercial', reason: 'commercial_category' }
      : { role: 'insufficient_travel_value', reason: 'not_a_travel_candidate' };
  }

  switch (taxonomy.subrole) {
    case 'gateway_air':
    case 'gateway_rail':
    case 'gateway_road':
    case 'gateway_water':
      return { role: 'gateway', reason: 'transport_category' };
    case 'ground_transport':
      return { role: 'transport', reason: 'transport_category' };
    case 'parking':
    case 'utility':
      return { role: 'infrastructure', reason: 'infrastructure_category' };
    case 'provisioning':
      return { role: 'food_support', reason: 'support_category' };
    case 'visitor_information':
    case 'support_service':
    case 'civic':
      return { role: 'support_stop', reason: 'support_category' };
    case 'lodging':
      return { role: 'lodging_support', reason: 'lodging_category' };
    case 'commerce':
      return { role: 'generic_commercial', reason: 'commercial_category' };
    case 'street_furniture':
      return { role: 'insufficient_travel_value', reason: 'no_recognised_category' };
    case 'unclassified':
      /**
       * Absence of a category is not evidence of an attraction.
       *
       * The taxonomy already refuses to promote an unknown record; this is the
       * same refusal expressed as a permission, and it is the reason the whole
       * table can be an allowlist. A catalogue we have never seen before adds
       * nothing to the board until somebody adds its words to `taxonomy.ts`.
       */
      return { role: 'insufficient_travel_value', reason: 'no_recognised_category' };
    case 'food_service':
      return { role: 'food', reason: 'food_category' };
    case 'market':
    case 'cultural':
    case 'scenic':
    case 'outdoor_nature':
    case 'urban_place':
      /*
       * THE ROLE IS A FLOOR FOR THE WHOLE UTILITY HALF, NOT ONLY FOR `excluded`.
       *
       * Five archetypes reach a visitable role, and until now the only thing
       * standing between a *utility* record and one of them was that no rule in
       * the table happened to pair, say, a `support` role with an
       * `outdoor_nature` archetype. That is a property of the table, checked by
       * a table test, and it is one spread away from not holding: writing
       * `{ ...HIKE, role: 'support' }` for a guided-walk desk would have
       * produced `itinerary_anchor`, because this switch reads only the subrole
       * and `HIKE` is three hours long.
       *
       * The rule the `excluded` branch above already states — "a subrole is a
       * refinement of a role, never an appeal against it" — is not special to
       * `excluded`. A gateway, a support stop, a bed and a pylon are refusals of
       * exactly the same kind, and each of them is a refusal the traveller-
       * facing slots must respect. So the floor is applied to all of them, and
       * the demotion below is what the record is instead.
       */
      if (!isVisitableRole(taxonomy.role)) return utilityRoleFor(taxonomy.role);
      return taxonomy.subrole === 'market'
        ? { role: 'market', reason: 'food_category' }
        : { role: attractionRole(taxonomy), reason: 'cannot_hold_a_day' };
  }
}

/**
 * What a record is when its archetype says "visit" and its role says otherwise.
 *
 * The role wins, and this is the demotion. Every arm is the same answer the
 * subrole switch above gives for that role's own archetypes, so the two agree by
 * construction rather than by coincidence — a `support` role lands on
 * `support_stop` here and on `support_stop` there.
 */
function utilityRoleFor(
  role: PlanningRole,
): { role: CandidateRole; reason: RoleRejectionReason } {
  switch (role) {
    case 'gateway':
      return { role: 'gateway', reason: 'transport_category' };
    case 'support':
      return { role: 'support_stop', reason: 'support_category' };
    case 'lodging':
      return { role: 'lodging_support', reason: 'lodging_category' };
    case 'infrastructure':
      return { role: 'infrastructure', reason: 'infrastructure_category' };
    case 'administrative':
      return { role: 'administrative_object', reason: 'administrative_category' };
    case 'food':
      return { role: 'food', reason: 'food_category' };
    default:
      /*
       * `excluded` returned above, and the four visitable roles never reach
       * here. Anything a widened `PLANNING_ROLES` adds lands on the refusal,
       * which is the conservative direction and the one a new value should
       * default to until somebody decides what it means.
       */
      return { role: 'insufficient_travel_value', reason: 'not_a_travel_candidate' };
  }
}

/**
 * Which attraction role, once the family is already settled.
 *
 * The tier is read from the archetype's own duration and gating — how long this
 * *kind* of thing takes and whether anybody sells a ticket for it — and from
 * nothing else. There is no prominence term because there is no prominence
 * input; a record cannot climb from `discovery` to `itinerary_anchor` by being
 * better catalogued, and neither can it climb into this function at all.
 *
 * `side_quest` and `outdoor` come from the pack's own role rather than being
 * re-derived, because `taxonomy.ts` already resolved the one case where the two
 * compete: a viewpoint is both short and weather-bound, and only the second of
 * those changes a plan.
 */
function attractionRole(
  taxonomy: TaxonomyClassification,
): AttractionRole | 'insufficient_travel_value' {
  // 1. A side quest is defined by not being able to hold a day. It wins first,
  //    so no later rule can hand it a morning.
  if (taxonomy.role === 'side_quest') return 'side_quest';

  // 2. Weather-, season- and daylight-boundness changes plans, so it outranks
  //    everything below. The scenic split is the one `taxonomy.ts` already
  //    resolved: a viewpoint is short *and* worthless in cloud, and only the
  //    second of those matters.
  if (taxonomy.role === 'outdoor') {
    return taxonomy.subrole === 'scenic' ? 'scenic' : 'outdoor';
  }

  // 3. The source named a *family*, not a thing. Borrowing an archetype from a
  //    branch is how we get a duration and an exposure at all; claiming it is a
  //    museum on that basis would be inventing one. `discovery` is the honest
  //    label for "real, and nobody wrote down what it is".
  /*
   * A BRANCH IS NOT A PERMISSION.
   *
   * This returned `discovery` — a full board card — for anything whose *branch*
   * we recognise and whose leaf we do not. Seven branches map to visitable
   * rules, so every unlisted leaf beneath them was offered as a thing to do: a
   * gym and an arcade under `active_life`, a private tour guide and a helicopter
   * charter under `attractions_and_activities`, a cemetery and a military base
   * under `cultural_and_historic`. A review reproduced it end to end — a
   * driver-for-hire filed one branch over from the one we fixed arrived on the
   * board described as "a historic site" and ranked *up* for anyone who had
   * ticked history and culture.
   *
   * That is the reported Bali defect with a different parent, and the file
   * previously claimed the opposite in as many words: "a catalogue we have never
   * seen before adds nothing to the board until somebody adds its words".
   *
   * So a branch tells us what *kind of thing* this might be — enough to give it
   * an archetype, a duration and an exposure, which is why the record is still
   * kept and still routable — and it does not tell us the record is worth
   * somebody's morning. Only a leaf or a path match can say that.
   *
   * The cost is real and is the right way round: a catalogue whose leaves we do
   * not know yields a thinner board, and `assessVisitableSupply` reports the
   * thinness. A board padded with gyms reports nothing at all.
   */
  if (
    taxonomy.match.kind === 'source_branch' ||
    taxonomy.match.kind === 'no_recognised_category'
  ) {
    return 'insufficient_travel_value';
  }

  // 4. It can hold a morning. A property of the archetype's own duration — never
  //    of how well catalogued any particular record is.
  if (taxonomy.typicalDurationMinutes >= ANCHOR_MINUTES) return 'itinerary_anchor';

  // 5–7. Otherwise the kind, which is the most useful thing left to say.
  if (taxonomy.subrole === 'cultural') return 'cultural';
  if (taxonomy.subrole === 'scenic') return 'scenic';
  if (taxonomy.subrole === 'outdoor_nature') return 'outdoor';

  /*
   * 8. Somebody sells a ticket for this kind of thing, so it is a destination
   *    rather than a stop — but it is neither long enough to be an anchor nor
   *    one of the kinds above.
   *
   *    No leaf in today's table reaches here: every gated sub-two-hour leaf we
   *    list turns out to be cultural or scenic. The role is kept because the
   *    table will grow and because the alternative — folding it into
   *    `discovery` — would say "nobody has written much about this" about a
   *    ticketed attraction, which is the one thing it is not. The complete-table
   *    test below asserts the current producers, so a table edit that starts
   *    reaching this row is visible rather than silent.
   */
  return taxonomy.plausiblyGated ? 'classic' : 'discovery';
}

/**
 * The roles this record does **not** hold, each with the reason.
 *
 * Emitted rather than implied because "why is this not on my board" is a
 * question a traveller, a support engineer and a coverage report all ask, and
 * three separate reconstructions of the answer is three chances to give
 * different ones. Bounded to the attraction family plus `food`: those are the
 * roles something could plausibly have been mistaken for, and listing all
 * nineteen others would be noise.
 */
function rejectionsFor(
  role: CandidateRole,
  reason: RoleRejectionReason,
): RoleRejection[] {
  const held = new Set<CandidateRole>([role]);
  if (role === 'market') held.add('food');

  const contested: CandidateRole[] = [...ATTRACTION_ROLES, 'food'];
  const rejections: RoleRejection[] = [];
  for (const candidate of contested) {
    if (held.has(candidate)) continue;
    /*
     * Inside the attraction family the refusal is about shape, not about worth:
     * a viewpoint is not an anchor because a viewpoint takes forty-five minutes,
     * which is a different sentence from "an airport is not an anchor".
     */
    const why =
      isAttractionRole(role) || role === 'food'
        ? candidate === 'food' || role === 'food'
          ? 'food_category'
          : 'cannot_hold_a_day'
        : reason;
    rejections.push({ role: candidate, reason: why });
  }

  return rejections;
}

function normaliseWord(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}
