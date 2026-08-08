'use server';

import { revalidatePath } from 'next/cache';
import { postRevealAnswersSchema } from '@sidequest/bench';
import {
  identitiesAreRevealed,
  revealIdentities,
  savePostRevealAnswers,
} from '@/lib/db/benchmark-review-repository';

/**
 * THE REVEAL, AND THE FOUR QUESTIONS THAT ONLY MAKE SENSE AFTER IT.
 *
 * The reveal is a navigation and a single row write, not an animation. There is
 * nothing to watch: what changes is that a column stops being null, and every
 * surface that shows an identity asks the database rather than a flag it was
 * handed. Making it a transition would suggest the reveal is a presentation
 * choice, and it is a state change that cannot be undone.
 *
 * Ordering is enforced in SQL — `revealIdentities` only moves a session that is
 * already `review_locked` — so a reviewer who guessed this URL before locking
 * gets a refusal rather than an answer.
 */
export async function revealIdentitiesAction(sessionId: string): Promise<void> {
  revealIdentities(sessionId, new Date());
  revalidatePath(`/labs/benchmark/${sessionId}/results`);
}

/**
 * Store the post-reveal answers, nulls and all.
 *
 * An unanswered question is stored as `null` rather than defaulted, because the
 * whole value of "would you have waited for the better plan" is that somebody
 * answered it; inventing one would be inventing the finding.
 */
export async function savePostRevealAction(sessionId: string, form: FormData): Promise<void> {
  if (!identitiesAreRevealed(sessionId)) return;

  const answers = postRevealAnswersSchema.safeParse({
    schemaVersion: 1,
    sessionId,
    slowerPlanJustifiesWait: optional(form, 'slowerPlanJustifiesWait'),
    wouldWaitForTheBetterPlan: optional(form, 'wouldWaitForTheBetterPlan'),
    wouldUseForARealTrip: optional(form, 'wouldUseForARealTrip'),
    wouldPayMoreFor: optional(form, 'wouldPayMoreFor'),
    suspectedIdentityBecause: (form.get('suspectedIdentityBecause') ?? '').toString().slice(0, 2000),
    answeredAt: new Date().toISOString(),
  });
  if (!answers.success) return;

  savePostRevealAnswers(answers.data);
  revalidatePath(`/labs/benchmark/${sessionId}/results`);
}

/** An empty select is an absence, and an absence is `null` rather than a blank. */
function optional(form: FormData, name: string): string | null {
  const value = form.get(name);
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length === 0 ? null : text;
}
