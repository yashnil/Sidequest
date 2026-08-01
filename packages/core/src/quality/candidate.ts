import type { PlaceEvidence } from '../schemas/evidence';
import type { Place } from '../schemas/place';

/**
 * IS THIS WORTH A TRAVELLER'S TIME?
 *
 * The question the compiler could not answer before this module existed, and the
 * reason an unmarked grave ranked beside a museum: a mapped object with a name
 * and a matching tag looked exactly like an attraction, because "has a name and
 * a matching tag" was the whole test.
 *
 * What replaces it is a set of signals, each of which is a fact about the
 * candidate rather than an opinion about the place:
 *
 * - how much evidence exists about it at all
 * - whether anyone official corroborates it
 * - whether anything suggests the public actually visits it
 * - how granular the mapped feature is
 * - whether it duplicates something already selected
 * - what the detour costs and whether it is feasible on these dates
 *
 * Two rules keep this honest and keep it generic.
 *
 * **No name lists, and no category vetoes.** The feature class is an input, not
 * a verdict. A sculpture with an operator, published hours and a ticket page is
 * a museum's worth of evidence and ranks accordingly; a sculpture with a name
 * and nothing else does not. That asymmetry is the whole design — it demotes
 * thin records everywhere on earth without ever naming one.
 *
 * **Popularity is not quality.** `popularityScore` appears nowhere below. A
 * niche place with strong evidence and a strong fit beats a famous place that
 * suits this traveller badly, which is the product's entire premise.
 */

export const CANDIDATE_OUTCOMES = [
  'must_see_classic',
  'high_fit_discovery',
  'nearby_side_quest',
  'scenic_detour',
  'rainy_day_option',
  'food_or_market',
  'support_stop',
  'low_confidence',
  'not_worth_detour',
  'redundant',
  'closed_or_unavailable',
  'insufficient_evidence',
] as const;
export const candidateOutcomeSchema = CANDIDATE_OUTCOMES;
export type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

export const CANDIDATE_OUTCOME_LABELS: Record<CandidateOutcome, string> = {
  must_see_classic: 'Must-see classic',
  high_fit_discovery: 'Made for you',
  nearby_side_quest: 'Side quest',
  scenic_detour: 'Scenic detour',
  rainy_day_option: 'Rainy-day option',
  food_or_market: 'Food and markets',
  support_stop: 'Useful stop',
  low_confidence: 'Needs verification',
  not_worth_detour: 'Not worth the detour',
  redundant: 'You are already going here',
  closed_or_unavailable: 'Shut on your dates',
  insufficient_evidence: 'Too little known',
};

/** Whether an outcome belongs in the "things to skip" section. */
export function isSkipOutcome(outcome: CandidateOutcome): boolean {
  return (
    outcome === 'not_worth_detour' ||
    outcome === 'redundant' ||
    outcome === 'closed_or_unavailable' ||
    outcome === 'insufficient_evidence'
  );
}

/**
 * How much ground a mapped feature covers.
 *
 * Derived from the classifying tag alone, so it works for any destination.
 * `micro` is the class that most needs saying: a plaque, a bench, a memorial, a
 * single artwork, a trail junction. None of those are worthless — several are
 * lovely things to walk past — but none of them is a reason to build a day
 * around, and before this existed several of them were.
 */
export const FEATURE_SCALES = ['micro', 'site', 'area'] as const;
export type FeatureScale = (typeof FEATURE_SCALES)[number];

/**
 * Tag *values* that name a single small object rather than somewhere you spend
 * an hour. Values, not places — this list is the same in Reykjavik and Osaka.
 */
const MICRO_FEATURE_VALUES = new Set([
  'artwork',
  'memorial',
  'monument',
  'grave',
  'grave_yard',
  'wayside_cross',
  'wayside_shrine',
  'boundary_stone',
  'milestone',
  'bench',
  'picnic_table',
  'information',
  'board',
  'guidepost',
  'viewpoint_marker',
  'tomb',
  'stone',
  'tree',
]);

/** Tag values that name a landscape or district rather than a single site. */
const AREA_FEATURE_VALUES = new Set([
  'nature_reserve',
  'national_park',
  'protected_area',
  'park',
  'beach',
  'glacier',
  'volcano',
  'archaeological_site',
  'marketplace',
]);

export function featureScale(place: Place): FeatureScale {
  const value = classifyingTagValue(place);
  if (value && MICRO_FEATURE_VALUES.has(value)) return 'micro';
  if (value && AREA_FEATURE_VALUES.has(value)) return 'area';
  return 'site';
}

/** `tourism=viewpoint` → `viewpoint`. Undefined when nothing tagged it. */
export function classifyingTagValue(place: Place): string | undefined {
  for (const tag of place.tags) {
    const index = tag.indexOf('=');
    if (index > 0) {
      const value = tag.slice(index + 1).trim().toLowerCase();
      if (value.length > 0) return value;
    }
  }
  return undefined;
}

export interface QualityInput {
  place: Place;
  evidence?: PlaceEvidence;
  /** 0–1, from the trip's own scorer. Never popularity. */
  fitScore: number;
  /** Minutes one way from the base. */
  detourMinutes: number;
  /** How many already-ranked candidates share this category. */
  categoryCount: number;
  /** True when something larger already covers this ground. */
  supersededByParent: boolean;
  /** True when an equal-or-better duplicate was already kept. */
  duplicate: boolean;
  /** From the season and hours layers. */
  usableOnTripDates: boolean;
  /** True when nobody publishes hours and the kind of place plausibly gates. */
  openingUncertain: boolean;
  /** Detour tolerance the traveller actually stated, in minutes. */
  detourToleranceMinutes: number;
}

export interface QualitySignals {
  /** 0–1. How many evidence dimensions produced anything at all. */
  evidenceCompleteness: number;
  /** An official voice said something about this. */
  officialCorroboration: boolean;
  /** Something indicates the public is expected: hours, a fee, a website. */
  publicVisitation: boolean;
  scale: FeatureScale;
  /** 0–1. 1 when the detour is free, 0 when it is past what they will travel. */
  routeFeasibility: number;
  /** How saturated this category already is on the board. */
  categorySaturation: number;
}

export interface QualityAssessment {
  signals: QualitySignals;
  /** 0–1, and the only number the ranker sorts on. */
  score: number;
  outcome: CandidateOutcome;
  /** One sentence a person could argue with. Rendered as-is on the board. */
  reason: string;
}

/**
 * The evidence dimensions that count towards completeness.
 *
 * Six, weighted equally, because weighting them would require asserting that a
 * price matters more than a closure — which depends entirely on the traveller.
 */
function completenessOf(place: Place, evidence: PlaceEvidence | undefined): number {
  const marks = [
    evidence?.officialUrl !== undefined,
    evidence?.booking !== undefined,
    (evidence?.costs.length ?? 0) > 0,
    (evidence?.closures.length ?? 0) > 0 || (evidence?.safety.length ?? 0) > 0,
    evidence?.suggestedDurationMinutes !== undefined,
    place.shortDescription.trim().length > 40,
    // What the source database itself recorded. See `recordedAttributes`.
    recordedAttributes(place).length > 0,
  ];
  return marks.filter(Boolean).length / marks.length;
}

/**
 * Attributes the source database recorded about this place.
 *
 * Emitted by a discovery provider as `attr:<name>` tags — deliberately the
 * attribute *names* and not their values, which keeps this a signal about how
 * completely something is described rather than a copy of somebody's database.
 *
 * This is the pre-research evidence that matters most, and leaving it out was a
 * real defect: before it, the only thing separating a well-described museum from
 * an unnamed feature at this stage was how long a sentence our own classifier
 * had written about it. A live New York compile dropped fifteen of twenty
 * candidates on that basis alone.
 */
export function recordedAttributes(place: Place): string[] {
  return place.tags
    .filter((tag) => tag.startsWith('attr:'))
    .map((tag) => tag.slice('attr:'.length))
    .filter((name) => name.length > 0);
}

/**
 * Attributes that indicate somebody expects visitors: a published site, posted
 * hours, a fee, a named operator, an entry in an open structured database.
 * Generic across every mapping vocabulary that records them.
 */
const VISITATION_ATTRIBUTES = new Set([
  'website',
  'contact:website',
  'opening_hours',
  'fee',
  'operator',
  'wikidata',
  'wikipedia',
  'phone',
  'contact:phone',
]);

function hasPublicVisitationEvidence(place: Place, evidence: PlaceEvidence | undefined): boolean {
  if (evidence?.officialUrl !== undefined) return true;
  if ((evidence?.costs.length ?? 0) > 0) return true;
  if (evidence?.booking !== undefined) return true;
  if (recordedAttributes(place).some((name) => VISITATION_ATTRIBUTES.has(name))) return true;
  // A place with a real visit duration attached by a source is one somebody
  // expects visitors at.
  return evidence?.suggestedDurationMinutes !== undefined;
}

export function assessCandidateQuality(input: QualityInput): QualityAssessment {
  const { place, evidence } = input;

  const evidenceCompleteness = completenessOf(place, evidence);
  const officialCorroboration = (evidence?.resolved ?? []).some(
    (fact) => fact.state === 'verified' || fact.state === 'corroborated',
  );
  const publicVisitation = hasPublicVisitationEvidence(place, evidence);
  const scale = featureScale(place);
  const tolerance = Math.max(15, input.detourToleranceMinutes);
  const routeFeasibility = Math.max(0, Math.min(1, 1 - input.detourMinutes / (tolerance * 1.5)));
  const categorySaturation = Math.min(1, input.categoryCount / 5);

  const signals: QualitySignals = {
    evidenceCompleteness,
    officialCorroboration,
    publicVisitation,
    scale,
    routeFeasibility,
    categorySaturation,
  };

  /**
   * The score. Fit leads, because the product ranks by fit; evidence is the
   * second term, because a place we cannot describe is a place we cannot
   * recommend; and the rest are penalties rather than credits, so a candidate
   * never climbs by being small and near.
   */
  let score =
    input.fitScore * 0.5 +
    evidenceCompleteness * 0.25 +
    routeFeasibility * 0.15 +
    (officialCorroboration ? 0.1 : 0);

  /**
   * The micro-feature penalty, and its escape hatch.
   *
   * A memorial nobody publishes anything about drops hard. A memorial with an
   * operator, a ticket page and published hours keeps almost all of it — which
   * is how a significant monument stays a headline stop and a roadside plaque
   * stops pretending to be one.
   */
  if (scale === 'micro' && !publicVisitation) score -= 0.3;
  else if (scale === 'micro') score -= 0.08;

  if (input.openingUncertain) score -= 0.05;
  score -= categorySaturation * 0.1;
  if (input.supersededByParent) score -= 0.15;

  score = Math.max(0, Math.min(1, score));

  const outcome = decideOutcome(input, signals, score);
  return { signals, score, outcome, reason: reasonFor(outcome, input, signals) };
}

function decideOutcome(
  input: QualityInput,
  signals: QualitySignals,
  score: number,
): CandidateOutcome {
  if (input.duplicate) return 'redundant';
  if (!input.usableOnTripDates) return 'closed_or_unavailable';

  /**
   * Too little known, and the bar moves with the scale of the thing.
   *
   * A landscape with a thin record is still a landscape; a single mapped object
   * with a thin record is a row in a database. So the floor is high for the
   * smaller feature and close to the floor for everything else — because this
   * runs *before* research, when almost nothing has evidence yet, and a bar set
   * where a museum fails it would empty the board.
   *
   * What the low bar still catches, and the reason it exists: a candidate with
   * no usable description, no official page, no price, no hours and no stated
   * duration is a name and a coordinate. That is the generic shape of the defect
   * the live evaluations surfaced.
   */
  const floor = signals.scale === 'micro' ? 0.34 : 0.09;
  if (signals.evidenceCompleteness < floor && !signals.publicVisitation) {
    return 'insufficient_evidence';
  }

  if (input.detourMinutes > input.detourToleranceMinutes * 1.5) return 'not_worth_detour';
  if (input.fitScore < 0.35 && score < 0.4) return 'not_worth_detour';

  if (signals.evidenceCompleteness < 0.34 && input.openingUncertain) return 'low_confidence';

  if (input.place.category === 'town_and_food') return 'food_or_market';
  if (
    input.place.weather.poorWeatherBackup &&
    (input.place.physicalIntensity === 'none' || input.place.physicalIntensity === 'easy')
  ) {
    return 'rainy_day_option';
  }
  if (input.place.category === 'scenic_drive' || input.place.category === 'viewpoint') {
    return 'scenic_detour';
  }
  if (signals.scale === 'micro') return 'support_stop';
  if (signals.officialCorroboration && input.fitScore >= 0.6 && input.place.hiddenGemScore < 0.5) {
    return 'must_see_classic';
  }
  if (input.fitScore >= 0.55) return 'high_fit_discovery';
  return 'nearby_side_quest';
}

function reasonFor(
  outcome: CandidateOutcome,
  input: QualityInput,
  signals: QualitySignals,
): string {
  switch (outcome) {
    case 'redundant':
      return 'Another stop on your board already covers this.';
    case 'closed_or_unavailable':
      return 'Shut, or out of season, on the dates you are travelling.';
    case 'insufficient_evidence':
      return signals.scale === 'micro'
        ? 'A small mapped feature with nothing published about it — a nice thing to pass, not a stop to plan.'
        : 'Too little is published about this for us to plan a visit around it.';
    case 'not_worth_detour':
      return input.detourMinutes > input.detourToleranceMinutes
        ? `${Math.round(input.detourMinutes)} minutes each way is past how far you said you would go.`
        : 'It is a poor match for how you said you like to travel.';
    case 'low_confidence':
      return 'We could not confirm when this is open, so we would not build a day around it.';
    case 'support_stop':
      return 'Worth a few minutes if you are passing, rather than a trip of its own.';
    case 'must_see_classic':
      return 'Well documented, officially sourced, and a strong match for you.';
    case 'high_fit_discovery':
      return 'A close match for what you said you care about.';
    case 'rainy_day_option':
      return 'Holds up when the weather does not.';
    case 'scenic_detour':
      return 'The route is the point here.';
    case 'food_or_market':
      return 'Somewhere to eat or browse, near where you will already be.';
    default:
      return 'A short hop from your base and a reasonable match.';
  }
}
