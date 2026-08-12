import {
  ACCESS_BADGE_LABELS,
  FIT_BAND_LABELS,
  OPERATING_BADGE_LABELS,
  PLACE_WEATHER_BADGE_LABELS,
  type AccessBadge,
  type BoardGroup,
  type DiscoveryCandidate,
  type OperatingBadge,
  type PlaceWeatherBadge,
} from '@sidequest/core';
import { formatCost, formatIntensity, formatMinutes } from '@/lib/format';

/**
 * WHAT THE BOARD SAYS, DECIDED WHERE IT CAN BE TESTED.
 *
 * This file holds the presentation judgements that used to sit inline in a
 * seventeen-hundred-line component and could therefore only be checked by
 * looking at a screenshot. Three of them were badly wrong, and all three are the
 * same mistake in different clothes: **saying a thing once per card that is true
 * of every card**.
 *
 * On a live Tokyo board every one of twenty-four cards carried the same six
 * chips, the same three warnings ("We could not check the journey", "Check
 * before you go", "Hours unconfirmed") and the same trailing disclosure reading
 * "Why we trust this (0 of 6 checked)". Nothing on that board distinguished any
 * place from any other place, which is the exact opposite of what a board is
 * for: a comparison surface where every row is identical is a list of one thing
 * repeated twenty-four times.
 *
 * So the rules here are:
 *
 * 1. **A fact true of most of the board is a fact about the board.** It is
 *    stated once, above the cards, and suppressed on every card it covers. A
 *    card whose situation genuinely differs still says its own piece — that
 *    difference is the whole signal, and it is invisible while everything shouts.
 * 2. **Two chips at most.** A card wearing six flags has taught the reader to
 *    read none of them. The order below is a decision order, not an importance
 *    ranking in the abstract: it puts what would stop the visit above what would
 *    merely colour it.
 * 3. **Nothing is invented.** Every string is either a shared label map or a
 *    sentence built from a value the candidate already carries.
 */

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Traveller-facing group names.
 *
 * `BOARD_GROUP_COPY` in core is the compiler's own vocabulary — "Personalised
 * hidden gems", "Low-effort & bad-weather backups", "Worth checking first" — and
 * it is shared with surfaces that are not this board. §10.2 asks for headings a
 * traveller would use, so the board translates on the way out rather than
 * renaming a shared constant other screens depend on.
 *
 * The blurb is one clause. The old ones ran to two sentences apiece and, stacked
 * six deep down a page, added about a screen of prose between the traveller and
 * the places.
 */
export const BOARD_GROUP_HEADINGS: Record<BoardGroup, { title: string; blurb: string }> = {
  must_see_classics: {
    title: 'Classics worth your time',
    blurb: 'The well-known ones that still suit how you travel.',
  },
  hidden_gems: {
    title: 'Quiet finds',
    blurb: 'Less obvious, and close to what you said you care about.',
  },
  /*
   * NEITHER OF THESE TWO HEADINGS MAY CLAIM MORE THAN ITS GROUP KNOWS.
   *
   * They used to claim rather a lot: "Easy wins near your base · Short hops you
   * can slot into any day" was the board's catch-all and duly collected a one
   * hour nine minute drive, while "Worth the detour · Further out" was assigned
   * on category alone and led with a thirteen-minute viewpoint. `groupFor` now
   * splits these two on the traveller's own detour classification, so the
   * further-out heading is true by construction — and the near one drops its
   * distance claim, because it also holds the stops whose journey nobody could
   * time, and "short hop" is not something we know about those.
   */
  nearby_side_quests: {
    title: 'Easy wins',
    blurb: 'Smaller stops that slot into a day without reshaping it.',
  },
  scenic_detours: {
    title: 'Worth the detour',
    blurb: 'Further out than you said you would usually go — worth the journey if the day allows.',
  },
  low_effort_backups: {
    title: 'Rainy days and easy days',
    blurb: 'For when the weather turns or the legs are done.',
  },
  needs_verification: {
    title: 'Promising — check before you go',
    blurb: 'These look good; we could not confirm the practical details.',
  },
  weak_fit: {
    title: 'Probably skip',
    blurb: 'Here for completeness, with the reason we would leave them out.',
  },
};

// ---------------------------------------------------------------------------
// Facts that belong to the board rather than to a card
// ---------------------------------------------------------------------------

/**
 * The repeated statements this board hoists, and the order they read in.
 *
 * Deliberately a closed list rather than "any string seen three times": these
 * four are the ones a compiled region genuinely produces board-wide, and each
 * has a sentence written for the plural case. A generic frequency counter over
 * arbitrary copy would eventually hoist a sentence that only makes sense in the
 * singular.
 */
export const SHARED_FACT_KINDS = [
  'weather',
  'journey',
  'hours',
  'conditions',
  /**
   * Nothing establishes what most of these places actually are.
   *
   * The honest per-card sentence for an unverified candidate — "this looks
   * promising, but nobody publishes enough about it" — is *right*, and printed
   * twenty-one times down one page it stops being information and becomes the
   * page's background texture. Hoisted, it is a statement about the destination's
   * data, which is what it always was.
   */
  'unverified',
  /**
   * The three numbers every card printed whatever they said.
   *
   * "Time there 1 hr 30 min · Cost Free · Effort Easy", on card after card, was
   * named verbatim by a fresh designer as part of the §18 banned pattern — and
   * they are the clearest case of the rule at the top of this file, because a
   * figure that is the same on twenty-two of twenty-four cards is not a fact
   * about any of them. Hoisted, the board states the norm once and a card
   * carries only the number on which it *differs*, which is the number somebody
   * comparing places is looking for.
   */
  'cost',
  'effort',
  'duration',
] as const;
export type SharedFactKind = (typeof SHARED_FACT_KINDS)[number];

export interface SharedBoardFacts {
  /** Sentences to render once, above the cards. */
  notes: string[];
  /** Which per-card statements the cards must now stay quiet about. */
  suppressed: ReadonlySet<SharedFactKind>;
  /** The board-level weather sentence, where one was hoisted. */
  weatherNote: string | null;
  /**
   * The "why this fits" sentence most of the board would otherwise share.
   *
   * The repetition problem has a second layer, and suppressing the first
   * exposed it: with the evidence sentence hoisted, fifteen cards fell through
   * to the same *quality* verdict — "we could not confirm when this is open, so
   * we would not build a day around it" — and the wall of identical prose came
   * straight back one rung down. Whatever sentence a majority would print is a
   * fact about the board, so the board prints it and the cards it covers move on
   * to the next thing they can say that is theirs.
   */
  commonWhy: string | null;
  /**
   * The value each of the three card numbers takes on most of the board, where
   * one dominates. A card prints only the ones it does *not* match.
   */
  norms: BoardNorms;
  /**
   * WHICH SIDE OF THE EVIDENCE LINE IS WORTH MARKING.
   *
   * A chip earns its space by telling cards apart. "Not verified" on nineteen of
   * twenty-four does the opposite — it is the board's condition wearing a card's
   * clothing, and the reader learns to skip it, including on the five cards
   * where it is the whole story.
   *
   * So the minority is marked, whichever minority it is. On a board where most
   * places are unchecked, the *checked* ones carry a mark and the rest say
   * nothing; on a board where most are checked, the unchecked ones do. `null`
   * when neither side is a clear minority and the mark would be noise either
   * way.
   */
  verificationMarker: 'unverified' | 'checked' | null;
}

/** The value that dominates the board on each of the card's three numbers. */
export interface BoardNorms {
  /** The formatted cost, e.g. `Free`. Null where no value dominates. */
  cost: string | null;
  effort: string | null;
  /** The formatted visit length, e.g. `about 1 hr 30 min`. */
  duration: string | null;
}

/**
 * A fact has to be on most of the board *and* on at least three cards.
 *
 * The threshold is high on purpose. Hoisting a sentence that applies to two of
 * seventeen places would be the opposite mistake — a claim about the board made
 * from a minority of it — and the traveller would have no way to tell which two.
 */
const SHARED_MIN_CARDS = 3;
const SHARED_MIN_SHARE = 0.6;

function shared(count: number, total: number): boolean {
  return count >= SHARED_MIN_CARDS && count >= total * SHARED_MIN_SHARE;
}

/** A journey nobody could establish. Base-area stops have no journey to establish. */
function journeyUnverified(candidate: DiscoveryCandidate): boolean {
  return candidate.detourClass !== 'base' && candidate.reach.status !== 'measured';
}

/** Nobody publishes opening times, or the ones we have need checking. */
function hoursUnverified(candidate: DiscoveryCandidate): boolean {
  return (
    candidate.operating.badges.includes('hours_unknown') ||
    candidate.operating.badges.includes('verify_hours')
  );
}

/** "Check conditions before you set off" — the access dataset's blanket caution. */
function conditionsUnverified(candidate: DiscoveryCandidate): boolean {
  return candidate.access.badges.includes('verify_conditions');
}

export function sharedBoardFacts(candidates: readonly DiscoveryCandidate[]): SharedBoardFacts {
  const total = candidates.length;
  const notes: string[] = [];
  const suppressed = new Set<SharedFactKind>();

  /*
   * The weather sentence is hoisted verbatim rather than rewritten, because the
   * verb has to match the evidence: "looks like the day for this one" is sayable
   * about a forecast and not about ten past Augusts, and that distinction is
   * made where the evidence is known.
   */
  const weatherNotes = candidates
    .map((candidate) => candidate.weather.note)
    .filter((note): note is string => Boolean(note));
  const counts = new Map<string, number>();
  for (const note of weatherNotes) counts.set(note, (counts.get(note) ?? 0) + 1);
  let weatherNote: string | null = null;
  for (const [note, count] of counts) {
    if (shared(count, total)) {
      weatherNote = note;
      break;
    }
  }
  if (weatherNote) {
    notes.push(weatherNote);
    suppressed.add('weather');
  }

  const unrouted = candidates.filter(journeyUnverified).length;
  if (shared(unrouted, total)) {
    notes.push(
      'We could not time the journeys from where you are staying, so the travel figures below are missing rather than wrong.',
    );
    suppressed.add('journey');
  }

  const unhoured = candidates.filter(hoursUnverified).length;
  if (shared(unhoured, total)) {
    notes.push(
      'Opening times are not published for most of these. Check anything you would make a special trip for.',
    );
    suppressed.add('hours');
  }

  const unchecked = candidates.filter(conditionsUnverified).length;
  if (shared(unchecked, total)) {
    notes.push('Conditions here change with the season — worth a look on the day.');
    suppressed.add('conditions');
  }

  /*
   * The one fact hoisted on a *count* rather than on a share.
   *
   * A live Tokyo board had eleven of twenty-three cards carrying the identical
   * thirty-word sentence "This looks promising, but nobody publishes enough
   * about it…" — under the share threshold, so it would not hoist, and far too
   * many to leave repeating. Naming the number is what makes the sentence
   * honest at any share: it is a claim about eleven cards and it says eleven,
   * where "most of these" would have been a claim about the board made from
   * less than half of it. The cards themselves then carry one short chip apiece,
   * so a reader can still see *which* eleven.
   */
  const unverified = candidates.filter((candidate) => candidate.fit.evidenceLimited).length;
  if (unverified >= SHARED_MIN_CARDS) {
    notes.push(
      `Almost nothing is published about ${unverified} of these, so we have not been able to check what they are actually like. They are marked below.`,
    );
    suppressed.add('unverified');
  }

  /*
   * Computed last, against the suppressions above, because they change what the
   * cards would have said. A blocker is never hoisted: "you cannot get there
   * without a car" is a verdict on one place, and a board-level version of it
   * would be read as a verdict on all of them.
   */
  const whys = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.fit.blockers.length > 0) continue;
    const why = whyThisFits(candidate, suppressed);
    if (why === null) continue;
    whys.set(why, (whys.get(why) ?? 0) + 1);
  }
  let commonWhy: string | null = null;
  for (const [why, count] of whys) {
    if (shared(count, total)) {
      commonWhy = why;
      notes.push(why);
      break;
    }
  }

  /*
   * The three numbers, and the one sentence that replaces them.
   *
   * Stated as a hedge — "unless a card says otherwise" — because that is exactly
   * what it is: a norm with named exceptions, not a claim about every card. The
   * cards that differ are then the only ones carrying a figure, which is what
   * makes the difference visible at a glance instead of buried in a row of
   * identical values.
   */
  const norms: BoardNorms = {
    cost: dominant(candidates.map((candidate) => formatCost(candidate.place.costLevel)), total),
    effort: dominant(
      candidates.map((candidate) => formatIntensity(candidate.place.physicalIntensity)),
      total,
    ),
    duration: dominant(candidates.map((candidate) => timeThere(candidate.place)), total),
  };
  if (norms.cost) suppressed.add('cost');
  if (norms.effort) suppressed.add('effort');
  if (norms.duration) suppressed.add('duration');
  const normParts = [
    norms.cost ? norms.cost.toLowerCase() : null,
    norms.effort ? `${norms.effort.toLowerCase()} going` : null,
    norms.duration ? `${norms.duration} at each` : null,
  ].filter((part): part is string => part !== null);
  if (normParts.length > 0) {
    notes.push(`Unless a card says otherwise these are ${listOf(normParts)}.`);
  }

  /*
   * Whichever way round the evidence falls, the smaller side is the one worth a
   * mark. A tie, or anything close to one, gets neither — see the field's own
   * comment.
   */
  const unverifiedShare = total === 0 ? 0 : unverified / total;
  const verificationMarker: SharedBoardFacts['verificationMarker'] =
    total < SHARED_MIN_CARDS
      ? null
      : unverifiedShare >= SHARED_MIN_SHARE
        ? 'checked'
        : unverifiedShare > 0 && unverifiedShare <= 1 - SHARED_MIN_SHARE
          ? 'unverified'
          : null;

  return { notes, suppressed, weatherNote, commonWhy, norms, verificationMarker };
}

/** The value at least `SHARED_MIN_SHARE` of the board takes, where there is one. */
function dominant(values: readonly string[], total: number): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  for (const [value, count] of counts) {
    if (shared(count, total)) return value;
  }
  return null;
}

/** "free", "free and easy going", "free, easy going and about 1 hr at each". */
function listOf(parts: readonly string[]): string {
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * THE THREE NUMBERS A CARD ACTUALLY PRINTS.
 *
 * Only what this card does not share with the board. A card that matches the
 * norm on all three prints none of them and is no poorer for it — the board said
 * so, once, above the cards — and a card that differs on one prints that one,
 * alone, where it cannot be missed.
 */
export function cardStats(
  candidate: DiscoveryCandidate,
  facts: Pick<SharedBoardFacts, 'norms'>,
): { key: string; label: string; value: string }[] {
  const stats = [
    { key: 'duration', label: 'Time there', value: timeThere(candidate.place), norm: facts.norms.duration },
    { key: 'cost', label: 'Cost', value: formatCost(candidate.place.costLevel), norm: facts.norms.cost },
    {
      key: 'effort',
      label: 'Effort',
      value: formatIntensity(candidate.place.physicalIntensity),
      norm: facts.norms.effort,
    },
  ];
  return stats
    .filter((stat) => stat.norm === null || stat.norm !== stat.value)
    .map(({ key, label, value }) => ({ key, label, value }));
}

/**
 * WHAT THIS PLACE IS, WHERE THAT IS WORTH A SENTENCE.
 *
 * §8.7 bans "A lake." and "A viewpoint." as copy, and a live Tokyo board carried
 * "A easy walk." eleven times, "A viewpoint." seven and "A lake." four. The
 * classifier is not at fault — that is the honest minimal sentence for a record
 * nothing is published about — but a description that only restates the category
 * chip beside it is a line that costs the reader a fixation and returns nothing.
 * Null, and the card simply has no description.
 */
export function descriptionOf(place: DiscoveryCandidate['place']): string | null {
  const description = place.shortDescription.trim();
  return substantive(description) ? description : null;
}

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

export interface BoardChip {
  key: string;
  label: string;
  tone: 'neutral' | 'pine' | 'amber' | 'clay' | 'blue';
}

/** The most a card may wear. See rule 2 at the top of this file. */
export const MAX_CARD_CHIPS = 2;

/**
 * The badges that survive, in the order a decision uses them.
 *
 * Everything above the line stops or reshapes a visit; everything below merely
 * describes it. Anything not named here is not a chip at all — it lives in the
 * card's disclosure, where a reader who has chosen to care will find it.
 */
export function chipsFor(
  candidate: DiscoveryCandidate,
  suppressed: ReadonlySet<SharedFactKind> = new Set(),
  /**
   * Which side of the evidence line is the minority on this board. Defaults to
   * the historical behaviour — mark the unverified — so a caller that has not
   * computed the board's shape still gets the safe, honest chip.
   */
  verificationMarker: SharedBoardFacts['verificationMarker'] = 'unverified',
): BoardChip[] {
  const chips: BoardChip[] = [];
  const { season, operating, access, weather, place, group } = candidate;

  const push = (chip: BoardChip) => {
    if (chips.length < MAX_CARD_CHIPS && !chips.some((existing) => existing.key === chip.key)) {
      chips.push(chip);
    }
  };

  // 1. It is shut, or shut for part of the trip. Nothing outranks this.
  if (season.status === 'closed' || operating.status === 'closed_throughout') {
    push({ key: 'closed', label: 'Closed on your dates', tone: 'clay' });
  } else if (season.status === 'partially_open' || operating.status === 'open_some_days') {
    push({ key: 'part-dates', label: 'Only some of your days', tone: 'amber' });
  }

  // 2. Nothing establishes what this actually is. It outranks a booking note,
  //    because a reservation policy read off an unverified record is unverified
  //    too — and §26 is explicit that an unchecked place must not read as a
  //    recommendation. Only where the board has hoisted the sentence, so a card
  //    never wears the chip *and* carries the paragraph.
  //    And only on the minority side: see `SharedBoardFacts.verificationMarker`
  //    for why a board of mostly-unchecked places marks the checked ones instead.
  if (candidate.fit.evidenceLimited) {
    if (verificationMarker === 'unverified' && suppressed.has('unverified')) {
      push({ key: 'unverified', label: 'Not verified', tone: 'amber' });
    }
  } else if (verificationMarker === 'checked') {
    push({ key: 'checked', label: 'Details checked', tone: 'pine' });
  }

  // 3. Something has to be arranged in advance, or paid for at a gate.
  const booking: OperatingBadge[] = ['reservation_required', 'timed_entry', 'admission_permit'];
  for (const badge of booking) {
    if (operating.badges.includes(badge)) push({ key: badge, label: OPERATING_BADGE_LABELS[badge], tone: 'amber' });
  }

  // 4. Getting in needs transport this traveller may not have.
  const gating: AccessBadge[] = ['car_required', 'shuttle_required', 'permit_required', 'seasonal_service'];
  for (const badge of gating) {
    if (access.badges.includes(badge)) push({ key: badge, label: ACCESS_BADGE_LABELS[badge], tone: 'amber' });
  }

  // 5. The weather over these dates, but only where it discriminates. A badge
  //    the board has already hoisted says nothing about *this* place.
  const weatherBadges: PlaceWeatherBadge[] = [
    'poor_in_the_forecast',
    'good_in_the_forecast',
    'poor_weather_friendly',
    'visibility_dependent',
  ];
  for (const badge of weatherBadges) {
    if (!weather.badges.includes(badge)) continue;
    if (suppressed.has('weather') && (badge === 'good_in_the_forecast' || badge === 'poor_in_the_forecast')) {
      continue;
    }
    push({
      key: badge,
      label: PLACE_WEATHER_BADGE_LABELS[badge],
      tone: badge === 'poor_in_the_forecast' ? 'amber' : badge === 'poor_weather_friendly' ? 'blue' : 'neutral',
    });
  }

  // 6. A quiet find, said once. The group heading already says it for the cards
  //    filed under it, so repeating it there would be the same word twice.
  if (place.hiddenGemScore >= 0.6 && group !== 'hidden_gems') {
    push({ key: 'gem', label: 'Quiet find', tone: 'amber' });
  }

  return chips;
}

// ---------------------------------------------------------------------------
// The argument
// ---------------------------------------------------------------------------

/**
 * The one calibrated recommendation label.
 *
 * Straight off `FIT_BAND_LABELS`, which the scorer's own distribution guard
 * calibrates. Nothing is invented here and no second vocabulary is introduced —
 * a board with two label scales is a board that can contradict itself.
 */
export function recommendationLabel(candidate: DiscoveryCandidate): string {
  return FIT_BAND_LABELS[candidate.fit.band];
}

/**
 * WHY THIS FITS, IN ONE LINE, EXPANDED BY DEFAULT.
 *
 * The board had this collapsed behind a disclosure while the negatives — three
 * warnings and a caution panel — ran down the card unprompted. A product whose
 * whole argument is personal fit was hiding the argument and leading with the
 * disclaimers.
 *
 * The chain is specific first: a scorer reason names an actual connection
 * ("stays quiet even in season, which matters more to you than a famous name"),
 * the quality sentence names the verdict, and where a candidate has neither the
 * function returns the honest thing rather than a manufactured compliment.
 *
 * `evidenceLimited` overrides all of it, and that is §26's worked example: a
 * card the engine could not verify must not read as a recommendation, whatever
 * its match score.
 */
export function whyThisFits(
  candidate: DiscoveryCandidate,
  suppressed: ReadonlySet<SharedFactKind> = new Set(),
  /**
   * The sentence the board has already made for most of its cards. A card that
   * would have said it says the next thing it can say that is its own.
   */
  commonWhy: string | null = null,
): string | null {
  if (candidate.fit.blockers.length > 0) return candidate.fit.blockers[0]!.message;
  if (candidate.fit.evidenceLimited && !suppressed.has('unverified')) {
    return 'This looks promising, but nobody publishes enough about it for us to have checked the practical details.';
  }
  const own = candidate.fit.reasons[0] ?? candidate.quality.reason;
  if (commonWhy === null || own !== commonWhy) return own;
  /*
   * Everything this card could say about *fit* is what the board has already
   * said, so it falls back to what the place is — but only if the description
   * is a description. §8.7 bans "A lake." and "A viewpoint." as primary copy,
   * and promoting one of those into the slot where the product makes its
   * argument would be worse than the repetition it replaces: it looks like an
   * answer and contains nothing.
   *
   * Null when there is nothing left to say, and the card then simply has no
   * reason line. A name, a picture, where it is, how long, what it costs and a
   * "not verified" chip is still a complete card; a card padded with filler is
   * a card that has stopped being trustworthy.
   */
  const description = candidate.place.shortDescription.trim();
  return substantive(description) ? description : null;
}

/**
 * ONE SENTENCE PER CARD, AND NEVER THE SAME ONE TWICE.
 *
 * `whyThisFits` answers for a card in isolation, which is right for a card and
 * wrong for a board: the scorer's reasons are *ranked*, so the obvious read —
 * always take `reasons[0]` — puts one sentence on every card that fits for the
 * same leading reason. The board's own hoist catches that only above a
 * three-fifths majority; below it, a live Tokyo board printed "Well off the
 * standard loop — the kind of find you said you wanted" on eight consecutive
 * cards. Under the threshold, and eight copies.
 *
 * So the sentence is chosen for the board rather than for the card: walk the
 * cards in the order they are read and give each the first reason nothing above
 * it has used. Every sentence is still one the model computed *about that
 * place*; what changes is which of its own reasons it leads with. A card whose
 * every reason is spoken for falls back to what the card would have said alone,
 * and null stays null — a card with no argument says nothing rather than
 * repeating its neighbour's.
 */
export function whysForBoard(
  candidates: readonly DiscoveryCandidate[],
  facts: Pick<SharedBoardFacts, 'suppressed' | 'commonWhy'>,
): Record<string, string | null> {
  const used = new Set<string>();
  const chosen: Record<string, string | null> = {};
  for (const candidate of candidates) {
    const fallback = whyThisFits(candidate, facts.suppressed, facts.commonWhy);
    /*
     * A blocker and the unverified sentence are not preferences between
     * reasons, they are the card's whole answer — `whyThisFits` returns them
     * ahead of everything and this must not talk over it.
     */
    if (candidate.fit.blockers.length > 0 || fallback === null) {
      chosen[candidate.place.id] = fallback;
      continue;
    }
    const own = candidate.fit.reasons.find((reason) => !used.has(reason));
    const why = own ?? (used.has(fallback) ? null : fallback);
    if (why !== null) used.add(why);
    chosen[candidate.place.id] = why;
  }
  return chosen;
}

/**
 * Whether a description says anything.
 *
 * The bare-stub form — an article, a noun phrase, a full stop — is exactly what
 * §8.7 names, and it is what the classifier emits for a record it knows nothing
 * about. The length floor catches the same shape with a couple of extra words.
 */
function substantive(description: string): boolean {
  if (description.length < 45) return false;
  return !/^an?\s+[a-z\s]+\.\s*$/i.test(description);
}

/**
 * What the evidence disclosure is called.
 *
 * "Why we trust this (0 of 6 checked)" appeared under every card on the live
 * board — a fraction nobody outside the team can act on, attached to a promise
 * of trust it then withdraws in the same breath. §26 names this exact string.
 * The replacement says what is inside the disclosure and nothing else; the
 * *state* of the evidence is already carried by the recommendation label above
 * it, which is where a calibrated claim belongs.
 */
export function evidenceDisclosureLabel(answered: number): string {
  return answered > 0 ? 'What we checked, and where it came from' : 'Where this came from';
}

/**
 * HOW LONG YOU WOULD SPEND THERE, AND WHO SAID SO.
 *
 * The card rendered `typicalDurationMinutes` as a flat figure — "Time there:
 * 1 hr 30 min" — for a river. Nobody timed a river. That number is the
 * archetype's constant for the *kind* of thing, which the compiler already
 * marks as such (`durationBasis: 'category_estimate'`, written beside a comment
 * saying it exists "so a card can write about instead"); the card was the half
 * of that pair that never landed.
 *
 * One word of hedging, not a caveat: "about 1 hr 30 min" is what a person would
 * say, and it costs the reader nothing while stopping the product from claiming
 * a measurement it does not have. A duration a source actually stated, or an
 * authored region's curated figure, keeps its plain form — hedging a figure
 * somebody did publish would be its own small dishonesty.
 */
export function timeThere(place: DiscoveryCandidate['place']): string {
  const figure = formatMinutes(place.typicalDurationMinutes);
  return place.durationBasis === 'category_estimate' ? `about ${figure}` : figure;
}

// ---------------------------------------------------------------------------
// Passing on something
// ---------------------------------------------------------------------------

/**
 * WHY SOMEBODY SAID NO — and it has to be usable now, not next trip.
 *
 * §10.6 asks for reasons and asks that they act on the current trip without a
 * new questionnaire. Each reason below maps to a property the board already
 * holds, so "too far" can immediately name the other stops that are further and
 * offer to drop them too. A reason that only got filed away would be a survey.
 */
export const PASS_REASONS = [
  { id: 'too_touristy', label: 'Too touristy' },
  { id: 'too_expensive', label: 'Too expensive' },
  { id: 'too_intense', label: 'Too much effort' },
  { id: 'too_far', label: 'Too far' },
  { id: 'not_my_thing', label: 'Not my thing' },
] as const;
export type PassReason = (typeof PASS_REASONS)[number]['id'];

/**
 * The other cards this traveller has just told us something about.
 *
 * Strictly "at least as bad on the named axis as the one they rejected", which
 * is what makes the follow-up offer defensible rather than a guess: nothing is
 * proposed for removal that is not further, dearer, harder or the same kind of
 * thing as the card they passed on. Cards they have already decided on are left
 * alone — re-asking about a settled choice is how a helpful prompt becomes a
 * nag.
 */
export function alsoLikeThis(input: {
  candidates: readonly DiscoveryCandidate[];
  passed: DiscoveryCandidate;
  reason: PassReason;
  decided: ReadonlySet<string>;
}): DiscoveryCandidate[] {
  const { candidates, passed, reason, decided } = input;
  const others = candidates.filter(
    (candidate) => candidate.place.id !== passed.place.id && !decided.has(candidate.place.id),
  );

  switch (reason) {
    case 'too_far': {
      const threshold = passed.travelMinutesFromBase;
      if (threshold === null) return [];
      return others.filter(
        (candidate) =>
          candidate.travelMinutesFromBase !== null &&
          candidate.travelMinutesFromBase >= threshold,
      );
    }
    case 'too_expensive':
      return others.filter((candidate) => candidate.place.costLevel >= passed.place.costLevel && passed.place.costLevel > 0);
    case 'too_intense': {
      const order = ['none', 'easy', 'moderate', 'strenuous'];
      const floor = order.indexOf(passed.place.physicalIntensity);
      if (floor <= 0) return [];
      return others.filter((candidate) => order.indexOf(candidate.place.physicalIntensity) >= floor);
    }
    case 'too_touristy':
      return others.filter(
        (candidate) => candidate.place.popularityScore >= passed.place.popularityScore && passed.place.popularityScore >= 0.6,
      );
    case 'not_my_thing':
      return others.filter((candidate) => candidate.place.category === passed.place.category);
  }
}

/** The sentence offering that follow-up. Plural-correct, and names the axis. */
export function alsoLikeThisPrompt(reason: PassReason, count: number): string {
  const plural = count === 1 ? 'is one more place' : `are ${count} more places`;
  switch (reason) {
    case 'too_far':
      return `There ${plural} at least as far out. Skip ${count === 1 ? 'it' : 'them'} too?`;
    case 'too_expensive':
      return `There ${plural} costing as much or more. Skip ${count === 1 ? 'it' : 'them'} too?`;
    case 'too_intense':
      return `There ${plural} that ask as much of you. Skip ${count === 1 ? 'it' : 'them'} too?`;
    case 'too_touristy':
      return `There ${plural} just as well-trodden. Skip ${count === 1 ? 'it' : 'them'} too?`;
    case 'not_my_thing':
      return `There ${plural} of the same kind. Skip ${count === 1 ? 'it' : 'them'} too?`;
  }
}
