import type { DestinationFeatureType } from '../schemas/destination-index';
import type { TripComposerAnswers } from '../schemas/composer';
import {
  DESTINATION_RANKER_VERSION,
  DESTINATION_SHORTLIST_VERSION,
  MAX_SHORTLIST,
  RANK_DIMENSIONS,
  RANK_DIMENSION_LABELS,
  RANK_WEIGHTS,
  type DestinationShortlist,
  type Exclusion,
  type RankDimension,
  type RankedDestination,
  type UnknownReason,
} from '../schemas/shortlist';
import { exclusionsFor, monthsFromAnswers, rankDestination, type CandidateEvidence } from './rank';
import { separationKm } from './distance';

/**
 * FROM A SCORED SET TO A LIST SOMEBODY WOULD ACTUALLY READ.
 *
 * Ranking alone returns five provinces of one country, because the things that
 * make a destination score well are regional: one country's climate, one
 * country's index density, one country's road distances. A list like that is
 * technically correct and useless — a traveller asking "where should I go" is
 * asking to be shown options, and eight variations on one option is one option.
 *
 * So there are two stages, and both are deterministic:
 *
 * 1. **Rank**, total order, ties broken to the last field.
 * 2. **Admit greedily under diversity constraints**, relaxing them in a fixed
 *    order and *recording* each relaxation.
 *
 * No randomness, no tuned λ, no maximal-marginal-relevance. A shortlist that
 * reorders between two identical requests is the dropdown-reordering defect at
 * destination scale, and it would make every "why was I shown this" answer a
 * guess.
 */

/** Two destinations closer than this are, for shortlist purposes, one option. */
export const MIN_SEPARATION_KM = 250;
/** How many picks may share a country before the cap has to be relaxed. */
export const MAX_PER_COUNTRY = 1;

export interface BuildShortlistInput {
  candidates: readonly CandidateEvidence[];
  answers: TripComposerAnswers;
  /** The months a season resolves to here. Empty when the traveller named none. */
  seasonMonths: readonly number[];
  limit?: number;
  climateRequests: number;
  elapsedMs: number;
  now: Date;
  /** Named at the top of the result. Properties of the method, not of a card. */
  blindSpots?: readonly string[];
}

/**
 * Everything the ranking depended on, as one string.
 *
 * Built like `scopeFingerprint`: an explicit field list rather than a hash of a
 * whole object. A hash would invalidate every stored shortlist whenever anybody
 * added a field to the composer, and — worse — would *not* invalidate them when
 * somebody changed a weight, because the weights are not in the object.
 */
export function shortlistInputKey(input: {
  answers: TripComposerAnswers;
  releaseId: string;
  candidateMonths: readonly number[];
}): string {
  const { answers } = input;
  const nights =
    answers.duration.mode === 'fixed' ? answers.duration.nights : undefined;
  return [
    `v${DESTINATION_SHORTLIST_VERSION}`,
    DESTINATION_RANKER_VERSION,
    `index:${input.releaseId}`,
    `months:${[...input.candidateMonths].sort((a, b) => a - b).join('.')}`,
    `dates:${answers.dates.mode}:${answers.dates.startDate ?? ''}:${answers.dates.flexDays ?? ''}`,
    `nights:${nights ?? ''}:${answers.duration.minNights ?? ''}:${answers.duration.maxNights ?? ''}`,
    `shape:${answers.shape ?? ''}`,
    `transport:${answers.transport ?? ''}`,
    `themes:${[...answers.themes].sort().join('.')}`,
    `needs:${[...answers.travelerNeeds].sort().join('.')}`,
    `pace:${answers.pace ?? ''}`,
    `budget:${answers.budget ?? ''}`,
    `intensity:${answers.outdoorIntensity ?? ''}`,
    `crowd:${answers.crowdTolerance ?? ''}`,
    `avoid:${(answers.avoid ?? '').trim().toLowerCase().slice(0, 120)}`,
  ].join('/');
}

/**
 * A destination the traveller named in what they wanted to avoid.
 *
 * Exact, whole-word, case-folded. **Never fuzzy** — an exclusion on an
 * edit-distance match is the Denali-versus-Delhi failure with worse
 * consequences: there, fame promoted the wrong row and the traveller could see
 * it; here, two characters of typo would silently delete a country from the
 * world and nothing on screen would explain why.
 */
export function ruledOut(answers: TripComposerAnswers, name: string): boolean {
  const avoid = (answers.avoid ?? '').toLowerCase();
  if (avoid.trim().length === 0) return false;
  const folded = name.trim().toLowerCase();
  if (folded.length < 4) return false;
  const words = avoid.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.includes(folded)) return true;
  // A multi-word name matches only as a contiguous phrase.
  return folded.includes(' ') && avoid.includes(folded);
}

export function buildShortlist(input: BuildShortlistInput): DestinationShortlist {
  const started = Date.now();
  const limit = Math.min(MAX_SHORTLIST, Math.max(1, input.limit ?? MAX_SHORTLIST));
  const candidateMonths = monthsFromAnswers(input.answers, input.seasonMonths);

  const excluded: { entryId: string; displayName: string; exclusion: Exclusion }[] = [];
  const ranked: RankedDestination[] = [];

  for (const candidate of input.candidates) {
    if (ruledOut(input.answers, candidate.entry.displayName)) {
      excluded.push({
        entryId: candidate.entry.id,
        displayName: candidate.entry.displayName,
        exclusion: {
          code: 'traveller_ruled_it_out',
          message: 'You named this in what you wanted to avoid.',
        },
      });
      continue;
    }

    const rankInput = { candidate, answers: input.answers, candidateMonths };
    const reasons = exclusionsFor(rankInput);
    if (reasons.length > 0) {
      excluded.push({
        entryId: candidate.entry.id,
        displayName: candidate.entry.displayName,
        exclusion: reasons[0]!,
      });
      continue;
    }
    ranked.push(rankDestination(rankInput));
  }

  /*
   * A total order, to the last field.
   *
   * Score, then coverage — because between two equal scores the one we actually
   * know something about is the better suggestion — then the id, which makes the
   * order total and therefore the output reproducible.
   */
  ranked.sort(
    (a, b) => b.score - a.score || b.coverage - a.coverage || a.entryId.localeCompare(b.entryId),
  );

  const { picks, note } = diversify(ranked, limit);

  return {
    schemaVersion: DESTINATION_SHORTLIST_VERSION,
    rankerVersion: DESTINATION_RANKER_VERSION,
    inputKey: shortlistInputKey({
      answers: input.answers,
      releaseId: input.candidates[0]?.releaseId ?? 'unknown',
      candidateMonths,
    }),
    picks,
    considered: ranked.length,
    excluded,
    blindSpots: [...(input.blindSpots ?? []), ...STANDING_BLIND_SPOTS],
    ...(note ? { diversityNote: note } : {}),
    builtAt: input.now.toISOString(),
    elapsedMs: Math.max(0, input.elapsedMs || Date.now() - started),
    climateRequests: Math.max(0, Math.trunc(input.climateRequests)),
  };
}

/**
 * What this method cannot see, said once at the top.
 *
 * Per-card would be worse: eight repetitions of the same caveat is how a caveat
 * becomes furniture. Every line is a dimension a traveller would reasonably
 * expect a "where should I go" answer to cover, and not one of them is sourced.
 */
const STANDING_BLIND_SPOTS = [
  'Flights — we have no fare or route data, so nothing here accounts for how hard anywhere is to reach.',
  'Visas and entry rules — not sourced, and not something we would guess at.',
  'Crowds and prices — no data, so neither one moved any of these scores.',
  'Safety — we make no claim about it here. Check your own government’s advice.',
];

/**
 * The feature types that are somebody's administrative geometry rather than
 * somewhere a traveller would name.
 *
 * A region, a county, a country: a polygon drawn for governing, whose only
 * published property is what it is *called*. The index carries no park, island
 * or protected area today, so in practice every shortlist is drawn entirely
 * from this set — and that is a fact about our catalogue that belongs on the
 * screen rather than in a code comment.
 *
 * `district` is deliberately absent: `themeMeasure` reads a district as urban
 * and does get a reading from it, so a list of districts is not the evidence-free
 * case this sentence describes. The set and the sentence have to agree.
 */
const ADMINISTRATIVE_FEATURE_TYPES = new Set<DestinationFeatureType>([
  'region',
  'county',
  'country',
  'dependency',
]);

/** What a missing feature type is called in the sentence a traveller reads. */
const LANDSCAPE_KIND_WORDS: Partial<Record<DestinationFeatureType, string>> = {
  island: 'islands',
  national_park: 'national parks',
  protected_area: 'protected areas',
  landmark: 'landmarks',
};

/**
 * Say when the whole list is administrative geometry, because it reads as one.
 *
 * A reviewer opening this screen described "eight identical abstract cards of
 * administrative regions" — Cobán, Kasarani, Akershus, Tirana County — and the
 * page gave no account of why the answer to "where should I go" looked like a
 * list of provinces. It is not a scoring failure; it is the whole catalogue.
 * Stated here, once, at the top, in the same place as the other four things
 * this method cannot see.
 *
 * **Measured, not inferred.** This used to read the *picks*: eight
 * administrative rows on screen were taken as proof that administrative rows
 * are all the index holds. That inference is false in exactly the case that
 * matters — an index carrying five national parks, none of which reached the
 * top eight, would still produce "that is all our place index holds", which is
 * a claim about our catalogue derived from a scoring outcome. So the caller
 * passes what the catalogue actually returned for each kind it asked for, and
 * the sentence is only said when a kind came back empty.
 */
export function catalogueBlindSpot(input: {
  /** The feature types the recommender asked the index for. */
  requested: readonly DestinationFeatureType[];
  /** The feature types the index actually supplied. Counted, not assumed. */
  supplied: readonly DestinationFeatureType[];
}): string[] {
  const supplied = new Set(input.supplied);
  if (supplied.size === 0) return [];
  if (![...supplied].every((type) => ADMINISTRATIVE_FEATURE_TYPES.has(type))) return [];

  const missing = input.requested
    .filter((type) => !supplied.has(type))
    .map((type) => LANDSCAPE_KIND_WORDS[type])
    .filter((word): word is string => Boolean(word));
  if (missing.length === 0) return [];

  const named =
    missing.length === 1
      ? missing[0]!
      : `${missing.slice(0, -1).join(', ')} or ${missing[missing.length - 1]!}`;
  return [
    `Every suggestion here is an administrative region or county. We looked for ${named} too and our place index holds none, so nothing below was chosen for its landscape.`,
  ];
}

/**
 * WHETHER THE ORDER IS AN ORDER.
 *
 * Measured over the live index against an ordinary set of answers, the top of
 * the shortlist is a thirty-eight-way tie: `durationFit` reads 1.00 for 239 of
 * 240 candidates, `transportFit` 1.00 for 239, `structureFit` 0.70 for 234, and
 * the two dimensions that do vary saturate at the top. Everything above the cut
 * therefore scores the same, and the sequence a traveller reads is
 * `entryId.localeCompare` — an alphabetical walk over UUIDs, presented as a
 * ranking with a hero panel beside the first row.
 *
 * A page cannot decide that for itself without re-deriving the scoring, so the
 * verdict is computed here, from the same records the order came from, and both
 * the page and the component read it. Three things it answers, each of which a
 * screen needs a different response to:
 *
 * - **Does it separate?** Only when every adjacent pair differs in score. One
 *   tie anywhere and the ordinals are a stronger claim than the copy above them
 *   is a disclaimer.
 * - **What was never measured?** The dimensions no pick could be scored on.
 *   The ones whose reason is `traveller_did_not_say` are the actionable half —
 *   they are literally the questions the revise form asks.
 * - **What was measured and moved nothing?** A dimension identical across every
 *   pick did not contribute to the order, however good its number looks.
 */
export interface ShortlistSeparation {
  /** True only when every adjacent pair of picks differs in score. */
  separates: boolean;
  /** True when no pick outscored any other: the sequence is the tiebreak alone. */
  undifferentiated: boolean;
  /** How many picks share the top score. Two or more and there is no leader. */
  tiedAtTop: number;
  /** Dimensions no pick could be measured on, with the reason they share. */
  unmeasured: readonly { id: RankDimension; label: string; reason: UnknownReason }[];
  /** Dimensions measured identically for every pick. They moved nothing. */
  flat: readonly { id: RankDimension; label: string }[];
}

export function shortlistSeparation(
  picks: readonly RankedDestination[],
): ShortlistSeparation {
  const unmeasured: { id: RankDimension; label: string; reason: UnknownReason }[] = [];
  const flat: { id: RankDimension; label: string }[] = [];

  for (const id of RANK_DIMENSIONS) {
    const measures = picks.map((pick) => pick.factors.find((factor) => factor.id === id)?.measure);
    if (measures.length === 0 || measures.some((measure) => measure === undefined)) continue;

    if (measures.every((measure) => measure!.kind === 'unknown')) {
      const reasons = measures.map((measure) => (measure as { reason: UnknownReason }).reason);
      /*
       * When the picks disagree about *why*, prefer the reason the traveller can
       * act on. "You have not told us" is a question we can ask; the others are
       * ours to fix or nobody's, and neither belongs at the top of a list of
       * things somebody could do next.
       */
      const reason = reasons.find((entry) => entry === 'traveller_did_not_say') ?? reasons[0]!;
      unmeasured.push({ id, label: RANK_DIMENSION_LABELS[id], reason });
      continue;
    }

    const values = measures.map((measure) =>
      measure!.kind === 'measured' ? measure!.value : null,
    );
    if (values.every((value) => value !== null && value === values[0])) {
      flat.push({ id, label: RANK_DIMENSION_LABELS[id] });
    }
  }

  const scores = picks.map((pick) => pick.score);
  const top = scores[0];
  const tiedAtTop = top === undefined ? 0 : scores.filter((score) => score === top).length;
  const separates = scores.every((score, index) => index === 0 || scores[index - 1]! > score);
  const undifferentiated = scores.length > 1 && scores.every((score) => score === top);

  return { separates, undifferentiated, tiedAtTop, unmeasured, flat };
}

/**
 * WHICH ONE TO PUT FIRST, AND WHAT MAY BE CLAIMED FOR IT.
 *
 * `shortlistSeparation` answers "is this a ranking". It is the honest answer and
 * it was, on its own, a dead end: the screen learned that its eight rows could
 * not be told apart and responded by heading them "We could not tell these
 * apart" over eight identical cards. A traveller who asked where they should go
 * was handed the method's self-assessment instead of an answer.
 *
 * A no-confidence result still has to be a useful screen, and the way out is not
 * to overclaim — it is to lead with one destination and be exact about *why it
 * is first*. Three bases, and the copy above each is a different sentence:
 *
 * - `outscored` — it genuinely beat every other. The ordinary case, and the only
 *   one where "why this one" is a true heading.
 * - `best_evidenced` — several tied on score, and this is the one we could check
 *   the most of. Not a claim that it fits better; a claim that we know more
 *   about it, which is a real reason to start there and a checkable one.
 * - `arbitrary` — tied on score *and* on how much we could see. Somebody still
 *   has to be first, so one is, and the screen says plainly that it was not
 *   chosen. This is the case the old headline was describing, and the fix is not
 *   to hide it but to stop making it the whole page.
 *
 * `nextQuestion` is the single most valuable thing the traveller could tell us:
 * the heaviest unmeasured dimension whose absence is theirs to fix. One, not the
 * six the page used to list — six questions is a form, and a form is what
 * somebody is trying to escape when they ask where to go.
 */
export type ShortlistLeadBasis = 'outscored' | 'best_evidenced' | 'arbitrary';

export interface ShortlistLead {
  entryId: string;
  basis: ShortlistLeadBasis;
  /** How many picks are level with the lead on score. One means it leads alone. */
  tiedWith: number;
  /** The one answer that would most change this ranking. Absent when none would. */
  nextQuestion?: { id: RankDimension; label: string; action: string };
}

export function shortlistLead(
  picks: readonly RankedDestination[],
  separation: ShortlistSeparation,
): ShortlistLead | null {
  const first = picks[0];
  if (!first) return null;

  /*
   * The heaviest question we could still ask.
   *
   * Weight order rather than declaration order, because the dimensions are not
   * equal: climate carries 0.24 of the nominal weight and transport 0.04, so
   * "name a month" is worth six times "say whether you would drive" and the
   * screen should ask for the one that pays.
   */
  const nextQuestion = separation.unmeasured
    .filter((entry) => entry.reason === 'traveller_did_not_say')
    .map((entry) => ({ ...entry, action: ANSWER_THAT_WOULD_HELP[entry.id] }))
    .filter((entry): entry is typeof entry & { action: string } => Boolean(entry.action))
    .sort((a, b) => RANK_WEIGHTS[b.id] - RANK_WEIGHTS[a.id] || a.id.localeCompare(b.id))
    .map((entry) => ({ id: entry.id, label: entry.label, action: entry.action }))[0];

  const withQuestion = nextQuestion ? { nextQuestion } : {};

  if (separation.tiedAtTop <= 1) {
    return { entryId: first.entryId, basis: 'outscored', tiedWith: 1, ...withQuestion };
  }

  const level = picks.filter((pick) => pick.score === first.score);
  const bestCoverage = Math.max(...level.map((pick) => pick.coverage));
  const evidenced = level.filter((pick) => pick.coverage === bestCoverage);

  return {
    entryId: evidenced[0]!.entryId,
    basis: evidenced.length === 1 ? 'best_evidenced' : 'arbitrary',
    tiedWith: level.length,
    ...withQuestion,
  };
}

/**
 * The answer that would fill a dimension, phrased as the question we ask.
 *
 * Only ever shown for a dimension whose absence reason is
 * `traveller_did_not_say` — the half of "what we could not see" that somebody
 * can do something about in the next thirty seconds. The other reasons are ours
 * or nobody's and offering them as an action would be a lie about who is stuck.
 *
 * Kept beside the ranker rather than in the page, because each line is a claim
 * about what a *measurer* reads: `climateMeasure` and `daylightMeasure` both key
 * on `candidateMonths`, `durationMeasure` on `nightsFrom`, `structureMeasure` on
 * `answers.shape`, `themeMeasure` on `answers.themes`, `transportMeasure` on
 * `answers.transport`. Move one of those and this map is the thing that has to
 * move with it.
 */
export const ANSWER_THAT_WOULD_HELP: Partial<Record<RankDimension, string>> = {
  climateFit: 'Name a month or a season rather than leaving the dates open — the weather is the strongest signal we have.',
  daylightFit: 'Name a month or a season; the daylight comes from the same dates.',
  durationFit: 'Say roughly how many nights you have.',
  structureFit: 'Say whether you want one base, two, or a circuit.',
  themeFit: 'Say what you are going for.',
  transportFit: 'Say whether you would drive or use public transport.',
};

/**
 * Admit greedily under diversity constraints, relaxing in a fixed order.
 *
 * The relaxations are ordered and recorded so the output is reproducible *and*
 * explicable: "we had to show you two places in one country because there were
 * not eight countries that fit" is a sentence, and a silently-relaxed constraint
 * is not.
 */
function diversify(
  ranked: readonly RankedDestination[],
  limit: number,
): { picks: RankedDestination[]; note?: string } {
  const stages: { countryCap: number; separationKm: number; label: string }[] = [
    { countryCap: MAX_PER_COUNTRY, separationKm: MIN_SEPARATION_KM, label: '' },
    { countryCap: MAX_PER_COUNTRY, separationKm: MIN_SEPARATION_KM / 2, label: 'closer together' },
    { countryCap: 2, separationKm: MIN_SEPARATION_KM / 2, label: 'more than one per country' },
    { countryCap: limit, separationKm: 0, label: 'without spreading them out' },
  ];

  const picks: RankedDestination[] = [];
  const perCountry = new Map<string, number>();
  let usedStage = 0;

  for (const [index, stage] of stages.entries()) {
    if (picks.length >= limit) break;
    usedStage = index;
    for (const candidate of ranked) {
      if (picks.length >= limit) break;
      if (picks.some((pick) => pick.entryId === candidate.entryId)) continue;

      const country = candidate.countryCode ?? candidate.entryId;
      if ((perCountry.get(country) ?? 0) >= stage.countryCap) continue;
      if (
        stage.separationKm > 0 &&
        picks.some((pick) => separationKm(pick.center, candidate.center) < stage.separationKm)
      ) {
        continue;
      }

      picks.push(candidate);
      perCountry.set(country, (perCountry.get(country) ?? 0) + 1);
    }
  }

  const note =
    usedStage > 0 && stages[usedStage]?.label
      ? `Not enough distinct options scored well, so we allowed suggestions ${stages[usedStage]!.label}.`
      : undefined;

  return { picks, ...(note ? { note } : {}) };
}
