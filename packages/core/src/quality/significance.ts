import type { CrowdLevel } from '../schemas/common';
import type { Place } from '../schemas/place';

/**
 * ONE NUMBER WEARING FOUR HATS, TAKEN APART.
 *
 * Until this module existed, a candidate carried a single figure called
 * `popularity` that was computed from *metadata richness* — a Wikidata id worth
 * half of it, names in two languages a quarter, a second catalogue the last
 * quarter in one producer; literally `tagCount / 5` in the other. Three more
 * fields were then read off that same figure:
 *
 * - `hiddenGemScore = 1 − popularity`, an affine inverse, so "hidden gem" meant
 *   "we hold less metadata about it"
 * - `crowdLevel = popularity > 0.7 ? 'busy' : 'quiet'`, a threshold on the same
 *   number under a third name
 * - `source.confidence = 0.7`, which was not derived from anything at all
 *
 * A board built on that has two groups — "must-see classics" and "personalised
 * hidden gems" — which are the top and bottom of one metadata count. They cannot
 * disagree, because there is only one variable.
 *
 * So the concepts are separated here, and the separation is the point: each of
 * the scores below answers a *different* question, from a *different* channel of
 * evidence, and two of them are allowed to say opposite things about the same
 * place.
 *
 * | Score | The question it answers | Its evidence |
 * | --- | --- | --- |
 * | `globalProminence` | has the wider world taken note? | knowledge-base breadth, cross-catalogue corroboration |
 * | `localSignificance` | does this matter *here*? | authority publication, conferred designation, the region's own naming |
 * | `evidenceRichness` | how much did a source write down? | attribute count — and it never ranks |
 * | `hiddenness` | locally important, globally unnoticed? | the gap between the first two |
 * | `crowdExpectation` | how busy will it be? | visitation, capacity, season — never prominence |
 * | `sourceConfidence` | how well described is this record? | richness and corroboration |
 *
 * **Absent is a value.** Every score above except richness and confidence is
 * optional, and an absence means "nobody could establish this", which is not the
 * same claim as a low number and must never be written as one. A place nobody
 * has any evidence about is *not* a hidden gem — it is a place we know nothing
 * about, and the board has to be able to tell those two apart.
 */

/**
 * What is observable about a place before anything has been researched.
 *
 * Every field optional, because the two producers see different things: a
 * compiled region pack carries alternate names and provenance, a live map
 * fallback carries tags and nothing else. A caller passes what it has, and the
 * policy for turning any of it into a score lives here rather than in either
 * caller — which is what stops the two drifting apart, as they had.
 */
export interface StandingEvidence {
  /** An encyclopaedic knowledge base holds an entry for this place. */
  inKnowledgeBase?: boolean;
  /**
   * Names recorded in other languages or scripts.
   *
   * The closest thing to a sitelink count available before research: a place
   * catalogued in four languages has been written about in four languages. It is
   * a breadth signal and nothing else — a *count of alternate names*, never a
   * count of how completely somebody filled in a listing.
   */
  knowledgeBaseNameCount?: number;
  /**
   * Two catalogues, from two different layers, independently described this.
   *
   * Deliberately not "this record lists several upstream contributors". A
   * conflated catalogue merges providers into one row and we did not watch it
   * merge them, so that is provenance rather than agreement — the same rule the
   * confidence signals are held to.
   */
  crossDatasetCorroboration?: boolean;
  /**
   * URLs a source associates with the place, unclassified.
   *
   * Passed raw so the authority test lives in one place. A business publishing
   * its own site is not a local-significance signal — a franchise does that as a
   * matter of course — which is exactly the defect that made a chain café outrank
   * a shrine.
   */
  publishedSites?: readonly string[];
  /**
   * The source's own classifying vocabulary: its category and category path.
   *
   * Read only for *conferred* classes — a national park, a nature reserve, a
   * heritage listing. Those are statuses an authority grants, so a source
   * recording one is repeating somebody official; `museum` or `cafe` is a kind
   * of thing and says nothing about significance.
   */
  classifyingValues?: readonly string[];
  /** The region's own records name it: a division, or its own containing area. */
  namedInRegionRecords?: boolean;
  /**
   * Attributes a source filled in.
   *
   * Feeds `evidenceRichness` and, through it, `sourceConfidence`. It reaches no
   * ranking score by any path, which is the whole correction this module makes.
   */
  recordedAttributeCount?: number;
  crowd?: CrowdEvidence;
}

/**
 * Evidence about how many people are actually there.
 *
 * Its own channel because the alternative is what was there before: a threshold
 * on a metadata count, which says a well-catalogued backstreet is busy and an
 * untagged cathedral is quiet. Absent evidence produces an absent expectation.
 */
export interface CrowdEvidence {
  /** Published visitor numbers, per year. */
  annualVisitors?: number;
  /** Timed entry, a permit, a capacity cap: somebody has to manage the flow. */
  managedEntry?: boolean;
  /** Reachable only part of the year, so a year's visits arrive in months. */
  seasonalConcentration?: boolean;
}

export interface PlaceStanding {
  /** 0–1 knowledge-base breadth. Absent when no knowledge base mentions it. */
  globalProminence?: number;
  /** 0–1 evidence that it matters where it is. Absent when there is none. */
  localSignificance?: number;
  /** 0–1 how much a source wrote down. Always computable, never ranked on. */
  evidenceRichness: number;
  /** 0–1 locally significant beyond what the world has noticed. Absent when unknown. */
  hiddenness?: number;
  /** Absent unless something about visitation, capacity or season was published. */
  crowdExpectation?: CrowdLevel;
  /** 0–1 how well sourced the record is. Derived, never a constant. */
  sourceConfidence: number;
}

/**
 * What `popularityScore` reads when nothing establishes prominence.
 *
 * Low and deliberately uniform: two places nobody has catalogued are equally
 * uncatalogued, and any spread between them would be the metadata count coming
 * back in through the field it was removed from.
 */
export const UNKNOWN_PROMINENCE_READ = 0.15;

/**
 * What `hiddenGemScore` reads when hiddenness could not be established.
 *
 * Below every "is this a hidden gem" threshold in the product (0.6), and above
 * what a globally prominent place scores — so the ordering still says a quiet
 * find is more of a find than a famous museum, while the *no evidence at all*
 * case stops being promoted into the hidden-gem group on the strength of its own
 * emptiness.
 */
export const UNKNOWN_HIDDENNESS_READ = 0.2;

/**
 * Public-authority domains, as a suffix test.
 *
 * Narrow on purpose. A false negative costs an absent score, which the model is
 * built to carry; a false positive promotes a business's own listing into
 * evidence that a place matters, which is the failure this module exists to
 * undo. No tourism-board heuristic ("visit…", "…travel") is included for the
 * same reason: those domains are registrable by anyone.
 */
const AUTHORITY_DOMAIN_PATTERNS: readonly RegExp[] = [
  /\.gov$/,
  /\.gov\.[a-z]{2}$/,
  /\.gouv\.[a-z]{2}$/,
  /\.gob\.[a-z]{2}$/,
  /\.go\.[a-z]{2}$/,
  /\.govt\.[a-z]{2}$/,
  /\.gc\.ca$/,
  /\.admin\.ch$/,
  /\.europa\.eu$/,
  /\.int$/,
];

/** Whether a URL is published on a public-authority domain. */
export function isAuthorityPublishedSite(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AUTHORITY_DOMAIN_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Classes that exist because an authority conferred them.
 *
 * A designation is a *decision somebody published* — a boundary drawn, a listing
 * entered, a status granted — which is why it counts as local significance and
 * why `park`, `museum` and `viewpoint` are not on the list. Values only, in the
 * vocabularies open catalogues actually use, so the same set reads Iceland and
 * Osaka without naming either.
 */
const DESIGNATED_VALUES = new Set([
  'national_park',
  'state_park',
  'provincial_park',
  'regional_park',
  'national_forest',
  'national_monument',
  'nature_reserve',
  'nature_preserve',
  'protected_area',
  'wildlife_refuge',
  'wildlife_sanctuary',
  'marine_reserve',
  'biosphere_reserve',
  'world_heritage_site',
  'heritage_site',
  'listed_building',
  'scheduled_monument',
  'conservation_area',
]);

function normaliseValue(value: string): string {
  const afterEquals = value.includes('=') ? value.slice(value.indexOf('=') + 1) : value;
  return afterEquals.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function hasDesignatedStatus(classifyingValues: readonly string[]): boolean {
  return classifyingValues.some((value) => DESIGNATED_VALUES.has(normaliseValue(value)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Two decimals, so a compiled artifact is byte-stable and a card is readable. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Independent evidence combined without letting any single channel dominate.
 *
 * `1 − Π(1 − wᵢ)` rather than a sum: three weak signals should add up to
 * something short of certainty, and a sum would let two of them exceed it. It
 * also keeps every channel *optional* — a missing one contributes nothing rather
 * than dragging an average down, which is what makes "we did not observe this"
 * different from "this scored zero".
 */
function union(weights: readonly number[]): number | undefined {
  if (weights.length === 0) return undefined;
  let miss = 1;
  for (const weight of weights) miss *= 1 - clamp01(weight);
  return round(clamp01(1 - miss));
}

export function assessPlaceStanding(evidence: StandingEvidence): PlaceStanding {
  /**
   * GLOBAL PROMINENCE — knowledge-base breadth, and nothing else.
   *
   * No attribute count reaches this. That is the entire fix: a franchise
   * publishing its hours, its operator and its website used to score three
   * quarters of the way up this scale before anybody looked at what it was.
   */
  const prominenceSignals: number[] = [];
  if (evidence.inKnowledgeBase) prominenceSignals.push(0.5);
  const names = evidence.knowledgeBaseNameCount ?? 0;
  if (names >= 4) prominenceSignals.push(0.45);
  else if (names >= 2) prominenceSignals.push(0.3);
  if (evidence.crossDatasetCorroboration) prominenceSignals.push(0.3);
  const globalProminence = union(prominenceSignals);

  /**
   * LOCAL SIGNIFICANCE — a genuinely separate channel.
   *
   * None of these three is a side effect of a business describing itself, and
   * none of them is a knowledge-base entry: a place can be designated, published
   * by the authority that manages it and named in the region's own geography
   * while no encyclopaedia has ever heard of it. That combination is what the
   * old model had no way to express.
   */
  const localSignals: number[] = [];
  const authoritySite = (evidence.publishedSites ?? []).some(isAuthorityPublishedSite);
  if (authoritySite) localSignals.push(0.5);
  if (hasDesignatedStatus(evidence.classifyingValues ?? [])) localSignals.push(0.6);
  if (evidence.namedInRegionRecords) localSignals.push(0.35);
  const localSignificance = union(localSignals);

  /**
   * EVIDENCE RICHNESS — the number that used to be called popularity.
   *
   * Kept, because it is real and useful: it is why the hours are known and the
   * website is linkable. It feeds `sourceConfidence` and reaches no ranking
   * score. Six attributes is treated as a fully described record; beyond that a
   * source is describing itself rather than telling us more.
   */
  const evidenceRichness = round(clamp01((evidence.recordedAttributeCount ?? 0) / 6));

  /**
   * HIDDENNESS — how much more this matters locally than the world has noticed.
   *
   * A difference of two channels, not an inverse of one. The three cases the old
   * `1 − popularity` collapsed into a single ordering:
   *
   * - locally significant, globally unnoticed → high. **The hidden gem.**
   * - globally prominent → low, whatever else is true. It is not hidden.
   * - nothing established either way → **absent**. We know nothing about it,
   *   which is a different sentence from "it is undiscovered", and it is the one
   *   the evidence supports.
   *
   * An unknown channel counts as zero *inside* this subtraction, and only here:
   * having looked for a knowledge-base entry and found none is itself the
   * globally-obscure half of the claim. It stays absent on `globalProminence`
   * because we cannot put a number on breadth we never observed.
   */
  const hiddenness =
    globalProminence === undefined && localSignificance === undefined
      ? undefined
      : round(clamp01((localSignificance ?? 0) - (globalProminence ?? 0)));

  /**
   * SOURCE CONFIDENCE — computed, where it used to be the constant `0.7`.
   *
   * A hardcoded number is a claim that somebody measured our confidence and is
   * the one field on a card that must never be decorative. Richness and
   * corroboration are the two things actually observable at this stage.
   */
  const sourceConfidence = round(
    clamp01(0.35 + evidenceRichness * 0.35 + (evidence.crossDatasetCorroboration ? 0.2 : 0)),
  );

  const standing: PlaceStanding = {
    evidenceRichness,
    sourceConfidence,
    ...(globalProminence !== undefined ? { globalProminence } : {}),
    ...(localSignificance !== undefined ? { localSignificance } : {}),
    ...(hiddenness !== undefined ? { hiddenness } : {}),
  };
  const crowdExpectation = expectCrowd(evidence.crowd);
  return crowdExpectation !== undefined ? { ...standing, crowdExpectation } : standing;
}

/**
 * Crowd from crowd evidence, or nothing.
 *
 * Bands rather than a scale, because that is the resolution the evidence
 * supports: published visitor numbers are the only quantity here, and everything
 * else is a fact about how the place is run.
 */
export function expectCrowd(evidence: CrowdEvidence | undefined): CrowdLevel | undefined {
  if (!evidence) return undefined;
  if (evidence.annualVisitors !== undefined) {
    if (evidence.annualVisitors >= 1_000_000) return 'very_busy';
    if (evidence.annualVisitors >= 250_000) return 'busy';
    if (evidence.annualVisitors >= 25_000) return 'moderate';
    return 'quiet';
  }
  // Somebody had to cap or time the entry, which is what happens when demand
  // exceeds the space.
  if (evidence.managedEntry) return 'busy';
  // A year's visitors arriving inside a short season concentrates them, without
  // saying how many there are.
  if (evidence.seasonalConcentration) return 'moderate';
  return undefined;
}

/**
 * The three legacy `Place` fields, as *reads* of the standing above.
 *
 * `popularityScore`, `hiddenGemScore` and `crowdLevel` are required by the place
 * schema and read across the board, the autoselector, the fit scorer and the
 * coverage report. Rather than let each producer invent its own fallback — which
 * is how the two producers ended up with different formulas for the same field —
 * the projection happens once, here, beside the model it projects.
 *
 * Every one of them is lossy in the same direction: a required field cannot say
 * "unknown", so it says the conservative thing and the honest answer stays
 * available beside it on the optional field.
 */
export function standingFields(
  standing: PlaceStanding,
): Pick<Place, 'popularityScore' | 'hiddenGemScore' | 'crowdLevel'> &
  Partial<
    Pick<
      Place,
      | 'globalProminence'
      | 'localSignificance'
      | 'evidenceRichness'
      | 'hiddenness'
      | 'crowdExpectation'
    >
  > {
  return {
    popularityScore: standing.globalProminence ?? UNKNOWN_PROMINENCE_READ,
    hiddenGemScore: standing.hiddenness ?? UNKNOWN_HIDDENNESS_READ,
    /*
     * CROWD, INFERRED FROM PROMINENCE WHEN NOBODY MEASURED IT.
     *
     * `crowdExpectation` needs visitation, capacity or managed-entry evidence,
     * and packs carry almost none of it — so making `crowdLevel` a pure read of
     * it turned every place `'quiet'`. That is truthful about the *evidence*
     * and it silently removed a personal-fit axis: `crowdComfort` scored 1.0
     * for a crowd-averse traveller and an unbothered one alike, so two very
     * different people got the same board. Losing differentiation is not a
     * neutral cost of honesty; it is the product's whole point.
     *
     * So the legacy field keeps a prominence-derived read as its fallback —
     * which is what it always was — while `crowdExpectation` stays absent, and
     * absent is what a consumer that can tell inference from evidence reads.
     * A place nobody has heard of is still `'quiet'`, exactly as before.
     */
    crowdLevel:
      standing.crowdExpectation ??
      ((standing.globalProminence ?? 0) >= 0.7 ? 'busy' : 'quiet'),
    evidenceRichness: standing.evidenceRichness,
    ...(standing.globalProminence !== undefined
      ? { globalProminence: standing.globalProminence }
      : {}),
    ...(standing.localSignificance !== undefined
      ? { localSignificance: standing.localSignificance }
      : {}),
    ...(standing.hiddenness !== undefined ? { hiddenness: standing.hiddenness } : {}),
    ...(standing.crowdExpectation !== undefined
      ? { crowdExpectation: standing.crowdExpectation }
      : {}),
  };
}
