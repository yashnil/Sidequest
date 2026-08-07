import { describe, expect, it } from 'vitest';
import { applyInterpretation, preferenceSignals, chipLabel } from './apply';
import { classifyPreferences, strengthOf } from './classify';
import { clampModelStrength, mergeModelProposals, spansForModel, type UnresolvedSpan } from './fallback';
import {
  AVOIDANCES,
  AVOIDANCE_LABELS,
  BUDGET_STYLES,
  CROWD_TOLERANCES,
  DAY_STARTS,
  DISCOVERY_MIXES,
  INTERESTS,
  INTEREST_LABELS,
  PACES,
} from '../schemas/common';
import {
  CONTROLLED_PREFERENCE_KEYS,
  INTERPRETATION_VERSION,
  LEXICON_VERSION,
  MODEL_MAX_MAGNITUDE,
  MODEL_STRENGTH_CEILING,
  PREFERENCE_MAGNITUDE_MAX,
  PREFERENCE_MAGNITUDE_MIN,
  PREFERENCE_POLARITIES,
  PREFERENCE_STRENGTHS,
  PREFERENCE_STRENGTH_LABELS,
  PREFERENCE_VALENCE,
  canApplyAsExclusion,
  chipTargetForKey,
  keyForChipTarget,
  normalizePreferenceMagnitude,
  preferenceValenceOf,
  type ChipTarget,
  type InterpretationSet,
  type InterpretedChip,
  type PreferenceStrength,
} from '../schemas/interpretation';
import { LEXICON_LOCALE } from './phrases';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';
import { scorePlace } from '../scoring/fit';
import { expandRegion } from '../region/expansion';
import type { QuestionnaireAnswers } from '../schemas/profile';
import {
  AUGUST_DATES,
  MAMMOTH_HIKER_ANSWERS,
  answers as answersWith,
  boardContext,
} from '../testing/fixtures';

/**
 * THE PREFERENCE TAXONOMY, TABLE-DRIVEN OVER ALL OF IT.
 *
 * The defect this file exists for: `applyInterpretation`'s avoidance branch
 * never read `chip.strength`, so every avoidance chip — a hard blocker list —
 * was written regardless of how firmly anybody meant it, and `clampModelStrength`
 * was therefore inert for every `avoidance:*` key. A model reading of "not
 * massively into long walks" deleted a category and lowered the effort ceiling.
 *
 * So the assertions here are deliberately exhaustive rather than illustrative.
 * Every strength, every key in the controlled vocabulary, both polarities and
 * both sources are enumerated from the enums themselves, so a member added later
 * is covered by construction rather than by somebody remembering.
 */

const CONTEXT = { travelerNeeds: [], tripDays: 5 };
const NOW = '2026-08-03T09:00:00Z';
const PROMPT_VERSION = 'interpret-preferences/2026-08-03.1';
const MODEL_ID = 'claude-opus-5';

function chip(overrides: Partial<InterpretedChip> & { target: ChipTarget }): InterpretedChip {
  return {
    id: `chip:test:${overrides.target.kind}:${overrides.target.value}`,
    field: 'mustDo',
    span: [0, 4],
    quote: 'text',
    strength: 'preference',
    source: 'deterministic',
    status: 'confirmed',
    ...overrides,
  };
}

function setOf(chips: InterpretedChip[], confirmed = true): InterpretationSet {
  return {
    schemaVersion: INTERPRETATION_VERSION,
    lexiconVersion: LEXICON_VERSION,
    lexiconLocale: LEXICON_LOCALE,
    chips,
    unresolved: [],
    suggestedQuestions: [],
    ...(confirmed ? { confirmedAt: NOW } : {}),
  };
}

// ---------------------------------------------------------------------------
// The taxonomy itself
// ---------------------------------------------------------------------------

describe('the taxonomy is total, ordered and bounded', () => {
  it('names all seven levels the brief asks for, and only those', () => {
    expect([...PREFERENCE_STRENGTHS]).toEqual([
      'must_have',
      'strong_preference',
      'preference',
      'low_preference',
      'dislike',
      'strong_dislike',
      'hard_avoid',
    ]);
  });

  it('gives every strength a valence, a label and a magnitude in range', () => {
    for (const strength of PREFERENCE_STRENGTHS) {
      const valence = preferenceValenceOf(strength);
      expect(valence, strength).not.toBeNull();
      expect(PREFERENCE_POLARITIES, strength).toContain(valence!.polarity);
      expect(Number.isFinite(valence!.magnitude), strength).toBe(true);
      expect(valence!.magnitude, strength).toBeGreaterThanOrEqual(PREFERENCE_MAGNITUDE_MIN);
      expect(valence!.magnitude, strength).toBeLessThanOrEqual(PREFERENCE_MAGNITUDE_MAX);
      expect(PREFERENCE_STRENGTH_LABELS[strength], strength).toBeTruthy();
      // No label is the identifier with its underscores taken out.
      expect(PREFERENCE_STRENGTH_LABELS[strength]).not.toBe(strength.replace(/_/g, ' '));
    }
  });

  /**
   * Polarity and magnitude are separate concepts, and this is what that means
   * operationally: the magnitudes do not encode direction. Sorting by magnitude
   * interleaves the two ladders, so nothing can recover "is this a refusal?"
   * from the number, and nothing can recover "how firmly?" from the direction.
   */
  it('keeps direction out of the number', () => {
    for (const strength of PREFERENCE_STRENGTHS) {
      expect(preferenceValenceOf(strength)!.magnitude, strength).toBeGreaterThanOrEqual(0);
    }
    const affirming = PREFERENCE_STRENGTHS.filter(
      (s) => PREFERENCE_VALENCE[s].polarity === 'affirms',
    ).map((s) => PREFERENCE_VALENCE[s].magnitude);
    const refusing = PREFERENCE_STRENGTHS.filter(
      (s) => PREFERENCE_VALENCE[s].polarity === 'refuses',
    ).map((s) => PREFERENCE_VALENCE[s].magnitude);
    expect(affirming.length).toBe(4);
    expect(refusing.length).toBe(3);
    // Both ladders share the range; neither owns a half of it.
    expect(Math.max(...affirming)).toBe(Math.max(...refusing));
  });

  it('orders each ladder strictly', () => {
    const ladder = (polarity: 'affirms' | 'refuses'): PreferenceStrength[] =>
      PREFERENCE_STRENGTHS.filter((s) => PREFERENCE_VALENCE[s].polarity === polarity);

    const affirming = ladder('affirms');
    expect(affirming).toEqual(['must_have', 'strong_preference', 'preference', 'low_preference']);
    for (let index = 1; index < affirming.length; index += 1) {
      expect(PREFERENCE_VALENCE[affirming[index]!].magnitude).toBeLessThan(
        PREFERENCE_VALENCE[affirming[index - 1]!].magnitude,
      );
    }

    const refusing = ladder('refuses');
    expect(refusing).toEqual(['dislike', 'strong_dislike', 'hard_avoid']);
    for (let index = 1; index < refusing.length; index += 1) {
      expect(PREFERENCE_VALENCE[refusing[index]!].magnitude).toBeGreaterThan(
        PREFERENCE_VALENCE[refusing[index - 1]!].magnitude,
      );
    }
  });

  /** Magnitude does not buy exclusion. Exactly one member carries the licence. */
  it('makes exclusion a separate property from size', () => {
    const exclusionary = PREFERENCE_STRENGTHS.filter((s) => PREFERENCE_VALENCE[s].exclusionary);
    expect(exclusionary).toEqual(['hard_avoid']);
    expect(PREFERENCE_VALENCE.strong_dislike.magnitude).toBeGreaterThan(
      PREFERENCE_VALENCE.dislike.magnitude,
    );
    expect(PREFERENCE_VALENCE.strong_dislike.exclusionary).toBe(false);
    // The largest affirming magnitude there is still cannot remove anything.
    expect(PREFERENCE_VALENCE.must_have.magnitude).toBe(PREFERENCE_MAGNITUDE_MAX);
    expect(PREFERENCE_VALENCE.must_have.exclusionary).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('nothing outside the range survives', () => {
  const rubbish: [string, unknown][] = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a string', '0.5'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { magnitude: 0.5 }],
    ['a bigint-ish', 1n as unknown],
  ];

  it('refuses a magnitude that is not a finite number', () => {
    for (const [name, value] of rubbish) {
      expect(normalizePreferenceMagnitude(value), name).toBeNull();
    }
  });

  it('clamps a finite number into the documented range rather than passing it on', () => {
    expect(normalizePreferenceMagnitude(-1)).toBe(PREFERENCE_MAGNITUDE_MIN);
    expect(normalizePreferenceMagnitude(-1e308)).toBe(PREFERENCE_MAGNITUDE_MIN);
    expect(normalizePreferenceMagnitude(2)).toBe(PREFERENCE_MAGNITUDE_MAX);
    expect(normalizePreferenceMagnitude(1e308)).toBe(PREFERENCE_MAGNITUDE_MAX);
    expect(normalizePreferenceMagnitude(0)).toBe(0);
    expect(normalizePreferenceMagnitude(1)).toBe(1);
    expect(normalizePreferenceMagnitude(0.25)).toBe(0.25);
    // -0 is a finite number in range and stays one rather than becoming null.
    expect(Object.is(normalizePreferenceMagnitude(-0), -0) || normalizePreferenceMagnitude(-0) === 0).toBe(true);
  });

  /**
   * Unknown is not the weakest wish.
   *
   * A stored chip from a build with a strength this one has never heard of, and
   * a fabricated one, both have to read as "no signal" rather than as
   * `low_preference` — otherwise an absence quietly becomes a preference.
   */
  it('keeps unknown separate from low preference', () => {
    for (const value of ['', 'unknown', 'LOW_PREFERENCE', 'maybe', 42, null, undefined, {}]) {
      expect(preferenceValenceOf(value), String(value)).toBeNull();
    }
    expect(preferenceValenceOf('low_preference')).toEqual({
      polarity: 'affirms',
      magnitude: 0.25,
      exclusionary: false,
    });
  });

  it('applies nothing at all for a chip with no valence', () => {
    const base = defaultAnswers(CONTEXT);
    const rogue = chip({
      target: { kind: 'interest', value: 'hiking' },
      strength: 'catastrophic' as PreferenceStrength,
    });
    const result = applyInterpretation(base, setOf([rogue]));
    /*
     * `preferenceSignals` is written unconditionally, including as an empty list.
     * That is deliberate rather than incidental: the field is the stored vector,
     * so a traveller who removes every chip has to end up with `[]` rather than
     * with the vector from before they removed them. Everything else about the
     * answers is untouched, which is what this case is actually about.
     */
    expect(result.answers).toEqual({ ...base, preferenceSignals: [] });
    expect(result.signals).toEqual([]);
    expect(result.applied).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Every key, every strength
// ---------------------------------------------------------------------------

describe('every preference key, at every strength', () => {
  const base = defaultAnswers(CONTEXT);

  it('covers the whole controlled vocabulary', () => {
    const kinds = new Set(CONTROLLED_PREFERENCE_KEYS.map((key) => key.split(':')[0]));
    expect([...kinds].sort()).toEqual([
      'avoidance',
      'budget',
      'crowd',
      'day_start',
      'discovery_mix',
      'interest',
      'pace',
    ]);
    expect(CONTROLLED_PREFERENCE_KEYS.length).toBe(
      INTERESTS.length +
        AVOIDANCES.length +
        PACES.length +
        DAY_STARTS.length +
        BUDGET_STYLES.length +
        CROWD_TOLERANCES.length +
        DISCOVERY_MIXES.length,
    );
  });

  /**
   * THE MATRIX. Every key × every strength × both sources.
   *
   * One invariant holds across the whole grid and it is the finding: an answer
   * set may gain a hard avoidance **only** where the chip cleared
   * `canApplyAsExclusion`. Everything else may move a graded answer or move
   * nothing, and neither is allowed to enlarge `avoidances`.
   */
  it('never enlarges the hard-avoidance list without permission', () => {
    const offenders: string[] = [];
    for (const key of CONTROLLED_PREFERENCE_KEYS) {
      const target = chipTargetForKey(key)!;
      for (const strength of PREFERENCE_STRENGTHS) {
        for (const source of ['deterministic', 'model'] as const) {
          const single = chip({ target, strength, source });
          const result = applyInterpretation(base, setOf([single]));
          const added = result.answers.avoidances.filter((a) => !base.avoidances.includes(a));
          const permitted = canApplyAsExclusion(single) && target.kind === 'avoidance';
          if (added.length > 0 && !permitted) {
            offenders.push(`${key} @ ${strength} (${source}) added ${added.join(',')}`);
          }
          if (added.length === 0 && permitted) {
            offenders.push(`${key} @ ${strength} (${source}) failed to add its avoidance`);
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /** No interest reaches `avoid` without the same permission. */
  it('never sets an interest to avoid without permission', () => {
    const offenders: string[] = [];
    for (const interest of INTERESTS) {
      for (const strength of PREFERENCE_STRENGTHS) {
        for (const source of ['deterministic', 'model'] as const) {
          const single = chip({ target: { kind: 'interest', value: interest }, strength, source });
          const result = applyInterpretation(base, setOf([single]));
          const level = result.answers.interests[interest];
          if (level === 'avoid' && !canApplyAsExclusion(single)) {
            offenders.push(`interest:${interest} @ ${strength} (${source}) reached avoid`);
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  /** Every key produces exactly one signal, and the signal round-trips its key. */
  it('reports one normalised signal per key at every strength', () => {
    for (const key of CONTROLLED_PREFERENCE_KEYS) {
      const target = chipTargetForKey(key)!;
      for (const strength of PREFERENCE_STRENGTHS) {
        const single = chip({ target, strength });
        const { signals } = applyInterpretation(base, setOf([single]));
        expect(signals, `${key} @ ${strength}`).toHaveLength(1);
        const signal = signals[0]!;
        expect(signal.key).toBe(key);
        expect(keyForChipTarget(signal.target)).toBe(key);
        expect(signal.polarity).toBe(PREFERENCE_VALENCE[strength].polarity);
        expect(signal.magnitude).toBe(PREFERENCE_VALENCE[strength].magnitude);
        expect(signal.magnitude).toBeGreaterThanOrEqual(PREFERENCE_MAGNITUDE_MIN);
        expect(signal.magnitude).toBeLessThanOrEqual(PREFERENCE_MAGNITUDE_MAX);
        expect(signal.exclusionary).toBe(canApplyAsExclusion(single));
      }
    }
  });

  /** `preferenceSignals` and `applyInterpretation` cannot disagree. */
  it('derives the same signals whether or not anything is applied', () => {
    for (const key of CONTROLLED_PREFERENCE_KEYS) {
      const target = chipTargetForKey(key)!;
      const set = setOf([chip({ target, strength: 'strong_dislike' })]);
      expect(preferenceSignals(set)).toEqual(applyInterpretation(base, set).signals);
    }
  });

  /**
   * Every key is reported to the traveller in words somebody wrote.
   *
   * A raw enum identifier reaching user-visible text is the mechanism
   * `stageLabel` was written to refuse, and the avoidance branch used to push
   * `target.value` straight into `applied[].label`.
   */
  it('labels every key from a map, and renders nothing for an unmapped one', () => {
    for (const key of CONTROLLED_PREFERENCE_KEYS) {
      const target = chipTargetForKey(key)!;
      const label = chipLabel(target);
      expect(label, key).not.toContain('_');
      if (target.kind === 'interest') expect(label).toBe(INTEREST_LABELS[target.value]);
      if (target.kind === 'avoidance') expect(label).toBe(AVOIDANCE_LABELS[target.value]);
    }
    // A value with no entry in the map renders nothing at all rather than
    // pseudo-English, and nothing that renders nothing reaches `applied`.
    const unmapped = { kind: 'avoidance', value: 'a_thing_nobody_mapped' } as unknown as ChipTarget;
    expect(chipLabel(unmapped)).toBe('');
    const result = applyInterpretation(
      base,
      setOf([chip({ target: unmapped, strength: 'hard_avoid' })]),
    );
    for (const entry of [...result.applied, ...result.noted]) {
      expect(entry.label).not.toBe('');
      expect(entry.label).not.toContain('_');
    }
  });
});

// ---------------------------------------------------------------------------
// What a model may be worth
// ---------------------------------------------------------------------------

describe('a model reading cannot exceed the taxonomy’s ceiling', () => {
  it('clamps every strength to the per-direction ceiling', () => {
    for (const strength of PREFERENCE_STRENGTHS) {
      const clamped = clampModelStrength(strength);
      const before = PREFERENCE_VALENCE[strength];
      const after = PREFERENCE_VALENCE[clamped];
      expect(after.polarity, strength).toBe(before.polarity);
      expect(after.exclusionary, strength).toBe(false);
      expect(after.magnitude, strength).toBeLessThanOrEqual(MODEL_MAX_MAGNITUDE);
      expect(after.magnitude, strength).toBeLessThanOrEqual(
        PREFERENCE_VALENCE[MODEL_STRENGTH_CEILING[before.polarity]].magnitude,
      );
    }
    expect(clampModelStrength('must_have')).toBe('preference');
    expect(clampModelStrength('strong_preference')).toBe('preference');
    expect(clampModelStrength('hard_avoid')).toBe('dislike');
    expect(clampModelStrength('strong_dislike')).toBe('dislike');
    expect(clampModelStrength('low_preference')).toBe('low_preference');
  });

  it('clamps a strength it has never heard of to the weakest rung', () => {
    expect(clampModelStrength('extremely_hard_avoid' as PreferenceStrength)).toBe('low_preference');
  });

  /**
   * THE FINDING, END TO END.
   *
   * An avoidance key was the one place the clamp never reached, because nothing
   * downstream of it read `strength`. Here the clamp runs, the chip comes out at
   * `dislike`, and the applied answers gain no hard avoidance — for every
   * avoidance key there is, not just the one in the bug report.
   */
  it('cannot turn any avoidance key into a hard exclusion, whatever it says', () => {
    const base = defaultAnswers(CONTEXT);
    for (const avoidance of AVOIDANCES) {
      const set: InterpretationSet = {
        schemaVersion: INTERPRETATION_VERSION,
        lexiconVersion: LEXICON_VERSION,
        lexiconLocale: LEXICON_LOCALE,
        chips: [],
        unresolved: [
          {
            span: [0, 34],
            quote: 'we are not massively into long walks',
            looksLikeAName: false,
            field: 'avoid',
          },
        ],
        suggestedQuestions: [],
      };
      const spans: UnresolvedSpan[] = [
        { index: 0, field: 'avoid', span: [0, 34], text: 'we are not massively into long walks' },
      ];
      const merged = mergeModelProposals({
        set,
        spans,
        response: {
          proposals: [
            {
              spanIndex: 0,
              key: `avoidance:${avoidance}`,
              polarity: 'refuses',
              needsClarification: false,
            },
          ],
        },
        attemptedAt: NOW,
        promptVersion: PROMPT_VERSION,
        modelId: MODEL_ID,
      });
      expect(merged.accepted, avoidance).toHaveLength(1);
      const read = merged.accepted[0]!;
      expect(read.source).toBe('model');
      expect(PREFERENCE_VALENCE[read.strength].exclusionary, avoidance).toBe(false);

      const confirmedSet: InterpretationSet = {
        ...merged.set,
        chips: merged.set.chips.map((entry) => ({ ...entry, status: 'confirmed' as const })),
        confirmedAt: NOW,
      };
      const applied = applyInterpretation(base, confirmedSet);
      expect(applied.answers.avoidances, avoidance).toEqual(base.avoidances);
      // And the effort ceiling the old path also moved is untouched.
      expect(buildTravelerProfile(applied.answers, CONTEXT).derived.maxPhysicalIntensity).toBe(
        buildTravelerProfile(base, CONTEXT).derived.maxPhysicalIntensity,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// What a hard avoidance requires
// ---------------------------------------------------------------------------

describe('a hard avoidance needs an explicit traveller action', () => {
  const target: ChipTarget = { kind: 'avoidance', value: 'expensive_activities' };

  it('requires the exclusionary strength, a deterministic source and a confirmation', () => {
    const cases: { strength: PreferenceStrength; source: 'deterministic' | 'model'; status: 'confirmed' | 'proposed' | 'rejected'; expected: boolean }[] = [];
    for (const strength of PREFERENCE_STRENGTHS) {
      for (const source of ['deterministic', 'model'] as const) {
        for (const status of ['confirmed', 'proposed', 'rejected'] as const) {
          cases.push({
            strength,
            source,
            status,
            expected: strength === 'hard_avoid' && source === 'deterministic' && status === 'confirmed',
          });
        }
      }
    }
    for (const entry of cases) {
      expect(
        canApplyAsExclusion({ strength: entry.strength, source: entry.source, status: entry.status }),
        `${entry.strength}/${entry.source}/${entry.status}`,
      ).toBe(entry.expected);
    }
  });

  it('applies nothing at all while the set is unconfirmed', () => {
    const base = defaultAnswers(CONTEXT);
    const unconfirmed = setOf([chip({ target, strength: 'hard_avoid' })], false);
    expect(applyInterpretation(base, unconfirmed).answers).toEqual(base);
    expect(applyInterpretation(base, unconfirmed).signals).toEqual([]);
  });

  /** Removing the confirmation removes the effect, byte for byte. */
  it('loses the exclusion when the confirmation is taken away', () => {
    const base = defaultAnswers(CONTEXT);
    const confirmed = setOf([chip({ target, strength: 'hard_avoid' })]);
    expect(applyInterpretation(base, confirmed).answers.avoidances).toContain('expensive_activities');

    const { confirmedAt: _dropped, ...withoutConfirmation } = confirmed;
    expect(applyInterpretation(base, withoutConfirmation as InterpretationSet).answers).toEqual(base);

    const rejected = setOf([chip({ target, strength: 'hard_avoid', status: 'rejected' })]);
    expect(applyInterpretation(base, rejected).answers).toEqual(base);
  });

  /**
   * Editing the text invalidates the confirmed interpretation.
   *
   * A re-parse is a fresh set with no `confirmedAt`, so the acceptance does not
   * carry across to words nobody has seen — and the chip ids move with the
   * spans, so nothing is resurrected under an old identity either.
   */
  it('invalidates a confirmed reading when the traveller edits the text', () => {
    const base = defaultAnswers(CONTEXT);
    const original = classifyPreferences({ avoid: 'no expensive activities at all' });
    const accepted: InterpretationSet = {
      ...original,
      chips: original.chips.map((entry) => ({ ...entry, status: 'confirmed' as const })),
      confirmedAt: NOW,
    };
    expect(applyInterpretation(base, accepted).answers.avoidances).toContain('expensive_activities');

    const edited = classifyPreferences({ avoid: 'expensive activities, if we can help it' });
    expect(edited.confirmedAt).toBeUndefined();
    expect(applyInterpretation(base, edited).answers).toEqual(base);
    expect(applyInterpretation(base, edited).signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ranking: lowered, not deleted
// ---------------------------------------------------------------------------

/**
 * THE INTEGRATION PROOF, AGAINST THE REAL SCORER.
 *
 * `scorePlace` is what the board, the auto-selector and the planner read, and
 * its `blockers` array is the difference between "ranked lower" and "removed and
 * then explained in your name". These cases run a real region through
 * `expandRegion` and assert on both.
 */
describe('an ordinary dislike lowers the ranking and removes nothing', () => {
  const SCORING_CONTEXT = { travelerNeeds: [], tripDays: 4 };

  function assess(input: QuestionnaireAnswers) {
    const shared = boardContext(AUGUST_DATES);
    const profile = buildTravelerProfile(input, SCORING_CONTEXT);
    const expansion = expandRegion({
      region: shared.region,
      places: shared.places,
      profile,
      months: shared.months,
      dates: shared.dates,
      access: shared.access,
      hours: shared.hours,
    });
    return [...expansion.base, ...expansion.satellites].map((entry) =>
      scorePlace(entry, { profile, travelerNeeds: [] }),
    );
  }

  const base = answersWith(MAMMOTH_HIKER_ANSWERS, SCORING_CONTEXT);

  it('scores a pricey stop lower without blocking it', () => {
    const dislike = applyInterpretation(
      base,
      setOf([chip({ target: { kind: 'avoidance', value: 'expensive_activities' }, strength: 'dislike' })]),
    );
    expect(dislike.answers.avoidances).toEqual(base.avoidances);
    expect(dislike.applied.length).toBeGreaterThan(0);

    const before = assess(base);
    const after = assess(dislike.answers);
    const pricey = before.filter((entry) => entry.factors.some((factor) => factor.id === 'budgetFit'));
    expect(pricey.length).toBeGreaterThan(0);

    let lowered = 0;
    for (const entry of after) {
      const original = before.find((candidate) => candidate.placeId === entry.placeId)!;
      // Nothing gained a cost blocker.
      expect(entry.blockers.map((blocker) => blocker.code)).not.toContain('too_expensive');
      if (entry.score < original.score) lowered += 1;
    }
    expect(lowered, 'a dislike changed no ranking at all').toBeGreaterThan(0);
  });

  /**
   * The other half of the pair: the same key, at the strength that has the
   * permission, does remove — and only where the destination evidence supports
   * the constraint, which here is the place's own cost level.
   */
  it('excludes the same stop once the refusal is explicit and confirmed', () => {
    const hard = applyInterpretation(
      base,
      setOf([
        chip({ target: { kind: 'avoidance', value: 'expensive_activities' }, strength: 'hard_avoid' }),
      ]),
    );
    expect(hard.answers.avoidances).toContain('expensive_activities');

    const scored = assess(hard.answers);
    const blocked = scored.filter((entry) =>
      entry.blockers.some((blocker) => blocker.code === 'too_expensive'),
    );
    expect(blocked.length, 'no place in the fixture is expensive enough to test this').toBeGreaterThan(0);
    // The evidence for the exclusion is the place's own cost level, not the chip.
    for (const entry of blocked) {
      expect(entry.band).toBe('not_workable');
    }
    // Everything the evidence does not support is untouched.
    const untouched = scored.filter(
      (entry) => !entry.blockers.some((blocker) => blocker.code === 'too_expensive'),
    );
    expect(untouched.length).toBeGreaterThan(0);
  });

  it('leaves the effort ceiling alone for a soft refusal and lowers it for a confirmed one', () => {
    const soft = applyInterpretation(
      base,
      setOf([chip({ target: { kind: 'avoidance', value: 'strenuous_activity' }, strength: 'strong_dislike' })]),
    );
    expect(buildTravelerProfile(soft.answers, CONTEXT).derived.maxPhysicalIntensity).toBe(
      buildTravelerProfile(base, CONTEXT).derived.maxPhysicalIntensity,
    );
    for (const entry of assess(soft.answers)) {
      expect(entry.blockers.map((blocker) => blocker.code)).not.toContain('too_strenuous');
    }
    // And the signal survives even though no answer could carry it.
    expect(soft.signals.map((signal) => signal.key)).toEqual(['avoidance:strenuous_activity']);
    expect(soft.signals[0]!.magnitude).toBe(PREFERENCE_VALENCE.strong_dislike.magnitude);
    expect(soft.noted.map((entry) => entry.label)).toEqual([
      AVOIDANCE_LABELS.strenuous_activity,
    ]);

    const hard = applyInterpretation(
      base,
      setOf([chip({ target: { kind: 'avoidance', value: 'strenuous_activity' }, strength: 'hard_avoid' })]),
    );
    expect(buildTravelerProfile(hard.answers, CONTEXT).derived.maxPhysicalIntensity).toBe('moderate');
  });

  it('lowers an interest rather than deleting it, for every non-exclusionary refusal', () => {
    for (const strength of ['dislike', 'strong_dislike'] as const) {
      const result = applyInterpretation(
        base,
        setOf([chip({ target: { kind: 'interest', value: 'history_and_culture' }, strength })]),
      );
      expect(result.answers.interests.history_and_culture, strength).toBe('low');
      expect(result.answers.interests.history_and_culture, strength).not.toBe('avoid');
    }
    const refused = applyInterpretation(
      base,
      setOf([chip({ target: { kind: 'interest', value: 'history_and_culture' }, strength: 'hard_avoid' })]),
    );
    expect(refused.answers.interests.history_and_culture).toBe('avoid');
  });
});

// ---------------------------------------------------------------------------
// The two paths agree
// ---------------------------------------------------------------------------

describe('the parser and the fallback produce compatible structures', () => {
  it('mints chips of the same shape, with the same fields and the same id scheme', () => {
    const parsed = classifyPreferences({
      mustDo: 'hot springs. somewhere we can potter about with no fixed plan.',
    });
    const deterministic = parsed.chips[0]!;
    const merged = mergeModelProposals({
      set: parsed,
      spans: spansForModel(parsed).spans,
      response: {
        proposals: [{ spanIndex: 0, key: 'pace:slow', polarity: 'affirms', needsClarification: false }],
      },
      attemptedAt: NOW,
      promptVersion: PROMPT_VERSION,
      modelId: MODEL_ID,
    });
    const read = merged.accepted[0]!;

    expect(Object.keys(deterministic).sort()).toEqual(
      ['field', 'id', 'quote', 'source', 'span', 'status', 'strength', 'target'].sort(),
    );
    // The model chip is the same shape plus the derived confidence.
    expect(Object.keys(read).sort()).toEqual(
      ['confidence', 'field', 'id', 'quote', 'source', 'span', 'status', 'strength', 'target'].sort(),
    );
    expect(read.id.startsWith('chip:')).toBe(true);
    expect(deterministic.id.startsWith('chip:')).toBe(true);

    // Both strengths are members of the same taxonomy and both have valences.
    for (const entry of [deterministic, read]) {
      expect(PREFERENCE_STRENGTHS).toContain(entry.strength);
      expect(preferenceValenceOf(entry.strength)).not.toBeNull();
    }
  });

  it('reads the same sentence to the same direction on both paths', () => {
    const text = 'we are not massively into long walks';
    const parserStrength = strengthOf(text, 'negative');
    expect(PREFERENCE_VALENCE[parserStrength].polarity).toBe('refuses');
    expect(PREFERENCE_VALENCE[clampModelStrength(parserStrength)].polarity).toBe('refuses');
    expect(PREFERENCE_VALENCE[clampModelStrength(parserStrength)].exclusionary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The locale limit
// ---------------------------------------------------------------------------

describe('the reader says which language it reads', () => {
  const corpus: [string, string][] = [
    ['French', 'nous aimerions quelque chose de très tranquille'],
    ['German', 'wir möchten etwas ruhiges ohne viele leute'],
    ['Spanish', 'queremos algo tranquilo pero también bonito'],
    ['Italian', 'vogliamo qualcosa di molto tranquillo senza folla'],
    ['Portuguese', 'nós queremos algum lugar muito tranquilo sem multidões'],
    ['Japanese', '静かな場所に行きたいです'],
    ['Mandarin', '我们想去安静的地方'],
    ['Korean', '조용한 곳에 가고 싶어요'],
    ['Arabic', 'نريد مكانا هادئا'],
    ['Greek', 'θέλουμε κάτι ήσυχο'],
    ['Russian', 'мы хотим что-то тихое'],
    ['Hindi', 'हम शांत जगह जाना चाहते हैं'],
    ['Thai', 'เราอยากไปที่เงียบๆ'],
    ['Hebrew', 'אנחנו רוצים מקום שקט'],
  ];

  it('names the locale rather than the vocabulary for text it does not read', () => {
    for (const [language, text] of corpus) {
      const set = classifyPreferences({ mustDo: text });
      expect(set.lexiconLocale).toBe(LEXICON_LOCALE);
      expect(set.chips, language).toHaveLength(0);
      expect(set.unresolved.length, language).toBeGreaterThan(0);
      for (const entry of set.unresolved) {
        expect(entry.clarificationReason, `${language}: ${entry.quote}`).toBe(
          'outside_the_locale_we_read',
        );
      }
    }
  });

  /**
   * The other half, and the one that would do the damage: an English sentence
   * must never be told we do not read English.
   */
  it('never claims a locale problem about text it can read', () => {
    const english = [
      'somewhere we can potter about with no fixed plan',
      'a café in the morning and a lovely walk after',
      'the Château de Foo, if we can',
      'nothing too far from the hotel',
      'we would like a bit of everything really',
      'a naïve question about the fjords',
    ];
    for (const text of english) {
      const set = classifyPreferences({ mustDo: text });
      for (const entry of set.unresolved) {
        expect(entry.clarificationReason, text).not.toBe('outside_the_locale_we_read');
      }
    }
  });

  it('keeps the locale finding when the reader declines the same span', () => {
    const set = classifyPreferences({ mustDo: 'nous aimerions quelque chose de très tranquille' });
    const { spans } = spansForModel(set);
    expect(spans.length).toBeGreaterThan(0);
    const merged = mergeModelProposals({
      set,
      spans,
      response: {
        proposals: [
          {
            spanIndex: 0,
            key: 'pace:slow',
            polarity: 'affirms',
            needsClarification: true,
            clarificationReason: 'outside_the_controlled_vocabulary',
          },
        ],
      },
      attemptedAt: NOW,
      promptVersion: PROMPT_VERSION,
      modelId: MODEL_ID,
    });
    expect(merged.set.unresolved[0]!.clarificationReason).toBe('outside_the_locale_we_read');
  });
});
