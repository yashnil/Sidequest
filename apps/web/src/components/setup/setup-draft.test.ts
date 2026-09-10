import { describe, expect, it } from 'vitest';
import {
  SETUP_STEPS,
  effectiveWindow,
  initialDraft,
  isStepAnswered,
  nextStep,
  payloadFor,
  previousStep,
  stepIsRelevant,
  summaryOf,
  type SetupDraft,
  advanceDraft,
} from './setup-draft';

/**
 * The setup step machine, tested as the pure function it is.
 *
 * The property that matters most is the negative one: nothing a traveller has
 * not said may appear as though they said it. That is what the running summary
 * got wrong on the first pass — it showed "6 nights · 7 days" and a date range
 * on the blank first screen, because those were the values the controls happened
 * to start with.
 */

const DEFAULTS = { startDate: '2026-10-08', endDate: '2026-10-14' };
const draft = (patch: Partial<SetupDraft> = {}): SetupDraft => ({ ...initialDraft(DEFAULTS), ...patch });

describe('the summary shows only what the traveller has answered', () => {
  it('a blank first screen says nothing about dates or length', () => {
    const summary = summaryOf(draft());
    expect(summary.lines).toEqual([]);
    expect(summary.short).toBe('Start with where');
  });

  it('a typed destination appears immediately, and nothing else does', () => {
    const summary = summaryOf(draft({ destinationText: 'the steppes' }));
    expect(summary.lines.map((line) => line.label)).toEqual(['Where']);
  });

  it('timing appears only once the timing question has been answered', () => {
    const before = summaryOf(draft({ destinationText: 'Hong Kong' }));
    expect(before.lines.map((line) => line.label)).not.toContain('When');
    const after = summaryOf(draft({ destinationText: 'Hong Kong', answered: ['where', 'when'] }));
    expect(after.lines.map((line) => line.label)).toContain('When');
  });

  it("marks Sidequest's own reads as such", () => {
    const line = summaryOf(draft({ destinationText: 'Kyrgyzstan', dateMode: 'best_time', answered: ['where', 'when'] })).lines.find((entry) => entry.label === 'When');
    expect(line?.assumed).toBe(true);
  });
});

describe('the step order adapts to the answers', () => {
  it('walks every step when nothing has been decided', () => {
    const steps: string[] = ['where'];
    let step = nextStep('where', draft());
    while (step) {
      steps.push(step);
      step = nextStep(step, draft());
    }
    expect(steps).toEqual([...SETUP_STEPS]);
  });

  it('starts with no dates at all, so nobody is handed a length they did not choose', () => {
    const fresh = draft();
    expect(fresh.startDate).toBe('');
    expect(fresh.endDate).toBe('');
    expect(isStepAnswered('when', fresh)).toBe(false);
  });

  it('does not ask for nights when two exact dates already answer it', () => {
    const withDates = draft({ dateMode: 'exact', startDate: '2027-05-11', endDate: '2027-05-20' });
    expect(stepIsRelevant('nights', withDates)).toBe(false);
    expect(nextStep('when', withDates)).toBe('who');
    expect(previousStep('who', withDates)).toBe('when');
  });

  it('does ask for nights when the traveller asked Sidequest to choose the dates', () => {
    const bestTime = draft({ dateMode: 'best_time' });
    expect(stepIsRelevant('nights', bestTime)).toBe(true);
    expect(nextStep('when', bestTime)).toBe('nights');
  });
});

describe('a step is answered when the traveller has actually said something', () => {
  it('two characters of free text is a destination', () => {
    expect(isStepAnswered('where', draft({ destinationText: ' ' }))).toBe(false);
    expect(isStepAnswered('where', draft({ destinationText: 'Gabon' }))).toBe(true);
  });

  it('"tell me when it is best" is a complete answer with no dates at all', () => {
    expect(isStepAnswered('when', draft({ dateMode: 'best_time' }))).toBe(true);
    expect(isStepAnswered('when', draft({ dateMode: 'undecided' }))).toBe(true);
  });

  it('a free window needs both ends, and the second after the first', () => {
    expect(isStepAnswered('when', draft({ dateMode: 'window', earliest: '2027-06-20', latest: '2027-06-10' }))).toBe(false);
    expect(isStepAnswered('when', draft({ dateMode: 'window', earliest: '2027-06-20', latest: '2027-08-10' }))).toBe(true);
  });

  it('a few named months needs at least one', () => {
    expect(isStepAnswered('when', draft({ dateMode: 'months', months: [] }))).toBe(false);
    expect(isStepAnswered('when', draft({ dateMode: 'months', months: [5, 6] }))).toBe(true);
  });

  it('nothing already fixed is a complete answer', () => {
    expect(isStepAnswered('fixed', draft())).toBe(true);
  });
});

describe('a recommended window stays coherent with the length', () => {
  const pick = { startDate: '2027-05-24', endDate: '2027-05-31', label: 'Late May', month: 5, year: 2027, reasons: ['Long daylight'], tradeoffs: [] };

  it('keeps the start the evidence chose and grows to the nights asked for', () => {
    expect(effectiveWindow(draft({ pick, nights: 10 }))).toEqual({ startDate: '2027-05-24', endDate: '2027-06-03' });
  });

  it('is the window itself when no length was given', () => {
    expect(effectiveWindow(draft({ pick }))).toEqual({ startDate: '2027-05-24', endDate: '2027-05-31' });
  });

  it('reaches the server as the trip dates, with the reasons attached', () => {
    const payload = payloadFor(draft({ destinationText: 'Kyrgyzstan', dateMode: 'best_time', pick, nights: 10 }));
    expect(payload.startDate).toBe('2027-05-24');
    expect(payload.endDate).toBe('2027-06-03');
    expect(payload.recommendation?.reasons).toEqual(['Long daylight']);
    expect(payload.dateMode).toBe('best_time');
  });
});

describe('what reaches the server', () => {
  it('never invents an arrival time for somebody who has not booked one', () => {
    const payload = payloadFor(draft({ destinationText: 'Tasmania' }));
    expect(payload.arrivalPrecision).toBe('not_booked');
    expect(payload.departurePrecision).toBe('not_booked');
  });

  it('carries the real times when the traveller says they know them', () => {
    const payload = payloadFor(draft({ destinationText: 'Tasmania', knowsFlightTimes: true, arrival: 'evening', departure: 'afternoon' }));
    expect(payload.arrivalPrecision).toBe('evening');
    expect(payload.departurePrecision).toBe('afternoon');
  });

  it('sends the typed text even when nothing in the index matched it', () => {
    const payload = payloadFor(draft({ destinationText: 'the Okavango Delta' }));
    expect(payload.destinationText).toBe('the Okavango Delta');
    expect(payload.destinationEntryId).toBeNull();
  });
});

/**
 * V6 — THE ACCEPTED WINDOW TRAVELS WITH THE ADVANCE.
 *
 * "Use this timing" used to patch the pick into state and then advance from
 * a draft that did not have it. The two production trips that lost their
 * dates went through exactly this press. `advanceDraft` is the pure half of
 * the fix: the draft it returns is the one that was pressed on.
 */
describe('advanceDraft', () => {
  it('keeps a pick handed to it and marks the step answered, so the payload carries the recommendation', () => {
    const pick = { startDate: '2027-06-13', endDate: '2027-06-20', label: 'Mid June', month: 6, year: 2027, reasons: ['Alpine roads open'], tradeoffs: [] };
    const before = draft({ destinationText: 'Hokkaido', dateMode: 'best_time', pick: null, nights: null });
    const after = advanceDraft({ ...before, pick, nights: 7 }, 'when');
    expect(after.answered).toContain('when');
    expect(after.pick).toEqual(pick);
    const payload = payloadFor(after);
    expect(payload.recommendation?.startDate).toBe('2027-06-13');
    expect(payload.recommendation?.endDate).toBe('2027-06-20');
    expect(payload.startDate).toBe('2027-06-13');
    expect(payload.nights).toBe(7);
  });
  it('is idempotent on an already-answered step', () => {
    const once = advanceDraft(draft({ destinationText: 'Hokkaido' }), 'where');
    expect(advanceDraft(once, 'where').answered).toEqual(once.answered);
  });
});
