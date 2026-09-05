import { INTEREST_LABELS, type Interest, type InterestLevel } from '../schemas/common';
import { DIETARY_NEED_LABELS } from '../schemas/food';
import { HARD_CONSTRAINT_LABELS, type PreferenceProvenance } from '../schemas/interview';
import type { QuestionnaireAnswers, TravelerProfile } from '../schemas/profile';
import { formatMinuteOfDay } from '../schemas/common';
import type { InterviewContext, InterviewOption, QuestionDefinition } from './catalog';
import type { InterviewPlan } from './selector';

/**
 * THE REVIEW LEDGER: WHAT YOU TOLD US, AND WHAT SIDEQUEST IS ASSUMING.
 *
 * One entry per question in the plan, split by provenance. Explicit answers
 * are "told"; everything else — smart defaults, destination priors, carried
 * composer answers, skips — is "assumed", each with the sentence that
 * explains the assumption. Hard constraints are listed separately because a
 * filter and a preference must not look alike on the screen where the
 * traveller confirms both.
 */

export interface ReviewEntry {
  questionId: string;
  label: string;
  value: string;
  source: PreferenceProvenance['source'];
  strength: PreferenceProvenance['strength'];
  reason?: string;
  tier: InterviewPlan['questions'][number]['tier'];
}

export interface ReviewLedger {
  told: ReviewEntry[];
  assumed: ReviewEntry[];
  hard: { label: string; detail?: string }[];
  /** Questions never put to the traveller that have no value worth showing. */
  unasked: number;
}

const LEVEL_WORD: Record<InterestLevel, string> = {
  avoid: 'skip',
  low: 'only if nearby',
  occasional: 'once or twice',
  frequent: 'a few times',
  core: 'the heart of the trip',
};

function optionLabel(options: readonly InterviewOption[] | undefined, value: unknown): string {
  if (!options) return String(value);
  return options.find((option) => option.value === value)?.label ?? String(value);
}

export function describeAnswer(question: QuestionDefinition, ctx: InterviewContext, answers: QuestionnaireAnswers): string {
  const value = question.read(answers);
  const options = question.options?.(ctx, answers);
  switch (question.kind) {
    case 'interests': {
      const chosen = (Array.isArray(value) ? value : []) as Interest[];
      if (chosen.length === 0) return 'Nothing chosen yet';
      return chosen.map((interest) => `${INTEREST_LABELS[interest]} (${LEVEL_WORD[answers.interests[interest] ?? 'low']})`).join(', ');
    }
    case 'dietary': {
      const record = (value ?? {}) as { needs?: string[]; strict?: boolean };
      if (!record.needs || record.needs.length === 0) return 'Nothing stated';
      return `${record.needs.map((need) => DIETARY_NEED_LABELS[need as keyof typeof DIETARY_NEED_LABELS] ?? need).join(', ')}${record.strict ? ' · requirements, not preferences' : ''}`;
    }
    case 'hard_constraints': {
      const record = (value ?? {}) as { constraints?: { code: string; value?: number; text?: string }[]; notes?: string };
      const parts = (record.constraints ?? []).map((c) => describeHard(c));
      if (record.notes) parts.push(`“${record.notes}” (hard)`);
      return parts.length > 0 ? parts.join(' · ') : 'Nothing off-limits';
    }
    case 'budget': {
      const record = (value ?? {}) as { style?: string; envelope?: { amount: number; currency: string; basis: string } | null };
      const style = optionLabel(options, record.style ?? 'dont_know');
      if (record.envelope) return `${style} · about ${record.envelope.currency} ${record.envelope.amount} ${record.envelope.basis.replace(/_/g, ' ')}`;
      return style;
    }
    case 'names': {
      const record = (value ?? {}) as { include?: string[]; avoid?: string[] };
      const parts: string[] = [];
      if (record.include && record.include.length > 0) parts.push(`must include ${record.include.join(', ')}`);
      if (record.avoid && record.avoid.length > 0) parts.push(`must avoid ${record.avoid.join(', ')}`);
      return parts.length > 0 ? parts.join(' · ') : 'No named places';
    }
    case 'multi': {
      const chosen = Array.isArray(value) ? value : [];
      if (chosen.length === 0) return 'Nothing';
      return chosen.map((v) => optionLabel(options, v)).join(', ');
    }
    case 'text':
      return typeof value === 'string' && value.trim() ? `“${value.trim()}”` : 'Nothing added';
    default:
      return optionLabel(options, value);
  }
}

export function describeHard(constraint: { code: string; value?: number; text?: string }): string {
  const label = HARD_CONSTRAINT_LABELS[constraint.code as keyof typeof HARD_CONSTRAINT_LABELS] ?? constraint.code;
  if (constraint.code === 'must_be_back_by' && constraint.value !== undefined) return `Back at base by ${formatMinuteOfDay(constraint.value)}`;
  if ((constraint.code === 'max_daily_drive_minutes' || constraint.code === 'max_walking_minutes') && constraint.value !== undefined) {
    const h = Math.floor(constraint.value / 60);
    const m = constraint.value % 60;
    return `${label}: ${h > 0 ? `${h} h` : ''}${m > 0 ? ` ${m} min` : ''}`.replace(/\s+/g, ' ').trim();
  }
  if (constraint.text) return `${label}: ${constraint.text}`;
  return label;
}

export function reviewLedger(ctx: InterviewContext, answers: QuestionnaireAnswers, plan: InterviewPlan): ReviewLedger {
  const told: ReviewEntry[] = [];
  const assumed: ReviewEntry[] = [];
  let unasked = 0;
  for (const planned of plan.questions) {
    const question = planned.definition;
    const provenance = answers.provenance[question.id];
    const entry: ReviewEntry = {
      questionId: question.id,
      label: question.prompt(ctx, answers).replace(/[:?]$/, ''),
      value: describeAnswer(question, ctx, answers),
      source: provenance?.source ?? 'smart_default',
      strength: provenance?.strength ?? 'weak',
      ...(provenance?.reason ? { reason: provenance.reason } : {}),
      tier: planned.tier,
    };
    if (provenance?.source === 'explicit') told.push(entry);
    else if (provenance) assumed.push(entry);
    else if (planned.tier !== 'fine_tune' && !planned.hidden) {
      assumed.push({ ...entry, reason: 'Not asked yet — the usual default stands.' });
    } else unasked += 1;
  }
  const hard: { label: string; detail?: string }[] = answers.hardConstraints.map((constraint) => ({ label: describeHard(constraint) }));
  if (answers.dietaryStrict && answers.dietaryNeeds.length > 0) {
    hard.push({ label: `Dietary needs are absolute: ${answers.dietaryNeeds.map((n) => DIETARY_NEED_LABELS[n]).join(', ')}` });
  }
  if (answers.hardNotes) hard.push({ label: `“${answers.hardNotes}”`, detail: 'In your words, marked as a hard requirement' });
  return { told, assumed, hard, unasked };
}

/**
 * The trip in one sentence, and qualitative strength bars instead of numbers
 * pretending to be measurements.
 */
export interface PersonalityBar {
  id: string;
  label: string;
  level: 'off' | 'low' | 'medium' | 'high';
  hint: string;
}

const LEVEL_RANK: Record<InterestLevel, number> = { avoid: 0, low: 1, occasional: 2, frequent: 3, core: 4 };

export function personalityBars(profile: TravelerProfile): PersonalityBar[] {
  const groups: { id: string; label: string; interests: Interest[] }[] = [
    { id: 'outdoors', label: 'Outdoors', interests: ['hiking', 'easy_nature_walks', 'lakes_and_rivers', 'wildlife'] },
    { id: 'scenery', label: 'Scenery', interests: ['scenic_viewpoints', 'scenic_drives', 'photography_golden_hour', 'stargazing'] },
    { id: 'culture', label: 'Culture', interests: ['history_and_culture', 'museums_and_galleries', 'architecture_and_landmarks'] },
    { id: 'city_life', label: 'City life', interests: ['neighbourhoods_and_local_life', 'markets_and_street_food'] },
    { id: 'food', label: 'Food', interests: ['food_and_towns', 'markets_and_street_food'] },
    { id: 'water', label: 'Coast & water', interests: ['beaches_and_swimming', 'hot_springs', 'geology_and_geothermal'] },
  ];
  return groups
    .map((group) => {
      const best = Math.max(...group.interests.map((interest) => LEVEL_RANK[profile.interests[interest] ?? 'low']));
      const level: PersonalityBar['level'] = best >= 4 ? 'high' : best === 3 ? 'medium' : best === 2 ? 'low' : 'off';
      const hint = level === 'high' ? 'the heart of the trip' : level === 'medium' ? 'a few times' : level === 'low' ? 'once or twice' : 'only if it is right there';
      return { id: group.id, label: group.label, level, hint };
    })
    .sort((a, b) => ['high', 'medium', 'low', 'off'].indexOf(a.level) - ['high', 'medium', 'low', 'off'].indexOf(b.level) || a.label.localeCompare(b.label));
}

export function personalitySentence(ctx: InterviewContext, profile: TravelerProfile): string {
  const bars = personalityBars(profile);
  const lead = bars[0] && bars[0].level !== 'off' ? bars[0].label.toLowerCase() : 'open-ended';
  const pace = profile.pace === 'slow' ? 'a slow' : profile.pace === 'fast' ? 'a full' : 'a balanced';
  const movement = profile.transport.willDrive
    ? 'with a car'
    : profile.interview.guideWillingness === 'prefer'
      ? 'guided where it counts'
      : 'without a car';
  const mix = profile.discoveryMix === 'mostly_classics' ? 'headline-first' : profile.discoveryMix === 'balanced' ? 'a mix of famous and quiet' : 'hidden-gem leaning';
  const bases = profile.interview.baseMoveTolerance === 'stay_put' ? 'from one base' : profile.interview.baseMoveTolerance === 'move_freely' ? 'moving with the route' : profile.interview.baseMoveTolerance === 'move_once' ? 'with one hotel change if it earns it' : 'moving only when it saves real time';
  return `A ${lead}-led, ${mix} trip to ${ctx.destination.proseName}: ${pace} pace over ${ctx.destination.tripDays} ${ctx.destination.tripDays === 1 ? 'day' : 'days'}, ${movement}, ${bases}.`;
}
