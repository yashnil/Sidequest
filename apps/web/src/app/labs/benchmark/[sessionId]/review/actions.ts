'use server';

import { revalidatePath } from 'next/cache';
import {
  MAX_CORRECTION_ROUNDS,
  PLAN_LABELS,
  PRODUCING_SYSTEMS,
  blindReviewSchema,
  type PlanRatings,
} from '@sidequest/bench';
import { readDraft } from '@/components/benchmark/neutral-dto';
import { blindPanels } from '@/lib/benchmark/blind';
import {
  advanceSessionState,
  getBenchmarkSession,
  getRunForArm,
  headPlanForRun,
} from '@/lib/db/benchmark-repository';
import {
  claimCorrectionRoundForBoth,
  completeCorrectionRound,
  listCorrections,
  lockReview,
  saveReviewDraft,
} from '@/lib/db/benchmark-review-repository';

/**
 * SAVING, LOCKING, AND ASKING BOTH FOR A CHANGE.
 *
 * The correction operation is the one worth reading twice. It takes a single
 * instruction and sends it to both plans, and there is deliberately no way to
 * address one of them. A per-plan correction box would let a reviewer tune one
 * system and not the other — half of them would do it without noticing, because
 * the plan in front of them is the one with the problem — and the comparison
 * afterwards would be between a system that got help and a system that did not.
 *
 * Every refusal is a *return value* with the same wording whichever arm caused
 * it. A message that said which one had run out of rounds would identify it.
 */

export type SaveResult = { ok: boolean };

export async function saveReviewDraftAction(
  sessionId: string,
  draft: unknown,
): Promise<SaveResult> {
  return { ok: saveReviewDraft(sessionId, readDraft(draft), new Date()) };
}

export type LockResult = { kind: 'locked' | 'incomplete' | 'refused' };

/**
 * Lock the review, once and for good.
 *
 * The completeness check happens here rather than only in the browser, because a
 * disabled button is not a guarantee — a second tab and a direct call both walk
 * straight past one. What makes the lock irreversible is a `WHERE` clause in the
 * repository; this function's job is to refuse to build a review that would be
 * dishonest if it succeeded.
 *
 * The session is moved to `ready_for_review` first when both plans have finished
 * and nothing has moved it yet. That transition has to happen *somewhere*, and a
 * read-only poll is the wrong place: a snapshot that advanced a lifecycle column
 * would mean leaving a tab open changed the experiment.
 */
export async function lockReviewAction(sessionId: string, draft: unknown): Promise<LockResult> {
  const session = getBenchmarkSession(sessionId);
  if (!session) return { kind: 'refused' };

  const presentation = blindPanels(sessionId);
  if (presentation === null || !presentation.bothTerminal) return { kind: 'refused' };

  const parsedDraft = readDraft(draft);
  const now = new Date();

  const ratings: PlanRatings[] = PLAN_LABELS.map((label) => {
    const reason = parsedDraft.notRateable[label];
    if (reason !== undefined && reason.trim().length > 0) {
      return { state: 'not_rateable', label, reason: reason.trim() };
    }
    return { state: 'rated', label, scores: parsedDraft.scores[label] ?? {} };
  });

  const review = blindReviewSchema.safeParse({
    schemaVersion: 1,
    sessionId,
    reviewer: parsedDraft.reviewer.trim(),
    ratings,
    choices: parsedDraft.choices,
    explanation: parsedDraft.explanation.trim(),
    /*
     * Carried through from the draft, because it is the only record of how long
     * the reviewer actually looked at each panel — and a first-position effect
     * cannot be estimated afterwards from anything else. The field existed in the
     * schema and in the draft for a while before anything forwarded it here,
     * which meant the design allowed for the confound and never measured it.
     */
    panelTimeMs: parsedDraft.panelTimeMs,
    submittedAt: now.toISOString(),
  });
  if (!review.success) return { kind: 'incomplete' };

  if (
    session.state === 'created' ||
    session.state === 'preparing' ||
    session.state === 'awaiting_answers' ||
    session.state === 'running'
  ) {
    advanceSessionState({ sessionId, from: session.state, to: 'ready_for_review', now });
  }

  const outcome = lockReview({ sessionId, review: review.data, now });
  revalidatePath(`/labs/benchmark/${sessionId}/review`);
  return { kind: outcome === 'locked' ? 'locked' : 'refused' };
}

export type CorrectionResult = {
  kind: 'sent' | 'limit_reached' | 'unavailable';
  roundsUsed: number;
};

/**
 * One instruction, both plans, and the same answer whatever happens.
 *
 * The two rounds are claimed inside a single transaction, and if either arm
 * refuses neither is taken. Claiming them one after another meant a refusal from
 * the second — a head plan that had moved, a round already running — left the
 * first arm a round ahead while the reviewer was told the instruction had gone to
 * both. That is exactly the asymmetry this operation exists to prevent, and it is
 * the kind that leaves no trace anybody would look for.
 *
 * Whether the review is still open is not tested here. That guard belongs where
 * the round is written, in SQL, because this action is not the only way to reach
 * the repository and because a `disabled` attribute stops nobody: a locked review
 * is a published judgement of two particular plans, and a later round would
 * insert a new head version and leave the screen showing a plan nobody rated.
 *
 * The session state is deliberately left alone. Moving it to `corrections` would
 * put it outside the one state `lockReview` accepts, so asking for a change
 * would quietly make the review unlockable.
 */
export async function requestCorrectionAction(
  sessionId: string,
  instruction: string,
): Promise<CorrectionResult> {
  const text = instruction.trim();
  const rounds = listCorrections(sessionId);
  const usedBySystem = new Map<string, number>();
  for (const round of rounds) {
    usedBySystem.set(round.system, (usedBySystem.get(round.system) ?? 0) + 1);
  }
  const used = Math.max(0, ...PRODUCING_SYSTEMS.map((system) => usedBySystem.get(system) ?? 0));

  if (text.length === 0) return { kind: 'unavailable', roundsUsed: used };
  if (used >= MAX_CORRECTION_ROUNDS) return { kind: 'limit_reached', roundsUsed: used };

  const heads = PRODUCING_SYSTEMS.map((system) => {
    const run = getRunForArm(sessionId, system);
    const head = run === null ? null : headPlanForRun(run.id);
    return { system, expectedHeadPlanId: head?.id ?? null };
  });
  const addressable = heads.filter(
    (entry): entry is { system: (typeof PRODUCING_SYSTEMS)[number]; expectedHeadPlanId: string } =>
      entry.expectedHeadPlanId !== null,
  );
  if (addressable.length !== heads.length) {
    return { kind: 'unavailable', roundsUsed: used };
  }

  const now = new Date();
  const claim = claimCorrectionRoundForBoth({
    sessionId,
    heads: addressable,
    instructionText: text,
    now,
  });

  if (claim.kind === 'refused') {
    revalidatePath(`/labs/benchmark/${sessionId}/review`);
    // `limit_reached` is the one refusal worth distinguishing, and it is safe to
    // distinguish: the limit is per system and both arms are held to the same
    // count, so saying so cannot tell the reviewer which panel is which.
    const limited = claim.refusals.some((refusal) => refusal.claim.kind === 'limit_reached');
    return { kind: limited ? 'limit_reached' : 'unavailable', roundsUsed: used };
  }

  for (const round of claim.rounds) {
    /*
     * Closed straight away, and honestly.
     *
     * Neither planner arm is wired into this interface yet, so nothing is going
     * to produce a revised plan for this round. Recording it as abandoned is the
     * truthful outcome; leaving it open would block every later round behind an
     * `already_running` that never resolves. When the adapters land, the
     * revision belongs here, between the claim and the completion.
     */
    completeCorrectionRound({
      sessionId,
      system: round.system,
      round: round.round,
      update: { outcome: 'failed', abandoned: true, abandonReason: 'No revised plan was produced.' },
      now,
    });
  }

  revalidatePath(`/labs/benchmark/${sessionId}/review`);
  return { kind: 'sent', roundsUsed: used + 1 };
}
