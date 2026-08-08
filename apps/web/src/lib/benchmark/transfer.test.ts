import { describe, expect, it } from 'vitest';
import { BENCHMARK_SESSION_VERSION, type BenchmarkQuestion } from '@sidequest/bench';
import { fakeRequest } from '@sidequest/bench/testing';
import { deterministicFollowUps } from './baseline/followups';
import { baselineFixtureInputs } from './baseline/fixtures';
import { buildResearchPacket } from './baseline/packet';
import { runPreliminaryScan } from './baseline/scan';
import { TRANSFERABLE_CONCEPTS, conceptOf, transferAnswers } from './transfer';

/**
 * MOVING AN ANSWER, AND SAYING SO WHEN IT CANNOT BE MOVED.
 *
 * The goal forbids one system winning because it silently received more traveller
 * information, and the follow-up round is exactly where that could happen: one
 * arm asks the questions, and without a transfer only that arm hears the answers.
 *
 * Two halves are tested here and the second matters as much as the first. The
 * answers that *can* move must move; the ones that cannot must be recorded as
 * unrepresentable rather than dropped, because a silent drop is indistinguishable
 * from parity in the record afterwards.
 */

const NOW = new Date('2026-08-06T09:00:00.000Z');

function question(text: string, answer: string | null): BenchmarkQuestion {
  return {
    schemaVersion: BENCHMARK_SESSION_VERSION,
    sessionId: 'session-transfer',
    questionId: `q-${text.slice(0, 12)}`,
    askedBy: 'baseline',
    stage: 'preliminary_scan',
    sequence: 0,
    questionText: text,
    whyItMatters: 'Because a test says so.',
    answerType: 'single_choice',
    options: [],
    required: false,
    presentedAt: NOW.toISOString(),
    answeredAt: answer === null ? null : NOW.toISOString(),
    elapsedMs: answer === null ? null : 1_000,
    answerValues: answer === null ? null : [answer],
    answeredFrom: answer === null ? 'unanswered' : 'traveller',
    transferredTo: answer === null ? null : 'sidequest',
  };
}

describe('every concept a standing rule can ask about is recognised', () => {
  /*
   * The concept is matched on the question's own prose, because the stored id is
   * a one-way hash — a question id is a string the asking system chose and may
   * name itself, so it never reaches the browser and never comes back. Matching
   * on prose is fragile, and this is the test that makes the fragility loud: an
   * edit to any rule's wording fails here rather than silently stopping a
   * transfer.
   */
  it('recognises every question the rules actually produce', () => {
    const inputs = baselineFixtureInputs(fakeRequest(), NOW);
    const packet = buildResearchPacket(inputs);

    /*
     * A traveller shaped to fire as many rules as possible: unstated edges, a
     * strict diet, flexible dates, a must-do nothing in the fixture matches.
     */
    const request = {
      ...fakeRequest(),
      arrival: { precision: 'unknown' as const, time: null },
      departure: { precision: 'unknown' as const, time: null },
      dates: { ...fakeRequest().dates, flexDays: 3 },
      party: { ...fakeRequest().party, dietaryStrict: true, dietary: ['vegan' as const] },
      taste: { ...fakeRequest().taste, mustDo: ['somewhere nobody has heard of'] },
      movement: { ...fakeRequest().movement, desiredBaseCount: 1, maxBaseChanges: 2 },
    };
    const scan = runPreliminaryScan({ request, packet });
    const questions = deterministicFollowUps({ request, packet, scan });

    expect(questions.length).toBeGreaterThan(0);
    for (const asked of questions) {
      expect(conceptOf(asked.text), `no concept matches: ${asked.text}`).not.toBeNull();
    }
  });

  it('lists its concepts, so a rule added without a mapping is visible', () => {
    expect(TRANSFERABLE_CONCEPTS.length).toBeGreaterThanOrEqual(9);
    expect(new Set(TRANSFERABLE_CONCEPTS).size).toBe(TRANSFERABLE_CONCEPTS.length);
  });
});

describe('what the other arm hears', () => {
  it('carries an arrival window onto the shared request', () => {
    const result = transferAnswers(fakeRequest(), [
      question('Roughly what time do you expect to arrive on the first day?', 'evening'),
    ]);
    expect(result.request.arrival.precision).toBe('evening');
    expect(result.report[0]?.verdict).toBe('applied');
  });

  it('carries a second base as a base count and a permitted move', () => {
    const request = {
      ...fakeRequest(),
      movement: { ...fakeRequest().movement, desiredBaseCount: 1, maxBaseChanges: 0 },
    };
    const result = transferAnswers(request, [
      question('Would you move to a second place to sleep, or stay put?', 'move'),
    ]);
    expect(result.request.movement.desiredBaseCount).toBeGreaterThanOrEqual(2);
    expect(result.request.movement.maxBaseChanges).toBeGreaterThanOrEqual(1);
  });

  it('carries a packed lunch through the one override that is not a request field', () => {
    const result = transferAnswers(fakeRequest(), [
      question('Are you happy to carry lunch on those days?', 'no'),
    ]);
    expect(result.overrides.willPackLunch).toBe(false);
  });

  it('records an unanswered question as unanswered rather than as parity', () => {
    const result = transferAnswers(fakeRequest(), [
      question('Roughly what time do you expect to arrive on the first day?', null),
    ]);
    expect(result.report[0]?.verdict).toBe('unanswered');
    expect(result.request.arrival.precision).toBe(fakeRequest().arrival.precision);
  });

  it('records a concept with nowhere to land, and changes nothing', () => {
    const before = fakeRequest();
    const result = transferAnswers(before, [
      question('We could not confirm opening hours for most of the places here.', 'include'),
    ]);
    expect(result.report[0]?.verdict).toBe('not_representable');
    expect(result.request).toEqual(before);
  });

  it('refuses to act on a date shift, because it would change the shared world', () => {
    const before = fakeRequest();
    const result = transferAnswers(before, [
      question('You said your dates could shift — is that worth moving them for?', 'shift'),
    ]);
    expect(result.report[0]?.verdict).toBe('not_representable');
    expect(result.request.dates).toEqual(before.dates);
  });

  it('produces exactly one row per question, so a lost transfer is a changed row', () => {
    const result = transferAnswers(fakeRequest(), [
      question('Roughly what time do you expect to arrive on the first day?', 'morning'),
      question('Roughly what time do you need to leave on the last day?', 'evening'),
      question('Something no rule ever wrote.', 'yes'),
    ]);
    expect(result.report).toHaveLength(3);
    expect(result.report[2]?.concept).toBe('unrecognised');
  });

  it('names the arm that did not ask as the recipient', () => {
    const result = transferAnswers(fakeRequest(), [
      question('Roughly what time do you expect to arrive on the first day?', 'morning'),
    ]);
    expect(result.report[0]?.askedBy).toBe('baseline');
    expect(result.report[0]?.toSystem).toBe('sidequest');
  });
});
