import { z } from 'zod';
import {
  forcedChoiceOptionSchema,
  ratingScoreSchema,
  type BenchmarkQuestion,
  type BlindPlan,
  type PlanLabel,
} from '@sidequest/bench';
import type { BlindPanel } from '@/lib/benchmark/blind';
import { redactDeep, redactForbidden, stableSortKey } from './copy';

/**
 * THE EXPLICIT NEUTRAL PROJECTION.
 *
 * Everything a pre-reveal screen renders is built here, and nothing else is
 * allowed across the boundary. The rule is not "do not render the system name" —
 * it is "do not *hold* it", because a value handed to a client component is
 * serialised into the page payload whether or not any element reads it, and that
 * copy is one right-click away. `blindPanels` already returns a type that cannot
 * carry the producer; this module is where the rest of a session's rows — runs,
 * questions, correction rounds — are narrowed to the same standard.
 *
 * Three things happen on the way through, and each closes a channel that neutral
 * wording alone does not:
 *
 * - **Every string is redacted.** The prose in a plan was written by one of the
 *   two competitors and obeys none of the blinding rules.
 * - **The pooled questions are re-ordered by a hash.** Their natural order is
 *   the order they were asked, which groups one system's block together.
 * - **`askedBy` never leaves this file.** It is persisted, because the ledger is
 *   what makes "did one system quietly get more information" answerable, and it
 *   is dropped here, because the reviewer must not see it.
 */

export type PanelState = BlindPanel['state'];

/**
 * One panel, with no per-arm version count on it.
 *
 * The stored panel knows which correction round its plan is on, and that figure
 * is dropped here rather than merely left unrendered. One arm producing a
 * revised plan while the other does not would print "2 / 2" beside one column
 * and "1 / 1" beside the other, and from then on the two panels are labelled for
 * the rest of the sitting — a mapping the reviewer learns without noticing they
 * have learned it. The session index already refuses to list its counts per arm
 * for this exact reason; the reviewing surface has more to lose by it. How many
 * rounds the *comparison* has been through is a fact about the comparison and is
 * shown once, beside the box that asks for one.
 */
export interface NeutralPanel {
  label: PlanLabel;
  state: PanelState;
  plan: BlindPlan | null;
}

export function toNeutralPanel(panel: BlindPanel): NeutralPanel {
  return {
    label: panel.label,
    state: panel.state,
    plan: panel.plan === null ? null : redactDeep(panel.plan),
  };
}

/* ------------------------------------------------------------------ *
 * The run screen
 * ------------------------------------------------------------------ */

export interface NeutralQuestionOption {
  value: string;
  label: string;
}

export interface NeutralQuestion {
  /**
   * A hash of the stored id, never the id.
   *
   * Question ids are minted by the system that asked, and nothing stops one
   * putting its own name in one — the fixture seam's first draft did exactly
   * that. An id reaches the browser as a form field name whether or not it is
   * displayed, so it is replaced by a hash on the way out and resolved back by
   * scanning the ledger on the way in.
   */
  handle: string;
  text: string;
  whyItMatters: string;
  answerType: BenchmarkQuestion['answerType'];
  options: NeutralQuestionOption[];
  required: boolean;
  answered: boolean;
}

/**
 * One list, from both, in an order neither of them chose.
 *
 * Sequence first, because the order a system asked its questions in carries real
 * meaning about what it needed when. Within a sequence number the tie is broken
 * by a hash of the question id rather than by the id itself: ids are minted by
 * the system that asked, so sorting on them would reliably put one system's
 * questions above the other's and give a reviewer a rule they could learn
 * without ever noticing they had learned it.
 */
/** The opaque handle a stored question id is rendered as. Stable, one-way. */
export function questionHandle(questionId: string): string {
  return `q${stableSortKey(questionId).toString(36)}`;
}

export function poolQuestions(questions: readonly BenchmarkQuestion[]): NeutralQuestion[] {
  return [...questions]
    .sort((left, right) => {
      if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      return stableSortKey(left.questionId) - stableSortKey(right.questionId);
    })
    .map((question) => ({
      handle: questionHandle(question.questionId),
      text: redactForbidden(question.questionText),
      whyItMatters: redactForbidden(question.whyItMatters),
      answerType: question.answerType,
      options: question.options.map((option) => ({
        value: option.value,
        label: redactForbidden(option.label),
      })),
      required: question.required,
      answered: question.answeredAt !== null,
    }));
}

/**
 * The only four things the progress screen may say about the pair.
 *
 * `asking` is the one the reviewer acts on: the world has been bought, the
 * questions are on screen, and nothing is planning until they say so. It is a
 * property of the *session* rather than of either arm, which is what keeps it
 * from being a tell — both arms are equally not-yet-started while it holds.
 */
export type PooledRunState = 'not_started' | 'asking' | 'working' | 'finished';

export interface RunSnapshot {
  /**
   * One state for the pair, not one per arm.
   *
   * The per-panel states are deliberately absent from this type rather than
   * merely unrendered, because everything on this snapshot is serialised into
   * the page payload on its way to the browser and the payload is one
   * right-click away. The review is gated on both runs having stopped so that
   * arrival order never reaches the rating form; a badge here saying one arm had
   * finished would hand the reviewer that ordering a screen earlier, and a
   * pooled "one of two finished" would hand them the same thing in a politer
   * sentence. So the three states below are all there are, and which arm reached
   * a terminal state first is not recoverable from any of them.
   */
  pooledState: PooledRunState;
  bothTerminal: boolean;
  anyStarted: boolean;
  /**
   * Still buying the world both arms will plan against. Nothing to answer yet.
   *
   * Separate from `awaitingAnswers` because only one of them may enable the
   * second press: a control offered during the purchase is a control that does
   * nothing when pressed, for as long as the purchase takes.
   */
  preparing: boolean;
  /** Stopped at the question round, waiting to be told to plan. */
  awaitingAnswers: boolean;
  /**
   * One clock for the comparison, not two.
   *
   * Both arms are started by the same press, so a single elapsed figure says
   * everything honest that two would and says nothing about which is quicker.
   * Seconds at the moment the response was produced, so the first client render
   * matches the server's and the ticking afterwards is the browser's own.
   */
  elapsedSeconds: number | null;
  questions: NeutralQuestion[];
}

/* ------------------------------------------------------------------ *
 * The review draft
 * ------------------------------------------------------------------ */

/**
 * What a half-finished review looks like on disk.
 *
 * Its own schema rather than a partial of `blindReviewSchema`, because a draft is
 * legitimately incomplete in ways a review may never be: no explanation yet, a
 * rating on one plan and not the other, no answer to four of the six choices. A
 * schema that permitted those on the real thing would let an incomplete review
 * be locked.
 */
export const reviewDraftSchema = z.object({
  reviewer: z.string().max(120).default(''),
  /**
   * Keyed by plain strings rather than by the label and dimension enums.
   *
   * A Zod record keyed by an enum is exhaustive, which is exactly right for the
   * finished review — all fifteen dimensions, all six choices — and exactly
   * wrong for a draft, where the whole point is that most of them are not
   * answered yet. Narrowing happens once, at the lock, against the real schema.
   */
  scores: z.record(z.string(), z.record(z.string(), ratingScoreSchema)).default({}),
  notRateable: z.record(z.string(), z.string().max(300)).default({}),
  choices: z.record(z.string(), forcedChoiceOptionSchema).default({}),
  explanation: z.string().max(2000).default(''),
  /**
   * How long each panel was actually attended to, in milliseconds.
   *
   * The review schema has carried a field for this since it was written, so that
   * a first-position effect stays estimable — and nothing measured it, which
   * meant the covariate was guaranteed missing on every real review and the
   * effect it exists to separate was guaranteed confounded with the display
   * draw. It is measured on the surface and carried on the draft because the
   * draft is what the lock is built from.
   *
   * Keyed by plain strings for the same reason the scores are: a draft is
   * legitimately partial, and a reviewer who never brought the second panel
   * forward has one key here rather than an invalid record.
   */
  panelTimeMs: z.record(z.string(), z.number().int().min(0)).default({}),
});
export type ReviewDraft = z.infer<typeof reviewDraftSchema>;

export const EMPTY_DRAFT: ReviewDraft = {
  reviewer: '',
  scores: {},
  notRateable: {},
  choices: {},
  explanation: '',
  panelTimeMs: {},
};

/**
 * A stored draft, or an empty one.
 *
 * Never throws. A draft written under an older shape is worth less than the
 * reviewer's time, and taking down the review screen over one would cost more
 * than starting the form again.
 */
export function readDraft(stored: unknown): ReviewDraft {
  const parsed = reviewDraftSchema.safeParse(stored);
  return parsed.success ? parsed.data : EMPTY_DRAFT;
}
