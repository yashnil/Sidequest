import { describe, expect, it } from 'vitest';
import { answerAdvisorQuestion, emptyAdvisorAnswers, emptyComposerAnswers, skipAdvisorQuestion, type TripComposerAnswers } from '@sidequest/core';
import { createSequencer, interviewScreen, openEssentialQuestion, type StepState } from './interview-step';

/**
 * The interview's ranking moved to the server. What the browser still decides
 * — which essential is next, which reply is the current one, and what to show
 * when the server has not answered or cannot — is asserted here, because the
 * degraded paths are the ones nobody sees until they matter.
 */
const NOW = new Date('2026-11-08T12:00:00Z');

function fresh(): TripComposerAnswers {
  return { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month', wantsRecommendation: false }, discovery: emptyAdvisorAnswers() };
}

function settled(): TripComposerAnswers {
  return answerAdvisorQuestion(answerAdvisorQuestion(fresh(), 'focus', ['mountains']), 'when', ['summer']);
}

type View = { questionId: string | null; ready: boolean };
const pending: StepState<View> = { status: 'pending' };
const failed: StepState<View> = { status: 'failed' };
const answer = (questionId: string | null, ready = true): StepState<View> => ({ status: 'ready', view: { questionId, ready } });
const base = { forced: null, settling: null, building: false, buildFailed: false };

describe('the essentials, known without the server', () => {
  it('asks what the trip is about, then when, then nothing more on its own', () => {
    expect(openEssentialQuestion(fresh())?.id).toBe('focus');
    expect(openEssentialQuestion(answerAdvisorQuestion(fresh(), 'focus', ['mountains']))?.id).toBe('when');
    expect(openEssentialQuestion(settled())).toBeNull();
  });

  it('does not re-ask an essential that was put and passed over', () => {
    expect(openEssentialQuestion(skipAdvisorQuestion(fresh(), 'focus'))?.id).toBe('when');
  });
});

describe('only the newest request counts', () => {
  it('makes every earlier ticket stale the moment a new one is issued', () => {
    const sequencer = createSequencer();
    const first = sequencer.issue();
    expect(sequencer.isCurrent(first)).toBe(true);
    const second = sequencer.issue();
    /* The slow reply to the older answer arrives now: it must not be used. */
    expect(sequencer.isCurrent(first)).toBe(false);
    expect(sequencer.isCurrent(second)).toBe(true);
  });
});

describe('what the interview shows', () => {
  it('asks an open essential at once, before the server has said anything', () => {
    const screen = interviewScreen({ ...base, answers: fresh(), step: pending });
    expect(screen.mode).toBe('ask');
    expect(screen.question?.id).toBe('focus');
    expect(screen.ready).toBe(false);
  });

  it('asks the question the server chose once it answers', () => {
    const screen = interviewScreen({ ...base, answers: settled(), step: answer('budget') });
    expect(screen).toMatchObject({ mode: 'ask', ready: true, finished: false });
    expect(screen.question?.id).toBe('budget');
  });

  it('holds the question just answered while the next step is in flight', () => {
    const screen = interviewScreen({ ...base, answers: settled(), step: pending, settling: 'when' });
    expect(screen.mode).toBe('settling');
    expect(screen.question?.id).toBe('when');
    /* The essentials are settled, so the traveller can ask for the list without waiting. */
    expect(screen.ready).toBe(true);
  });

  it('says it is working out the first question when a typed request settled the essentials', () => {
    const screen = interviewScreen({ ...base, answers: settled(), step: pending });
    expect(screen).toMatchObject({ mode: 'opening', question: null, ready: true });
  });

  it('builds when the server finds nothing left worth asking', () => {
    expect(interviewScreen({ ...base, answers: settled(), step: answer(null) })).toMatchObject({ mode: 'building', finished: true });
  });

  it('puts a question the traveller asked to change, whatever the step says', () => {
    for (const step of [pending, failed, answer('budget'), answer(null)]) {
      const screen = interviewScreen({ ...base, answers: settled(), step, forced: 'when' });
      expect(screen.mode).toBe('ask');
      expect(screen.question?.id).toBe('when');
    }
  });

  it('ignores a question id it does not hold rather than showing nothing', () => {
    const screen = interviewScreen({ ...base, answers: fresh(), step: answer('not_a_question', false) });
    expect(screen.mode).toBe('ask');
    expect(screen.question?.id).toBe('focus');
  });
});

describe('when the step cannot be worked out', () => {
  it('keeps asking the essentials in their fixed order', () => {
    const first = interviewScreen({ ...base, answers: fresh(), step: failed });
    expect(first).toMatchObject({ mode: 'ask', ready: false });
    expect(first.question?.id).toBe('focus');
    const second = interviewScreen({ ...base, answers: answerAdvisorQuestion(fresh(), 'focus', ['mountains']), step: failed });
    expect(second.question?.id).toBe('when');
  });

  it('stops asking once the essentials are settled, and never claims to be comparing', () => {
    const screen = interviewScreen({ ...base, answers: settled(), step: failed, settling: 'when' });
    expect(screen.mode).toBe('stalled');
    expect(screen.mode).not.toBe('building');
    expect(screen.question).toBeNull();
    /* "Show me places now" still works. */
    expect(screen.ready).toBe(true);
  });

  it('does not sit on a build that failed', () => {
    expect(interviewScreen({ ...base, answers: settled(), step: answer(null), buildFailed: true }).mode).toBe('stalled');
    /* Pressing again is a build again. */
    expect(interviewScreen({ ...base, answers: settled(), step: answer(null), buildFailed: false, building: true }).mode).toBe('building');
  });
});
