import { INTERESTS, type Interest, type PlaceCategory } from '../schemas/common';
import type { DestinationEntityType } from '../schemas/geography';
import {
  CLASS_INTEREST_PACKS,
  CLASS_SIGNATURES,
  DESTINATION_CLASSES,
  INTEREST_EVIDENCE,
  UNIVERSAL_INTERESTS,
  type DestinationClass,
  type InterestEvidenceRule,
} from './vocabulary';

/**
 * WHICH QUESTIONS THIS DESTINATION HAS EARNED THE RIGHT TO ASK.
 *
 * The rule the whole file exists to enforce: **a region that cannot serve an
 * interest does not offer it as a graded row.** Every row on the intake screen
 * is a promise that an answer will change something, and a hot-springs row in
 * front of somebody planning a city is a promise nothing downstream can keep —
 * worse, a `core` answer on it steers acquisition towards material that is not
 * there, which is how a metropolis came to be searched for mountain towns.
 *
 * Three ways to reach an offer, and they are ordered by how much is known:
 *
 *   `region_evidence`    the region has been compiled, so its own places decide.
 *   `destination_class`  only the resolved entity type exists, so the class
 *                        packs decide and nothing is claimed about supply.
 *   `whole_vocabulary`   nothing is known, so nothing is withheld.
 *
 * The last of these is the honest floor rather than a failure: withholding a
 * question because we have not looked yet would be a claim about the
 * destination made from our own ignorance.
 */
export const INTEREST_OFFER_BASES = [
  'region_evidence',
  'destination_class',
  'whole_vocabulary',
] as const;
export type InterestOfferBasis = (typeof INTEREST_OFFER_BASES)[number];

export interface InterestOffer {
  /** Rows to grade, strongest local footing first. */
  interests: readonly Interest[];
  /** What kind of place this was read as. Empty when nothing was read. */
  classes: readonly DestinationClass[];
  basis: InterestOfferBasis;
}

/**
 * The shape this file needs from a place, and no more.
 *
 * Structural rather than `Place` so a caller can pass a compiled place, a
 * provisional card or a test literal without either side importing the other's
 * whole model. Every field is one of the three evidence channels.
 */
export interface InterestEvidenceSubject {
  category: PlaceCategory;
  displayKind?: string | undefined;
  interests: readonly Interest[];
  tags?: readonly string[] | undefined;
}

/**
 * THE EVIDENCE ON ITS OWN, PRISED OFF THE RECORD THAT CARRIES IT.
 *
 * `InterestEvidenceSubject` is a place that already exists, and a place already
 * carries its stamped interests. The compiler's classifier holds the same three
 * facts *one step earlier* — before there is a place — and it is the thing that
 * decides what gets stamped in the first place.
 *
 * That is why this shape exists rather than the subject alone. The two tables
 * were separate: `INTEREST_EVIDENCE` decided which rows the intake offered, a
 * hand-written column in the compiler's taxonomy decided what a place claimed,
 * and nothing made them agree. They did not: every compiled region offered
 * rows — architecture, markets, museums — that no place in it could match, so a
 * traveller who graded one `core` had every place that should have satisfied it
 * scored as though they had said "only if it is right there". The classifier
 * now *reads* this table through `evidencedInterests` instead of restating it.
 */
export interface InterestEvidence {
  category: PlaceCategory;
  displayKind?: string | undefined;
  /** Interests a classifier has already stamped. Always trusted. */
  interests?: readonly Interest[] | undefined;
  /** The source's own leaf categories, as a compiled place carries them. */
  sourceCategories?: readonly string[] | undefined;
}

/**
 * How many rows a traveller should ever be shown at once.
 *
 * Section 6.1's discipline in a constant: a smaller number of high-information
 * questions beats a complete one. Twelve is roughly a phone screen of rows at
 * the five-across frequency control, and the ordering below means the twelve
 * kept are the twelve this destination has the most to offer for.
 */
export const MAX_OFFERED_INTERESTS = 12;

/**
 * Below this many places, an interest is a coincidence rather than a theme.
 *
 * One is the right floor and not two. A city with a single great museum should
 * still ask whether museums matter — the answer changes which day that museum
 * lands on — whereas a region with none must not, because there is nothing an
 * answer could steer.
 */
const MIN_SUPPORT = 1;

/** What an entity type implies before anything has been researched. */
const CLASSES_BY_ENTITY_TYPE: Partial<Record<DestinationEntityType, readonly DestinationClass[]>> =
  {
    neighbourhood: ['urban'],
    city: ['urban'],
    metro_area: ['urban'],
    municipality: ['urban', 'countryside'],
    island: ['coastal', 'countryside'],
    archipelago: ['coastal', 'countryside'],
    protected_area: ['mountain', 'countryside'],
    /** V8.1 — a named landscape: outdoors first, and the countryside around it. */
    natural_region: ['mountain', 'countryside'],
  };

function lower(value: string | undefined): string {
  return (value ?? '').toLowerCase();
}

/**
 * Only the source-category tag, never the whole tag list.
 *
 * The rest of a compiled place's tags are `attr:*` attribute *names* and
 * colon-prefixed role markers — matching `market` against `attr:marketing_name`
 * would manufacture evidence out of a field label. The `=` separator is the
 * convention the inventory writes the classifying category under, and the one
 * `board.ts` deliberately keeps distinct from its own `role:` prefix.
 */
function sourceCategoriesIn(tags: readonly string[] | undefined): string[] {
  const values: string[] = [];
  for (const tag of tags ?? []) {
    const separator = tag.indexOf('=');
    if (separator < 0) continue;
    const sourceCategory = tag.slice(separator + 1).toLowerCase();
    if (sourceCategory.length > 0) values.push(sourceCategory);
  }
  return values;
}

/**
 * WHETHER A KEYWORD NAMES THIS LEAF'S OWN KIND, OR MERELY SITS INSIDE IT.
 *
 * A leaf category is a snake_case compound, and this test used to be
 * `sourceCategory.includes(keyword)`. A raw substring reads a keyword out of
 * the middle of an unrelated word, and over the 220 leaves the compiler's
 * taxonomy recognises it did: `market` inside `supermarket`, `quarter` inside
 * `corporate_headquarters`, `park` inside `bicycle_parking`. Each one put an
 * interest on a record that does not serve it, and the interest then reached
 * the traveller twice over — once as a stamped `matchedInterests` chip, once as
 * "you marked this, and that is what this delivers".
 *
 * Whole tokens instead, and a contiguous run for the multi-token keywords
 * (`hot_spring`, `nature_reserve`, `food_hall`), so a keyword names one kind
 * rather than two words that happen to co-occur. Split on any non-alphanumeric
 * run because vocabularies differ about the separator.
 */
function namesKind(sourceCategory: string, keyword: string): boolean {
  const tokens = sourceCategory.split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  const wanted = keyword.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0);
  if (wanted.length === 0 || wanted.length > tokens.length) return false;
  for (let start = 0; start + wanted.length <= tokens.length; start += 1) {
    if (wanted.every((word, offset) => tokens[start + offset] === word)) return true;
  }
  return false;
}

/**
 * The keyword channel, with the rule's own refusals applied first.
 *
 * `sourceExclusions` names the compounds whose head noun is one of the keywords
 * and whose kind is not — see the table. Checked before the keywords rather
 * than after a match, so an excluded leaf reaches no keyword at all and cannot
 * be admitted by a second one.
 */
function keywordEvidences(
  rule: InterestEvidenceRule,
  sourceCategories: readonly string[],
): boolean {
  if (!rule.sourceKeywords) return false;
  for (const raw of sourceCategories) {
    const sourceCategory = raw.toLowerCase();
    if (rule.sourceExclusions?.includes(sourceCategory)) continue;
    if (rule.sourceKeywords.some((keyword) => namesKind(sourceCategory, keyword))) return true;
  }
  return false;
}

/** True when this evidence says an interest can be served. The one matcher. */
export function evidences(evidence: InterestEvidence, interest: Interest): boolean {
  // The classifier's own verdict, and the strongest channel there is.
  if (evidence.interests?.includes(interest)) return true;

  const rule = INTEREST_EVIDENCE[interest];
  if (rule.categories?.includes(evidence.category)) return true;

  const kind = lower(evidence.displayKind);
  if (kind.length > 0 && rule.displayKinds?.some((entry) => entry === kind)) return true;

  return keywordEvidences(rule, evidence.sourceCategories ?? []);
}

/**
 * Every interest this evidence supports.
 *
 * What the compiler's taxonomy stamps onto a place, so that "the region can
 * serve this" and "this place claims this" are two readings of one table rather
 * than two tables that have to be kept in step by hand.
 */
export function evidencedInterests(evidence: InterestEvidence): Interest[] {
  return INTERESTS.filter((interest) => evidences(evidence, interest));
}

/**
 * WHETHER A RECORD NAMES ITS OWN KIND AT ALL.
 *
 * A compiled place always does — the inventory writes the source's leaf
 * category as its first tag (`places=shinto_shrine`), and `displayKind` carries
 * the truthful noun a card prints. An authored place carries neither: its
 * category and interests were curated by the same hand, and curation is itself
 * the evidence. Callers that hold a claim to the *kind* standard (see
 * `kindEvidences`) read this first, so a hand-written record is never held to a
 * channel it structurally does not carry.
 */
export function namesOwnKind(subject: InterestEvidenceSubject): boolean {
  return lower(subject.displayKind).length > 0 || sourceCategoriesIn(subject.tags).length > 0;
}

/**
 * THE KIND CHANNELS ALONE: WHAT THE SOURCE CALLED IT, NEVER WHAT A BUCKET IMPLIES.
 *
 * `evidences` answers "can this record serve the interest", and its planning
 * category channel is right for that question. But the thirteen-value planning
 * category is a *bucket*, and a bucket launders: a theme park files under the
 * food-and-towns category, so by the category channel a theme park "delivers"
 * food — which is, verbatim, a sentence a live board printed at a traveller. A
 * claim **about the record's own kind** ("you marked X, and that is what this
 * delivers") therefore has to clear the two channels with the resolution to
 * name a kind: the display noun and the source's own leaf category.
 *
 * The stamped-interest channel is deliberately not consulted either: stamps
 * arrive through the same bucket, and a claim checked against its own
 * derivation checks nothing.
 */
export function kindEvidences(subject: InterestEvidenceSubject, interest: Interest): boolean {
  const rule = INTEREST_EVIDENCE[interest];
  const kind = lower(subject.displayKind);
  if (kind.length > 0 && rule.displayKinds?.some((entry) => entry === kind)) return true;
  return keywordEvidences(rule, sourceCategoriesIn(subject.tags));
}

/** True when this place is evidence that the region can serve this interest. */
export function placeEvidences(subject: InterestEvidenceSubject, interest: Interest): boolean {
  return evidences(
    {
      category: subject.category,
      displayKind: subject.displayKind,
      interests: subject.interests,
      sourceCategories: sourceCategoriesIn(subject.tags),
    },
    interest,
  );
}

/** How many places back each interest. The number every decision below reads. */
export function interestSupport(
  places: readonly InterestEvidenceSubject[],
): Record<Interest, number> {
  const counts = Object.fromEntries(INTERESTS.map((interest) => [interest, 0])) as Record<
    Interest,
    number
  >;
  for (const place of places) {
    for (const interest of INTERESTS) {
      if (placeEvidences(place, interest)) counts[interest] += 1;
    }
  }
  return counts;
}

/**
 * What kind of place this is, from what is in it.
 *
 * A class is claimed when its signature interests are backed by enough of the
 * region to be a fact about the region rather than about one record. The
 * threshold scales: a tenth of the places, floored at two, so a handful of
 * museums in a thirty-place city counts and a single bridge in a valley does
 * not.
 *
 * `countryside` is the fallback rather than a verdict, so a region that reads
 * as nothing in particular still gets a coherent pack instead of an empty one.
 */
export function destinationClassesFrom(
  support: Record<Interest, number>,
  placeCount: number,
): DestinationClass[] {
  const threshold = Math.max(2, Math.ceil(placeCount * 0.1));
  const classes = DESTINATION_CLASSES.filter((destinationClass) =>
    CLASS_SIGNATURES[destinationClass].some((interest) => support[interest] >= threshold),
  );
  return classes.length > 0 ? [...classes] : ['countryside'];
}

/**
 * The offer, from a compiled region's own places.
 *
 * Ordering is by local footing — how many places back the interest — because
 * that is the order in which the answers matter here. Ties break on the
 * vocabulary's own order so the screen is stable between two compilations of
 * the same place.
 *
 * The universal core is admitted on the same evidence terms as everything else,
 * with one exception: food. A region's food supply lives in a separate dataset
 * from its places, so a region whose only restaurants are food venues rather
 * than `town_and_food` places would otherwise never be asked about eating,
 * which is absurd — and the traveller's answer decides how hard the food layer
 * looks. `foodVenueCount` is that second channel.
 */
export function interestOfferFromRegion(input: {
  places: readonly InterestEvidenceSubject[];
  foodVenueCount?: number;
}): InterestOffer {
  const support = interestSupport(input.places);
  const foodVenueCount = input.foodVenueCount ?? 0;
  if (foodVenueCount > 0) {
    support.food_and_towns = Math.max(support.food_and_towns, foodVenueCount);
  }
  const classes = destinationClassesFrom(support, input.places.length);

  const candidates = new Set<Interest>(UNIVERSAL_INTERESTS);
  for (const destinationClass of classes) {
    for (const interest of CLASS_INTEREST_PACKS[destinationClass]) candidates.add(interest);
  }

  /*
   * What makes this place *this* place goes first, and survives the cap.
   *
   * Ordering by support alone put a region's distinguishing question below the
   * questions every destination asks: the authored mountain region has one hot
   * spring and eight things worth photographing, so sorting on count alone
   * pushed hot springs off the bottom of a twelve-row screen in the one region
   * where the answer most changes the trip. A signature interest is one whose
   * presence identified the class in the first place, so it is by construction
   * the thing worth asking about here and nowhere else.
   */
  const signature = new Set<Interest>(
    classes.flatMap((destinationClass) => [...CLASS_SIGNATURES[destinationClass]]),
  );
  const order = new Map(INTERESTS.map((interest, index) => [interest, index]));
  const rank = (interest: Interest): number => (signature.has(interest) ? 0 : 1);
  const offered = [...candidates]
    .filter((interest) => support[interest] >= MIN_SUPPORT)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        support[b] - support[a] ||
        (order.get(a) ?? 0) - (order.get(b) ?? 0),
    )
    .slice(0, MAX_OFFERED_INTERESTS);

  /*
   * A region we could not read anything into is not a region with no
   * preferences. Falling through to the whole vocabulary keeps the intake
   * usable, and says so in the basis rather than pretending the evidence
   * produced this.
   */
  if (offered.length === 0) return wholeVocabularyOffer();

  return { interests: offered, classes, basis: 'region_evidence' };
}

/**
 * The offer before anything has been researched, from the resolved entity type.
 *
 * Weaker than the evidence path and honest about it: this says "a question of
 * this kind makes sense in a place of this kind", not "there is something here
 * for it". An entity type we have no class for falls through to the whole
 * vocabulary rather than guessing.
 */
export function interestOfferFromEntityType(entityType: DestinationEntityType): InterestOffer {
  const classes = CLASSES_BY_ENTITY_TYPE[entityType];
  if (!classes) return wholeVocabularyOffer();

  const candidates = new Set<Interest>(UNIVERSAL_INTERESTS);
  for (const destinationClass of classes) {
    for (const interest of CLASS_INTEREST_PACKS[destinationClass]) candidates.add(interest);
  }
  const order = new Map(INTERESTS.map((interest, index) => [interest, index]));
  return {
    interests: [...candidates]
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      .slice(0, MAX_OFFERED_INTERESTS),
    classes: [...classes],
    basis: 'destination_class',
  };
}

export function wholeVocabularyOffer(): InterestOffer {
  return { interests: [...INTERESTS], classes: [], basis: 'whole_vocabulary' };
}

/**
 * The one entry point a surface should call.
 *
 * Takes whatever context exists and returns the strongest offer that context
 * supports, so a caller never has to know which of the three paths it is on.
 */
export function interestOffer(input: {
  places?: readonly InterestEvidenceSubject[] | undefined;
  foodVenueCount?: number | undefined;
  entityType?: DestinationEntityType | undefined;
}): InterestOffer {
  if (input.places && input.places.length > 0) {
    return interestOfferFromRegion({
      places: input.places,
      ...(input.foodVenueCount === undefined ? {} : { foodVenueCount: input.foodVenueCount }),
    });
  }
  if (input.entityType) return interestOfferFromEntityType(input.entityType);
  return wholeVocabularyOffer();
}
