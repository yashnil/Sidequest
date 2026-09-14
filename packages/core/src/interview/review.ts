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
    case 'interest_roles': {
      const record = (value ?? {}) as Record<string, string>;
      const entries = Object.keys(record) as Interest[];
      if (entries.length === 0) return 'Nothing chosen yet';
      return entries.map((interest) => `${INTEREST_LABELS[interest]}: ${LEVEL_WORD[answers.interests[interest] ?? 'low']}`).join(' · ');
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
    hard.push({ label: `Dietary needs are absolute: ${answers.dietaryNeeds.map((n) => DIETARY_NEED_LABELS[n]).join(', ')}`, ...(answers.dietaryNotes ? { detail: answers.dietaryNotes } : {}) });
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

// ---------------------------------------------------------------------------
// The review, in one glance
// ---------------------------------------------------------------------------

/**
 * WHAT THE TRAVELLER SEES BEFORE THEY PRESS BUILD.
 *
 * MVP V3, Stage 39. What this replaces: two columns of every question in the
 * plan, each a label, a value and a "Change" link — a database listing of
 * fifteen rows, presented as the moment somebody confirms their holiday. It was
 * correct and unreadable, and the founder's word for it was "administrative".
 *
 * A glance is six or seven groups, each one a *statement about the trip* rather
 * than a question and its answer, each with one place to go and change it. The
 * per-question ledger is not deleted — it is the thing that makes the product
 * checkable — it moves behind one disclosure.
 *
 * Grouping lives here rather than in the component for the same reason the
 * ledger does: it is a claim about what matters, and a claim is testable.
 */
export interface ReviewGlanceGroup {
  id: string;
  title: string;
  /** Short statements, in the traveller's register. Never "question: answer". */
  lines: { text: string; assumed: boolean }[];
  /** The question this group opens when the traveller presses Edit. */
  editQuestionId: string;
}

const GLANCE_GROUPS: { id: string; title: string; questions: string[] }[] = [
  { id: 'shape', title: 'The trip', questions: ['coverage_strategy', 'base_moves', 'transport_mode', 'day_trips'] },
  { id: 'priorities', title: 'You care most about', questions: ['priorities', 'priority_roles'] },
  { id: 'feel', title: 'How it should feel', questions: ['day_shape', 'day_start', 'effort', 'walking_tolerance', 'free_time', 'late_nights'] },
  { id: 'outdoors', title: 'On the trail', questions: ['hike_appetite', 'trail_setting', 'altitude_comfort', 'permit_activities'] },
  { id: 'choices', title: 'What wins a tie', questions: ['iconic_crowds', 'famous_vs_hidden', 'convenience_spend', 'budget'] },
  { id: 'food', title: 'Food', questions: ['food_tradeoff', 'dietary', 'breakfast', 'special_meals'] },
  { id: 'stay', title: 'Where you sleep', questions: ['lodging_style', 'rustic_lodging'] },
];

/**
 * The glance, built from the same ledger the disclosure shows.
 *
 * A group appears only when something in it has been settled; a group whose
 * every line is Sidequest's own read still appears, marked, because "we assumed
 * all of this" is exactly what a traveller needs to see before they build.
 */
/** "Nothing stated", "None", "Nothing off-limits" — an absence, not a statement about the trip. */
const SAYS_NOTHING = /^(nothing|none)\b/i;

/** Two answers that say the same thing in different words still say it once. */
function overlapping(a: string, b: string): boolean {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((word) => word.length > 3);
  const first = new Set(key(a));
  const second = key(b);
  if (first.size === 0 || second.length === 0) return false;
  const shared = second.filter((word) => first.has(word)).length;
  return shared / second.length > 0.6;
}

/**
 * V11 §H — WHAT WILL SHAPE THE ROUTE, AND WHAT WAS MERELY DECIDED.
 *
 * The review screen showed every glance group as an equal card, so a traveller
 * about to press the one button the whole interview exists for read seven cards
 * of which three were Sidequest's own defaults for questions they never saw. §H
 * asks for "only genuinely consequential decisions", and the honest
 * discrimination is not about the *topic* — food matters enormously on some
 * trips — it is about who decided.
 *
 * A group with at least one answer the traveller actually gave is consequential:
 * they said it, it binds the plan, and it belongs on the screen where they check
 * it. A group where every line is our own read is still true, still reachable in
 * the ledger below, and is reported as a **count** rather than as a card —
 * "Sidequest also decided 3 things you did not answer" — which is the one
 * sentence that makes them worth opening.
 *
 * Deliberately not a hand-written list of "important" groups: that would be a
 * claim about what matters to a traveller we have never met, and it would go
 * stale the moment a question is added.
 */
export interface ReviewShapers {
  /** Groups carrying at least one answer the traveller gave. */
  groups: ReviewGlanceGroup[];
  /** Group titles where every line is Sidequest's own read. Counted, never carded. */
  decidedForYou: string[];
}

export function reviewShapers(ledger: ReviewLedger): ReviewShapers {
  const groups: ReviewGlanceGroup[] = [];
  const decidedForYou: string[] = [];
  for (const group of reviewGlance(ledger)) {
    if (group.lines.some((line) => !line.assumed)) groups.push(group);
    else decidedForYou.push(group.title);
  }
  return { groups, decidedForYou };
}

export function reviewGlance(ledger: ReviewLedger): ReviewGlanceGroup[] {
  const byId = new Map<string, ReviewEntry>();
  for (const entry of [...ledger.told, ...ledger.assumed]) byId.set(entry.questionId, entry);
  const groups: ReviewGlanceGroup[] = [];
  for (const group of GLANCE_GROUPS) {
    const lines: ReviewGlanceGroup['lines'] = [];
    let anchor: string | null = null;
    for (const questionId of group.questions) {
      const entry = byId.get(questionId);
      if (!entry) continue;
      anchor ??= questionId;
      /*
       * An absence is not a statement. "Nothing stated" under Food reads on a
       * glance as though the traveller decided something, and the glance is the
       * screen where every line is supposed to be a decision.
       */
      if (SAYS_NOTHING.test(entry.value.trim())) continue;
      /*
       * `priorities` and `priority_roles` are the same three interests written
       * twice — once as "a few times" in brackets, once as "a few times" after a
       * colon. Two renderings of one answer is what made the first version of
       * this screen read like a database.
       */
      if (lines.some((line) => overlapping(line.text, entry.value))) continue;
      lines.push({ text: entry.value, assumed: entry.source !== 'explicit' });
    }
    if (lines.length === 0 || !anchor) continue;
    groups.push({ id: group.id, title: group.title, lines: lines.slice(0, 2), editQuestionId: anchor });
  }
  return groups;
}
