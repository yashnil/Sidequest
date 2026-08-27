import type { TransportMode } from '../schemas/access';
import type { PlaceEvidence } from '../schemas/evidence';
import type { Place } from '../schemas/place';
import { REACH_MODE_PHRASE } from '../travel/reach';
import { KIND_ONLY_SHARE } from './significance';

/**
 * The standing model reaches consumers through the quality module's one door.
 *
 * `significance.ts` decides what prominence, local significance, hiddenness and
 * crowd *are*, and this file decides what a candidate is worth given them —
 * inputs and verdict, one module, one entry point. Anything that assesses a
 * candidate needs both, and a second barrel entry would let a caller take the
 * scores while skipping the rules below that say what may be ranked on.
 */
export * from './significance';

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
  /**
   * 0–1, from the trip's own scorer. Never popularity.
   *
   * This is also the **only** channel a graded refusal reaches candidate quality
   * through, and deliberately so. `scorePlace` already scales intensity, cost,
   * detour and logistics by the magnitude of anything the traveller said they
   * would rather not do; taking a second, separate `refusalMagnitude` here and
   * subtracting it again would penalise the same sentence twice, once through
   * fit and once through quality, for no additional information.
   *
   * The property that matters — every consumer interpreting one normalised
   * magnitude the same way — is held by there being one derivation, not by every
   * consumer having its own parameter.
   */
  fitScore: number;
  /**
   * Minutes one way from the base, **in the mode the traveller would use**.
   *
   * Absent when nothing usable was measured, and the absence is load-bearing: a
   * `0` here reads as "no detour at all" and hands an unroutable place a perfect
   * `routeFeasibility`, while any positive default invents a journey. Both are
   * claims; nothing is the truth. `routeFeasibility` becomes neutral and no
   * distance verdict is passed.
   */
  detourMinutes?: number;
  /**
   * The mode those minutes are in, for the one sentence that quotes them.
   *
   * The skip row renders no travel stat of its own, so this reason string is
   * the only travel fact on it — and "96 minutes each way is past how far you
   * said you would go" names no mode for a journey whose mode is the entire
   * question. Optional alongside `detourMinutes`, absent when it is.
   */
  detourMode?: TransportMode;
  /**
   * WHETHER THOSE MINUTES ARE THE JOURNEY, OR A STAND-IN FOR ONE NOBODY PRICED.
   *
   * `transitBlindWalk` asked of this candidate's own reach: the compilation
   * signed that nothing could time a scheduled route, the destination evidence
   * observes a scheduled network, and the walk is past what the traveller said
   * they would walk. Where that holds, the minutes above are a pedestrian clock
   * standing in for a train, and the refusal sentence may not be built out of
   * them.
   *
   * The live skip list is what this exists to stop: "1 hr 29 min each way on
   * foot is past how far you said you would go", over the principal temple of a
   * city with a metro, for a traveller who chose public transport. Every clause
   * of that sentence is false — it is not how far away the place is, it is not
   * how they would go, and it was not their answer that ruled it out. It was
   * our missing timetable, and the traveller was billed for it.
   *
   * Optional, and absent means "the walk is the journey", which is the ordinary
   * case and keeps every caller written before the distinction exactly as it
   * was. It is a fact about the trip's travel evidence and can only be supplied
   * by whoever holds it; nothing here may infer it from a duration.
   */
  journeyUnverified?: boolean;
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
  /**
   * 0–1. How many evidence dimensions produced anything at all.
   *
   * **A verification signal, never a rank.** It decides whether a candidate is
   * a name-and-a-coordinate (`insufficient_evidence`), whether its card needs a
   * "we could not confirm" warning (`low_confidence`), and it may break a tie
   * between candidates the honest dimensions cannot separate — its §7 job, all
   * of it. It holds no share of `score`, because a count of filled-in fields is
   * a fact about somebody's database and §8.3 bans ranking on that: a chain
   * café with posted hours and a website out-completed a famous garden on a
   * live Tokyo board, and took the garden's seat at the final cut.
   */
  evidenceCompleteness: number;
  /**
   * 0–1 composed kind-and-evidence significance, straight off the place.
   *
   * Present only where a producer composed it (`experienceSignificanceOf`, the
   * §8.3 dimension); absent means nobody could, which is a different claim
   * from a low value and is recorded as such. The score substitutes a neutral
   * read for the absence — see `UNKNOWN_SIGNIFICANCE_READ`.
   */
  experienceSignificance?: number;
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

/**
 * WHAT KIND OF STATEMENT THE REASON IS — BECAUSE A HEADING CLAIMS ONE OF THEM.
 *
 * `reason` is one sentence, and the surfaces that render it put a heading over
 * it that makes its own claim. "Worth skipping · Popular or nearby, and still a
 * poor match for how you said you travel" is a claim about *this traveller's
 * fit*; "Too little is published about this for us to plan a visit around it"
 * is a claim about *our evidence*; "Shut, or out of season, on the dates you
 * are travelling" is a claim about *the trip*. On the delivered packets the
 * first heading stood over sentences of all three kinds, so a traveller reading
 * "we could not confirm this" was told the product had weighed the place
 * against their answers and rejected it. It had not, and the two are acted on
 * differently: a fit refusal is settled, an evidence gap is something they can
 * go and close in a browser tab.
 *
 * Three values because there are three kinds of sentence in `reasonFor`, and a
 * surface routes on the code rather than pattern-matching the prose.
 */
export const REASON_BASES = ['fit_judgement', 'evidence_gap', 'trip_state'] as const;
export type ReasonBasis = (typeof REASON_BASES)[number];

export interface QualityAssessment {
  signals: QualitySignals;
  /** 0–1, and the only number the ranker sorts on. */
  score: number;
  outcome: CandidateOutcome;
  /** One sentence a person could argue with. Rendered as-is on the board. */
  reason: string;
  /**
   * Which of the three claims `reason` makes. A surface whose heading asserts
   * one of them may render only the reasons that make it, and must say less
   * about the rest rather than filing them under a heading that misdescribes
   * them.
   */
  reasonBasis: ReasonBasis;
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

/**
 * What the ranker reads when no producer composed an experience significance.
 *
 * The neutral middle, for the same reason `routeFeasibility` reads 0.5 when no
 * journey was measured: a 1 would reward a record for coming from a producer
 * that never asked the question, a 0 would punish it for the same, and neither
 * is a fact about the place. Compiled packs compose the score on every record;
 * the live map fallback does not, and within either producer the read is
 * uniform, so it never reorders candidates against each other dishonestly.
 */
export const UNKNOWN_SIGNIFICANCE_READ = 0.5;

export function assessCandidateQuality(input: QualityInput): QualityAssessment {
  const { place, evidence } = input;

  const evidenceCompleteness = completenessOf(place, evidence);
  const officialCorroboration = (evidence?.resolved ?? []).some(
    (fact) => fact.state === 'verified' || fact.state === 'corroborated',
  );
  const publicVisitation = hasPublicVisitationEvidence(place, evidence);
  const scale = featureScale(place);
  const tolerance = Math.max(15, input.detourToleranceMinutes);
  /*
   * Neutral, not perfect and not zero, where the journey is unknown. A 1 would
   * reward a place for being unroutable; a 0 would punish it for the same, and
   * neither is a fact about the place. 0.5 is the honest middle, and it is
   * `categorySaturation`'s treatment of an unknown too.
   */
  const routeFeasibility =
    input.detourMinutes === undefined
      ? 0.5
      : Math.max(0, Math.min(1, 1 - input.detourMinutes / (tolerance * 1.5)));
  const categorySaturation = Math.min(1, input.categoryCount / 5);

  const signals: QualitySignals = {
    evidenceCompleteness,
    ...(place.experienceSignificance !== undefined
      ? { experienceSignificance: place.experienceSignificance }
      : {}),
    officialCorroboration,
    publicVisitation,
    scale,
    routeFeasibility,
    categorySaturation,
  };

  /**
   * The score. Fit leads, because the product ranks by fit; **significance is
   * the second term**, because whether a place is worth a traveller's attention
   * is a question about the world, not about how completely somebody filled a
   * listing in; and the rest are penalties rather than credits, so a candidate
   * never climbs by being small and near.
   *
   * `evidenceCompleteness` held this quarter-share until 16B stage 8d, and the
   * consequence was measured on a live Tokyo pack: the final board cut ranked
   * on `fit·0.5 + completeness·0.25`, so a memorial plaque carrying a website
   * attribute (completeness 0.29, significance 0.22) held a seat at 0.671
   * while the city's headline imperial garden — significance 0.81 but a
   * thinner record — was cut at 0.571. That is §8.3's metadata heuristic
   * deciding a quarter of the last rung. Completeness now informs the
   * verification labels below and may break ties between candidates the honest
   * dimensions cannot separate; it holds no share of this number.
   *
   * The significance read is the §8.3 dimension the phase built for exactly
   * this: kind prior bounded at `KIND_ONLY_SHARE`, established evidence
   * bounded by the channel table, no count reaching it by any path — see
   * `composeExperienceSignificance`.
   */
  const significance = place.experienceSignificance ?? UNKNOWN_SIGNIFICANCE_READ;
  let score =
    input.fitScore * 0.5 +
    significance * 0.25 +
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
  return {
    signals,
    score,
    outcome,
    reason: reasonFor(outcome, input, signals),
    reasonBasis: reasonBasisFor(outcome, input),
  };
}

/**
 * The basis of the sentence `reasonFor` will produce, decided from the same two
 * inputs so the pair cannot disagree.
 *
 * `not_worth_detour` is the one outcome that produces sentences of two
 * different kinds, and it splits on exactly the condition `reasonFor` splits
 * on: an unpriced journey is our gap, and a measured one past a stated
 * tolerance is the traveller's own answer.
 */
function reasonBasisFor(outcome: CandidateOutcome, input: QualityInput): ReasonBasis {
  switch (outcome) {
    case 'insufficient_evidence':
    case 'low_confidence':
      return 'evidence_gap';
    case 'redundant':
    case 'closed_or_unavailable':
      return 'trip_state';
    case 'not_worth_detour':
      return input.journeyUnverified &&
        input.detourMinutes !== undefined &&
        input.detourMinutes > input.detourToleranceMinutes
        ? 'evidence_gap'
        : 'fit_judgement';
    default:
      return 'fit_judgement';
  }
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
   *
   * **Established significance is evidence too, and this gate has to hear it.**
   * A composed significance above `KIND_ONLY_SHARE` cannot be reached on the
   * kind prior alone — arithmetic, not convention — so it means somebody
   * outside the record vouched for this place: an encyclopaedic entry or
   * article, a second catalogue, a designation with a drawn boundary, an
   * authority publication. A record the world has vouched for is not a name
   * and a coordinate however few practical fields anyone filled in, and
   * dropping it here was this defect one rung later: on the live Tokyo replay
   * an encyclopaedically-noted canal (significance 0.66) was discarded as
   * `insufficient_evidence` because its *description was short*. It keeps its
   * verification label — unknown hours still read `low_confidence` below —
   * which is the honest split: completeness gates what we can *confirm*, never
   * what exists. The raw field is read, not the ranker's neutral substitute:
   * an absence means nobody composed the score, and an absence must never
   * open a gate.
   */
  const worldEstablished = (input.place.experienceSignificance ?? 0) > KIND_ONLY_SHARE;
  const floor = signals.scale === 'micro' ? 0.34 : 0.09;
  if (signals.evidenceCompleteness < floor && !signals.publicVisitation && !worldEstablished) {
    return 'insufficient_evidence';
  }

  /*
   * A distance verdict needs a distance. `undefined` skips the test entirely
   * rather than comparing against a fabricated number — an unroutable place is
   * `reach_unverified` on the card, and calling it "not worth the detour" would
   * be a confident sentence about a journey nobody established.
   *
   * The tolerance is the caller's, and it is now mode-aware: the board passes
   * `detourToleranceMinutesFor(profile, mode)`, so a train is judged against the
   * traveller's transport budget rather than against a driving radius they were
   * never asked about. It also cannot be zero any more — it used to be, whenever
   * the detour question was hidden, which made this line read `> 0` and stamped
   * `not_worth_detour` on every non-base place on the board.
   */
  if (
    input.detourMinutes !== undefined &&
    input.detourMinutes > input.detourToleranceMinutes * 1.5
  ) {
    return 'not_worth_detour';
  }
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
  /**
   * A classic is officially corroborated, a strong fit, and not a find.
   *
   * `hiddenness` where it was established, the legacy read where it was not.
   * What is deliberately absent from this condition is `evidenceRichness`: a
   * source filling in six attributes must never promote a place into the
   * classics, and under the old model — where popularity *was* the attribute
   * count — that is precisely what it did.
   */
  const hidden = input.place.hiddenness ?? input.place.hiddenGemScore;
  if (signals.officialCorroboration && input.fitScore >= 0.6 && hidden < 0.5) {
    return 'must_see_classic';
  }
  if (input.fitScore >= 0.55) return 'high_fit_discovery';
  return 'nearby_side_quest';
}

/**
 * "96 minutes" is an odometer reading; "1 hr 36 min" is how a person says it.
 * The same shape every other duration on the board already uses.
 */
function humaneMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
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
      /*
       * A JOURNEY NOBODY COULD PRICE IS NOT THE TRAVELLER'S FAULT, AND NOT A
       * CLOCK.
       *
       * Asked before the distance sentence, because the distance sentence is
       * built out of the two things that are untrue here: a walking clock for a
       * ride, and "you said" for an answer that ruled nothing out. See
       * `journeyUnverified`. What is left is what is true — nobody could
       * confirm a route — and it names our gap rather than their preference,
       * which is also the only version of this a traveller can act on.
       */
      if (
        input.journeyUnverified &&
        input.detourMinutes !== undefined &&
        input.detourMinutes > input.detourToleranceMinutes
      ) {
        return 'We could not confirm any route here, so we cannot say how far away it really is.';
      }
      return input.detourMinutes !== undefined &&
        input.detourMinutes > input.detourToleranceMinutes
        ? `${humaneMinutes(Math.round(input.detourMinutes))} each way${input.detourMode ? ` ${REACH_MODE_PHRASE[input.detourMode]}` : ''} is past how far you said you would go.`
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
      /*
       * No distance claim. This branch fires for candidates at any detour class,
       * including too-far and unmeasured ones, and it used to assert "a short
       * hop from your base" over all of them — a flat untruth on exactly the
       * cards whose whole problem is the journey.
       */
      return 'A reasonable match for how you said you like to travel.';
  }
}
