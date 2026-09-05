import type { InterviewMode } from '../schemas/interview';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { interviewCatalog, type InterviewContext, type InterviewModule, type InterviewTier, type QuestionDefinition } from './catalog';

/**
 * THE QUESTION SELECTOR — DETERMINISTIC, EXPLAINABLE, NO MODEL.
 *
 * Every relevant question gets one score:
 *
 *   value = 2·impact + 1.5·relevance + 0.75·criticality − 0.4·burden
 *
 * where impact is how many planning decisions the answer can change
 * (saturating at four), relevance is the destination-and-profile fit the
 * question declared for itself, criticality is how wrong the plan is without
 * it, and burden is how much the traveller has to think. Redundancy removes a
 * question outright: one whose superseding question was answered, or whose
 * answer the composer already carried, is not asked.
 *
 * The order is stable while a traveller is answering — it depends on the
 * context and on which answers *unlock* other questions, never on the fact
 * that a question has just been answered — so Back always returns to the
 * screen that was there. Uncertainty decides inclusion (an answered question
 * stays; a carried one is hidden), not position.
 *
 * Budgets: the core tier holds at most `CORE_BUDGET` questions and the
 * destination tier at most `DESTINATION_BUDGET`; the lowest-scoring open
 * questions past those caps are demoted to the fine-tune tier, which is only
 * shown on "Personalize it more". A criticality-3 question is never demoted.
 */

/** Core questions between the priorities anchor and the hard-limit closer. */
export const CORE_BUDGET = 7;
/** Role questions asked in the core tier; the rest wait in fine-tune. */
export const CORE_ROLE_BUDGET = 2;
export const DESTINATION_BUDGET = 5;

export type QuestionStatus = 'open' | 'answered' | 'decided' | 'skipped' | 'carried';

export interface PlannedQuestion {
  id: string;
  tier: InterviewTier;
  module: InterviewModule;
  score: number;
  /** Why this question is in the plan: the trait, answer or default that put it there. */
  reason: string;
  status: QuestionStatus;
  /** Carried questions are in the plan for the review screen but never shown. */
  hidden: boolean;
  definition: QuestionDefinition;
}

export interface InterviewPlan {
  questions: PlannedQuestion[];
  /** Questions relevant to this trip, whatever their tier. */
  available: number;
  /** The ids the wizard walks, in order, for the given mode. */
  shown: string[];
  byTier: Record<InterviewTier, number>;
}

export function questionScore(question: QuestionDefinition, relevance: number): number {
  const impact = Math.min(1, question.impacts.length / 4);
  return 2 * impact + 1.5 * relevance + 0.75 * question.criticality - 0.4 * question.burden;
}

export function questionStatus(answers: QuestionnaireAnswers, ctx: InterviewContext, question: QuestionDefinition): QuestionStatus {
  const provenance = answers.provenance[question.id];
  const log = answers.interview;
  if (provenance?.source === 'explicit') return 'answered';
  if (log?.skipped.includes(question.id)) return 'skipped';
  if (log?.decided.includes(question.id) || provenance?.source === 'smart_default' || provenance?.source === 'destination_prior') return 'decided';
  if (provenance?.source === 'existing_profile') return 'carried';
  if (question.carriedFields?.some((field) => ctx.traveller.carried.includes(field))) return 'carried';
  return 'open';
}

function resolved(status: QuestionStatus): boolean {
  return status !== 'open';
}

function branchReason(question: QuestionDefinition, ctx: InterviewContext, answers: QuestionnaireAnswers, relevance: number): string {
  if (question.tier === 'core') return 'asked of every traveller';
  const withTraits = (traits: typeof ctx.destination.traits): InterviewContext => ({ ...ctx, destination: { ...ctx.destination, traits } });
  const bare = question.relevance(withTraits([]), answers);
  // A trait explains the question when removing it lowers relevance, or — when
  // two traits each suffice — when it alone raises relevance above the bare floor.
  let traits = ctx.destination.traits.filter((trait) => question.relevance(withTraits(ctx.destination.traits.filter((t) => t !== trait)), answers) < relevance);
  if (traits.length === 0 && bare < relevance) {
    traits = ctx.destination.traits.filter((trait) => question.relevance(withTraits([trait]), answers) > bare);
  }
  if (traits.length > 0) return `because ${ctx.destination.proseName} reads as ${traits.map((t) => t.replace(/_/g, ' ')).join(', ')}`;
  if (question.dependsOn && question.dependsOn.length > 0) return `because of your answer on ${question.dependsOn.join(', ')}`;
  return 'because of who is travelling';
}

export function planInterview(input: { ctx: InterviewContext; answers: QuestionnaireAnswers; mode?: InterviewMode }): InterviewPlan {
  const { ctx, answers } = input;
  const mode = input.mode ?? answers.interview?.mode ?? 'normal';
  const catalog = interviewCatalog(ctx, answers);
  const statusById = new Map(catalog.map((q) => [q.id, questionStatus(answers, ctx, q)] as const));

  const candidates: PlannedQuestion[] = [];
  let available = 0;
  for (const question of catalog) {
    const relevance = question.relevance(ctx, answers);
    if (relevance <= 0) continue;
    available += 1;
    const status = statusById.get(question.id) ?? 'open';
    if (question.dependsOn?.some((dep) => !resolved(statusById.get(dep) ?? 'open'))) continue;
    if (status !== 'answered' && question.supersededBy?.some((other) => statusById.get(other) === 'answered')) continue;
    candidates.push({
      id: question.id,
      tier: question.tier,
      module: question.module,
      score: Math.round(questionScore(question, relevance) * 1000) / 1000,
      reason: branchReason(question, ctx, answers, relevance),
      status,
      hidden: status === 'carried',
      definition: question,
    });
  }

  const byScore = (a: PlannedQuestion, b: PlannedQuestion) => b.score - a.score || a.id.localeCompare(b.id);

  // --- core: priorities first, hard constraints last, the rest by value -------
  const core = candidates.filter((q) => q.tier === 'core');
  const pinnedFirst = core.filter((q) => q.id === 'priorities');
  const pinnedLast = core.filter((q) => q.id === 'hard_constraints');
  const roles = core.filter((q) => q.id.startsWith('priority_role:'));
  const middle = core.filter((q) => !pinnedFirst.includes(q) && !pinnedLast.includes(q) && !roles.includes(q)).sort(byScore);
  const demoted = new Set<string>();
  // Roles past the budget wait in fine-tune, unless already answered.
  roles.filter((q) => q.status === 'open').slice(CORE_ROLE_BUDGET).forEach((q) => demoted.add(q.id));
  const middleVisible = middle.filter((q) => !q.hidden);
  if (middleVisible.length > CORE_BUDGET) {
    const demotable = middleVisible
      .filter((q) => q.status === 'open' && q.definition.criticality < 3)
      .sort((a, b) => a.definition.criticality - b.definition.criticality || a.score - b.score || a.id.localeCompare(b.id));
    let kept = middleVisible.length;
    for (const q of demotable) {
      if (kept <= CORE_BUDGET) break;
      demoted.add(q.id);
      kept -= 1;
    }
  }
  const coreOrdered = [...pinnedFirst, ...roles, ...middle, ...pinnedLast];

  // --- destination: by value, capped, critical ones never demoted -----------------
  const destination = candidates.filter((q) => q.tier === 'destination').sort(byScore);
  const destinationVisible = destination.filter((q) => !q.hidden);
  if (destinationVisible.length > DESTINATION_BUDGET) {
    const demotable = destinationVisible
      .filter((q) => q.status === 'open' && q.definition.criticality < 3)
      .sort((a, b) => a.definition.criticality - b.definition.criticality || a.score - b.score || a.id.localeCompare(b.id));
    let kept = destinationVisible.length;
    for (const q of demotable) {
      if (kept <= DESTINATION_BUDGET) break;
      demoted.add(q.id);
      kept -= 1;
    }
  }

  const fineTune = candidates.filter((q) => q.tier === 'fine_tune').sort(byScore);

  const finalTier = (q: PlannedQuestion): InterviewTier => (demoted.has(q.id) ? 'fine_tune' : q.tier);
  const ordered: PlannedQuestion[] = [
    ...coreOrdered.filter((q) => !demoted.has(q.id) && q.id !== 'hard_constraints'),
    ...destination.filter((q) => !demoted.has(q.id)),
    // Hard limits close the interview, after the destination follow-ups, so the
    // chips on offer already know how the traveller is getting around.
    ...pinnedLast,
    ...[...coreOrdered, ...destination].filter((q) => demoted.has(q.id)).map((q) => ({ ...q, tier: 'fine_tune' as const })),
    ...fineTune,
  ].map((q) => ({ ...q, tier: finalTier(q) }));

  const shown = ordered
    .filter((q) => !q.hidden)
    .filter((q) => (mode === 'deep' ? true : q.tier !== 'fine_tune'))
    .map((q) => q.id);

  const byTier: Record<InterviewTier, number> = { core: 0, destination: 0, fine_tune: 0 };
  for (const q of ordered) if (!q.hidden) byTier[q.tier] += 1;

  return { questions: ordered, available, shown, byTier };
}

/** The next unresolved question in the shown order, or null when the interview is complete. */
export function nextOpenQuestion(plan: InterviewPlan): PlannedQuestion | null {
  for (const id of plan.shown) {
    const q = plan.questions.find((entry) => entry.id === id);
    if (q && q.status === 'open') return q;
  }
  return null;
}
