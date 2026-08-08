import 'server-only';
import {
  type BlindAssignment,
  type BlindPlan,
  type PlanLabel,
  type ProducingSystem,
  displayOrder,
  systemForLabel,
  toBlindPlan,
} from '@sidequest/bench';
import {
  type StoredPlan,
  getAssignment,
  getRunForArm,
  headPlanForRun,
  planVersionsForRun,
} from '@/lib/db/benchmark-repository';
import { identitiesAreRevealed } from '@/lib/db/benchmark-review-repository';

/**
 * THE ONE PLACE THAT SEES BOTH THE PLAN AND THE SYSTEM THAT MADE IT.
 *
 * Everything a pre-reveal page renders comes through here, and what leaves is a
 * type that structurally cannot carry a system identity — not a full object with
 * a field the component happens not to read.
 *
 * That distinction is the whole design. A React server component that receives
 * `{ system: 'sidequest', plan }` and renders only `plan` has still shipped the
 * word to the browser: props are serialised into the page payload, and the
 * payload is readable with a right-click. It is the single most likely way this
 * benchmark leaks, it leaves no trace in anything a person looks at, and no
 * amount of care in the component prevents it. So the projection happens at the
 * boundary and returns a value with no such field to leak.
 *
 * The rule, if you add a route: **a pre-reveal page may call `blindPanels` and
 * nothing else in this module.**
 */

export interface BlindPanel {
  label: PlanLabel;
  /** Absent when the run has produced nothing yet. */
  plan: BlindPlan | null;
  /** How many correction rounds this plan has been through. */
  version: number;
  versionCount: number;
  state: 'pending' | 'running' | 'succeeded' | 'partial' | 'failed';
}

export interface BlindPresentation {
  /** In the order the reviewer sees them, which was drawn once and stored. */
  panels: readonly [BlindPanel, BlindPanel];
  bothTerminal: boolean;
}

/**
 * The two panels, in display order, with no way to tell which is which.
 *
 * `bothTerminal` gates the review screen, and gating it is not politeness. If
 * panels appeared as they finished, arrival order would announce the faster
 * system on every session — a latency tell that no amount of neutral wording
 * fixes. So neither plan is reviewable until both runs have stopped, whether
 * they stopped by succeeding, by producing something partial, or by failing.
 */
export function blindPanels(sessionId: string): BlindPresentation | null {
  const assignment = getAssignment(sessionId);
  if (!assignment) return null;

  const [first, second] = displayOrder(assignment);
  const panelFirst = panelFor(sessionId, assignment, first);
  const panelSecond = panelFor(sessionId, assignment, second);

  return {
    panels: [panelFirst, panelSecond],
    bothTerminal: isTerminal(panelFirst.state) && isTerminal(panelSecond.state),
  };
}

function isTerminal(state: BlindPanel['state']): boolean {
  return state === 'succeeded' || state === 'partial' || state === 'failed';
}

function panelFor(
  sessionId: string,
  assignment: BlindAssignment,
  label: PlanLabel,
): BlindPanel {
  const system = systemForLabel(assignment, label);
  const run = getRunForArm(sessionId, system);
  if (!run) return { label, plan: null, version: 0, versionCount: 0, state: 'pending' };

  const head = headPlanForRun(run.id);
  const versions = planVersionsForRun(run.id);
  return {
    label,
    // `toBlindPlan` is what removes `producedBy`. Called here rather than in the
    // component, so the component never holds a value that has it.
    plan: head ? toBlindPlan(head.plan) : null,
    version: head?.planVersion ?? 0,
    versionCount: versions.length,
    state: run.state,
  };
}

/**
 * Which system a label was, and only after the reveal.
 *
 * Guarded rather than trusted. A caller that got the ordering wrong, or a route
 * somebody adds later without reading this file, gets `null` instead of the
 * answer — and a `null` that breaks a post-reveal page is a far better failure
 * than a string that quietly appears on a pre-reveal one.
 */
export function revealedSystemFor(
  sessionId: string,
  label: PlanLabel,
): ProducingSystem | null {
  if (!identitiesAreRevealed(sessionId)) return null;
  const assignment = getAssignment(sessionId);
  if (!assignment) return null;
  return systemForLabel(assignment, label);
}

/** The full mapping, post-reveal only. */
export function revealedMapping(
  sessionId: string,
): { A: ProducingSystem; B: ProducingSystem } | null {
  const a = revealedSystemFor(sessionId, 'A');
  const b = revealedSystemFor(sessionId, 'B');
  return a && b ? { A: a, B: b } : null;
}

/**
 * The stored plan behind a label, for post-reveal diagnostics.
 *
 * Separate from `blindPanels` and guarded by the same reveal check, because this
 * one returns the plan *with* `producedBy` on it.
 */
export function revealedPlanFor(sessionId: string, label: PlanLabel): StoredPlan | null {
  const system = revealedSystemFor(sessionId, label);
  if (!system) return null;
  const run = getRunForArm(sessionId, system);
  return run ? headPlanForRun(run.id) : null;
}
