import type { QuestionnaireAnswers } from '../schemas/profile';
import type { InterviewContext } from './catalog';
import { PLANNING_IMPACT_KEYS, type PlanningImpactKey } from './impact';
import type { InterviewPlan } from './selector';

/**
 * QUESTIONNAIRE ANALYTICS — STRUCTURAL, FOR TESTS AND DEBUGGING.
 *
 * No tracking infrastructure: this is a pure function over the plan and the
 * answers, computed on demand. It answers the questions the acceptance
 * fixtures ask — how many questions existed for this trip, how many were
 * shown, how many were answered versus decided versus skipped, why each
 * branch appeared, and which planning dimensions ended up with a stated or
 * assumed value.
 */
export interface InterviewAnalytics {
  available: number;
  shown: number;
  answered: number;
  decided: number;
  skipped: number;
  carried: number;
  open: number;
  byTier: InterviewPlan['byTier'];
  modules: string[];
  branchReasons: Record<string, string>;
  traits: string[];
  dimensionsResolved: PlanningImpactKey[];
  dimensionsUnresolved: PlanningImpactKey[];
  mode: string;
}

export function interviewAnalytics(ctx: InterviewContext, answers: QuestionnaireAnswers, plan: InterviewPlan): InterviewAnalytics {
  const shownQuestions = plan.questions.filter((q) => plan.shown.includes(q.id));
  const count = (status: string) => plan.questions.filter((q) => !q.hidden && q.status === status && plan.shown.includes(q.id)).length;
  const resolved = new Set<PlanningImpactKey>();
  for (const q of plan.questions) {
    if (q.status === 'open') continue;
    for (const impact of q.definition.impacts) resolved.add(impact);
  }
  const branchReasons: Record<string, string> = {};
  for (const q of shownQuestions) branchReasons[q.id] = q.reason;
  return {
    available: plan.available,
    shown: plan.shown.length,
    answered: count('answered'),
    decided: count('decided'),
    skipped: count('skipped'),
    carried: plan.questions.filter((q) => q.status === 'carried').length,
    open: count('open'),
    byTier: plan.byTier,
    modules: [...new Set(shownQuestions.map((q) => q.module))],
    branchReasons,
    traits: [...ctx.destination.traits],
    dimensionsResolved: PLANNING_IMPACT_KEYS.filter((key) => resolved.has(key)),
    dimensionsUnresolved: PLANNING_IMPACT_KEYS.filter((key) => !resolved.has(key)),
    mode: answers.interview?.mode ?? 'normal',
  };
}
