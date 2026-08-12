import { describe, expect, it } from 'vitest';
import { classifyPreferences, PHRASES_LONGEST_FIRST } from './classify';
import { applyInterpretation } from './apply';
import { PHRASES } from './phrases';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';
import type { InterpretationSet } from '../schemas/interpretation';

/**
 * "NO LONG HIKES" MUST NARROW THE TRIP, NEVER DELETE IT.
 *
 * The defect these tests pin down: `PHRASES` is grouped by topic, the matcher
 * used to read it in declaration order, and its comment claimed longest-first.
 * So `hike` — an interest, declared two hundred lines above the avoidances —
 * matched inside "no long hikes", claimed the span, and the sentence became a
 * confirmed hard refusal of the whole hiking interest: `frequencyCaps.hiking`
 * of zero, from a traveller who was asking for *shorter* hikes.
 *
 * The fix is a sort at module load (`PHRASES_LONGEST_FIRST`), and the last
 * test here is the one that keeps it fixed: it asserts the ordering property
 * over the actual iteration table, so a new phrase that shadows an existing
 * longer one fails in CI rather than in a traveller's plan.
 */

const CONTEXT = { travelerNeeds: [], tripDays: 5 };

function confirmed(set: InterpretationSet): InterpretationSet {
  return {
    ...set,
    chips: set.chips.map((chip) => ({ ...chip, status: 'confirmed' as const })),
    confirmedAt: '2026-08-11T00:00:00Z',
  };
}

function targets(set: InterpretationSet): string[] {
  return set.chips.map((chip) => `${chip.target.kind}:${chip.target.value}`);
}

describe('long hikes against hiking', () => {
  it('reads "no long hikes" as the long-hikes avoidance, not a refusal of hiking', () => {
    const set = classifyPreferences({ avoid: 'no long hikes' });
    expect(targets(set)).toEqual(['avoidance:long_hikes']);
    expect(set.chips[0]!.strength).toBe('hard_avoid');
  });

  it('reads "long hikes" in the avoid box as a dislike of long hikes', () => {
    const set = classifyPreferences({ avoid: 'long hikes' });
    expect(targets(set)).toEqual(['avoidance:long_hikes']);
    // The box supplies direction only; without an explicit marker this is not a refusal.
    expect(set.chips[0]!.strength).toBe('dislike');
  });

  it('reads "all day hikes" as the long-hikes avoidance', () => {
    const set = classifyPreferences({ avoid: 'all day hikes' });
    expect(targets(set)).toEqual(['avoidance:long_hikes']);
  });

  it('keeps the hiking interest alive through the whole pipeline', () => {
    const set = confirmed(
      classifyPreferences({ mustDo: 'we must go hiking', avoid: 'no long hikes' }),
    );
    const applied = applyInterpretation(defaultAnswers(CONTEXT), set);
    expect(applied.answers.interests.hiking).toBe('core');
    expect(applied.answers.avoidances).toContain('long_hikes');

    /*
     * The end of the pipe, where the original defect surfaced: a zeroed
     * frequency cap deletes every hike from the board. Narrowing must cap the
     * *intensity*, never the count.
     */
    const profile = buildTravelerProfile(applied.answers, CONTEXT);
    expect(profile.derived.frequencyCaps.hiking).toBeGreaterThan(0);
    expect(profile.derived.maxPhysicalIntensity).toBe('moderate');
  });
});

describe('the iteration order the matcher actually uses', () => {
  it('carries every declared phrase exactly once', () => {
    expect(PHRASES_LONGEST_FIRST).toHaveLength(PHRASES.length);
    const phrases = PHRASES_LONGEST_FIRST.map(([phrase]) => phrase);
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  /**
   * The shadow audit, programmatic rather than by inspection.
   *
   * A phrase is shadowed when an earlier phrase in iteration order is a
   * substring of it: the earlier one matches inside any text containing the
   * later one, claims the span, and the later phrase can never win. With the
   * longest-first sort this cannot happen — an earlier phrase is never shorter
   * — and this test states that property over the real table, so it holds for
   * every phrase anybody adds later, not just the pairs we know about today.
   */
  it('never lets a shorter phrase precede a longer phrase that contains it', () => {
    const phrases = PHRASES_LONGEST_FIRST.map(([phrase]) => phrase);
    for (let earlier = 0; earlier < phrases.length; earlier += 1) {
      for (let later = earlier + 1; later < phrases.length; later += 1) {
        expect(
          phrases[later]!.includes(phrases[earlier]!),
          `“${phrases[earlier]}” at ${earlier} shadows “${phrases[later]}” at ${later}`,
        ).toBe(false);
      }
    }
  });

  /** The known-bad pairs, named, so a regression report reads as English. */
  it('checks the historically shadowed pairs in particular', () => {
    const order = PHRASES_LONGEST_FIRST.map(([phrase]) => phrase);
    for (const [longer, shorter] of [
      ['all day hike', 'hike'],
      ['long hike', 'hike'],
      ['big hike', 'hike'],
      ['street food', 'food'],
      ['local food', 'food'],
      ['extreme heat', 'heat'],
      ['freezing water', 'freezing'],
      ['high altitude', 'altitude'],
      ['markets', 'market'],
      ['swimming', 'swim'],
    ] as const) {
      expect(order.indexOf(longer)).toBeGreaterThanOrEqual(0);
      if (order.includes(shorter)) {
        expect(
          order.indexOf(longer),
          `“${longer}” must be tried before “${shorter}”`,
        ).toBeLessThan(order.indexOf(shorter));
      }
    }
  });
});
