import type { InterviewLog, InterviewMode, PreferenceProvenance } from '../schemas/interview';
import type { QuestionnaireAnswers } from '../schemas/profile';
import type { QuestionnaireContext } from '../questionnaire/definition';
import { normalizeAnswers } from '../questionnaire/transform';
import type { InterviewContext, QuestionDefinition, SmartDefault } from './catalog';
import { planInterview, type InterviewPlan } from './selector';
import type { DestinationQuestionContext } from './traits';

/**
 * INTERVIEW STATE TRANSITIONS.
 *
 * The answers are the durable artifact; these functions are the only writers
 * of `answers.provenance` and `answers.interview`. Every transition ends in
 * `normalizeAnswers`, so a hard constraint chosen on one screen has already
 * landed on the legacy fields by the time the next screen renders.
 */

export function questionnaireContextOf(ctx: InterviewContext, region?: QuestionnaireContext['region']): QuestionnaireContext {
  return {
    travelerNeeds: [...ctx.traveller.travelerNeeds],
    tripDays: ctx.traveller.tripDays,
    offeredInterests: ctx.traveller.offeredInterests,
    ...(region ? { region } : {}),
  };
}

function emptyLog(mode: InterviewMode = 'normal'): InterviewLog {
  return { mode, asked: [], answered: [], decided: [], skipped: [], branchReasons: {} };
}

function logOf(answers: QuestionnaireAnswers): InterviewLog {
  return answers.interview ?? emptyLog();
}

function without(list: readonly string[], id: string): string[] {
  return list.filter((entry) => entry !== id);
}

function stamp(answers: QuestionnaireAnswers, id: string, provenance: PreferenceProvenance): QuestionnaireAnswers {
  return { ...answers, provenance: { ...answers.provenance, [id]: provenance } };
}

/** Record that a question was shown, so analytics can count what was asked versus available. */
export function markAsked(answers: QuestionnaireAnswers, id: string): QuestionnaireAnswers {
  const log = logOf(answers);
  if (log.asked.includes(id)) return answers;
  return { ...answers, interview: { ...log, asked: [...log.asked, id] } };
}

export function withScreening(answers: QuestionnaireAnswers, destination: DestinationQuestionContext, mode?: InterviewMode): QuestionnaireAnswers {
  const log = logOf(answers);
  return {
    ...answers,
    interview: {
      ...log,
      ...(mode ? { mode } : {}),
      screening: { traits: [...destination.traits], basis: { ...(destination.basis as Record<string, string>) }, evidence: destination.evidence },
    },
  };
}

export function withPosition(answers: QuestionnaireAnswers, id: string | undefined): QuestionnaireAnswers {
  const log = logOf(answers);
  return { ...answers, interview: { ...log, ...(id ? { position: id } : {}) } };
}

export function withMode(answers: QuestionnaireAnswers, mode: InterviewMode): QuestionnaireAnswers {
  return { ...answers, interview: { ...logOf(answers), mode } };
}

/** The traveller answered. Explicit, full confidence, and the hard flag when the answer is a "cannot". */
export function answerQuestion(input: {
  answers: QuestionnaireAnswers;
  ctx: InterviewContext;
  question: QuestionDefinition;
  value: unknown;
  /**
   * MVP V3 — the traveller's own words beside the option they picked.
   *
   * Stored under the question's id and rendered verbatim in the brief. Never
   * parsed into a setting: an inferred preference is one nobody chose, and the
   * whole reason this field exists is that the enum could not hold what they
   * said.
   */
  note?: string;
  now: Date;
  region?: QuestionnaireContext['region'];
}): QuestionnaireAnswers {
  const { answers, ctx, question, value, now } = input;
  const patch = question.apply(value, answers, ctx);
  const note = input.note?.trim().slice(0, 300) ?? '';
  const notes = { ...(answers.preferenceNotes ?? {}) };
  if (note) notes[question.id] = note;
  else delete notes[question.id];
  const hard = question.hardCapable && isHardValue(value);
  const log = logOf(answers);
  const next: QuestionnaireAnswers = {
    ...answers,
    ...patch,
    preferenceNotes: notes,
    interview: {
      ...log,
      asked: log.asked.includes(question.id) ? log.asked : [...log.asked, question.id],
      answered: log.answered.includes(question.id) ? log.answered : [...log.answered, question.id],
      decided: without(log.decided, question.id),
      skipped: without(log.skipped, question.id),
    },
  };
  return normalizeAnswers(
    stamp(next, question.id, { source: 'explicit', strength: hard || note.length > 0 ? (hard ? 'hard' : 'strong') : 'strong', confidence: 1, at: now.toISOString() }),
    questionnaireContextOf(ctx, input.region),
  );
}

function isHardValue(value: unknown): boolean {
  if (value === 'cannot' || value === 'avoid_high') return true;
  if (value && typeof value === 'object') {
    const record = value as { constraints?: unknown; strict?: unknown; include?: unknown; avoid?: unknown; notesAreHard?: unknown };
    if (Array.isArray(record.constraints) && record.constraints.length > 0) return true;
    if (record.strict === true) return true;
    if (record.notesAreHard === true) return true;
    if ((Array.isArray(record.include) && record.include.length > 0) || (Array.isArray(record.avoid) && record.avoid.length > 0)) return true;
  }
  return false;
}

/** "Decide this for me": the question's own smart default, recorded as such with its reason. */
export function decideQuestion(input: {
  answers: QuestionnaireAnswers;
  ctx: InterviewContext;
  question: QuestionDefinition;
  now: Date;
  region?: QuestionnaireContext['region'];
}): { answers: QuestionnaireAnswers; decision: SmartDefault } {
  const { answers, ctx, question, now } = input;
  const decision = question.smartDefault(ctx, answers);
  const patch = question.apply(decision.value, answers, ctx);
  const log = logOf(answers);
  const next: QuestionnaireAnswers = {
    ...answers,
    ...patch,
    interview: {
      ...log,
      asked: log.asked.includes(question.id) ? log.asked : [...log.asked, question.id],
      answered: without(log.answered, question.id),
      decided: log.decided.includes(question.id) ? log.decided : [...log.decided, question.id],
      skipped: without(log.skipped, question.id),
    },
  };
  return {
    answers: normalizeAnswers(
      stamp(next, question.id, { source: decision.source, strength: 'weak', confidence: decision.source === 'destination_prior' ? 0.6 : 0.5, reason: decision.reason, at: now.toISOString() }),
      questionnaireContextOf(ctx, input.region),
    ),
    decision,
  };
}

/** "No preference": the silent value stays, and the skip is recorded so nothing calls it a choice. */
export function skipQuestion(input: {
  answers: QuestionnaireAnswers;
  ctx: InterviewContext;
  question: QuestionDefinition;
  now: Date;
  region?: QuestionnaireContext['region'];
}): QuestionnaireAnswers {
  const { answers, ctx, question, now } = input;
  const log = logOf(answers);
  const provenance = { ...answers.provenance };
  delete provenance[question.id];
  const next: QuestionnaireAnswers = {
    ...answers,
    provenance: { ...provenance, [question.id]: { source: 'smart_default', strength: 'weak', confidence: 0.3, reason: 'You said you had no preference, so the usual default stands.', at: now.toISOString() } },
    interview: {
      ...log,
      asked: log.asked.includes(question.id) ? log.asked : [...log.asked, question.id],
      answered: without(log.answered, question.id),
      decided: without(log.decided, question.id),
      skipped: log.skipped.includes(question.id) ? log.skipped : [...log.skipped, question.id],
    },
  };
  return normalizeAnswers(next, questionnaireContextOf(ctx, input.region));
}

/**
 * Carried answers are recorded as `existing_profile` provenance so the review
 * screen can say where they came from. Idempotent.
 */
export function markCarried(answers: QuestionnaireAnswers, ctx: InterviewContext, plan: InterviewPlan, now: Date): QuestionnaireAnswers {
  let next = answers;
  for (const question of plan.questions) {
    if (question.status !== 'carried' || answers.provenance[question.id]) continue;
    next = stamp(next, question.id, { source: 'existing_profile', strength: 'normal', confidence: 0.9, reason: 'Carried from what you told us when you started the trip.', at: now.toISOString() });
  }
  return next;
}

/**
 * THE FAST PATH: every open core and destination question decided at once.
 *
 * Each decision goes through the question's own smart default, so the reasons
 * are the same sentences "Decide this for me" would have shown one at a time.
 * Fine-tune questions are left alone — silence, not a decision.
 */
export function applySmartDefaults(input: {
  answers: QuestionnaireAnswers;
  ctx: InterviewContext;
  now: Date;
  region?: QuestionnaireContext['region'];
  mode?: InterviewMode;
}): { answers: QuestionnaireAnswers; decisions: { id: string; decision: SmartDefault }[] } {
  let answers = withMode(input.answers, input.mode ?? 'fast');
  const decisions: { id: string; decision: SmartDefault }[] = [];
  // Iterate until the plan has no open non-fine-tune question: deciding one may unlock another.
  for (let guard = 0; guard < 40; guard += 1) {
    const plan = planInterview({ ctx: input.ctx, answers, mode: 'normal' });
    const open = plan.questions.find((q) => !q.hidden && q.tier !== 'fine_tune' && q.status === 'open');
    if (!open) break;
    const result = decideQuestion({ answers, ctx: input.ctx, question: open.definition, now: input.now, ...(input.region ? { region: input.region } : {}) });
    answers = result.answers;
    decisions.push({ id: open.id, decision: result.decision });
  }
  return { answers, decisions };
}

/** Whether the shown part of the plan has no open question left. */
export function interviewComplete(plan: InterviewPlan): boolean {
  return plan.shown.every((id) => plan.questions.find((q) => q.id === id)?.status !== 'open');
}
