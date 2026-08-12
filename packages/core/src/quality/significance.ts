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
 * | `globalProminence` | has the wider world taken note? | an encyclopaedic entry, an encyclopaedic article, a second catalogue |
 * | `localSignificance` | does this matter *here*? | authority publication, conferred designation, the region's own naming |
 * | `evidenceRichness` | how much did a source write down? | attribute and name counts — and they never rank |
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
   * An encyclopaedia holds an *article* about this place, not just a row.
   *
   * A separate channel from `inKnowledgeBase` because the two are different
   * statements and the stronger one used to have no way to be heard. An
   * identifier says a catalogue minted a key for the thing; an article says
   * somebody wrote prose about it and other people kept it. On real compiled
   * packs the split is real — a third of the knowledge-base entries in a dense
   * city carry no article — and it is the channel that took over the
   * discriminating work the alternate-name count used to do.
   */
  encyclopaedicArticle?: boolean;
  /**
   * Names recorded in other languages or scripts.
   *
   * **A record-completeness signal, and nothing else.** It reaches
   * `evidenceRichness` and stops there, in the same place the recorded-attribute
   * count stops, and no ranking score can see it by any path.
   *
   * It has been demoted twice, and the second demotion is the one that took.
   * First it was a prominence channel in its own right, on the argument that a
   * place catalogued in four languages has been written about in four languages
   * — false in the direction that matters, because a commuter railway line
   * carries `["Keikyū-Hauptlinie","Keikyū Main Line","Línea Keikyū
   * principal","Linea Keikyu principale"]` only because multilingual mappers
   * translate route relations, and it reached a live board as a scenic
   * viewpoint on the strength of exactly that. Then it was made "corroborating
   * only": it could no longer *open* a prominence but it could still raise one,
   * and on a live compiled board that turned out to be the whole of the
   * ordering. Every distinct prominence on that board was one of three values —
   * an entry, an entry plus two names, an entry plus four — so a gate admitted
   * on evidence and a count then decided who won, which is §8.3's metadata
   * heuristic with an extra step in front of it.
   *
   * A count of names is a fact about how completely somebody filled a record
   * in. There is no weight small enough to make that a fact about the world.
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
 * EVERY STATEMENT SIGNIFICANCE IS ALLOWED TO HEAR, IN ONE TABLE.
 *
 * §8.3's instruction is "do not reduce this to one metadata-count heuristic",
 * and the way that instruction gets broken is never by naming a heuristic. It
 * gets broken by one channel being worth so much more than the others — or by
 * the others so rarely firing — that the ordering *is* that channel with noise
 * on it. Both halves of that have happened here: the alternate-name count was
 * the only thing separating one live board's candidates, and the three local
 * channels sat silent behind it because none of them was ever passed anything.
 *
 * So the channels are a table rather than a run of `if`s. Three properties
 * follow, and each is asserted rather than intended:
 *
 * - **Every claim is made by somebody outside the record.** An encyclopaedia,
 *   a second catalogue, a public authority, an act of designation, the
 *   surrounding geography. None of them can be produced by filling a listing
 *   in more completely, which is what makes this significance rather than
 *   completeness under a new name.
 * - **No one claim carries the ordering.** `MAX_SINGLE_CHANNEL_WEIGHT` bounds
 *   any single statement, and because the channels combine as a union rather
 *   than a sum, the top of the scale is reachable only where several of them
 *   agree.
 * - **Both questions get their own channels.** A place can be designated,
 *   published by the authority that manages it and named in the region's own
 *   geography while no encyclopaedia has heard of it; that is the combination
 *   the old single-figure model could not express at all.
 */
export type SignificanceChannelId =
  | 'knowledge_base_entry'
  | 'encyclopaedic_article'
  | 'cross_catalogue_corroboration'
  | 'authority_publication'
  | 'conferred_designation'
  | 'region_namesake';

export interface SignificanceChannel {
  id: SignificanceChannelId;
  /** Which of the two standing questions this statement answers. */
  standing: 'global' | 'local';
  /** 0–1 what this one statement is worth on its own. */
  weight: number;
  /** What has to be true *in the world* for it to fire. Never about the record. */
  claim: string;
}

/**
 * The most any one statement may be worth on its own.
 *
 * Not a tuning knob: it is the numeric form of "not one heuristic". A channel
 * above this bound would be able to decide the order by itself, at which point
 * the other five are decoration and the model is a single signal again — which
 * is the state two successive reviews found it in.
 */
export const MAX_SINGLE_CHANNEL_WEIGHT = 0.6;

export const SIGNIFICANCE_CHANNELS: readonly SignificanceChannel[] = [
  {
    id: 'knowledge_base_entry',
    standing: 'global',
    weight: 0.5,
    claim: 'An encyclopaedic knowledge base holds an entry for this place.',
  },
  {
    id: 'encyclopaedic_article',
    standing: 'global',
    weight: 0.4,
    claim: 'An encyclopaedia holds an article about it — prose, not an identifier.',
  },
  {
    id: 'cross_catalogue_corroboration',
    standing: 'global',
    weight: 0.3,
    claim: 'Two catalogues from different layers described it independently.',
  },
  {
    id: 'authority_publication',
    standing: 'local',
    weight: 0.5,
    claim: 'A public authority publishes it on its own domain.',
  },
  {
    id: 'conferred_designation',
    standing: 'local',
    weight: 0.6,
    claim: 'An authority granted it a status: protected, listed, reserved, designated.',
  },
  {
    id: 'region_namesake',
    standing: 'local',
    weight: 0.35,
    claim: "The region's own geography carries its name.",
  },
];

const CHANNEL_WEIGHT = Object.fromEntries(
  SIGNIFICANCE_CHANNELS.map((channel) => [channel.id, channel.weight]),
) as Record<SignificanceChannelId, number>;

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

/**
 * The highest prominence the model can express: every global channel agreeing.
 *
 * Derived from the table rather than written down, because a threshold above
 * what the model can reach is a branch that never runs, and one shipped: the
 * fit scorer's tourist-trap penalty tested `popularityScore >= 0.8` and stayed
 * alive only on the alternate-name count that used to inflate prominence past
 * that bar. Removing the count would have quietly killed it. A consumer that
 * needs "as noted as this model can say" reads this instead of guessing.
 */
export const MAX_GLOBAL_PROMINENCE = union(
  SIGNIFICANCE_CHANNELS.filter((channel) => channel.standing === 'global').map(
    (channel) => channel.weight,
  ),
)!;

/**
 * "One of the names people come here for."
 *
 * The bar at which a place is treated as widely known — for the tourist-trap
 * penalty, and for the card that tells a classics-minded traveller this is one
 * of the famous ones. Below `MAX_GLOBAL_PROMINENCE` by construction, and high
 * enough that no single channel reaches it: it takes an encyclopaedic entry
 * *and* an article, or an entry and a second catalogue and more, to clear it.
 */
export const WIDELY_NOTED_PROMINENCE = 0.7;

export function assessPlaceStanding(evidence: StandingEvidence): PlaceStanding {
  /**
   * GLOBAL PROMINENCE — established by something outside the record, or absent.
   *
   * No count reaches this, of attributes or of names. That is the whole of the
   * §8.3 requirement and both halves of it were violated in turn: a franchise
   * publishing its hours, its operator and its website used to score three
   * quarters of the way up this scale, and once that was removed a count of
   * translated names took over the same job one rung lower down, as the only
   * thing separating candidates that had passed the gate.
   *
   * What is left is three statements somebody outside this record made — a
   * knowledge base minted an entry, an encyclopaedia wrote an article, a second
   * catalogue in a different layer described the same thing — combined as a
   * union so that no one of them reaches the top of the scale alone.
   */
  const globalProminence = union([
    ...(evidence.inKnowledgeBase ? [CHANNEL_WEIGHT.knowledge_base_entry] : []),
    ...(evidence.encyclopaedicArticle ? [CHANNEL_WEIGHT.encyclopaedic_article] : []),
    ...(evidence.crossDatasetCorroboration
      ? [CHANNEL_WEIGHT.cross_catalogue_corroboration]
      : []),
  ]);

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
  if (authoritySite) localSignals.push(CHANNEL_WEIGHT.authority_publication);
  if (hasDesignatedStatus(evidence.classifyingValues ?? [])) {
    localSignals.push(CHANNEL_WEIGHT.conferred_designation);
  }
  if (evidence.namedInRegionRecords) localSignals.push(CHANNEL_WEIGHT.region_namesake);
  const localSignificance = union(localSignals);

  /**
   * EVIDENCE RICHNESS — the number that used to be called popularity, and the
   * only thing a count of anything is allowed to move.
   *
   * Kept, because it is real and useful: it is why the hours are known and the
   * website is linkable. It feeds `sourceConfidence` and reaches no ranking
   * score. Six recorded facts is treated as a fully described record; beyond
   * that a source is describing itself rather than telling us more.
   *
   * Names in other scripts count here, capped at two, and this is where they
   * were sent when they stopped being allowed to rank. A romanisation is a fact
   * somebody wrote down about the record — the same kind of fact as the opening
   * hours — and saying so in the field named "how much did a source write down"
   * is the honest home for it. The cap is there because the fourth translation
   * of a route relation tells us nothing the second did not.
   */
  const recordedFacts =
    (evidence.recordedAttributeCount ?? 0) + Math.min(evidence.knowledgeBaseNameCount ?? 0, 2);
  const evidenceRichness = round(clamp01(recordedFacts / 6));

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
 * Whether *anything* establishes that this place matters — globally or locally.
 *
 * The gate the evidence-demanding categories read: a bridge, a cemetery, a
 * structural claim or a point claiming to be a mountain is offered to a
 * traveller only when this is true. Deliberately a presence test rather than a
 * threshold: the standing model refuses to fabricate either channel, so "either
 * is defined" means one of the `SIGNIFICANCE_CHANNELS` above vouched for it —
 * an encyclopaedic entry, an encyclopaedic article, a second catalogue
 * describing it independently, a public authority publishing it, a conferred
 * designation, or the region's own geography carrying its name — and "neither"
 * means nothing did.
 *
 * Every one of those six is a statement somebody *else* made. None of them can
 * be produced by filling a record in more completely, which is the property
 * that makes this a significance test rather than the §8.3 metadata heuristic
 * under a new name. It was the latter for one release: `globalProminence` was
 * defined by a count of alternate names, so a commuter railway with four
 * translations passed the gate and a temple recorded once did not.
 */
export function hasSignificanceEvidence(standing: PlaceStanding): boolean {
  return standing.globalProminence !== undefined || standing.localSignificance !== undefined;
}

export interface ExperienceSignificanceInput {
  standing: PlaceStanding;
  /**
   * 0–1 how much a thing of this *kind* tends to matter as an experience — a
   * museum, a temple, a major park against a pocket park or a named slope.
   * Supplied by the category taxonomy, which is class evidence: it cannot be
   * moved by how completely a mapper filled in a listing.
   *
   * A **prior**, in the strict sense: what to believe about a place of this
   * kind before anybody has said anything about *this* one. See
   * `experienceSignificanceOf` for why that distinction is load-bearing.
   */
  categoryWeight: number;
}

/**
 * How far evidence may loosen the category's grip, at the kind most open to it.
 *
 * The number that turns the category weight from a ceiling into a prior. At
 * `0` this function is the old one: `categoryWeight` multiplies everything and
 * no quantity of evidence can lift a place past the best its kind is allowed to
 * score. Above `0`, evidence about *this* place opens headroom above the kind's
 * weight — in proportion to that weight, so the loosening is a loosening and
 * not a bypass.
 *
 * 1.5 is set by one requirement, not by taste: **evidence must be able to
 * overcome roughly one full step of category weight.** A kind weighted at half
 * another, with several independent statements behind it, has to outrank the
 * heavier kind with one statement behind it — otherwise "famous instance of a
 * modest kind" is a sentence the model cannot say.
 */
export const PRIOR_ELASTICITY = 1.5;

/**
 * What the kind alone is worth, as a share of the kind's own weight.
 *
 * Unchanged, and deliberately: at zero evidence this function returns exactly
 * what it always did, so every unevidenced place keeps its score and the change
 * below lands only where somebody has actually established something.
 */
export const KIND_ONLY_SHARE = 0.3;

/**
 * SIGNIFICANCE — one interpretable number for "is this worth a traveller's
 * attention", distinct from every metadata count.
 *
 * Two factors, and the *relationship* between them is the thing this function
 * has been rewritten for:
 *
 * - **What kind of thing it is** (`categoryWeight`) is a **prior**. A museum
 *   with no evidence at all still matters more than a slope with none, because
 *   the kinds differ — that is the floor that kept 24 micro-features from being
 *   outranked only by each other on a live board.
 * - **What the world has established about *this one*** (the standing's
 *   channels, unioned so no single one dominates) both raises the score and
 *   **raises the ceiling**.
 *
 * The second half is the correction. This used to be `categoryWeight × (0.3 +
 * 0.7 × established)`, in which the category is a hard multiplicative cap: a
 * kind weighted 0.4 could never score above 0.4 however much the world had said
 * about a particular instance, while a kind weighted 0.85 started above that
 * cap with nothing said about it at all. So a major urban park — encyclopaedic
 * article, second catalogue, the city's own naming — sat below an anonymous
 * gallery whose only qualification was being filed under a heavier word. §8.3
 * says significance is about *this place*, and a cap makes the category the
 * answer rather than the prior.
 *
 * `reach` is the repair. Evidence closes part of the distance between the
 * kind's weight and certainty, and the part it can close is itself scaled by
 * that weight — so a kind that is not an experience at all (`0`) stays at zero
 * no matter what is published about it, a modest kind can be argued a long way
 * up, and a kind already near the top has almost nothing left to gain. That
 * last property is why the change is surgical: at high weights `(1 − w) × w` is
 * small, so the anchors that were scoring correctly do not move.
 *
 * `evidenceRichness` reaches this number by no path, and neither does any count.
 */
export function experienceSignificanceOf(input: ExperienceSignificanceInput): number {
  const { standing } = input;
  const established =
    union(
      [standing.globalProminence, standing.localSignificance].filter(
        (value): value is number => value !== undefined,
      ),
    ) ?? 0;
  const prior = clamp01(input.categoryWeight);
  const reach = clamp01(prior + (1 - prior) * prior * established * PRIOR_ELASTICITY);
  return round(clamp01(reach * (KIND_ONLY_SHARE + (1 - KIND_ONLY_SHARE) * established)));
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
