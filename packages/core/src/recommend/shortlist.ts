import type { TripComposerAnswers } from '../schemas/composer';
import {
  DESTINATION_RANKER_VERSION,
  DESTINATION_SHORTLIST_VERSION,
  MAX_SHORTLIST,
  type DestinationShortlist,
  type Exclusion,
  type RankedDestination,
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
