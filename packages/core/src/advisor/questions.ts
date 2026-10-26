import type { TripComposerAnswers } from '../schemas/composer';
import type { CatalogDestination, WorldRegion } from './catalog/schema';
import { FOCUS_KEYS, FOCUS_LABELS, emptyAdvisorAnswers, type AdvisorAnswers, type FocusKey } from './answers';
import { rankCatalog } from './advise';
import { focusOf } from './profile';
import { selectShortlist } from './select';

/**
 * THE DESTINATION INTERVIEW: ASK WHAT WOULD CHANGE THE ANSWER, THEN STOP.
 *
 * Every question here is a set of options, and every option is a pure patch on
 * the answers. That makes the value of asking computable: apply each option,
 * rebuild the shortlist, and measure how far it moves from the current one.
 *
 *     value(q) = Σ_o P(o) · distance(shortlist now, shortlist if o) / effort(q)
 *
 * — the expected change in the decision, a decision-focused form of value of
 * information (Chajewska et al. 2000; Viappiani & Boutilier 2010). "Do you like
 * nature?" scores near zero for a traveller already choosing between Norway and
 * Tanzania because every answer leaves the list where it was; "safari, alpine
 * trekking or reefs?" scores high because each answer sends it somewhere else.
 *
 * Three honesty rules:
 *
 * - **The answer priors are explicit** (`prior` on each option) and tested,
 *   because the value is only as good as them. Most are uniform; a "restrict
 *   the world" question puts half its mass on "anywhere", which is the answer
 *   most people give.
 * - **A skip is no information.** A skipped question is never asked again and
 *   changes nothing.
 * - **Stopping is measured, not counted.** Once the two essentials are settled
 *   the interview stops when no remaining question is expected to move the
 *   list by more than `STOP_BELOW`, or after `MAX_FOLLOW_UPS` — whichever is
 *   first. The traveller can stop it sooner at any point.
 */

export type QuestionId =
  | 'focus'
  | 'lead'
  | 'when'
  | 'adventure'
  | 'length'
  | 'budget'
  | 'reach'
  | 'party'
  | 'getting_around'
  | 'crowds'
  | 'novelty'
  | 'climate'
  | 'wildlife_kind'
  | 'mountain_style'
  | 'swim'
  | 'region';

export interface QuestionOption {
  id: string;
  label: string;
  hint?: string;
  /** How likely a traveller is to give this answer, before we know anything. */
  prior: number;
  apply: (answers: TripComposerAnswers) => TripComposerAnswers;
}

export interface AdvisorQuestion {
  id: QuestionId;
  prompt: string;
  /** One line on what the answer changes. Shown under the question. */
  why: string;
  select: 'one' | 'many';
  /** Taps cost 1; a multi-select costs more; typing more still. */
  effort: number;
  essential: boolean;
  options: (answers: TripComposerAnswers) => QuestionOption[];
  applies: (answers: TripComposerAnswers) => boolean;
  answered: (answers: TripComposerAnswers) => boolean;
}

export const STOP_BELOW = 0.18;
export const MAX_FOLLOW_UPS = 5;
const COMPARE_DEPTH = 6;

function discovery(answers: TripComposerAnswers): AdvisorAnswers {
  return answers.discovery ?? emptyAdvisorAnswers();
}

function withDiscovery(answers: TripComposerAnswers, patch: Partial<AdvisorAnswers>): TripComposerAnswers {
  return { ...answers, discovery: { ...discovery(answers), ...patch } };
}

function asked(answers: TripComposerAnswers, id: QuestionId): boolean {
  return discovery(answers).asked.includes(id) || answers.skipped.includes(`advisor:${id}`);
}

/** Records that a question was put, whatever the answer. */
export function markAdvisorAsked(answers: TripComposerAnswers, id: QuestionId): TripComposerAnswers {
  const current = discovery(answers);
  if (current.asked.includes(id)) return answers;
  return withDiscovery(answers, { asked: [...current.asked, id] });
}

export function skipAdvisorQuestion(answers: TripComposerAnswers, id: QuestionId): TripComposerAnswers {
  return markAdvisorAsked(answers, id);
}

const one = (id: string, label: string, prior: number, apply: QuestionOption['apply'], hint?: string): QuestionOption => ({ id, label, prior, apply, ...(hint ? { hint } : {}) });

const REGION_GROUPS: Record<string, WorldRegion[]> = {
  europe: ['northern_europe', 'western_europe', 'southern_europe', 'central_eastern_europe'],
  americas: ['north_america_west', 'north_america_east', 'north_america_north', 'mexico_central_america', 'caribbean', 'south_america_north', 'south_america_south'],
  asia: ['caucasus_central_asia', 'middle_east', 'south_asia', 'southeast_asia', 'east_asia'],
  africa: ['north_africa', 'east_africa', 'southern_africa', 'west_central_africa', 'indian_ocean'],
  oceania: ['oceania', 'pacific_islands'],
};
export const REGION_GROUP_LABELS: Record<string, string> = { europe: 'Europe', americas: 'The Americas', asia: 'Asia & the Middle East', africa: 'Africa & Indian Ocean', oceania: 'Australia, NZ & Pacific' };
export { REGION_GROUPS };

const SEASON_OPTIONS: [string, string, TripComposerAnswers['dates']][] = [
  ['summer', 'June to August', { mode: 'season', season: 'summer', wantsRecommendation: false }],
  ['autumn', 'September to November', { mode: 'season', season: 'autumn', wantsRecommendation: false }],
  ['winter', 'December to February', { mode: 'season', season: 'winter', wantsRecommendation: false }],
  ['spring', 'March to May', { mode: 'season', season: 'spring', wantsRecommendation: false }],
];

export const ADVISOR_QUESTIONS: readonly AdvisorQuestion[] = [
  {
    id: 'focus',
    prompt: 'What do you want the trip to be about?',
    why: 'This decides which corners of the world are even in the running.',
    select: 'many',
    effort: 1.4,
    essential: true,
    options: () =>
      FOCUS_KEYS.map((key) =>
        one(key, FOCUS_LABELS[key], 1 / FOCUS_KEYS.length, (answers) => withDiscovery(answers, { focus: [key], focusRanked: false })),
      ),
    applies: () => true,
    answered: (answers) => focusOf(answers).length > 0,
  },
  {
    id: 'lead',
    prompt: 'If the trip could only be brilliant at one of these, which?',
    why: 'Places that do all of it are rare. Knowing what leads stops us averaging your interests into somewhere that is fine at everything.',
    select: 'one',
    effort: 1,
    essential: false,
    options: (answers) => {
      const focus = focusOf(answers);
      return focus.map((key) =>
        one(key, FOCUS_LABELS[key], 1 / focus.length, (a) => withDiscovery(a, { focus: [key, ...focusOf(a).filter((other) => other !== key)], focusRanked: true })),
      );
    },
    applies: (answers) => focusOf(answers).length >= 2,
    answered: (answers) => discovery(answers).focusRanked === true,
  },
  {
    id: 'when',
    prompt: 'When could you go?',
    why: 'Half the world is in the wrong season at any moment.',
    select: 'one',
    effort: 1,
    essential: true,
    options: () => [
      ...SEASON_OPTIONS.map(([id, label, dates]) => one(id, label, 0.2, (a) => ({ ...a, dates }))),
      one('open', 'I’m flexible', 0.2, (a) => ({ ...a, dates: { mode: 'flexible', wantsRecommendation: true } })),
    ],
    applies: () => true,
    answered: (answers) =>
      (answers.dates.mode === 'season' && Boolean(answers.dates.season)) ||
      (answers.dates.mode === 'month' && Boolean(answers.dates.month)) ||
      (answers.dates.mode === 'months' && Boolean(answers.dates.months?.length)) ||
      Boolean(answers.dates.startDate) ||
      (answers.dates.mode === 'flexible' && answers.dates.wantsRecommendation === true),
  },
  {
    id: 'adventure',
    prompt: 'How adventurous?',
    why: 'The same mountains can be a lakeside hotel or a week between huts.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('comfortable', 'Comfortable and easy', 0.25, (a) => withDiscovery({ ...a, outdoorIntensity: 'gentle' }, { adventure: 'comfortable' }), 'Good roads, short walks, nice beds'),
      one('active', 'Active, a few big days', 0.35, (a) => withDiscovery({ ...a, outdoorIntensity: 'moderate' }, { adventure: 'active' }), 'Full-day hikes, comfortable nights'),
      one('rugged', 'Rugged and remote', 0.25, (a) => withDiscovery({ ...a, outdoorIntensity: 'strenuous' }, { adventure: 'rugged' }), 'Long days, simple places, few people'),
      one('expedition', 'Expedition-style', 0.15, (a) => withDiscovery({ ...a, outdoorIntensity: 'strenuous' }, { adventure: 'expedition' }), 'Multi-day treks, altitude, camps'),
    ],
    applies: () => true,
    answered: (answers) => Boolean(discovery(answers).adventure) || Boolean(answers.outdoorIntensity),
  },
  {
    id: 'length',
    prompt: 'How long have you got?',
    why: 'A weekend and three weeks point at different continents.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('short', 'A long weekend', 0.15, (a) => ({ ...a, duration: { mode: 'range', minNights: 2, maxNights: 4, wantsRecommendation: false } })),
      one('week', 'About a week', 0.35, (a) => ({ ...a, duration: { mode: 'range', minNights: 5, maxNights: 8, wantsRecommendation: false } })),
      one('two_weeks', 'Around two weeks', 0.3, (a) => ({ ...a, duration: { mode: 'range', minNights: 10, maxNights: 15, wantsRecommendation: false } })),
      one('long', 'Several weeks', 0.1, (a) => ({ ...a, duration: { mode: 'range', minNights: 18, maxNights: 28, wantsRecommendation: false } })),
      one('flexible', 'Flexible', 0.1, (a) => ({ ...a, duration: { mode: 'unknown', wantsRecommendation: true } })),
    ],
    applies: () => true,
    answered: (answers) => answers.duration.mode !== 'unknown' || answers.duration.wantsRecommendation === true,
  },
  {
    id: 'budget',
    prompt: 'What kind of budget?',
    why: 'Norway and Kyrgyzstan both have mountains. They do not cost the same.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('budget', 'Budget-conscious', 0.25, (a) => ({ ...a, budget: 'budget' })),
      one('mid_range', 'Moderate', 0.35, (a) => ({ ...a, budget: 'mid_range' })),
      one('premium', 'Comfortable', 0.25, (a) => ({ ...a, budget: 'premium' })),
      one('luxury', 'Luxury', 0.08, (a) => ({ ...a, budget: 'luxury' })),
      one('unstated', 'Flexible', 0.07, (a) => ({ ...a, budget: 'unstated' })),
    ],
    applies: () => true,
    answered: (answers) => Boolean(answers.budget),
  },
  {
    id: 'reach',
    prompt: 'How far will you go?',
    why: 'Decides whether the other side of the world is on the table.',
    select: 'one',
    effort: 1.2,
    essential: false,
    options: () => [
      one('short', 'Close to home', 0.25, (a) => ({ ...a, flightTolerance: 'short' }), 'A short flight or a drive'),
      one('moderate', 'Within my wider region', 0.3, (a) => ({ ...a, flightTolerance: 'moderate' })),
      one('long', 'A long-haul flight is fine', 0.2, (a) => ({ ...a, flightTolerance: 'long' })),
      one('any', 'Anywhere', 0.25, (a) => ({ ...a, flightTolerance: 'any' })),
    ],
    applies: () => true,
    answered: (answers) => Boolean(answers.flightTolerance) || Boolean(discovery(answers).regions?.length) || Boolean(discovery(answers).countries?.length),
  },
  {
    id: 'party',
    prompt: 'Who’s going?',
    why: 'Children, older travellers and limited mobility each rule places in or out.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('adults', 'Just adults', 0.65, (a) => ({ ...a, children: 0 })),
      one('kids', 'With children', 0.2, (a) => ({ ...a, children: Math.max(1, a.children), travelerNeeds: [...new Set([...a.travelerNeeds, 'kids_under_12' as const])] })),
      one('older', 'Older travellers', 0.1, (a) => ({ ...a, travelerNeeds: [...new Set([...a.travelerNeeds, 'seniors_in_group' as const])] })),
      one('mobility', 'Someone with limited mobility', 0.05, (a) => ({ ...a, travelerNeeds: [...new Set([...a.travelerNeeds, 'mobility_limited' as const])] })),
    ],
    applies: () => true,
    answered: (answers) => answers.children > 0 || answers.travelerNeeds.length > 0,
  },
  {
    id: 'getting_around',
    prompt: 'Happy to drive?',
    why: 'Some of the best wild places are a road trip; others are a train ride.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('drive', 'Yes, happy to drive', 0.55, (a) => ({ ...a, transport: 'drive' })),
      one('no_car', 'Rather not', 0.3, (a) => ({ ...a, transport: 'public_transport' })),
      one('either', 'Either way', 0.15, (a) => ({ ...a, transport: 'undecided' })),
    ],
    applies: () => true,
    answered: (answers) => Boolean(answers.transport),
  },
  {
    id: 'crowds',
    prompt: 'Crowds?',
    why: 'Some famous places are famous for a reason; some have quieter equals.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('avoid', 'I’d rather avoid them', 0.55, (a) => ({ ...a, crowdTolerance: 'avoid' })),
      one('tolerate', 'Don’t mind', 0.45, (a) => ({ ...a, crowdTolerance: 'tolerate' })),
    ],
    applies: () => true,
    answered: (answers) => Boolean(answers.crowdTolerance),
  },
  {
    id: 'novelty',
    prompt: 'Classic or unexpected?',
    why: 'We never favour a place for being famous — or for being obscure — unless you ask.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('familiar', 'Proven classics', 0.3, (a) => ({ ...a, surpriseAppetite: 'familiar' })),
      one('open', 'A mix', 0.4, (a) => ({ ...a, surpriseAppetite: 'open' })),
      one('surprise_me', 'Somewhere I’d never think of', 0.3, (a) => ({ ...a, surpriseAppetite: 'surprise_me' })),
    ],
    applies: () => true,
    answered: (answers) => Boolean(answers.surpriseAppetite),
  },
  {
    id: 'climate',
    prompt: 'What temperature suits you?',
    why: 'Separates a hot-weather trip from a cool-mountain one in the same month.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('warm', 'Warm to hot', 0.35, (a) => ({ ...a, climatePreference: 'warm' })),
      one('mild', 'Mild', 0.4, (a) => ({ ...a, climatePreference: 'mild' })),
      one('cold', 'Cool and fresh', 0.15, (a) => ({ ...a, climatePreference: 'cold' })),
      one('any', 'Don’t mind', 0.1, (a) => ({ ...a, climatePreference: 'any' })),
    ],
    applies: () => true,
    answered: (answers) => Boolean(answers.climatePreference),
  },
  {
    id: 'wildlife_kind',
    prompt: 'What kind of wildlife?',
    why: 'Lions, whales and puffins live in very different places.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('safari', 'Big animals on safari', 0.35, (a) => withDiscovery(a, { wildlifeKind: 'safari' })),
      one('marine', 'Whales, seals, reefs', 0.25, (a) => withDiscovery(a, { wildlifeKind: 'marine' })),
      one('birds', 'Birds', 0.1, (a) => withDiscovery(a, { wildlifeKind: 'birds' })),
      one('any', 'Whatever’s there', 0.3, (a) => withDiscovery(a, { wildlifeKind: 'any' })),
    ],
    applies: (answers) => focusOf(answers).includes('wildlife'),
    answered: (answers) => Boolean(discovery(answers).wildlifeKind),
  },
  {
    id: 'mountain_style',
    prompt: 'How do you like your mountains?',
    why: 'Day hikes from a village, hut-to-hut, or high altitude are three different trips.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('base_day_hikes', 'Day hikes from a base', 0.5, (a) => withDiscovery(a, { mountainStyle: 'base_day_hikes' })),
      one('hut_to_hut', 'Hut-to-hut, several days', 0.3, (a) => withDiscovery(a, { mountainStyle: 'hut_to_hut' })),
      one('high_altitude', 'High and wild', 0.2, (a) => withDiscovery(a, { mountainStyle: 'high_altitude' })),
    ],
    applies: (answers) => focusOf(answers).includes('mountains'),
    answered: (answers) => Boolean(discovery(answers).mountainStyle),
  },
  {
    id: 'swim',
    prompt: 'Where do you want to swim?',
    why: 'A warm sea and a cold mountain lake rarely share a postcode.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('warm_sea', 'A warm sea', 0.45, (a) => withDiscovery(a, { swimStyle: 'warm_sea' })),
      one('lakes', 'Lakes and rivers', 0.25, (a) => withDiscovery(a, { swimStyle: 'lakes' })),
      one('either', 'Either', 0.3, (a) => withDiscovery(a, { swimStyle: 'either' })),
    ],
    applies: (answers) => {
      const focus = focusOf(answers);
      return focus.includes('beaches') || focus.includes('lakes');
    },
    answered: (answers) => Boolean(discovery(answers).swimStyle),
  },
  {
    id: 'region',
    prompt: 'Anywhere in particular?',
    why: 'Only if you already have a part of the world in mind.',
    select: 'one',
    effort: 1,
    essential: false,
    options: () => [
      one('anywhere', 'Anywhere', 0.7, (a) => withDiscovery(a, { regions: undefined })),
      ...Object.entries(REGION_GROUPS).map(([id, regions]) => one(id, REGION_GROUP_LABELS[id]!, 0.06, (a) => withDiscovery(a, { regions }))),
    ],
    applies: () => true,
    answered: (answers) => Boolean(discovery(answers).regions?.length) || Boolean(discovery(answers).countries?.length),
  },
];

export function advisorQuestionById(id: string): AdvisorQuestion | null {
  return ADVISOR_QUESTIONS.find((question) => question.id === id) ?? null;
}

/** The shortlist a set of answers produces, as ordered ids — what a question's value is measured against. */
export function shortlistIds(answers: TripComposerAnswers, catalog: readonly CatalogDestination[]): string[] {
  const { profile, ranked } = rankCatalog(answers, catalog);
  const selection = selectShortlist(ranked, profile);
  return [...selection.picks, ...selection.alternates].map((scored) => scored.destination.id).slice(0, COMPARE_DEPTH);
}

/**
 * How different two shortlists are, 0 (same) … 1 (nothing shared). The first
 * three places weigh double: that is what the traveller reads.
 */
export function shortlistDistance(a: readonly string[], b: readonly string[]): number {
  let total = 0;
  let shared = 0;
  for (let index = 0; index < Math.max(a.length, b.length, 1); index += 1) {
    const weight = index < 3 ? 2 : 1;
    total += weight;
    if (a[index] !== undefined && b.includes(a[index]!)) shared += weight;
  }
  if (a.length === 0 && b.length === 0) return 0;
  return 1 - shared / total;
}

export interface QuestionValue {
  id: QuestionId;
  value: number;
}

export interface NextStep {
  question: AdvisorQuestion | null;
  /** True when we can recommend responsibly: the essentials are settled. */
  ready: boolean;
  /** Why the interview stopped, when it did. */
  stopReason: 'essentials_missing' | 'asking' | 'low_value' | 'enough_asked' | 'nothing_left';
  values: QuestionValue[];
  followUpsAsked: number;
  current: string[];
}

export function nextQuestion(answers: TripComposerAnswers, catalog: readonly CatalogDestination[]): NextStep {
  const open = ADVISOR_QUESTIONS.filter((question) => question.applies(answers) && !question.answered(answers) && !asked(answers, question.id));
  const essential = open.find((question) => question.essential);
  const current = shortlistIds(answers, catalog);
  const followUpsAsked = discovery(answers).asked.filter((id) => !ADVISOR_QUESTIONS.find((question) => question.id === id)?.essential).length;
  if (essential) return { question: essential, ready: false, stopReason: 'essentials_missing', values: [], followUpsAsked, current };

  const values: QuestionValue[] = open.map((question) => {
    const options = question.options(answers);
    const priorTotal = options.reduce((sum, option) => sum + option.prior, 0) || 1;
    let expected = 0;
    for (const option of options) {
      const ids = shortlistIds(option.apply(answers), catalog);
      expected += (option.prior / priorTotal) * shortlistDistance(current, ids);
    }
    return { id: question.id, value: expected / question.effort };
  });
  values.sort((a, b) => b.value - a.value || ADVISOR_QUESTIONS.findIndex((q) => q.id === a.id) - ADVISOR_QUESTIONS.findIndex((q) => q.id === b.id));

  if (values.length === 0) return { question: null, ready: true, stopReason: 'nothing_left', values, followUpsAsked, current };
  if (followUpsAsked >= MAX_FOLLOW_UPS) return { question: null, ready: true, stopReason: 'enough_asked', values, followUpsAsked, current };
  if (values[0]!.value < STOP_BELOW) return { question: null, ready: true, stopReason: 'low_value', values, followUpsAsked, current };
  return { question: advisorQuestionById(values[0]!.id), ready: true, stopReason: 'asking', values, followUpsAsked, current };
}

/** Applies one or several options of a question and records that it was asked. */
export function answerAdvisorQuestion(answers: TripComposerAnswers, id: QuestionId, optionIds: readonly string[]): TripComposerAnswers {
  const question = advisorQuestionById(id);
  if (!question) return answers;
  let next = answers;
  if (id === 'focus') {
    const keys = optionIds.filter((option): option is FocusKey => (FOCUS_KEYS as readonly string[]).includes(option));
    next = withDiscovery(next, { focus: keys, focusRanked: keys.length <= 1 });
  } else {
    for (const option of question.options(answers)) if (optionIds.includes(option.id)) next = option.apply(next);
  }
  return markAdvisorAsked(next, id);
}
