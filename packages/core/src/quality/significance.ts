import { foldForMatch } from '../destinations/normalize';
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
 * | `globalProminence` | has the wider world taken note, and of how much? | an encyclopaedic entry, an encyclopaedic article, a second catalogue — read through a magnitude |
 * | `noticeMagnitude` | how far does that notice reach past the row that minted it? | destination-scale designated ground, a precinct of namesakes |
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
   * What the source calls this place, for one purpose only: telling a page
   * *about* it from the page of the body that owns it.
   *
   * Never a ranking input on its own, and never compared with anything but a
   * URL published on an authority domain. See `authorityPageNamesSubject`.
   */
  subjectName?: string;
  /**
   * The source's own classifying vocabulary: its category and category path.
   *
   * Scanned for *conferred* classes — a national park, a nature reserve, a
   * heritage listing — and **never sufficient on its own**. See
   * `mappedExtentMetres` and `hasConferredDesignation` for the other half of
   * the test, which is the half that makes this evidence rather than filing.
   */
  classifyingValues?: readonly string[];
  /**
   * How far across the outline a source published for this record is, in
   * metres. Absent for a point feature or a polygon the width of a hair.
   *
   * Here for one reason: **a designation is a boundary somebody drew.** Without
   * it the designation channel reads a bag of words, and a word is how a
   * catalogue *filed* a row rather than anything about the world. See
   * `hasConferredDesignation`.
   */
  mappedExtentMetres?: number;
  /** The region's own records name it: a division, or its own containing area. */
  namedInRegionRecords?: boolean;
  /**
   * How many distinct guard-passed witnesses the surrounding *ground* gives
   * this place — records other than this one wearing its name, counted under
   * the ground-namesake channel's own guards (brand refusal, generic-name
   * ceiling, division bans, strict embedding). Absent or zero means the
   * channel is silent, which is not a claim that nobody names it.
   *
   * A graded signal, deliberately not flattened to a bit: the pack builder's
   * retention ledger already orders on this count because "a landmark the
   * surrounding ground names eight times" and "a pond named twice" are
   * different statements, and one bit cannot carry the difference. The seat
   * layer reads the same grade for the witness bound's ground door — see
   * `composeExperienceSignificance`.
   */
  groundWitnessCount?: number;
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
  /**
   * 0–1 how far the world's notice reaches beyond the row that minted it.
   *
   * Absent when nothing says. Carried on the standing because the number above
   * cannot answer "is this notice about a landmark or about a class every
   * catalogue notices" — see `NOTICE_MAGNITUDE_CHANNELS`. Nothing persists it;
   * it exists so a consumer, and a test, can read the ceiling's reason rather
   * than infer it from a rounded score.
   */
  noticeMagnitude?: number;
  /**
   * Which magnitude channel spoke, where either did.
   *
   * The number above says how much; only this says *what kind of statement it
   * was*, and the classics caption turns on the difference. See
   * `NOTICE_MAGNITUDES`.
   */
  noticeMagnitudeBasis?: NoticeMagnitudeBasis;
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
  /**
   * The graded ground-witness count, echoed when the channel fired (≥ 1).
   *
   * Carried on the standing because the bound's ground door needs the grade,
   * not the bit: `channels` can say the ground names this place, and only the
   * count can say whether one member wears the name or a precinct does.
   */
  groundWitnesses?: number;
  /**
   * Which statements actually fired, in table order.
   *
   * Carried because the two numbers above cannot answer "what kind of witness is
   * this" — they are unions, and a union of one operator statement is
   * arithmetically identical to a union of one encyclopaedic one. Every consumer
   * that has to weigh the *kind* of evidence rather than its amount reads this;
   * nothing persists it.
   */
  channels: readonly SignificanceChannelId[];
}

/**
 * What `popularityScore` reads when **no channel of any kind** spoke.
 *
 * Low and deliberately uniform: two places nobody has catalogued are equally
 * uncatalogued, and any spread between them would be the metadata count coming
 * back in through the field it was removed from.
 *
 * It was named `UNKNOWN_PROMINENCE_READ` and was reached by a much wider door:
 * *any* record without a knowledge-base tag, whatever else was established
 * about it. That made a missing tag into a claim of obscurity, and the live
 * cost was the sharpest inversion this model has shipped — a metropolis's
 * principal castle, whose own catalogue row carries no identifier, read 0.15
 * while a municipal sports park two kilometres away read 0.70 on the entry and
 * article the cataloguing convention mints for every park it maps. A missing
 * tag is absence of evidence; reading it as evidence of absence puts the
 * unobserved record below everything and above nothing.
 *
 * So the read is **withheld** rather than floored: `prominenceRead` lets the
 * channels that *did* speak answer first, and this constant is what is left
 * when none of them did — which is the only case it was ever a true statement
 * about.
 */
export const WITHHELD_PROMINENCE_READ = 0.15;

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
  | 'authority_page_about_it'
  | 'conferred_designation'
  | 'pocket_designation'
  | 'ground_witness'
  | 'region_namesake';

export interface SignificanceChannel {
  id: SignificanceChannelId;
  /** Which of the two standing questions this statement answers. */
  standing: 'global' | 'local';
  /** 0–1 what this one statement is worth on its own. */
  weight: number;
  /** What has to be true *in the world* for it to fire. Never about the record. */
  claim: string;
  /**
   * WHAT THE STATEMENT IS ABOUT — the place, the body that runs it, or a name.
   *
   * Only the first can vouch for a contested claim about what a thing *is*, and
   * the other two reached a live board pretending they could.
   *
   * **`its_operator`.** `authority_publication` observes that the record's own
   * published address sits on a government domain, and what that establishes is
   * who runs the place. A public body publishes every asset on its books: in
   * New York eleven public-housing developments reached the Discovery Board
   * carrying `nyc.gov/NYCHA`, the housing authority's own page, and in Tokyo a
   * block of the Urban Renaissance Agency's rental stock carrying a
   * `ur-net.go.jp` letting listing. Both were filed under a bare
   * historic-and-cultural node, both needed a witness that they were historic,
   * and both got one from a URL that says only that a government is the
   * landlord — the same defect `publishedSites` already refuses from a
   * franchise, wearing a government suffix.
   *
   * **`its_name`.** `region_namesake` observes that an administrative area
   * carries the record's name. Which of the two is named after the other is not
   * in the record, and on a live New York pack the channel's only wrong answers
   * were of exactly that shape: `Clason Point`, a public-housing development in
   * the Bronx neighbourhood of Clason Point, opened the significance gate on a
   * name it had *taken from* the geography. A shared name is a fact about
   * names.
   *
   * Both keep their weight and lose their casting vote: each can *raise* a
   * standing — a park a parks department publishes really is more established
   * than one nobody publishes — and neither can *open* one. See
   * `hasSignificanceEvidence`.
   */
  attests: 'the_place' | 'its_operator' | 'its_name';
  /**
   * Whether this statement certifies a *visit* rather than only the object —
   * the stronger claim the witness bound and the hazardous-approach kinds
   * turn on. A designation conferred over standing ground and an authority's
   * page addressed to the place both say a visitor belongs there; an
   * encyclopaedia's entry, a pocket boundary and a namesake do not. See
   * `composeExperienceSignificance` and `hasLocalPlaceAttestation`.
   */
  certifiesVisit: boolean;
  /**
   * WHETHER SOMEBODY OUTSIDE THIS RECORD POINTED AT *THIS PLACE*.
   *
   * A third question about the same statement, and it is not `attests` with
   * two values instead of three. `attests` decides which statements may
   * **open the candidacy gate** — may a bridge, a burial ground or a point
   * claiming to be a mountain be offered at all — and that gate is held to
   * the narrowest reading, because the alternative is a housing block
   * certified historic by its landlord's URL. This column decides which
   * statements may put a record whose *notice was never observed* above what
   * notice alone can assert, and one statement sits differently on the two
   * questions: `ground_witness`.
   *
   * The ground's own guarded records wearing a place's name — its gate, its
   * garden, the tea house at its door, counted under the brand refusal, the
   * generic-name ceiling, the division bans and the strict embedding — is the
   * ground *pointing at* a landmark. It is not the encyclopaedia describing
   * it, which is why it may not open the candidacy gate; and it is not a
   * shared administrative name, which is the statement that cannot say which
   * way the naming ran. On the stored dense-metro packs it is very often the
   * only thing anybody says about the destination's principal temple, shrine,
   * palace and castle: their rows carry one attribute apiece, their own
   * published address, and the surrounding city named after them.
   *
   * False, therefore, for exactly the two statements the table already gives
   * weight and denies a casting vote: `authority_publication` (the body that
   * runs it) and `region_namesake` (an area that shares its name). See
   * `prominenceBasisOf`.
   */
  pointsAtThePlace: boolean;
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
    attests: 'the_place',
    certifiesVisit: false,
    pointsAtThePlace: true,
  },
  {
    id: 'encyclopaedic_article',
    standing: 'global',
    weight: 0.4,
    claim: 'An encyclopaedia holds an article about it — prose, not an identifier.',
    attests: 'the_place',
    certifiesVisit: false,
    pointsAtThePlace: true,
  },
  {
    id: 'cross_catalogue_corroboration',
    standing: 'global',
    weight: 0.3,
    claim: 'Two catalogues from different layers described it independently.',
    attests: 'the_place',
    certifiesVisit: false,
    pointsAtThePlace: true,
  },
  {
    id: 'authority_publication',
    standing: 'local',
    weight: 0.5,
    claim: 'A public authority publishes it somewhere on its own domain.',
    attests: 'its_operator',
    certifiesVisit: false,
    pointsAtThePlace: false,
  },
  {
    id: 'authority_page_about_it',
    standing: 'local',
    weight: 0.5,
    claim: 'A public authority publishes a page addressed to this place by name.',
    attests: 'the_place',
    certifiesVisit: true,
    pointsAtThePlace: true,
  },
  {
    id: 'conferred_designation',
    standing: 'local',
    weight: 0.6,
    claim:
      'A protected, listed or reserved status, over standing ground somebody drew a boundary around.',
    attests: 'the_place',
    certifiesVisit: true,
    pointsAtThePlace: true,
  },
  {
    /**
     * THE SAME STATUS WORD OVER A POCKET OF GROUND IS A SMALLER CLAIM.
     *
     * A conferred designation certifies a visit because somebody surveyed
     * destination-scale ground and drew its edges. The same status conferred
     * on a two-hundred-metre knoll is real — a municipality protecting a
     * rock formation in a suburb — and it is a statement about *care*, not
     * about a place people travel to stand on. On a live road-country board
     * three suburban micro-sites (204 m, 240 m and 303 m across) rode the
     * full designation weight past the destination's headline waterfalls and
     * were captioned as its established names, while every genuinely
     * designated area on the same pack — the reserves a traveller would
     * recognise — measures upward of a kilometre. So below
     * `DESIGNATED_AREA_STANDING_METRES` the boundary keeps a voice and loses
     * the casting vote: it still attests the place (a real reserve is
     * admitted on it), at the namesake channel's weight, and it neither
     * unlocks the witness bound nor passes a hazardous approach.
     */
    id: 'pocket_designation',
    standing: 'local',
    weight: 0.35,
    claim: 'A protected or listed status over a pocket of drawn ground.',
    attests: 'the_place',
    certifiesVisit: false,
    pointsAtThePlace: true,
  },
  {
    /**
     * THE GROUND'S OWN WITNESSES, AS A CHANNEL.
     *
     * Records other than this one wear its name — its gate, its garden, the
     * tea house at its door — counted under every guard the ground-namesake
     * verdict applies (brand refusal, generic-name ceiling, division bans,
     * strict embedding). Split from `region_namesake` because the two are
     * different statements: an administrative area sharing a record's name
     * cannot say which way the naming ran, while a guarded precinct of
     * namesakes is the ground pointing at its landmark. Same weight, so no
     * record's standing moves by the split alone; the difference is legible
     * in `channels` and in the graded count the witness bound reads.
     */
    id: 'ground_witness',
    standing: 'local',
    weight: 0.35,
    claim: "The surrounding ground's own records are named after it.",
    attests: 'its_name',
    certifiesVisit: false,
    pointsAtThePlace: true,
  },
  {
    id: 'region_namesake',
    standing: 'local',
    weight: 0.35,
    claim: "The region's own geography carries its name.",
    attests: 'its_name',
    certifiesVisit: false,
    pointsAtThePlace: false,
  },
];

/**
 * HOW BIG THE THING THE WORLD NOTICED IS — THE DIMENSION THE UNION HAD NONE OF.
 *
 * The three global channels above are *presence* bits: an entry exists, an
 * article exists, a second catalogue described it. Presence is the only
 * question they answer, and on a live compiled board that is the whole of the
 * ordering — because an open catalogue mints an entry and an article for
 * **every row of a class it notices at all**, so the pair says as much about a
 * neighbourhood ballfield as about a national landmark. Measured on three
 * delivered boards: a municipal sports park read 0.70, a suburban park twenty
 * kilometres out 0.79, a city tower 0.79, and a metropolis's principal castle
 * — whose own catalogue row carries no identifier — 0.15, beneath all of them.
 * A model whose top band holds a ballfield and whose bottom band holds the
 * castle is not measuring notice; it is measuring which rows a mapper happened
 * to link.
 *
 * So presence gets a companion question — **how far does that notice reach
 * beyond the row that minted it** — and the answer bounds how much of the
 * presence union is admitted. Three properties, each asserted rather than
 * intended:
 *
 * - **Magnitude never opens a prominence.** With no notice at all there is
 *   nothing to grade, and the standing stays absent. A channel here can only
 *   decide how much of what was already established is heard, which is what
 *   keeps it from becoming a fourth presence bit — and what keeps it from
 *   double-counting the evidence it reads for a different question.
 * - **Every claim is about the scale of the thing, not the fullness of the
 *   record.** A boundary somebody surveyed at destination scale; a precinct of
 *   guard-passed namesakes the surrounding ground carries. Neither can be
 *   produced by filling a listing in more completely, which is the same
 *   property `SIGNIFICANCE_CHANNELS` is held to.
 * - **The evidence is what the packs already carry.** Both readings come off
 *   fields the compiled path already computes and passes — `mappedExtentMetres`
 *   under a conferred status, and the graded `groundWitnessCount`. Nothing here
 *   asks for a field nobody populates and nothing here costs a request.
 *
 * Deliberately NOT on the list, and each for a reason already stated above:
 * the alternate-name count (a fact about how completely a record was filled
 * in), the recorded-attribute count (likewise), a published site (an
 * operator's address, not a magnitude), and cross-catalogue corroboration
 * (already a presence channel — hearing it twice would raise a standing by
 * counting one statement as two witnesses).
 */
export type NoticeMagnitudeChannelId = 'destination_scale_ground' | 'ground_namesake_precinct';

export interface NoticeMagnitudeChannel {
  id: NoticeMagnitudeChannelId;
  /** 0–1 how much of the notice above the minted floor this statement admits. */
  weight: number;
  /** What has to be true *in the world* for it to fire. Never about the record. */
  claim: string;
}

export const NOTICE_MAGNITUDE_CHANNELS: readonly NoticeMagnitudeChannel[] = [
  {
    /*
     * The heavier of the two, and the reason is the act rather than the words:
     * somebody surveyed ground and traced its edges at destination scale, which
     * is the strongest statement about *size* anything in a pack makes. The
     * status word alone cannot fire it — `designationChannelFor` already holds
     * the "a designation is a boundary somebody drew" rule and the kilometre
     * that separates a reserve from a protected knoll — so this reads a
     * verdict, never a category token.
     */
    id: 'destination_scale_ground',
    weight: 0.7,
    claim:
      'A conferred status over ground somebody surveyed at destination scale — the designation tier, not the pocket.',
  },
  {
    /*
     * Lighter, and deliberately so: a precinct of namesakes says the ground
     * orients itself around this thing, which is real and is not a survey. The
     * same asymmetry the significance table already applies to `its_name`
     * evidence — it may raise and may not decide.
     */
    id: 'ground_namesake_precinct',
    weight: 0.5,
    claim: "A precinct of the surrounding ground's own records carries its name.",
  },
];

/**
 * No single statement about scale admits the notice in full.
 *
 * The magnitude table's own form of `MAX_SINGLE_CHANNEL_WEIGHT`, and it says
 * the same thing: a weight of 1 here would let one reading of one field decide
 * how far a record's notice reaches, which is the one-signal model wearing a
 * second name. Asserted, so a weight cannot drift up to it.
 */
export const MAX_MAGNITUDE_CHANNEL_WEIGHT = 0.7;

const MAGNITUDE_WEIGHT = Object.fromEntries(
  NOTICE_MAGNITUDE_CHANNELS.map((channel) => [channel.id, channel.weight]),
) as Record<NoticeMagnitudeChannelId, number>;

/**
 * The most that notice with nothing behind it may be worth.
 *
 * Not a tuning knob, and not chosen to move any particular record: it is the
 * weight of the strongest single global statement, `knowledge_base_entry`. The
 * argument is one sentence — *a catalogue that mints an entry and an article
 * for every row of a class has made one decision to notice, not two* — and the
 * number follows from it, because one decision cannot be worth more than the
 * heaviest single statement the model can hear. Everything above it is notice
 * the record has to show a magnitude for.
 *
 * It sits strictly below `WIDELY_NOTED_PROMINENCE` by construction, which is
 * the property that matters downstream: minted notice alone can no longer buy
 * the classics seat or the "one of the established names here" caption, which
 * on live boards went to a suburban lake and a small municipal beach while a
 * world-famous waterfall rendered under "Probably skip".
 */
export const MINTED_NOTICE_PROMINENCE = 0.5;

/**
 * How much of the notice above that floor is heard with no magnitude behind it.
 *
 * Not zero, and the reason is a defect the witness bound one layer down already
 * had to fix: `min(open, kind)` capped every bounded record at the same number,
 * so inside the cap the graded channels stopped ordering anything and the seat
 * cut fell back to the id lottery the ground channel exists to end. A hard
 * clamp here does exactly that — an entry, an entry-and-article, and an
 * entry-article-and-second-catalogue would all read `MINTED_NOTICE_PROMINENCE`,
 * and a park with an article of its own would tie with twelve canal segments
 * wearing a fanned one and lose the tie to its id.
 *
 * So the excess is **compressed rather than cut**. A third of it is heard,
 * which keeps the presence band strictly ordered — an article really is a
 * stronger statement than an identifier, which is why they are separate
 * channels — while the top of the compressed band sits a clear step below
 * `WIDELY_NOTED_PROMINENCE`, so no amount of presence buys the caption.
 */
export const UNMAGNIFIED_NOTICE_ADMISSION = 1 / 3;

/** Channel ids that describe the place itself rather than the body running it. */
const PLACE_ATTESTING_CHANNELS = new Set<SignificanceChannelId>(
  SIGNIFICANCE_CHANNELS.filter((channel) => channel.attests === 'the_place').map(
    (channel) => channel.id,
  ),
);

/**
 * The channels that certify a *visit*: a conferred designation over standing
 * ground, an authority page addressed to the place by name. Derived from the
 * table's own `certifiesVisit` column, because these are the statements that
 * certify a *visitable thing on the ground* rather than an object the
 * encyclopaedia noted — the distinction the witness bound in
 * `composeExperienceSignificance` turns on. A pocket designation attests the
 * place (it opens the significance gate) and deliberately does not certify a
 * visit, which is why the set reads the column rather than `attests`.
 */
const LOCAL_PLACE_ATTESTING_CHANNELS = new Set<SignificanceChannelId>(
  SIGNIFICANCE_CHANNELS.filter((channel) => channel.certifiesVisit).map(
    (channel) => channel.id,
  ),
);

/**
 * The channels that are somebody pointing at *this place*, from the table's own
 * `pointsAtThePlace` column. Read by `prominenceBasisOf` to decide whether a
 * record whose notice was never observed has a standing at all, or only a
 * landlord and a shared name.
 */
const SUBJECT_POINTING_CHANNELS = new Set<SignificanceChannelId>(
  SIGNIFICANCE_CHANNELS.filter((channel) => channel.pointsAtThePlace).map(
    (channel) => channel.id,
  ),
);

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
 * The shortest name worth looking for inside a URL.
 *
 * Short names collide with path words by accident — `Park`, `Bridge`, a
 * two-letter code — and a coincidence would promote a record on nothing. Eight
 * folded characters is long enough that a match is a match; measured on the
 * stored Tokyo and New York packs the admitted set is identical at six, eight
 * and ten, so the bound costs nothing and closes the accident.
 */
const NAMED_IN_PAGE_MIN_CHARS = 8;

/**
 * THE DIFFERENCE BETWEEN A LANDLORD'S FRONT DOOR AND A PAGE ABOUT A PLACE.
 *
 * `authority_publication` was demoted because a public body publishes every
 * asset on its books, and the demotion was right — it is what stopped eleven
 * public-housing developments being certified historic. But it also silenced
 * the case where a public body has *written about one thing by name*, and the
 * collateral is not small: on the stored New York pack of 2026-08-12 the
 * significance gate refused **the Brooklyn Bridge**, whose record carries the
 * city transport department's own page for it — `nyc.gov/…/bridges/
 * brooklyn_bridge.shtml` — while `Clason Point`, a housing development, carried
 * `nyc.gov/NYCHA` and was treated as the same kind of evidence.
 *
 * They are not the same kind of evidence, and the difference is legible in the
 * address: one page is *addressed to this subject*, the other is the
 * organisation's own door. An authority that has published a page for a named
 * thing has said something about the thing; an authority that lists a thing
 * among its holdings has said who owns it.
 *
 * Measured over both packs, this admits 24 New York records and 2 Tokyo ones —
 * the Brooklyn, Manhattan and Bayonne bridges, Liberty State Park, Canarsie
 * Pier, Fort Wadsworth, the Turtle Bay Gardens historic district, the Newtown
 * Creek nature walk — and **not one** public-housing development, because no
 * housing authority publishes a page per estate under the estate's name.
 *
 * Deliberately a test on the *path*, never the host: a government domain is
 * already the whole of `authority_publication`, and reading the host again
 * would be the same statement counted twice.
 */
export function authorityPageNamesSubject(
  subjectName: string | undefined,
  urls: readonly string[],
): boolean {
  const subject = foldForMatch(subjectName ?? '').replace(/[^a-z0-9]/g, '');
  if (subject.length < NAMED_IN_PAGE_MIN_CHARS) return false;
  return urls.filter(isAuthorityPublishedSite).some((raw) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    const path = `${url.pathname}${url.search}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    return path.includes(subject);
  });
}

/**
 * Classes that exist because an authority conferred them.
 *
 * A designation is a *decision somebody published* — a boundary drawn, a listing
 * entered, a status granted — which is why it counts as local significance and
 * why `park`, `museum` and `viewpoint` are not on the list. Values only, in the
 * vocabularies open catalogues actually use, so the same set reads Iceland and
 * Osaka without naming either.
 *
 * **Necessary and not sufficient.** Every word here doubles as a category in
 * some catalogue's POI menu, and a menu choice is not a decision anybody
 * published. `hasConferredDesignation` is the test; this is one half of it.
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

/**
 * The smallest outline that is an outline.
 *
 * The same hundred metres the description and the landscape-plausibility gate
 * already use, for the same reason: below it a published boundary is as likely
 * to be the bounding box of a point as a measurement of anything. Stated once
 * so "we drew a boundary around this" means one thing everywhere.
 */
export const DESIGNATED_AREA_MIN_METRES = 100;

/**
 * A DESIGNATION IS A BOUNDARY SOMEBODY DREW — NOT A WORD SOMEBODY FILED UNDER.
 *
 * This is the whole of the correction, and the defect it removes is the worst
 * one this module has shipped: `conferred_designation` is the heaviest channel
 * in the table, it opens the significance gate on its own, and it fired from
 * the record's *own category string*. On the two live packs of 2026-08-12 that
 * certified, verbatim, as holding a protected or heritage designation:
 *
 * - `Isekai Depato`, an anime shop, filed by the catalogue under `national_park`
 * - `Governors Island Beer Co`, a brewery, likewise
 * - `早稲田大学 11号館前 ベンチ` — a bench outside a university lecture hall —
 *   under `nature_reserve`
 * - `Carver Playground`, `Ranaqua Playground`, `Washington Square Fountain`
 * - `Yosemite National Park` and `Gates of the Arctic National Park`, both in a
 *   **New York** pack, and `知床半島` and `秋吉台`, both hundreds of kilometres
 *   from Tokyo
 *
 * 92 records fired in New York and 29 in Tokyo, and **every single one of them
 * fired from a category word**: not one fired from a designation stated
 * anywhere else in the record. A channel that fires on how a catalogue filed a
 * row is not evidence about a place. It is §8.3's metadata heuristic with a
 * grander name, and it is exactly what the table above promises this model
 * never does — *"none of them can be produced by filling a listing in more
 * completely"*.
 *
 * A word cannot be told from a mistake. A **boundary** can: somebody surveyed
 * ground and traced its edges, which is a different act from choosing a
 * category from a menu, and it is the act a designation actually consists of.
 * So the status word is necessary and the extent is what makes it a claim: on
 * the same two packs every offending record above is a point carrying a
 * one-to-three-metre bounding box, while the designated areas — Liberty State
 * Park at 3.6 km, the Statue of Liberty National Monument at 1.7 km, the
 * Meadowlands reserves at hundreds of metres — are ground with a shape.
 *
 * The consequence worth stating plainly: a POI listing for a famous park no
 * longer carries the park's designation. The record that has the boundary does,
 * and the listing gets there through the linker or not at all — which is right,
 * because the boundary is the thing the designation was conferred on.
 */
export function hasConferredDesignation(evidence: {
  classifyingValues?: readonly string[];
  mappedExtentMetres?: number;
}): boolean {
  if (!hasDesignatedStatus(evidence.classifyingValues ?? [])) return false;
  return (evidence.mappedExtentMetres ?? 0) >= DESIGNATED_AREA_MIN_METRES;
}

/**
 * The extent at which a designation is destination-scale ground.
 *
 * Not a tuning knob: it is the measured gap on the live artifacts between the
 * two populations the one channel was conflating. Every suburban micro-site
 * that rode the designation past a destination's headline canon measures 204,
 * 240 or 303 metres across; every reserve a traveller would recognise as a
 * place to go measures 1,198, 1,843, 2,752 or 22,036. A kilometre sits in the
 * middle of that gap with an order of magnitude of room on either side.
 * Below it a real designation still speaks (`pocket_designation`); at or
 * above it the boundary certifies the visit (`conferred_designation`).
 */
export const DESIGNATED_AREA_STANDING_METRES = 1000;

/**
 * Which designation channel a drawn boundary earns, or none.
 *
 * One decision, stated once, so the assessment and its tests cannot disagree:
 * the status word plus the minimum outline is a designation; the same word
 * over standing ground is the full, visit-certifying channel.
 */
export function designationChannelFor(evidence: {
  classifyingValues?: readonly string[];
  mappedExtentMetres?: number;
}): 'conferred_designation' | 'pocket_designation' | undefined {
  if (!hasConferredDesignation(evidence)) return undefined;
  return (evidence.mappedExtentMetres ?? 0) >= DESIGNATED_AREA_STANDING_METRES
    ? 'conferred_designation'
    : 'pocket_designation';
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
 * NOTICE, READ THROUGH THE MAGNITUDE BEHIND IT.
 *
 * Notice up to `MINTED_NOTICE_PROMINENCE` is always heard — a catalogue that
 * minted an entry did make a statement, and refusing it would be the opposite
 * error. Above that floor the excess is admitted at
 * `UNMAGNIFIED_NOTICE_ADMISSION` plus the magnitude's share of what is left, so
 * presence alone still *orders* the band it can reach and cannot climb out of
 * it, while a record the world surveyed and the ground repeats hears nearly all
 * of its notice.
 *
 * Stated once, as a function, because the published maximum and the assessor
 * both need it and a constant computed from a *different* formula than the one
 * that ranks is how a bar ends up above the ceiling. Absent notice returns
 * absent: magnitude never opens a prominence, because how big a thing is says
 * nothing about whether anyone took note of it.
 */
function admitNotice(noticed: number | undefined, magnitude: number | undefined): number | undefined {
  if (noticed === undefined) return undefined;
  const minted = Math.min(noticed, MINTED_NOTICE_PROMINENCE);
  const admission =
    UNMAGNIFIED_NOTICE_ADMISSION + (1 - UNMAGNIFIED_NOTICE_ADMISSION) * (magnitude ?? 0);
  return round(minted + (noticed - minted) * admission);
}

/**
 * The highest prominence the model can express: every global channel agreeing,
 * with the magnitude to be believed at full weight.
 *
 * Derived from the table rather than written down, because a threshold above
 * what the model can reach is a branch that never runs, and one shipped: the
 * fit scorer's tourist-trap penalty tested `popularityScore >= 0.8` and stayed
 * alive only on the alternate-name count that used to inflate prominence past
 * that bar. Removing the count would have quietly killed it. A consumer that
 * needs "as noted as this model can say" reads this instead of guessing.
 *
 * Derived from **both** tables since the magnitude gate landed, and that is the
 * same rule one rung along rather than a new one: the presence union is what
 * the world said, the magnitude union is how much of it is admitted, and a
 * constant that read only the first would sit above everything the model can
 * now produce — a published bar nothing can clear, which is precisely the dead
 * branch this constant exists to prevent. Reaching it takes all three presence
 * statements **and** both magnitude statements; the three presence statements
 * on their own stop at `MINTED_NOTICE_PROMINENCE`, which is the whole
 * correction — on three delivered boards the presence union's top band held a
 * municipal ballfield, a suburban park and a city tower at the same number.
 */
export const MAX_GLOBAL_PROMINENCE = admitNotice(
  union(
    SIGNIFICANCE_CHANNELS.filter((channel) => channel.standing === 'global').map(
      (channel) => channel.weight,
    ),
  )!,
  union(NOTICE_MAGNITUDE_CHANNELS.map((channel) => channel.weight)),
)!;

/**
 * "One of the names people come here for."
 *
 * The bar at which a place is treated as widely known — for the tourist-trap
 * penalty, and for the card that tells a classics-minded traveller this is one
 * of the famous ones. Below `MAX_GLOBAL_PROMINENCE` by construction, and above
 * `MINTED_NOTICE_PROMINENCE` by construction, which is the property that
 * matters: no amount of presence alone clears it, so the statements a catalogue
 * mints for every row of a class cannot buy the caption. Clearing it takes
 * several presence statements *and* a magnitude behind them.
 */
export const WIDELY_NOTED_PROMINENCE = 0.7;

/**
 * THE CEILING ON NOTICE THAT NOTHING VOUCHED FOR THE SIZE OF.
 *
 * Every global channel firing, with no statement anywhere about how big the
 * noticed thing is — which is precisely the evidence an open catalogue mints
 * for a municipal row it happens to have linked. Derived from the tables, for
 * the same reason `MAX_GLOBAL_PROMINENCE` is: a bar written as a literal beside
 * a formula is how a bar ends up on the wrong side of what the model produces.
 *
 * Measured on the delivered boards this is exactly the band the inversion lived
 * in: a ward park at 0.57, a suburban zoo at 0.60, a cruise terminal at 0.57 —
 * every one of them a row whose only distinction is that a mapper linked its
 * catalogue entry — while the destination's principal temple, shrine, palace
 * and castle read 0.35, because nobody ever put the notice question to them at
 * all.
 *
 * So this is the line the withheld read is placed above (`prominenceRead`), and
 * the line a standing nothing pointed at may not cross. It is the numeric form
 * of the sentence the ledger states: *a withheld read is not a low score, and
 * presence-only municipal rows may not outrank one.*
 */
export const MAX_UNMAGNIFIED_PROMINENCE = admitNotice(
  union(
    SIGNIFICANCE_CHANNELS.filter((channel) => channel.standing === 'global').map(
      (channel) => channel.weight,
    ),
  )!,
  undefined,
)!;

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
   *
   * All three are *presence* bits, and presence alone was the third violation:
   * an open catalogue mints an entry and an article for every row of a class it
   * notices at all, so the union said the same thing about a neighbourhood
   * ballfield as about a national landmark, and three delivered boards put a
   * municipal sports park (0.70) and a city tower (0.79) in the same band. So
   * the union is now read through a magnitude — see below, and see
   * `NOTICE_MAGNITUDE_CHANNELS` for what magnitude is allowed to be.
   */
  const fired: SignificanceChannelId[] = [];
  if (evidence.inKnowledgeBase) fired.push('knowledge_base_entry');
  if (evidence.encyclopaedicArticle) fired.push('encyclopaedic_article');
  if (evidence.crossDatasetCorroboration) fired.push('cross_catalogue_corroboration');

  const noticed = union([
    ...(evidence.inKnowledgeBase ? [CHANNEL_WEIGHT.knowledge_base_entry] : []),
    ...(evidence.encyclopaedicArticle ? [CHANNEL_WEIGHT.encyclopaedic_article] : []),
    ...(evidence.crossDatasetCorroboration
      ? [CHANNEL_WEIGHT.cross_catalogue_corroboration]
      : []),
  ]);

  /**
   * MAGNITUDE, READ BEFORE THE UNION IS BELIEVED.
   *
   * `NOTICE_MAGNITUDE_CHANNELS` states the two readings and why these two. What
   * happens to them is here: notice up to `MINTED_NOTICE_PROMINENCE` is always
   * heard, and every point above it is admitted in proportion to the magnitude
   * behind it. A record with no magnitude statement therefore cannot pass the
   * minted floor however many presence bits it carries, and a record whose
   * ground the world surveyed and whose name the ground repeats hears its
   * notice in full.
   *
   * Deliberately a *gate on notice already established* rather than a fourth
   * addend: a magnitude with no notice under it leaves `globalProminence`
   * absent, because how big a thing is says nothing about whether the wider
   * world took any note of it — and absent is a value.
   */
  const designationMagnitude =
    designationChannelFor(evidence) === 'conferred_designation';
  const namesakeMagnitude =
    (evidence.groundWitnessCount ?? 0) >= GROUND_PRECINCT_STANDING_WITNESSES;
  const magnitude = union([
    ...(designationMagnitude ? [MAGNITUDE_WEIGHT.destination_scale_ground] : []),
    ...(namesakeMagnitude ? [MAGNITUDE_WEIGHT.ground_namesake_precinct] : []),
  ]);
  /*
   * Which of the two spoke, carried beside how much they were worth. See
   * `NOTICE_MAGNITUDES`: the arithmetic cannot distinguish a surveyed boundary
   * from the ground wearing a name, and one consumer has to.
   */
  const magnitudeBasis: NoticeMagnitudeBasis | undefined =
    designationMagnitude && namesakeMagnitude
      ? 'both'
      : designationMagnitude
        ? 'designation'
        : namesakeMagnitude
          ? 'ground_namesake'
          : undefined;
  const globalProminence = admitNotice(noticed, magnitude);

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
  const sites = evidence.publishedSites ?? [];
  /*
   * One statement, read at its strongest. A government page addressed to this
   * subject by name and a government page that merely lists it are the same
   * URL set seen two ways, so exactly one of the two channels fires — unioning
   * both would count one page as two witnesses.
   */
  if (authorityPageNamesSubject(evidence.subjectName, sites)) {
    localSignals.push(CHANNEL_WEIGHT.authority_page_about_it);
    fired.push('authority_page_about_it');
  } else if (sites.some(isAuthorityPublishedSite)) {
    localSignals.push(CHANNEL_WEIGHT.authority_publication);
    fired.push('authority_publication');
  }
  const designation = designationChannelFor(evidence);
  if (designation !== undefined) {
    localSignals.push(CHANNEL_WEIGHT[designation]);
    fired.push(designation);
  }
  /*
   * One naming statement, read at its strongest — the same rule the two
   * authority channels follow above. The ground's own guarded witnesses and
   * an administrative area wearing the name are both "the region carries its
   * name"; hearing them as two witnesses would raise a standing by counting
   * one statement twice, so the graded ground channel speaks for both when it
   * fired and the namesake channel speaks only when it is the only voice.
   */
  const groundWitnesses = evidence.groundWitnessCount ?? 0;
  if (groundWitnesses >= 1) {
    localSignals.push(CHANNEL_WEIGHT.ground_witness);
    fired.push('ground_witness');
  } else if (evidence.namedInRegionRecords) {
    localSignals.push(CHANNEL_WEIGHT.region_namesake);
    fired.push('region_namesake');
  }
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
    channels: fired,
    ...(globalProminence !== undefined ? { globalProminence } : {}),
    ...(magnitude !== undefined ? { noticeMagnitude: magnitude } : {}),
    ...(magnitudeBasis !== undefined ? { noticeMagnitudeBasis: magnitudeBasis } : {}),
    ...(localSignificance !== undefined ? { localSignificance } : {}),
    ...(hiddenness !== undefined ? { hiddenness } : {}),
    ...(groundWitnesses >= 1 ? { groundWitnesses } : {}),
  };
  const crowdExpectation = expectCrowd(evidence.crowd);
  return crowdExpectation !== undefined ? { ...standing, crowdExpectation } : standing;
}

/**
 * Whether anything establishes that **this place** matters — globally or locally.
 *
 * The gate the evidence-demanding categories read: a bridge, a cemetery, a
 * structural claim or a point claiming to be a mountain is offered to a
 * traveller only when this is true. Deliberately a presence test rather than a
 * threshold: the standing model refuses to fabricate either channel, so "one
 * fired" means one of the `SIGNIFICANCE_CHANNELS` above vouched for it — an
 * encyclopaedic entry, an encyclopaedic article, a second catalogue describing
 * it independently, a designation conferred on ground somebody drew a boundary
 * around, or a public authority's own page addressed to it by name — and "none
 * fired" means nothing did.
 *
 * Every one of those is a statement somebody *else* made about the place. None
 * can be produced by filling a record in more completely, which is the property
 * that makes this a significance test rather than the §8.3 metadata heuristic
 * under a new name. It was the latter for one release: `globalProminence` was
 * defined by a count of alternate names, so a commuter railway with four
 * translations passed the gate and a temple recorded once did not.
 *
 * ## Why the operator channel and the name channel are not among them
 *
 * `authority_publication` observes that the record's published address sits on
 * a government domain, which establishes who runs it. A public body runs, and
 * publishes, everything on its books: its parks and its housing stock, its
 * museums and its depots, its monuments and its bridges. Where the source has
 * already said what the thing *is* — a park, a museum, a monument — that is a
 * real extra statement about local standing and it still counts towards the
 * score. Where the source has *not*, and the category is only an assertion that
 * something is historic, a government URL is evidence for the wrong
 * proposition.
 *
 * `region_namesake` observes that an administrative area carries the record's
 * name, and cannot say which way the naming ran. A live New York pack admitted
 * a Bronx public-housing development because the *neighbourhood it stands in*
 * is called the same thing — a name it took, not a name it gave. Both channels
 * still raise a standing and neither may open one.
 *
 * The narrowing left real places outside, which is why `authority_page_about_it`
 * exists beside the operator channel: a page a public body publishes **for a
 * named subject** is a statement about the subject, and refusing it cost the
 * same New York board the Brooklyn Bridge.
 *
 * Both live boards proved it in the same week and on two continents. Eleven New
 * York public-housing developments and a block of Tokyo agency rental stock
 * were filed by the catalogue under its bare historic-and-cultural node,
 * demanded a witness that they were historic, and each got one from the page
 * their landlord publishes — `nyc.gov/NYCHA`, `ur-net.go.jp/chintai/…` — while
 * the same city's museum, carrying no channel at all, ranked below them. The
 * catalogue class they arrived under is not a kind of building and cannot be
 * told apart from one; the only thing that could have told them apart was the
 * witness, and the witness was answering a question nobody asked.
 *
 * This is the same rule `publishedSites` already states for the commercial
 * case — "a business publishing its own site is not a local-significance
 * signal — a franchise does that as a matter of course" — applied to the case
 * where the landlord happens to be a government.
 */
export function hasSignificanceEvidence(standing: PlaceStanding): boolean {
  return standing.channels.some((channel) => PLACE_ATTESTING_CHANNELS.has(channel));
}

/**
 * Whether something attests this place **on the ground** — a designation
 * conferred over a drawn boundary, or a public authority's page addressed to
 * it by name. The stronger claim the hazardous-approach kinds need: an
 * encyclopaedia noting a glacier attests the ice; only a body that manages
 * ground for visitors attests that a visitor belongs there. The same channel
 * set the witness bound in `composeExperienceSignificance` treats as a full
 * unlock, exported so the admission gate and the rank read one definition.
 */
export function hasLocalPlaceAttestation(standing: PlaceStanding): boolean {
  return standing.channels.some((channel) => LOCAL_PLACE_ATTESTING_CHANNELS.has(channel));
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
   * `composeExperienceSignificance` for why that distinction is load-bearing,
   * and for why it is added to the evidence rather than multiplied by it.
   */
  categoryWeight: number;
  /**
   * True for kinds that are travel candidates only because a witness vouched —
   * the taxonomy's `requiresSignificanceEvidence`: a river crossing, a rail
   * overpass, a burial ground, a point claiming to be a mountain. Optional so
   * that callers which never gated (the live map fallback, older producers)
   * keep today's behaviour exactly. See `composeExperienceSignificance` for
   * what it changes and the measured defect that demanded it.
   */
  witnessRequired?: boolean;
  /**
   * True when somebody operationally expects visitors at this record — posted
   * hours, a fee, an operator, a published site or phone. The same asymmetry
   * the quality layer's micro-feature penalty already turns on: a monument with
   * a ticket page keeps its rank; a plaque with a name does not. Read from the
   * record's own attributes; see `attributesExpectVisitors`.
   */
  expectsVisitors?: boolean;
  /**
   * True for kinds whose encyclopaedic notice is minted at cataloguing scale —
   * the taxonomy's `commonplaceNotice`: a municipal park, a zoo, a theme park,
   * a reserve. Notice for these kinds cannot discriminate *within* the kind,
   * so encyclopaedic evidence is bounded exactly as it is for the
   * witness-demanding kinds; the doors out of the bound are the same, with the
   * ground door held to a precinct grade. See `composeExperienceSignificance`.
   */
  commonplaceKind?: boolean;
  /**
   * True when the record publishes a site *and* its kind is one somebody
   * opens and closes (the taxonomy's `plausiblyGated`). The conjunction is
   * the claim: a gated kind's own published page is the door's address — a
   * temple, a palace, a managed cave publishes where and when to visit —
   * while a site on an ungated kind is routinely somebody else's (the
   * measured road bridge carrying a bus company's homepage), which is why
   * `OPERATIONAL_VISIT_ATTRIBUTES` refuses bare websites and this input is
   * never read for kinds without a door. Computed by the caller, which holds
   * the taxonomy; see `composeExperienceSignificance`.
   */
  publishedSiteAtGate?: boolean;
  /**
   * Distinct guard-passed witnesses standing *beyond* the record's own
   * boundary and inside the precinct — the surrounding ground pointing at a
   * landmark, with the complex's own furniture excluded. The exclusion is
   * measured: a multi-facility municipal park is "witnessed" by its own named
   * ballfields and numbered plots, a destination's shrine by a stadium and
   * outer gardens two kilometres out, and a door that cannot tell those
   * apart is no door. Supplied by the producer that computed the graded
   * verdict; absent means the channel is silent.
   */
  groundPrecinctWitnesses?: number;
}

/**
 * Attribute names that say somebody receives visitors here: posted hours, an
 * admission fee. Facts about *visiting*, in the vocabularies open catalogues
 * actually publish.
 *
 * Deliberately narrower than the quality layer's visitation vocabulary, and
 * each exclusion is a measured false positive from a stored dense-metro pack:
 *
 * - **`wikidata` / `wikipedia`** — for a witness-demanding kind these are the
 *   statements that opened the gate, and letting them also certify
 *   visit-worthiness would make the gate's own key unlock the bound that
 *   exists because the gate is not a rank.
 * - **`website`** — the primary place catalogue attaches a website to nearly
 *   every record it conflates, and the value is routinely somebody else's: a
 *   road bridge on the stored pack carried a bus company's homepage. A URL is
 *   a web page, not a visit.
 * - **`operator` / `phone`** — who runs a structure is the operator question,
 *   and the standing model already rules that an operator's existence attests
 *   the operator ("a public body publishes every asset on its books"). A rail
 *   viaduct on the stored pack carried its transit authority as `operator`;
 *   trains are operated, not visited.
 */
export const OPERATIONAL_VISIT_ATTRIBUTES: ReadonlySet<string> = new Set([
  'opening_hours',
  'fee',
  'charge',
  'admission',
]);

/** Whether a record's recorded attribute names include operational visit evidence. */
export function attributesExpectVisitors(attributeNames: readonly string[]): boolean {
  return attributeNames.some((name) => OPERATIONAL_VISIT_ATTRIBUTES.has(name));
}

/**
 * The most the *kind* alone may be worth, as a share of the finished score.
 *
 * Two things at once, and they are the same number on purpose. It is the share
 * of the kind's own weight that survives with nothing established — so at zero
 * evidence this function returns exactly what it always did, and every
 * unevidenced place keeps its score. And it is the **bound on the category
 * contribution**: a kind can add at most this much, which is what stops the
 * category deciding the order by itself.
 */
export const KIND_ONLY_SHARE = 0.3;

/**
 * The most the *world's statements about this one place* may be worth.
 *
 * The remainder, derived rather than written, so the two contributions are a
 * partition of one scale and the top of that scale is reachable: a
 * fully-weighted kind with every channel agreeing scores 1. Under the shape
 * this replaced the top was reachable by nothing at all.
 */
export const ESTABLISHED_SHARE = 1 - KIND_ONLY_SHARE;

/**
 * The kind weight at which evidence about a particular place counts in full.
 *
 * Not a tuning knob: `taxonomy.ts` gives *any visitable kind nobody weighted*
 * exactly this weight, so it is the table's own line between "a kind of place a
 * traveller might go to" and a fragment of one — a stream, a patch of woodland,
 * a piece of unrecognised ground. At or above it, what the world has published
 * about a particular record is worth the same whatever the record is. Below it
 * the evidence contribution is scaled down in proportion, reaching zero at zero.
 *
 * That last property is what keeps the repair honest in the other direction. A
 * pylon, a car park and a depot are weighted `0`, and a substation with an open
 * identifier and a second catalogue behind it must not be argued onto a board;
 * "the category is a prior, not a ceiling" cannot be allowed to mean "any
 * well-documented thing is an attraction".
 */
export const EXPERIENCE_CREDIBILITY_FLOOR = 0.3;

/**
 * Significance, taken apart into the contributions that produced it.
 *
 * Returned rather than computed inside because §9's instruction is that the
 * ranking stay interpretable and its dimensions stay distinct: a consumer that
 * wants to say *why* a place ranks where it does reads the two contributions,
 * and a test that wants to prove neither one caps the other reads them too. The
 * score is the sum of the two rounded contributions exactly, so an explanation
 * built from them cannot drift from the number that did the ranking.
 */
export interface SignificanceComposition {
  /** 0–1. `kindContribution + evidenceContribution`, clamped. */
  score: number;
  /** 0–`KIND_ONLY_SHARE`. What being this kind of thing is worth. */
  kindContribution: number;
  /** 0–`ESTABLISHED_SHARE`. What the world has said about *this one*. */
  evidenceContribution: number;
  /** 0–1 union of the standing's channels. Absent evidence reads 0. */
  established: number;
  /** 0–1 how far this kind admits evidence at all. See the floor above. */
  evidenceAdmission: number;
  /**
   * True when the witness bound capped the evidence contribution: the kind
   * demanded more than notice, and no door out of the bound was open. Exposed
   * because consumers act on it — a rank the model itself refused to let the
   * evidence buy must not wear the "established name" caption or a classics
   * seat, which is how three suburban micro-sites captioned themselves as a
   * destination's names. Producers stamp it onto the place as
   * `significanceBounded`; the caption and the classics group read that field.
   */
  witnessBounded: boolean;
}

/**
 * SIGNIFICANCE — one interpretable number for "is this worth a traveller's
 * attention", distinct from every metadata count, composed from two **bounded,
 * additive** contributions.
 *
 * - **What kind of thing it is** (`categoryWeight`) is a **prior**, and it
 *   contributes at most `KIND_ONLY_SHARE`. A museum with no evidence at all
 *   still matters more than a slope with none, because the kinds differ — that
 *   is the floor that kept 24 micro-features from being outranked only by each
 *   other on a live board.
 * - **What the world has established about *this one*** (the standing's
 *   channels, unioned so no single one dominates) contributes the rest.
 *
 * THE STRUCTURE IS THE FIX, AND IT IS THE ADDITION.
 *
 * Every earlier shape multiplied the two: first `categoryWeight × (0.3 + 0.7 ×
 * established)`, then `reach(categoryWeight, established) × (0.3 + 0.7 ×
 * established)` where `reach` was itself anchored at the weight. Both are
 * `finalScore = f(categoryWeight) × g(evidence)`, and in that family the
 * category is a **ceiling**: the best a kind may score is fixed before anybody
 * looks at the place. The second shape only moved the ceiling — a kind weighted
 * 0.3 could not pass 0.62 even at total certainty, while a record filed under a
 * 0.85 word reached 0.61 on a single knowledge-base row.
 *
 * Measured on the live Osaka pack (release 2026-07-22.0, 1,404 records): every
 * record that carried any evidence at all carried the *same* evidence — a
 * knowledge-base entry and an encyclopaedic article, 0.7 — because those are
 * the only two channels an open catalogue populates at scale. With the evidence
 * term constant the product collapses to a function of the kind alone, and the
 * ordering *was* the category table: the walled castle grounds that are that
 * city's headline historic park sat 55th of 1,218, below twenty-seven anonymous
 * urban creeks whose evidence was identical to its own.
 *
 * Adding the contributions instead means the category orders places whose
 * evidence ties and cannot cap places whose evidence does not. A modest kind
 * needs `KIND_ONLY_SHARE / ESTABLISHED_SHARE × Δweight` more established
 * evidence to overtake a heavier one — a real amount, bounded, and reachable.
 *
 * `evidenceRichness` reaches this number by no path, and neither does any count.
 */
export function composeExperienceSignificance(
  input: ExperienceSignificanceInput,
): SignificanceComposition {
  const { standing } = input;
  const established =
    union(
      [standing.globalProminence, standing.localSignificance].filter(
        (value): value is number => value !== undefined,
      ),
    ) ?? 0;
  const prior = clamp01(input.categoryWeight);
  const evidenceAdmission = clamp01(prior / EXPERIENCE_CREDIBILITY_FLOOR);
  /*
   * Rounded to the scale's resolution, and then floored at it while the kind is
   * a travel experience at all — so that a positive weight can never round away
   * to the same number a pylon gets. See `ratesAsExperience`.
   */
  const kindContribution = prior === 0 ? 0 : Math.max(round(prior * KIND_ONLY_SHARE), SCORE_STEP);
  /**
   * THE WITNESS OPENS THE GATE; IT DOES NOT BUY THE SEAT.
   *
   * A witness-demanding kind (`requiresSignificanceEvidence`) is a candidate
   * only because a statement from outside the record vouched for it — and until
   * this bound, the same statement was then worth the full `ESTABLISHED_SHARE`
   * of the rank, so the gate's key doubled as the seat's price. Measured on a
   * stored dense-metro compile: six river crossings and a rail overpass, each
   * carrying one encyclopaedic article and nothing else, composed 0.66 – 0.71
   * as "viewpoints" and held final-board seats, while the destination's palace
   * (0.46), its two headline sanctuaries (0.42) and its tallest observation
   * tower were cut — the §4 regression class, at the compile-side cut. An
   * encyclopaedia documenting a bridge attests the *structure*; the taxonomy's
   * own entry for the class says what being one is worth as an experience
   * ("most bridges are how a road crosses water"), and an entry-plus-article —
   * which the mapping convention mints for nearly every crossing in a dense
   * city — cannot overrule that sentence for a kind whose candidacy the same
   * statement had to establish.
   *
   * So, for witness-demanding kinds, **encyclopaedic notice alone contributes
   * at most what the kind itself is worth**. The bound lifts entirely when
   * anything beyond the encyclopaedia certifies the *visit* rather than the
   * object:
   *
   * - operational visit evidence — posted hours, a fee, an operator, a
   *   published site (`expectsVisitors`): the destination's great gated
   *   structures keep their full rank, because they are the ones with ticket
   *   pages;
   * - a local place-attesting channel — a designation conferred on ground
   *   somebody drew a boundary around, or a public authority's page addressed
   *   to it by name. This is the module's own celebrated case kept whole: the
   *   famous suspension bridge admitted on its city's own page for it ranks in
   *   full, while an article-only river crossing ranks as what it is.
   *
   * The same discipline the seat machinery applies to the operator and
   * namesake channels — "keeps its weight and loses its casting vote" —
   * applied to the gate's own key at the rank it was never meant to hold. No
   * kind is vetoed, and nothing here touches kinds that never needed a
   * witness.
   */
  const visitAttested = standing.channels.some((channel) =>
    LOCAL_PLACE_ATTESTING_CHANNELS.has(channel),
  );
  /**
   * THE SECOND DOORS — ONE PER FAMILY, EACH KEYED TO WHAT ITS RECORDS CARRY.
   *
   * The operational door above reads the record's posted hours and fees, and
   * on the live dense-metro packs the catalogue's place layer publishes none
   * of them for the destination's gated canon — a palace, a castle and two
   * headline sanctuaries each carry exactly one attribute, their own official
   * site. A door the pack can never open is not a door; it is the bound made
   * permanent for precisely the records the §4 regression is about.
   *
   * **Witness-demanding kinds** open on `publishedSiteAtGate`: the record's
   * own published page, admitted only where the kind has a door somebody
   * opens. That is exactly the evidence the gated canon carries and the
   * commodity crossings do not — a temple publishes where and when to visit;
   * a road bridge's site is a bus company's homepage, and an ungated kind
   * never reads this input. Deliberately NOT the graded ground channel: the
   * measured metro ground names its commodity bridges and moats as readily
   * as its temples (the riverside park under a crossing wears the crossing's
   * name), so a ground door here reseated the §4 regression class verbatim.
   *
   * **Commonplace kinds** open on the graded ground precinct instead: their
   * problem is that *every* instance is gated with a site and noticed with an
   * article — a site door or a notice door would be no door — while only a
   * landmark accumulates a precinct of distinct namesakes *beyond its own
   * boundary*. The beyond matters as much as the count: a sports-complex
   * park is "witnessed" by its own named ballfields and numbered plots
   * standing inside it, while the destination's great shrine is named by a
   * stadium and outer gardens two kilometres out. So the door reads
   * `groundPrecinctWitnesses` — member-tier furniture excluded — at a grade
   * strictly above the attestation minimum.
   */
  const doorOpen =
    input.witnessRequired === true
      ? input.publishedSiteAtGate === true
      : (input.groundPrecinctWitnesses ?? 0) >= GROUND_PRECINCT_STANDING_WITNESSES;
  const witnessBounded =
    (input.witnessRequired === true || input.commonplaceKind === true) &&
    input.expectsVisitors !== true &&
    !visitAttested &&
    !doorOpen;
  const openEvidenceContribution = round(established * ESTABLISHED_SHARE * evidenceAdmission);
  /*
   * The bound is a ceiling, not a flattener. `min(open, kind)` capped every
   * bounded record of one kind at the same number, so inside the bound the
   * graded channels stopped ordering anything and the cut under a bounded
   * tie band went back to the id lottery the ground channel exists to end —
   * the exact seat lottery the stored-pack funnels measured. Scaling by
   * `established` keeps the cap (established ≤ 1, so the contribution never
   * exceeds the kind's own worth) while a record the ground names still
   * outranks its unnamed tie tier.
   */
  const evidenceContribution = witnessBounded
    ? round(kindContribution * established)
    : openEvidenceContribution;
  return {
    score: round(clamp01(kindContribution + evidenceContribution)),
    kindContribution,
    evidenceContribution,
    established,
    evidenceAdmission,
    witnessBounded,
  };
}

/**
 * The beyond-boundary ground grade at which a commonplace kind's notice is
 * unbounded.
 *
 * Strictly above the compiler ground channel's attestation minimum, because
 * for the kinds every catalogue maps densely the minimum is table stakes: a
 * municipal park is "attested" by its own pony ring, and a sports complex by
 * its own numbered plots. The grade counts only witnesses standing beyond
 * the record's own boundary (`groundPrecinctWitnesses`) — the surrounding
 * city naming things after a landmark — where the measured metro split is
 * clean: the destination's great shrine and national park hold a ring of
 * three or more while every neighbourhood park and suburban zoo holds none.
 */
export const GROUND_PRECINCT_STANDING_WITNESSES = 3;

/**
 * The smallest thing this scale can say that is not nothing.
 *
 * `round` keeps two decimals so a compiled artifact is byte-stable, which makes
 * `0.01` the resolution rather than an arbitrary epsilon.
 */
const SCORE_STEP = 0.01;

/**
 * Whether the model is *ranking* this record at all.
 *
 * Zero on this scale is not "ranked last". It is the model declining: the kind
 * carries no experience weight, `evidenceAdmission` is therefore zero too, and
 * no amount of published evidence can move the score off the floor — a
 * substation with an encyclopaedic article still scores exactly zero, which is
 * deliberate and is what `EXPERIENCE_CREDIBILITY_FLOOR` exists to say.
 *
 * The distinction has to be *stateable* because a consumer acts on it. The
 * region pack's retention pass ranks rows on this very function and then
 * reserves a share of every partition cell for the family these records fall
 * into — and a stored Tokyo pack spent exactly 20 of every cell's 205 seats,
 * 175 of 1,840, on rows scoring 0.000: a chiropractor, an insurance agency, a
 * package locker, an ATM. Those roles can never become candidates, so every
 * seat is one no traveller will ever see, and they were held in the same nine
 * cells where canonical attractions were outranked.
 *
 * Before this, "unrated" and "rated at the bottom" were the same number by
 * luck: no kind in the taxonomy happened to be weighted low enough to round to
 * zero. `composeExperienceSignificance` now guarantees it by construction, so a
 * caller that drops zero-scoring records cannot silently start dropping rated
 * ones when a weight is next tuned.
 */
export function ratesAsExperience(score: number): boolean {
  return score > 0;
}

/** The composed score on its own, for the callers that only rank. */
export function experienceSignificanceOf(input: ExperienceSignificanceInput): number {
  return composeExperienceSignificance(input).score;
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
 * WHICH QUESTION THE NUMBER IN `popularityScore` IS AN ANSWER TO.
 *
 * Three states, because the required field has to carry three different
 * sentences and for two releases it carried them all on one scale:
 *
 * - **`observed`** — somebody put the notice question to this place and an
 *   answer came back. The number is that answer.
 * - **`withheld`** — nobody ever put the notice question, and something
 *   outside the record *pointing at this place* established a standing anyway:
 *   a designation over drawn ground, a public authority's page addressed to it
 *   by name, the surrounding ground's own guarded records named after it.
 * - **`unestablished`** — nothing pointing at this place spoke at all. What is
 *   left is a landlord's front door, an area that happens to share a name, or
 *   literally nothing beyond a name and a position.
 *
 * Carried out onto the place (`standingFields`) rather than re-derived by each
 * consumer, because two of them act on it and both were guessing: the caption
 * asked "is `globalProminence` present", which is true of a ward park and false
 * of a destination's principal temple, and auto-pick asked nothing at all.
 */
/**
 * WHAT VOUCHED FOR THE SIZE OF A RECORD'S NOTICE, WHERE ANYTHING DID.
 *
 * The magnitude gate has two channels and until now only their *arithmetic*
 * survived onto the place. That was enough for ranking and not enough for the
 * one consumer that has to weigh the **kind** of statement: `WIDELY_NOTED_PROMINENCE`
 * sits one hundredth above `MAX_UNMAGNIFIED_PROMINENCE`, so passing the bar and
 * passing the magnitude gate are the same event, and the classics caption was
 * therefore being sold by whichever channel opened it.
 *
 * They are not interchangeable claims. `designation` is a boundary somebody
 * surveyed — a statement about how much ground, which is real and is not fame,
 * and which every protected area of any size carries. `ground_namesake` is the
 * surrounding ground's own records wearing this thing's name, which is the
 * ground saying the thing matters. `both` is what it says.
 */
export const NOTICE_MAGNITUDES = ['designation', 'ground_namesake', 'both'] as const;
export type NoticeMagnitudeBasis = (typeof NOTICE_MAGNITUDES)[number];

export const PROMINENCE_BASES = ['observed', 'withheld', 'unestablished'] as const;
export type ProminenceBasis = (typeof PROMINENCE_BASES)[number];

export function prominenceBasisOf(standing: PlaceStanding): ProminenceBasis {
  if (standing.globalProminence !== undefined) return 'observed';
  if (
    standing.localSignificance !== undefined &&
    standing.channels.some((channel) => SUBJECT_POINTING_CHANNELS.has(channel))
  ) {
    return 'withheld';
  }
  return 'unestablished';
}

/**
 * WHERE A WITHHELD READ SITS, AND WHY IT IS NOT ON THE NOTICE SCALE.
 *
 * A withheld read is placed at the union of two independent statements: *the
 * most that notice alone can assert about anybody* and *what the region's own
 * evidence established about this one*. The union is the module's own operator
 * and the argument is one sentence — **nobody having asked the world is not a
 * worse answer than the world having been asked and mildly answered**, and
 * whatever the region established is independent of a question nobody put.
 *
 * The floor is therefore `MAX_UNMAGNIFIED_PROMINENCE` by construction rather
 * than by choice, which is the invariant the ledger asks for: a presence-only
 * municipal row cannot outrank a record whose standing was never observed. The
 * ceiling is `MAX_GLOBAL_PROMINENCE`, also by construction, and it says the
 * other half — **an unobserved read may never assert more than an observed one
 * could.** Above the point where the ceiling binds, two withheld records tie;
 * that compression is real, it is bounded, and past it the difference between
 * them is a difference between two statements neither of which was the notice
 * question.
 */
function withheldStandingRead(localSignificance: number): number {
  return Math.min(
    round(union([MAX_UNMAGNIFIED_PROMINENCE, localSignificance])!),
    MAX_GLOBAL_PROMINENCE,
  );
}

/**
 * WHAT THE REQUIRED FIELD SAYS WHEN THE WORLD'S NOTICE WAS NEVER OBSERVED.
 *
 * `popularityScore` cannot say "unknown", so it has to say *something*, and for
 * one release that something was a floor: any record without a knowledge-base
 * tag read `WITHHELD_PROMINENCE_READ` regardless of what else had been
 * established about it. That is absence of evidence written down as evidence of
 * absence, and it produced the sharpest inversion this model has shipped — a
 * metropolis's principal castle at 0.15, under a municipal sports park at 0.70,
 * because the park's row happened to carry the identifier and the castle's did
 * not.
 *
 * The release after it stopped flooring and started **substituting**: the local
 * union answered where the global read was absent, on the same 0–1 axis. That
 * narrowed the inversion and did not end it, because the two numbers are not
 * commensurable. Measured on the boards delivered from that build: the
 * destination's principal temple, shrine, palace and castle all read
 * 0.35 — one local channel, the ground around them wearing their names —
 * beneath a ward park at 0.57, a suburban zoo at 0.60, a cruise terminal at
 * 0.57 and a flood-basin park at 0.69, every one of which is a row whose
 * catalogue entry a mapper happened to link. A local weight projected onto the
 * notice axis lands *inside the presence band*, and presence is minted for
 * every row of a class.
 *
 * So the read is **banded, not substituted**. `prominenceBasisOf` says which
 * question was answered, and each answer is read on its own scale:
 *
 * - observed → the notice read, unchanged;
 * - withheld → `withheldStandingRead`, above everything presence alone reaches;
 * - unestablished → the local weight, and **capped at what notice alone can
 *   assert**, which is the table's own "keeps its weight and loses its casting
 *   vote" rule stated on the read: a landlord's front door and a shared
 *   administrative name may raise a record inside the presence band and may not
 *   lift it out of one. Nothing at all still reads `WITHHELD_PROMINENCE_READ`,
 *   which is the only case that constant was ever a true statement about.
 */
export function prominenceRead(standing: PlaceStanding): number {
  switch (prominenceBasisOf(standing)) {
    case 'observed':
      return standing.globalProminence!;
    case 'withheld':
      return withheldStandingRead(standing.localSignificance!);
    default:
      return standing.localSignificance === undefined
        ? WITHHELD_PROMINENCE_READ
        : Math.min(standing.localSignificance, MAX_UNMAGNIFIED_PROMINENCE);
  }
}

/**
 * WHETHER NOTHING WHATEVER IS PUBLISHED ABOUT THIS PLACE.
 *
 * Not a weaker standing and not a low score: **no channel fired at all**. It is
 * the same population the compiled description says it about in so many words —
 * *"Nothing beyond its name and position is published about it"* — and stating
 * it once here is what keeps the sentence a traveller reads and the condition a
 * scheduler applies from being two different claims.
 *
 * The condition an **anchor-role slot** turns on. A live compile handed such a
 * record a 240-minute block, made it the sole activity of a day holding 42% of
 * the trip's activity time, and computed the readiness verdict over it —
 * globalProminence absent, no local standing of any kind, source confidence
 * 0.41. Nothing in the admission or scheduling path asked, so nothing refused.
 *
 * Deliberately **not** a threshold and deliberately not a count of recorded
 * attributes. Metadata completeness is the one thing this module refuses to
 * read as significance, and the offending record would have cleared such a bar
 * anyway; two thirds of this population publish a page about themselves, which
 * is a page and not a witness.
 *
 * Both absences are required, so this is narrower than `prominenceBasisOf`'s
 * `unestablished`: a public authority that lists the record among its holdings
 * and an area that shares its name are statements the table gives weight and
 * denies a casting vote — they may not buy a caption, and refusing them an
 * anchor slot as well would be one rule doing two jobs. An authored place
 * carries none of these fields and is exempt: curation is itself the evidence
 * there.
 */
export function nothingIsPublishedAboutIt(place: {
  globalProminence?: number;
  localSignificance?: number;
  evidenceRichness?: number;
}): boolean {
  if (place.evidenceRichness === undefined) return false;
  return place.globalProminence === undefined && place.localSignificance === undefined;
}

/**
 * WHETHER A RECORD MAY WEAR "ONE OF THE ESTABLISHED NAMES HERE".
 *
 * One predicate for the two surfaces that make the claim — the board's classics
 * group and the fit scorer's standing line — because they were two copies of
 * the same condition, and a copy is where two rules drift. Three refusals, each
 * a measured defect:
 *
 * - **A bounded standing.** `significanceBounded` is the significance model
 *   itself declining to let the evidence buy the rank; a caption must not
 *   assert what the rank was refused. Three suburban micro-sites wore this
 *   sentence on a live road-country board on the minted knowledge-base pair
 *   alone.
 * - **Notice below the bar.** `WIDELY_NOTED_PROMINENCE`, which since the
 *   magnitude gate is unreachable by presence alone — so a suburban lake and a
 *   small municipal beach can no longer be captioned as the names a
 *   destination is known for while its famous waterfall renders under
 *   "Probably skip".
 * - **A standing nothing pointed at.** "The kind of stop this area is known
 *   for" claims that somebody established the standing, so the number has to
 *   have been *earned* rather than substituted. The condition used to be
 *   "carries an observed `globalProminence`", and that read the wrong fact: on
 *   the delivered metro boards it was true of a ward park and a cruise terminal
 *   and false of the destination's principal temple, shrine, palace and castle
 *   — with the result that "Classics worth your time — the well-known ones"
 *   rendered **empty on both metro boards** and, on the third, over a single
 *   suburban pond. So the condition is `prominenceBasis`: an observed read
 *   qualifies, and so does a withheld one that a statement *pointing at this
 *   place* opened, while a landlord's front door and a shared administrative
 *   name qualify neither — and neither can reach the bar in the first place,
 *   because `prominenceRead` caps them at what notice alone can assert.
 *
 * An authored place carries none of these fields and is exempt: curation is
 * itself the evidence there, which is the same exemption `fit.ts`'s evidence
 * cap already grants. A place stored before `prominenceBasis` existed falls
 * back to the old condition, so a stale artifact reads exactly as it did.
 *
 * Famous is not mandatory. Where no card earns the sentence the classics group
 * holds nothing and `buildDiscoveryBoard` drops it, which is the same "never
 * render an empty group" rule every other heading follows.
 */
export function standsAsEstablishedName(place: {
  popularityScore: number;
  globalProminence?: number;
  evidenceRichness?: number;
  significanceBounded?: boolean;
  prominenceBasis?: ProminenceBasis;
  noticeMagnitude?: NoticeMagnitudeBasis;
}): boolean {
  if (place.significanceBounded === true) return false;
  if (place.popularityScore < WIDELY_NOTED_PROMINENCE) return false;
  if (place.evidenceRichness === undefined) return true;
  /*
   * A SURVEYED BOUNDARY IS NOT FAME.
   *
   * `WIDELY_NOTED_PROMINENCE` sits one hundredth above
   * `MAX_UNMAGNIFIED_PROMINENCE`, so for an *observed* read, clearing the bar
   * and passing the magnitude gate are the same event — and one of the two
   * magnitude channels is a designation, which every protected area of any size
   * carries. The delivered consequence was mechanical rather than marginal: a
   * designated suburban lake was the **only** card under "Classics worth your
   * time — the well-known ones" on a whole board, while that destination's
   * famous waterfall — a point record with no boundary drawn round it, and so
   * capped at the unmagnified ceiling — rendered under "Probably skip".
   *
   * The other magnitude is not the same claim and keeps its vote: the
   * surrounding ground naming its own records after a thing is the ground
   * saying the thing matters, which is precisely what the caption asserts.
   *
   * Applied to the magnitude rather than to the basis, and the difference was
   * measured: a first version tested `prominenceBasis === 'observed'` too, and
   * the same designation then bought the caption through the withheld door
   * instead — two coastal nature reserves sat under "Classics worth your time"
   * on the very next build. What the caption is refusing is a *kind of
   * statement*, and which question that statement happened to answer is beside
   * the point.
   *
   * A record with **no** magnitude at all is untouched, which is the case this
   * bar exists to leave open: a destination's principal temple, shrine, palace
   * or castle reaches 0.74 through `withheldStandingRead` — a union of the
   * region's own evidence with what notice alone can assert — and never passes
   * the magnitude gate on the way.
   */
  if (place.noticeMagnitude === 'designation') return false;
  if (place.prominenceBasis !== undefined) return place.prominenceBasis !== 'unestablished';
  return place.globalProminence !== undefined;
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
): Pick<Place, 'popularityScore' | 'hiddenGemScore' | 'crowdLevel' | 'prominenceBasis'> &
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
    popularityScore: prominenceRead(standing),
    /*
     * Which question the number above answers, carried rather than re-derived.
     * A consumer that acts on the difference — the classics seat, the caption,
     * the anchor-slot condition — must not have to infer it from the number,
     * which is exactly what "is `globalProminence` present" was doing when it
     * emptied the classics group on two metro boards.
     */
    prominenceBasis: prominenceBasisOf(standing),
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
    /*
     * Which magnitude vouched for the notice, where either did. The classics
     * caption reads it; nothing ranks on it.
     */
    ...(standing.noticeMagnitudeBasis !== undefined
      ? { noticeMagnitude: standing.noticeMagnitudeBasis }
      : {}),
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
