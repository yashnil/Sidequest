import { describe, expect, it } from 'vitest';
import {
  QUESTIONNAIRE_STEPS,
  resumeStepIndex,
  stepIdForOrdinal,
  stepOrdinal,
  type QuestionnaireStepId,
} from './definition';

/**
 * THE DRAFT POSITION IS A STEP, NOT A NUMBER INTO A LIST THAT MOVES.
 *
 * The stored draft position used to be an index into the *visible* step list,
 * and the visible list changes length: a step whose only question the composer
 * answered is dropped from the flow. So a traveller who reached step seven of
 * nine, answered the budget question in the composer on a later edit, and
 * refreshed came back one step off — or past the end. The position is now
 * stored as the step's ordinal in the canonical `QUESTIONNAIRE_STEPS` order
 * and resolved against whatever list is actually being shown.
 */

const visible = (ids: QuestionnaireStepId[]) => ids.map((id) => ({ id }));

describe('canonical step ordinals', () => {
  it('round-trips every step', () => {
    for (const id of QUESTIONNAIRE_STEPS) {
      expect(stepIdForOrdinal(stepOrdinal(id))).toBe(id);
    }
  });

  it('clamps rather than trusting a stored number', () => {
    expect(stepIdForOrdinal(-3)).toBe('interests');
    expect(stepIdForOrdinal(999)).toBe('review');
    expect(stepIdForOrdinal(2.7)).toBe(QUESTIONNAIRE_STEPS[2]);
  });
});

describe('resuming against the visible list', () => {
  const ALL = visible([...QUESTIONNAIRE_STEPS]);
  const WITHOUT_BUDGET = visible(
    QUESTIONNAIRE_STEPS.filter((id) => id !== 'budget'),
  );

  it('lands on the saved step when it is still shown', () => {
    expect(resumeStepIndex(ALL, 'region')).toBe(6);
    expect(resumeStepIndex(WITHOUT_BUDGET, 'region')).toBe(5);
  });

  /**
   * The defect case: the saved step vanished because the composer answered it.
   * Resuming *before* it would replay covered ground, so resume lands on the
   * next step the traveller has actually still to see.
   */
  it('resumes at the next visible step when the saved one was dropped', () => {
    expect(WITHOUT_BUDGET[resumeStepIndex(WITHOUT_BUDGET, 'budget')]!.id).toBe('food');
  });

  it('falls to the last step when nothing later survives', () => {
    const shortened = visible(['interests', 'rhythm']);
    expect(resumeStepIndex(shortened, 'review')).toBe(1);
  });

  it('starts at the beginning for a fresh draft', () => {
    expect(resumeStepIndex(ALL, stepIdForOrdinal(0))).toBe(0);
  });
});
