import { describe, expect, it } from 'vitest';
import { itineraryStructureFingerprint, type Itinerary } from '@sidequest/core';
import { planTrip } from './plan';
import { buildScenario, type ScenarioOptions } from './testing/scenario';

/**
 * THE TRAVELLER'S ACCESSIBILITY NOTE — CARRIED, NEVER INTERPRETED.
 *
 * PR-QUES-10's last placebo: the questionnaire's free-text accessibility box
 * wrote to `profile.accessibility.notes` and nothing anywhere read it. The
 * honest consumer is the simplest one: the plan's check-before-you-book list
 * carries the note verbatim, attributed as the traveller's own words, so it is
 * in front of them exactly when they are booking the things it is about.
 *
 * Both halves of the honesty matter and both are held here. The words must
 * arrive — a stored-and-silent note is a placebo — and the words must not be
 * *acted on*: free text keyword-parsed into scheduling behaviour would be the
 * product guessing at a sentence nobody confirmed, which is worse than the
 * placebo it replaces. The structured `mobilityLimited` answer beside the box
 * is the input that changes the plan; the box is the traveller's own voice.
 */

const NOTE = 'My knee is recovering — I can walk, but stairs and steep steps are a problem.';

function plan(options: ScenarioOptions = {}): Itinerary {
  const result = planTrip(buildScenario(options));
  if (!result.ok) throw new Error(`Planning failed: ${result.code} — ${result.message}`);
  return result.itinerary;
}

describe('the accessibility note reaches the plan', () => {
  it('carries the note verbatim, attributed as the traveller’s own words', () => {
    const strategy = plan({ answers: { accessibilityNotes: NOTE } }).transportStrategy;
    const carried = strategy.verifyBeforeTravel.find((line) => line.includes(NOTE));
    expect(
      carried,
      'the traveller’s accessibility note never reached the check-before-you-book list',
    ).toBeDefined();
    // Attributed as theirs — not presented as something the product concluded.
    expect(carried).toMatch(/your own words/i);
  });

  it('says nothing when the traveller wrote nothing', () => {
    const strategy = plan().transportStrategy;
    for (const line of strategy.verifyBeforeTravel) {
      expect(line).not.toMatch(/your own words/i);
    }
  });

  it('treats a whitespace-only note as no note', () => {
    const strategy = plan({ answers: { accessibilityNotes: '   ' } }).transportStrategy;
    for (const line of strategy.verifyBeforeTravel) {
      expect(line).not.toMatch(/your own words/i);
    }
  });
});

describe('the note is never parsed into behaviour', () => {
  it('schedules the identical trip whatever the words say', () => {
    /*
     * Three notes chosen to bait a keyword parser: one names an avoidance, one
     * names an intensity, one is neutral. If any of them ever changes what is
     * scheduled, the product has started acting on an unconfirmed guess about
     * free text, and this fails.
     */
    const baited = ['no hiking, no long walks, nothing strenuous', 'I love strenuous hikes', NOTE];
    const control = plan();
    for (const note of baited) {
      const varied = plan({ answers: { accessibilityNotes: note } });
      expect(itineraryStructureFingerprint(varied)).toBe(itineraryStructureFingerprint(control));
    }
  });
});
