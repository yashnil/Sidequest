import {
  BUDGET_BAND_LABELS,
  TRANSPORT_INTENT_LABELS,
  TRIP_SHAPE_LABELS,
  TRIP_THEME_LABELS,
  type TripComposerAnswers,
} from '../schemas/composer';
import { RANK_WEIGHTS, type RankDimension } from '../schemas/shortlist';

/**
 * V11 §A1 — THE INTAKE LADDER FOR "HELP ME CHOOSE".
 *
 * The screen this replaces was a form: three numbered sections, twenty controls,
 * every one of them visible at once, and a disclosure called "a few more that
 * change the answer" holding five more. A traveller who has not decided where to
 * go is the traveller least able to answer twenty questions about a trip that
 * does not exist yet.
 *
 * So the questions are ordered here rather than laid out there, by exactly one
 * rule: **what would most change the ranking, asked first**. Every question
 * names the rank dimensions it feeds, and its position is the sum of those
 * dimensions' nominal weights (`RANK_WEIGHTS`) — the same table `coverage` is
 * measured against. A question that feeds nothing the ranker measures is not in
 * this list, and there is no way to add one without naming a dimension.
 *
 * Two consequences worth stating, because they are the point:
 *
 * - **Stopping is a decision the data makes.** `intakeReady` is true once the
 *   answered questions carry enough nominal weight to separate a list, and once
 *   the two questions nothing can be ranked without — when, and what for — are
 *   answered. Everything past that is offered, never demanded.
 * - **Skipping is recorded.** A question the traveller passed over is written to
 *   `skipped` so it is not asked twice, and so "nobody said" stays
 *   distinguishable from "nobody was asked" — which is the difference between a
 *   dimension that abstains and one we failed to collect.
 */

export const INTAKE_QUESTION_IDS = [
  'when',
  'length',
  'priorities',
  'origin',
  'party',
  'budget',
  'intensity',
  'climate',
  'flight',
  'scope',
  'crowds',
  'transport',
  'shape',
  'lodging',
  'visited',
  'constraints',
  'surprise',
] as const;
export type IntakeQuestionId = (typeof INTAKE_QUESTION_IDS)[number];

export interface IntakeQuestion {
  id: IntakeQuestionId;
  /** The question as a traveller reads it. */
  title: string;
  /** One line saying what the answer changes. Never decoration. */
  consequence: string;
  /** Rank dimensions this answer feeds. Empty is not permitted. */
  feeds: readonly RankDimension[];
  /**
   * Nothing can be ranked without this. Two of them, and the list says which.
   */
  essential: boolean;
}

/**
 * The ladder.
 *
 * `feeds` is the load-bearing field: `intakeWeight` sums those dimensions'
 * nominal weights and that sum is the order. The two `essential` questions are
 * pinned to the front regardless, because a ranking with no month and no theme
 * is not a weak ranking, it is an arbitrary one.
 */
export const INTAKE_QUESTIONS: readonly IntakeQuestion[] = [
  {
    id: 'when',
    title: 'When are you free?',
    consequence: 'Decides which half of the world is in season at all.',
    feeds: ['climateFit', 'daylightFit', 'crowdFit'],
    essential: true,
  },
  {
    id: 'priorities',
    title: 'What are you going for?',
    consequence: 'Without this we would be ranking places against nobody.',
    feeds: ['themeFit', 'supplyFit', 'varietyFit'],
    essential: true,
  },
  {
    id: 'length',
    title: 'How long could you go for?',
    consequence: 'Decides how much ground a place has to cover to be worth the trip.',
    feeds: ['durationFit', 'structureFit'],
    essential: false,
  },
  {
    id: 'origin',
    title: 'Where would you be starting from?',
    consequence: 'How much of the trip is spent getting there. A distance, never a fare.',
    feeds: ['flightBurden', 'entryFriction'],
    essential: false,
  },
  {
    id: 'budget',
    title: 'What are you working with per person?',
    consequence: 'Whether the beds you want exist here at the money you have.',
    feeds: ['comfortFit'],
    essential: false,
  },
  {
    id: 'climate',
    title: 'Warm, mild or cold?',
    consequence: 'A preference about the place, not a forecast.',
    feeds: ['climatePreferenceFit'],
    essential: false,
  },
  {
    id: 'flight',
    title: 'How far would you fly?',
    consequence: 'Turns distance from a fact into a cost you have priced.',
    feeds: ['flightBurden'],
    essential: false,
  },
  {
    id: 'party',
    title: 'Who is going?',
    consequence: 'Changes what counts as an easy day and what has to be bookable.',
    feeds: ['structureFit', 'comfortFit'],
    essential: false,
  },
  {
    id: 'intensity',
    title: 'How hard should the days be?',
    consequence: 'Separates a place you walk through from a place you climb.',
    feeds: ['themeFit', 'supplyFit'],
    essential: false,
  },
  {
    id: 'crowds',
    title: 'How busy will you accept?',
    consequence: 'Some of the best months are the busy ones. Worth saying which way you lean.',
    feeds: ['crowdFit'],
    essential: false,
  },
  {
    id: 'scope',
    title: 'Leaving the country?',
    consequence: 'Decides whether a passport is part of this trip.',
    feeds: ['entryFriction'],
    essential: false,
  },
  {
    id: 'shape',
    title: 'How often would you move?',
    consequence: 'A region that needs four bases is the wrong answer for one.',
    feeds: ['structureFit'],
    essential: false,
  },
  {
    id: 'transport',
    title: 'How would you get around?',
    consequence: 'A place we ruled out for being spread thin comes back the moment you say you will drive.',
    feeds: ['transportFit'],
    essential: false,
  },
  {
    id: 'lodging',
    title: 'How comfortable do the beds have to be?',
    consequence: 'Separate from money: budget and fussiness are different questions.',
    feeds: ['comfortFit'],
    essential: false,
  },
  {
    id: 'visited',
    title: 'Anywhere you have already been?',
    consequence: 'Lowers how novel somewhere similar looks. Never removes it.',
    feeds: ['noveltyFit'],
    essential: false,
  },
  {
    id: 'surprise',
    title: 'How far from the familiar?',
    consequence: 'Decides whether the wildcard is a nudge or a shove.',
    feeds: ['noveltyFit', 'varietyFit'],
    essential: false,
  },
  {
    id: 'constraints',
    title: 'Anything we should rule out?',
    consequence: 'Naming a place exactly takes it off the list. We never guess at a near-miss.',
    feeds: ['themeFit'],
    essential: false,
  },
];

const QUESTION_BY_ID = new Map(INTAKE_QUESTIONS.map((question) => [question.id, question] as const));

export function intakeQuestion(id: IntakeQuestionId): IntakeQuestion {
  const found = QUESTION_BY_ID.get(id);
  /* Total by construction: the map is built from the same list the type is. */
  if (!found) throw new Error(`unknown intake question: ${id}`);
  return found;
}

/** The nominal rank weight an answer to this question would unlock. */
export function intakeWeight(question: IntakeQuestion): number {
  let total = 0;
  const seen = new Set<RankDimension>();
  for (const dimension of question.feeds) {
    if (seen.has(dimension)) continue;
    seen.add(dimension);
    total += RANK_WEIGHTS[dimension];
  }
  return total;
}

/**
 * Has this question been answered?
 *
 * Deliberately a function of the stored composer record rather than of component
 * state, so that a traveller who closes the laptop and comes back is asked
 * exactly the questions they have not answered.
 */
export function intakeAnswered(id: IntakeQuestionId, answers: TripComposerAnswers): boolean {
  switch (id) {
    case 'when': {
      const dates = answers.dates;
      if (dates.mode === 'month') return typeof dates.month === 'number';
      if (dates.mode === 'season') return Boolean(dates.season);
      if (dates.mode === 'exact' || dates.mode === 'flexible') return Boolean(dates.startDate);
      return dates.mode === 'undecided';
    }
    case 'length':
      return answers.duration.mode === 'fixed' || answers.duration.mode === 'range';
    case 'priorities':
      return answers.themes.length > 0;
    case 'origin':
      return Boolean(answers.origin?.trim());
    case 'party':
      /* Anything other than the schema default is an answer; the default is not. */
      return answers.adults !== 2 || answers.children > 0 || answers.travelerNeeds.length > 0;
    case 'budget':
      return typeof answers.budgetPerPerson === 'number' || Boolean(answers.budget);
    case 'intensity':
      return Boolean(answers.outdoorIntensity);
    case 'climate':
      return Boolean(answers.climatePreference);
    case 'flight':
      return Boolean(answers.flightTolerance);
    case 'scope':
      return Boolean(answers.tripScope);
    case 'crowds':
      return Boolean(answers.crowdTolerance);
    case 'transport':
      return Boolean(answers.transport);
    case 'shape':
      return Boolean(answers.shape);
    case 'lodging':
      return Boolean(answers.lodgingComfort);
    case 'visited':
      return (answers.visited ?? []).length > 0;
    case 'surprise':
      return Boolean(answers.surpriseAppetite);
    case 'constraints':
      return Boolean(answers.avoid?.trim());
  }
}

/** Answered, or explicitly passed over. Either way, not asked again. */
export function intakeSettled(id: IntakeQuestionId, answers: TripComposerAnswers): boolean {
  return intakeAnswered(id, answers) || answers.skipped.includes(`intake:${id}`);
}

/**
 * The questions still worth asking, heaviest first.
 *
 * Essentials lead, then descending nominal weight, then declaration order so the
 * sequence is stable for a traveller who reloads mid-intake.
 */
export function intakeQueue(answers: TripComposerAnswers): IntakeQuestion[] {
  const index = new Map(INTAKE_QUESTIONS.map((question, position) => [question.id, position] as const));
  return INTAKE_QUESTIONS.filter((question) => !intakeSettled(question.id, answers)).sort((a, b) => {
    if (a.essential !== b.essential) return a.essential ? -1 : 1;
    const byWeight = intakeWeight(b) - intakeWeight(a);
    if (Math.abs(byWeight) > 1e-9) return byWeight;
    return index.get(a.id)! - index.get(b.id)!;
  });
}

/** The next question, or null when there is nothing left worth asking. */
export function nextIntakeQuestion(answers: TripComposerAnswers): IntakeQuestion | null {
  return intakeQueue(answers)[0] ?? null;
}

/**
 * Nominal weight the answers so far have unlocked, 0–1.
 *
 * Against the same `RANK_WEIGHTS` table `coverage` uses, so "we have enough to
 * rank" and "we measured enough to rank" are expressed in one currency.
 */
export function intakeSignal(answers: TripComposerAnswers): number {
  const unlocked = new Set<RankDimension>();
  for (const question of INTAKE_QUESTIONS) {
    if (!intakeAnswered(question.id, answers)) continue;
    for (const dimension of question.feeds) unlocked.add(dimension);
  }
  let total = 0;
  for (const dimension of unlocked) total += RANK_WEIGHTS[dimension];
  return Math.min(1, total);
}

/**
 * Enough signal to rank.
 *
 * Both essentials, and half the nominal weight. Not a high bar on purpose: past
 * this point the traveller gets an answer and the remaining questions become an
 * offer beside it, which is the entire difference between an intake and a form.
 */
export const INTAKE_SIGNAL_FLOOR = 0.5;

export function intakeReady(answers: TripComposerAnswers): boolean {
  const essentials = INTAKE_QUESTIONS.filter((question) => question.essential);
  if (!essentials.every((question) => intakeAnswered(question.id, answers))) return false;
  return intakeSignal(answers) >= INTAKE_SIGNAL_FLOOR;
}

// ---------------------------------------------------------------------------
// What Sidequest understands
// ---------------------------------------------------------------------------

export interface UnderstandingLine {
  /** Which question produced it, so pressing the line can reopen that question. */
  id: IntakeQuestionId;
  label: string;
  value: string;
  /**
   * True when Sidequest supplied this rather than the traveller.
   *
   * The brief's word is `[assumed]` and the rule is V6's: an assumption shown as
   * a statement is how a default becomes a fact nobody chose.
   */
  assumed: boolean;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const CLIMATE_WORDS: Record<'warm' | 'mild' | 'cold' | 'any', string> = {
  warm: 'Somewhere warm',
  mild: 'Mild, neither extreme',
  cold: 'Cold and clear',
  any: 'The weather is not the point',
};

const FLIGHT_WORDS: Record<'short' | 'moderate' | 'long' | 'any', string> = {
  short: 'A short flight at most',
  moderate: 'Half a day of travel is fine',
  long: 'A long haul is fine',
  any: 'Distance is not an obstacle',
};

const SCOPE_WORDS: Record<'domestic' | 'international' | 'either', string> = {
  domestic: 'Staying in the country',
  international: 'Leaving the country',
  either: 'Either side of a border',
};

const LODGING_WORDS: Record<'simple' | 'comfortable' | 'refined', string> = {
  simple: 'Simple beds are fine',
  comfortable: 'Comfortable, not fancy',
  refined: 'Somewhere properly nice',
};

const SURPRISE_WORDS: Record<'familiar' | 'open' | 'surprise_me', string> = {
  familiar: 'Somewhere you can picture',
  open: 'Open to being talked into something',
  surprise_me: 'Surprise you',
};

const CROWD_WORDS: Record<'avoid' | 'tolerate' | 'unbothered', string> = {
  avoid: 'Away from the crowds',
  tolerate: 'Busy is survivable',
  unbothered: 'Crowds do not bother you',
};

const INTENSITY_WORDS: Record<'gentle' | 'moderate' | 'strenuous', string> = {
  gentle: 'Gentle days',
  moderate: 'Moderate days',
  strenuous: 'Hard days, on purpose',
};

/**
 * The running summary, in the traveller's terms.
 *
 * One line per answered question, in the order the questions were asked, and
 * every line traceable back to a control. Two rules it holds:
 *
 * - **Nothing appears that nobody said.** An unanswered question produces no
 *   line. The one exception is the party default, which is marked `assumed` and
 *   says so, because a trip is planned for somebody whether or not they said
 *   who.
 * - **No invented precision.** A budget with no figure says the band; a figure
 *   says the figure and whether it was meant to cover getting there.
 */
export function intakeUnderstanding(answers: TripComposerAnswers): UnderstandingLine[] {
  const lines: UnderstandingLine[] = [];
  const push = (id: IntakeQuestionId, label: string, value: string, assumed = false) =>
    lines.push({ id, label, value, assumed });

  const dates = answers.dates;
  if (intakeAnswered('when', answers)) {
    const value =
      dates.mode === 'month' && dates.month
        ? MONTH_NAMES[dates.month - 1]!
        : dates.mode === 'season' && dates.season
          ? `${dates.season[0]!.toUpperCase()}${dates.season.slice(1)}`
          : dates.startDate && dates.endDate
            ? `${dates.startDate} to ${dates.endDate}`
            : dates.startDate
              ? `From ${dates.startDate}`
              : 'Open — any time of year';
    push('when', 'When', dates.mode === 'flexible' ? `${value}, flexible` : value);
  }

  if (answers.duration.mode === 'fixed' && answers.duration.nights) {
    push('length', 'How long', `${answers.duration.nights} nights`);
  } else if (answers.duration.mode === 'range' && answers.duration.minNights && answers.duration.maxNights) {
    push('length', 'How long', `${answers.duration.minNights}–${answers.duration.maxNights} nights`);
  }

  if (answers.themes.length > 0) {
    push('priorities', 'Going for', answers.themes.map((theme) => TRIP_THEME_LABELS[theme]).join(' · '));
  }

  if (answers.origin?.trim()) push('origin', 'Starting from', answers.origin.trim());

  const party =
    answers.children > 0
      ? `${answers.adults} ${answers.adults === 1 ? 'adult' : 'adults'}, ${answers.children} ${answers.children === 1 ? 'child' : 'children'}`
      : `${answers.adults} ${answers.adults === 1 ? 'traveller' : 'travellers'}`;
  push('party', 'Who', party, !intakeAnswered('party', answers));

  if (typeof answers.budgetPerPerson === 'number') {
    const scope = answers.budgetIncludesFlights === undefined
      ? ''
      : answers.budgetIncludesFlights
        ? ', flights included'
        : ', before flights';
    push('budget', 'Budget', `${answers.budgetPerPerson.toLocaleString('en-GB')} per person${scope}`);
  } else if (answers.budget) {
    push('budget', 'Budget', BUDGET_BAND_LABELS[answers.budget]);
  }

  if (answers.outdoorIntensity) push('intensity', 'Effort', INTENSITY_WORDS[answers.outdoorIntensity]);
  if (answers.climatePreference) push('climate', 'Climate', CLIMATE_WORDS[answers.climatePreference]);
  if (answers.flightTolerance) push('flight', 'Getting there', FLIGHT_WORDS[answers.flightTolerance]);
  if (answers.tripScope) push('scope', 'Borders', SCOPE_WORDS[answers.tripScope]);
  if (answers.crowdTolerance) push('crowds', 'Crowds', CROWD_WORDS[answers.crowdTolerance]);
  if (answers.transport) push('transport', 'Getting around', TRANSPORT_INTENT_LABELS[answers.transport]);
  if (answers.shape) push('shape', 'Moving', TRIP_SHAPE_LABELS[answers.shape]);
  if (answers.lodgingComfort) push('lodging', 'Beds', LODGING_WORDS[answers.lodgingComfort]);
  if ((answers.visited ?? []).length > 0) push('visited', 'Already seen', (answers.visited ?? []).join(', '));
  if (answers.surpriseAppetite) push('surprise', 'Appetite', SURPRISE_WORDS[answers.surpriseAppetite]);
  if (answers.avoid?.trim()) push('constraints', 'Ruled out', answers.avoid.trim());

  return lines;
}
