import type { InterviewPlan, PlannedQuestion } from './selector';

/**
 * QUESTION SUFFICIENCY — WHAT STILL DECIDES THIS TRIP.
 *
 * Before Build, Sidequest asks one deterministic question of the interview
 * plan: is there a critical planning dimension for this destination that
 * nobody resolved — not answered, not decided for the traveller, not
 * carried from an earlier trip? A question is critical when the catalog
 * marks it `criticality: 3` and the selector judged it relevant enough to
 * show. If exactly one such dimension is open, the review asks that one
 * question first; if none, the trip builds; if several, the traveller is
 * offered "Personalize it more" rather than a wall — smart defaults still
 * cover every one of them.
 */
export interface CriticalUnknown {
  id: string;
  question: PlannedQuestion;
}

export function criticalUnknowns(plan: InterviewPlan): CriticalUnknown[] {
  return plan.questions
    .filter((q) => !q.hidden && q.status === 'open' && q.definition.criticality === 3 && plan.shown.includes(q.id))
    .map((q) => ({ id: q.id, question: q }));
}

export type Sufficiency = { kind: 'sufficient' } | { kind: 'one_question'; unknown: CriticalUnknown } | { kind: 'several'; unknowns: CriticalUnknown[] };

export function assessSufficiency(plan: InterviewPlan): Sufficiency {
  const unknowns = criticalUnknowns(plan);
  if (unknowns.length === 0) return { kind: 'sufficient' };
  if (unknowns.length === 1) return { kind: 'one_question', unknown: unknowns[0]! };
  return { kind: 'several', unknowns };
}
