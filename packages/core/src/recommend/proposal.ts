import { z } from 'zod';
import {
  RANK_DIMENSION_LABELS,
  rankedDestinationSchema,
  type RankDimension,
  type RankedDestination,
} from '../schemas/shortlist';

/**
 * V11 §3 — FROM A RANKED LIST TO AN ANSWER SOMEBODY CAN ACT ON.
 *
 * The ranker and the shortlist were already here and already good: eight
 * dimensions, unknown removed rather than scored, five to eight picks with
 * diversity applied. What was missing is everything between "a ranked list
 * exists" and "a traveller chose a trip".
 *
 * Three things, all deterministic:
 *
 * 1. **Three and a wildcard.** Five to eight is the right size for a *shortlist*
 *    and the wrong size for an *answer*. §3 asks for the best three plus one
 *    deliberate outlier, and the outlier is chosen for being different rather
 *    than for scoring fourth — a fourth-place pick that is a near-twin of the
 *    third teaches nobody anything.
 * 2. **Why X over Y.** A comparison across the dimensions where the two
 *    genuinely differ, in the traveller's own terms, with the dimensions they
 *    tie on left out because a table of nine equal rows hides the two that
 *    matter.
 * 3. **Reranking.** "Cheaper", "closer", "warmer" and the rest are re-weightings
 *    of dimensions already measured, so they need no model and no new evidence:
 *    the same picks, ordered by what the traveller just said matters more.
 *
 * No model call happens anywhere in this file, and none is needed.
 */

// ---------------------------------------------------------------------------
// Three and a wildcard
// ---------------------------------------------------------------------------

export const RECOMMENDATION_ROLES = ['best_fit', 'wildcard'] as const;
export type RecommendationRole = (typeof RECOMMENDATION_ROLES)[number];

export const destinationProposalSchema = z.object({
  role: z.enum(RECOMMENDATION_ROLES),
  destination: rankedDestinationSchema,
  /** Why this one is in the list at all, when it is the wildcard. */
  wildcardReason: z.string().min(1).max(200).optional(),
});
export type DestinationProposal = z.infer<typeof destinationProposalSchema>;

/**
 * How different two picks are, over the dimensions both were measured on.
 *
 * Mean absolute difference rather than score difference: two destinations can
 * reach the same score along completely different routes, and for a wildcard
 * that difference is the entire point.
 */
export function dimensionDistance(a: RankedDestination, b: RankedDestination): number {
  const byId = new Map(b.factors.map((factor) => [factor.id, factor] as const));
  let total = 0;
  let counted = 0;
  for (const factor of a.factors) {
    const other = byId.get(factor.id);
    if (!other || factor.measure.kind !== 'measured' || other.measure.kind !== 'measured') continue;
    total += Math.abs(factor.measure.value - other.measure.value);
    counted += 1;
  }
  return counted === 0 ? 0 : total / counted;
}

/**
 * The answer: the best three, and one deliberate outlier.
 *
 * The wildcard is the most *different* candidate from the three already chosen
 * that still scores respectably — never the strongest thing left over, and never
 * something the ranker excluded. A wildcard nobody could take is a joke at the
 * traveller's expense.
 */
export function proposeDestinations(input: { picks: readonly RankedDestination[]; best?: number; wildcardFloor?: number }): DestinationProposal[] {
  const best = input.best ?? 3;
  const floor = input.wildcardFloor ?? 0.6;
  const ordered = [...input.picks];
  const chosen = ordered.slice(0, best);
  const proposals: DestinationProposal[] = chosen.map((destination) => ({ role: 'best_fit' as const, destination }));
  const rest = ordered.slice(best);
  if (rest.length === 0) return proposals;

  /* Respectable means "within `floor` of the leader", so a wildcard is a real option and not a curiosity. */
  const leader = chosen[0]?.score ?? 0;
  const eligible = rest.filter((candidate) => candidate.score >= leader * floor && candidate.band !== 'thin_evidence');
  if (eligible.length === 0) return proposals;

  let pick = eligible[0]!;
  let widest = -1;
  for (const candidate of eligible) {
    const distance = Math.min(...chosen.map((other) => dimensionDistance(candidate, other)));
    if (distance > widest) {
      widest = distance;
      pick = candidate;
    }
  }
  const differing = mostDifferentDimensions(pick, chosen[0]!, 1)[0];
  proposals.push({
    role: 'wildcard',
    destination: pick,
    wildcardReason: differing
      ? `A different kind of trip from the three above — ${RANK_DIMENSION_LABELS[differing.id].toLowerCase()} in particular.`
      : 'A different kind of trip from the three above.',
  });
  return proposals;
}

// ---------------------------------------------------------------------------
// Why X over Y
// ---------------------------------------------------------------------------

export interface DimensionComparison {
  id: RankDimension;
  label: string;
  /** Positive when the left destination is better on this dimension. */
  delta: number;
  left: { value: number; basis: string } | null;
  right: { value: number; basis: string } | null;
  /** Absent on both sides, so the comparison says nothing about it. */
  bothUnknown: boolean;
}

export interface DestinationComparison {
  left: RankedDestination;
  right: RankedDestination;
  /** Dimensions where the two genuinely differ, biggest difference first. */
  differences: DimensionComparison[];
  /** Dimensions they tie on. Named, never listed row by row. */
  tied: RankDimension[];
  /** Dimensions neither could be measured on. */
  unknownForBoth: RankDimension[];
}

/** How far apart two picks are on each dimension, the widest first. */
export function mostDifferentDimensions(left: RankedDestination, right: RankedDestination, limit = 4): DimensionComparison[] {
  return compareDestinations(left, right).differences.slice(0, limit);
}

/**
 * A comparison a traveller asked for by name.
 *
 * Only the dimensions that differ by enough to be worth a sentence — a
 * two-percent edge on daylight is not a reason to choose a country — and the
 * ties and the blanks are reported as counts rather than as rows, because a
 * table where most rows say "the same" buries the two that do not.
 */
const MEANINGFUL_DIFFERENCE = 0.08;

export function compareDestinations(left: RankedDestination, right: RankedDestination): DestinationComparison {
  const rightById = new Map(right.factors.map((factor) => [factor.id, factor] as const));
  const differences: DimensionComparison[] = [];
  const tied: RankDimension[] = [];
  const unknownForBoth: RankDimension[] = [];

  for (const factor of left.factors) {
    const other = rightById.get(factor.id);
    if (!other) continue;
    const l = factor.measure.kind === 'measured' ? { value: factor.measure.value, basis: factor.measure.basis } : null;
    const r = other.measure.kind === 'measured' ? { value: other.measure.value, basis: other.measure.basis } : null;
    if (!l && !r) {
      unknownForBoth.push(factor.id);
      continue;
    }
    const delta = (l?.value ?? 0) - (r?.value ?? 0);
    if (l && r && Math.abs(delta) < MEANINGFUL_DIFFERENCE) {
      tied.push(factor.id);
      continue;
    }
    differences.push({ id: factor.id, label: RANK_DIMENSION_LABELS[factor.id], delta, left: l, right: r, bothUnknown: false });
  }

  differences.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.id.localeCompare(b.id));
  return { left, right, differences, tied, unknownForBoth };
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

export const RERANK_CONTROLS = ['cheaper', 'closer', 'warmer', 'more_adventurous', 'less_touristy', 'more_beach', 'more_hiking', 'easier_logistics'] as const;
export type RerankControl = (typeof RERANK_CONTROLS)[number];

export const RERANK_LABELS: Record<RerankControl, string> = {
  cheaper: 'Cheaper',
  closer: 'Closer to home',
  warmer: 'Warmer',
  more_adventurous: 'More adventurous',
  less_touristy: 'Less touristy',
  more_beach: 'More beach',
  more_hiking: 'More hiking',
  easier_logistics: 'Easier logistics',
};

/**
 * What each control actually leans on.
 *
 * Every entry is a dimension the ranker **already measured**, which is what
 * makes reranking free, instant and honest: pressing "warmer" does not go and
 * find new destinations, it re-asks the same question with the traveller's new
 * emphasis. A control with no measured dimension behind it would be a button
 * that pretends; there is none here.
 *
 * `more_beach` and `more_hiking` lean on `themeFit`, which is scored against the
 * traveller's own stated themes — so the caller adds the theme before reranking
 * and the lean amplifies it. That is stated because it is the one control whose
 * effect depends on an input change as well as a weight change.
 */
const CONTROL_EMPHASIS: Record<RerankControl, Partial<Record<RankDimension, number>>> = {
  cheaper: { comfortFit: 1.6, flightBurden: 1.4 },
  closer: { flightBurden: 3 },
  warmer: { climatePreferenceFit: 3, climateFit: 1.5 },
  more_adventurous: { noveltyFit: 2.5, varietyFit: 1.5, crowdFit: 1.3 },
  less_touristy: { crowdFit: 3, noveltyFit: 1.5 },
  more_beach: { themeFit: 2.5, climatePreferenceFit: 1.5 },
  more_hiking: { themeFit: 2.5, supplyFit: 1.3 },
  easier_logistics: { transportFit: 2.5, entryFriction: 2, structureFit: 1.5, flightBurden: 1.2 },
};

/**
 * The same picks, in the order the traveller's emphasis implies.
 *
 * Recomputed from each pick's own factors rather than from its score, so the
 * emphasis reaches the dimension and not a number that has already flattened
 * it. Unknown dimensions stay out of the denominator exactly as they do in the
 * original ranking, so leaning on something nobody measured changes nothing
 * rather than inventing a difference.
 */
export function rerankBy(picks: readonly RankedDestination[], controls: readonly RerankControl[]): RankedDestination[] {
  if (controls.length === 0) return [...picks];
  const emphasis: Partial<Record<RankDimension, number>> = {};
  for (const control of controls) {
    for (const [id, multiplier] of Object.entries(CONTROL_EMPHASIS[control]) as [RankDimension, number][]) {
      emphasis[id] = (emphasis[id] ?? 1) * multiplier;
    }
  }
  const scoreOf = (pick: RankedDestination): number => {
    let weight = 0;
    let earned = 0;
    for (const factor of pick.factors) {
      if (factor.measure.kind !== 'measured') continue;
      const w = factor.weight * (emphasis[factor.id] ?? 1);
      weight += w;
      earned += w * factor.measure.value;
    }
    return weight === 0 ? 0 : earned / weight;
  };
  /* A stable sort on the leaned score, with the original score as the tiebreak so the order never churns for nothing. */
  return [...picks].sort((a, b) => scoreOf(b) - scoreOf(a) || b.score - a.score || a.displayName.localeCompare(b.displayName));
}
