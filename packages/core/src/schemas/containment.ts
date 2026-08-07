import { z } from 'zod';
import { geographicEvidenceSchema, levelComparisonSchema, geographicLevelSchema } from './geographic-evidence';

/**
 * THE ONE AUTHORITATIVE CONTAINMENT CONTRACT.
 *
 * ---
 *
 * ## What this replaces
 *
 * Three vocabularies. The compiler's `backbone/containment.ts` declared six
 * relationships; `schemas/region-pack.ts` declared the same six again for
 * persistence; and four helpers describing an admission policy
 * (`partitionByMembership`, `canAnchor`, `admitsToVisitableSlot`,
 * `describeExternalInclusion`) had **no production readers at all**, so the
 * policy the comments described was enforced nowhere and
 * `membership_unknown` reached every slot including `anchor`.
 *
 * One vocabulary, declared once, in the package both the compiler and the web
 * app already depend on. Everything that produces a candidate produces one of
 * these, and everything that consumes a candidate reads eligibility off it
 * rather than re-deriving a rule.
 *
 * ## The rule the whole contract exists to hold
 *
 * > Distance may order candidates, prioritise geometric checks, bound provider
 * > work and support diagnostics. Distance alone may not prove membership, prove
 * > non-membership, create a gateway, create a satellite, grant board
 * > eligibility or grant planner eligibility.
 *
 * The argument, which is why no threshold can be tuned into correctness:
 * membership is a relation between a record and a **named entity**, and distance
 * is a function of two points and a metric. A function of coordinates alone is
 * invariant under every relabelling of the ground, so it cannot distinguish two
 * points 45 km apart that share a first-level division from two points 45 km
 * apart that straddle one — the division is not among its arguments. Any
 * threshold therefore partitions the plane into level sets of the *metric*, not
 * of the *belonging relation*. Under-exclusion is unbounded, because reach grows
 * with nights; over-exclusion is guaranteed, because real regions are not discs.
 * A radius that excludes an unrelated county 166 km away necessarily excludes a
 * legitimate regional member 45 km away.
 *
 * `diagnosticDistanceKm` is on every decision, and it is named `diagnostic`
 * because that is the only thing it is allowed to be.
 */

/**
 * The version of this contract, bumped when the meaning of a decision changes.
 *
 * Lives here rather than beside the overlay that builds decisions, because the
 * *cache key* has to carry it and the cache key is derived in this package. An
 * artifact built under an older contract is then recognisable as such rather
 * than silently comparable to a newer one — which is the failure mode the
 * previous session hit from the other direction, when a fingerprint change
 * orphaned every stored artifact and the test that should have caught it was
 * vacuous.
 */
export const TRIP_SCOPE_CONTRACT_VERSION = 1 as const;

/**
 * How a candidate stands to the ground the traveller chose.
 *
 * Eight values rather than a boolean, because the interesting cases are the ones
 * a boolean flattens: an airport an hour out is not inside and is not noise; a
 * record nobody placed is not inside and is not proven outside; a lake a
 * regional expansion deliberately added is outside the destination and inside
 * the trip.
 */
export const SCOPE_RELATIONSHIPS = [
  /** Inside the selected destination, on geometry. */
  'inside_scope',
  /**
   * Inside a division the destination *is*, established from published division
   * identity rather than from a name comparison. The strongest positive
   * available where no polygon exists, which is nearly everywhere.
   */
  'inside_selected_division',
  /**
   * Inside the selected **region**, where the destination is a region rather
   * than a locality.
   *
   * Its own value because a country trip and a town trip mean different things
   * by "inside": for a country, agreeing at region *is* membership; for a town,
   * agreeing at region says only that the record is in the same state.
   */
  'inside_selected_region',
  /**
   * Outside the destination, and deliberately added by regional expansion.
   *
   * Assigned by the trip-scope overlay after the expansion layer has run, never
   * at pack build — the pack is shared across travellers and an expansion is a
   * property of one. Adjacency alone never produces one: something has to have
   * asked for the area.
   */
  'regional_expansion_member',
  /**
   * Outside, and load-bearing: how the traveller arrives or leaves. Carries a
   * typed planning reason and never occupies a slot a traveller chooses between.
   */
  'adjacent_gateway',
  /**
   * Outside, in an area an expansion listed as optional. Remains labelled
   * wherever it is shown, and requires explicit inclusion to be used.
   */
  'optional_satellite',
  /**
   * Nobody published enough to say.
   *
   * Admitted to the pack and to a **provisional** board, where it is labelled;
   * withheld from final attraction slots and from the planner. Never promoted by
   * an absence — the escape hatch that said "if we could not identify the
   * destination, let anything anchor" is the single line that re-opened the
   * defect this contract closes, and it is gone.
   */
  'membership_unknown',
  /** Outside. Removed before personalisation and before any ranking. */
  'outside_scope',
] as const;
export const scopeRelationshipSchema = z.enum(SCOPE_RELATIONSHIPS);
export type ScopeRelationship = (typeof SCOPE_RELATIONSHIPS)[number];

/**
 * What the verdict was actually decided on.
 *
 * Recorded rather than implied, because the bases are not equally good and a
 * consumer is entitled to know which one answered. A region whose candidates are
 * all `no_evidence` is a region we admitted on nothing, and that is worth being
 * able to say out loud.
 */
export const CONTAINMENT_EVIDENCE_BASES = [
  /** A point inside the destination's own published boundary. */
  'selected_boundary_geometry',
  /** A point inside the published boundary of a division the destination is. */
  'selected_division_geometry',
  /** Shared published division identifiers. Identity, not names. */
  'division_identity',
  /** Levelled administrative names that agreed or disagreed. */
  'typed_administrative_names',
  /** The trip's own expansion, gateway or satellite decision. */
  'explicit_trip_relationship',
  /** Nobody published anything comparable. */
  'no_evidence',
] as const;
export const containmentEvidenceBasisSchema = z.enum(CONTAINMENT_EVIDENCE_BASES);
export type ContainmentEvidenceBasis = (typeof CONTAINMENT_EVIDENCE_BASES)[number];

/** How sure the basis makes us. Ordered, and never derived from a distance. */
export const CONTAINMENT_CONFIDENCES = ['high', 'medium', 'low', 'none'] as const;
export const containmentConfidenceSchema = z.enum(CONTAINMENT_CONFIDENCES);
export type ContainmentConfidence = (typeof CONTAINMENT_CONFIDENCES)[number];

export const CONTAINMENT_CONFIDENCE_BY_BASIS: Record<
  ContainmentEvidenceBasis,
  ContainmentConfidence
> = {
  selected_boundary_geometry: 'high',
  selected_division_geometry: 'high',
  division_identity: 'high',
  typed_administrative_names: 'medium',
  explicit_trip_relationship: 'high',
  no_evidence: 'none',
};

/** Why an external gateway is in the plan at all. Typed, never free text. */
export const GATEWAY_PLANNING_REASONS = [
  'traveller_named_gateway',
  'no_gateway_inside_scope',
  'water_or_air_crossing_required',
] as const;
export const gatewayPlanningReasonSchema = z.enum(GATEWAY_PLANNING_REASONS);
export type GatewayPlanningReason = (typeof GATEWAY_PLANNING_REASONS)[number];

/** Why a satellite or expansion member is in the trip. */
export const EXTERNAL_INCLUSION_REASONS = [
  'regional_expansion_requested',
  'expansion_base',
  'expansion_subregion',
  'traveller_requested_area',
] as const;
export const externalInclusionReasonSchema = z.enum(EXTERNAL_INCLUSION_REASONS);
export type ExternalInclusionReason = (typeof EXTERNAL_INCLUSION_REASONS)[number];

/**
 * How the candidate sits relative to the destination's geometry, where geometry
 * was available at all.
 *
 * `unknown` is a first-class member. Most destinations in the index publish a
 * centre and no polygon, so "we have no geometry to relate these with" is the
 * ordinary case and must not be written as `beyond_extent`.
 */
export const GEOMETRY_RELATIONSHIPS = [
  'inside_boundary',
  'outside_boundary',
  'boundary_unavailable',
] as const;
export const geometryRelationshipSchema = z.enum(GEOMETRY_RELATIONSHIPS);
export type GeometryRelationship = (typeof GEOMETRY_RELATIONSHIPS)[number];

/** A comparison at one level, kept with its level so it can be explained. */
export const levelVerdictSchema = z.object({
  level: geographicLevelSchema,
  comparison: levelComparisonSchema,
  /** The scope's own value, verbatim, where there was one to show. */
  expected: z.string().min(1).optional(),
  /** The candidate's value, verbatim, where there was one to show. */
  found: z.string().min(1).optional(),
});
export type LevelVerdict = z.infer<typeof levelVerdictSchema>;

/**
 * Which uses a candidate is permitted.
 *
 * Four booleans rather than one, because the four questions genuinely differ. A
 * record nobody could place is worth showing a traveller on a provisional board
 * — labelled, so they can say "yes, that one" — and is not worth building a
 * morning around. Collapsing those is what produced a board of somewhere else.
 *
 * Every one of these is a *permission*, computed before any score. A score is a
 * number; no number can grant a permission.
 */
export const eligibilitySchema = z.object({
  /** May be used at all for the role it claims. Set by role eligibility. */
  roleEligible: z.boolean(),
  /**
   * May be a card at all — on either board.
   *
   * Both boards, deliberately. A card that cannot be a final attraction must
   * never be a provisional one either: a traveller who sees an airport at the
   * cut, then watches it vanish from the finished plan, has no way to tell a fix
   * from a loss. What this permits is *appearing*; what it does not permit is a
   * day being built around it.
   */
  provisionalBoardEligible: z.boolean(),
  /**
   * May occupy the **anchor** slot — the thing a day is built around.
   *
   * Named for the board because that is where a traveller meets it, and it is
   * the attraction portfolio in the inventory's vocabulary.
   * `SLOTS_BY_RELATIONSHIP` in `balance.ts` is what enforces it, and
   * `balance.test.ts` asserts the two agree for every relationship in both
   * directions — so they are two tables with one meaning rather than two sources
   * of truth.
   *
   * `membership_unknown` is `false` here and `true` above: a place nobody could
   * confidently place may be offered and chosen and stopped at, and may not be
   * the reason a morning exists.
   */
  finalBoardEligible: z.boolean(),
  /**
   * May be resolved into a day at all.
   *
   * Separate from the board because a gateway is the case that needs both
   * answers at once: an airport reaches the planner, because a plan that cannot
   * mention where it lands is not a plan, and reaches no board, because a board
   * is what a traveller chooses between.
   */
  plannerEligible: z.boolean(),
});
export type ContainmentEligibility = z.infer<typeof eligibilitySchema>;

/**
 * One candidate, one scope, one decision — with everything the decision rested
 * on, so that a wrong verdict is traceable rather than merely wrong.
 */
export const containmentDecisionSchema = z.object({
  /** The candidate this is about. */
  candidateId: z.string().min(1),
  candidateName: z.string().optional(),
  /** The scope it was judged against, and the revision of that scope. */
  scopeId: z.string().min(1),
  scopeRevision: z.number().int().min(0),
  relationship: scopeRelationshipSchema,
  basis: containmentEvidenceBasisSchema,
  confidence: containmentConfidenceSchema,
  /** Typed, levelled evidence for the scope and for the candidate. */
  scopeEvidence: geographicEvidenceSchema,
  candidateEvidence: geographicEvidenceSchema,
  /** Every level that was actually compared, and how it came out. */
  levels: z.array(levelVerdictSchema).default([]),
  geometry: geometryRelationshipSchema,
  /**
   * Great-circle kilometres from the destination centre.
   *
   * Descriptive. It appears in diagnostics and in ordering, and it is
   * structurally incapable of changing `relationship` — an architecture test
   * asserts that this field is never read by the decision function.
   */
  diagnosticDistanceKm: z.number().min(0),
  gatewayReason: gatewayPlanningReasonSchema.optional(),
  inclusionReason: externalInclusionReasonSchema.optional(),
  /** Which selected cluster, base or area this serves, where one claimed it. */
  servesAreaId: z.string().min(1).optional(),
  eligibility: eligibilitySchema,
  /** One sentence, for diagnostics. Never names a destination in source. */
  reason: z.string().min(1),
});
export type ContainmentDecision = z.infer<typeof containmentDecisionSchema>;

/**
 * The relationships that never reach personalisation or a board ranking.
 *
 * The whole exclusion policy, in one place, so that "which relationships are
 * removed" is a fact somebody can read rather than a condition repeated in four
 * files.
 */
export const EXCLUDED_RELATIONSHIPS: readonly ScopeRelationship[] = ['outside_scope'];

/** Relationships that are positively inside the ground the traveller chose. */
export const INSIDE_RELATIONSHIPS: readonly ScopeRelationship[] = [
  'inside_scope',
  'inside_selected_division',
  'inside_selected_region',
];

/** Relationships that are outside and present because something asked. */
export const EXTERNAL_RELATIONSHIPS: readonly ScopeRelationship[] = [
  'regional_expansion_member',
  'adjacent_gateway',
  'optional_satellite',
];

/**
 * The admission table, declared rather than computed.
 *
 * A table because every previous attempt at this was a chain of `if`s spread
 * over four files, and the one line that mattered — an escape that promoted an
 * unidentifiable record when the destination's own identity was unresolvable —
 * was invisible inside it. Here the whole policy is nine rows and can be read
 * in one sitting, and an exhaustive test walks it.
 *
 * `roleEligible` is **not** in this table. Containment says where something is;
 * role says what it may be used for. The final eligibility is the conjunction,
 * and neither factor can override the other — which is what stops a famous
 * airport becoming an attraction and stops a genuine museum being deleted for
 * being unplaceable.
 */
export const RELATIONSHIP_ADMISSION: Readonly<
  Record<ScopeRelationship, Omit<ContainmentEligibility, 'roleEligible'>>
> = {
  inside_scope: { provisionalBoardEligible: true, finalBoardEligible: true, plannerEligible: true },
  inside_selected_division: {
    provisionalBoardEligible: true,
    finalBoardEligible: true,
    plannerEligible: true,
  },
  inside_selected_region: {
    provisionalBoardEligible: true,
    finalBoardEligible: true,
    plannerEligible: true,
  },
  regional_expansion_member: {
    provisionalBoardEligible: true,
    finalBoardEligible: true,
    plannerEligible: true,
  },
  /*
   * A gateway is how the trip gets in and out. It reaches the planner, because a
   * plan that cannot mention the airport it lands at is not a plan; it reaches
   * no board, because a board is what a traveller chooses between and nobody
   * chooses an airport.
   */
  adjacent_gateway: {
    provisionalBoardEligible: false,
    finalBoardEligible: false,
    plannerEligible: true,
  },
  /*
   * A satellite is offered and labelled, and is used only once something has
   * explicitly included it — at which point the overlay re-decides it as a
   * `regional_expansion_member`. Until then it may be shown and not planned.
   */
  optional_satellite: {
    provisionalBoardEligible: true,
    finalBoardEligible: false,
    plannerEligible: false,
  },
  /*
   * The honest unknown. Shown provisionally with its uncertainty on the card,
   * because a traveller can recognise a place we could not place; withheld from
   * the final board and from the planner, because we cannot.
   */
  membership_unknown: {
    provisionalBoardEligible: true,
    finalBoardEligible: false,
    plannerEligible: false,
  },
  outside_scope: {
    provisionalBoardEligible: false,
    finalBoardEligible: false,
    plannerEligible: false,
  },
};

/**
 * The eligibility a relationship and a role together permit.
 *
 * The only supported way to compute eligibility. Both factors are required and
 * both are restrictive: neither knownness, nor prominence, nor traveller
 * interest, nor geographic balancing appears here, because none of them is a
 * permission.
 */
export function eligibilityFor(
  relationship: ScopeRelationship,
  roleEligible: boolean,
): ContainmentEligibility {
  const admission = RELATIONSHIP_ADMISSION[relationship];
  return {
    roleEligible,
    provisionalBoardEligible: roleEligible && admission.provisionalBoardEligible,
    finalBoardEligible: roleEligible && admission.finalBoardEligible,
    plannerEligible: roleEligible && admission.plannerEligible,
  };
}

/** Whether a candidate may reach personalisation and ranking at all. */
export function admitsToInventory(relationship: ScopeRelationship): boolean {
  return !EXCLUDED_RELATIONSHIPS.includes(relationship);
}

/**
 * Whether a candidate may anchor a day.
 *
 * Positive membership plus planner eligibility, and nothing else. There is no
 * corroboration escape and no unknown-destination escape: if we could not
 * establish the destination's own identity, that is a gap in *our* evidence and
 * the honest consequence is a thin board, not a board of records we cannot
 * place. A budget-starved build must not be able to convert a coverage failure
 * into a membership claim.
 */
export function canAnchor(decision: Pick<ContainmentDecision, 'relationship' | 'eligibility'>): boolean {
  return (
    decision.eligibility.plannerEligible &&
    (INSIDE_RELATIONSHIPS.includes(decision.relationship) ||
      decision.relationship === 'regional_expansion_member')
  );
}
