import { describe, expect, it } from 'vitest';
import {
  applyComposer,
  applyTransportDecision,
  composerAnsweredFields,
  composerCarriedFields,
} from './apply';
import { defaultAnswers } from '../questionnaire/transform';
import type { QuestionnaireContext } from '../questionnaire/definition';

/**
 * THE ANSWER THE PRODUCT ASKED FOR, IGNORED, AND THEN CONTRADICTED.
 *
 * The composer asks how the traveller is getting around and stores it. The
 * questionnaire then seeded itself from `defaultAnswers`, which hard-codes
 * `willDrive: true`. So the flow was: ask "how are you getting around", hear
 * "trains, buses and transfers", scope the region as a transit trip — and then
 * present a later screen with **"You will have a car" already ticked**.
 *
 * These tests are about that class of defect rather than about a mapping table:
 * every one of them asserts that something the traveller *said* survives to the
 * screen that acts on it.
 */

const CONTEXT: QuestionnaireContext = { travelerNeeds: [], tripDays: 5 };
const MOBILITY: QuestionnaireContext = { travelerNeeds: ['mobility_limited'], tripDays: 5 };

describe('the composer answers reach the questionnaire', () => {
  it('does not tick "you will have a car" for somebody who chose public transport', () => {
    const base = defaultAnswers(CONTEXT);
    /* The defect, stated as a precondition so the test cannot silently stop testing it. */
    expect(base.willDrive).toBe(true);

    const carried = applyComposer(base, { transport: 'public_transport' });
    expect(carried.willDrive).toBe(false);
    expect(carried.willUseShuttles).toBe(true);
  });

  it('leaves a car in the plan for somebody who said they would use both', () => {
    const carried = applyComposer(defaultAnswers(CONTEXT), { transport: 'mixed' });
    expect(carried.willDrive).toBe(true);
  });

  it('treats "undecided" as nobody having said, rather than as an answer', () => {
    const base = defaultAnswers(CONTEXT);
    const carried = applyComposer(base, { transport: 'undecided', budget: 'unstated' });
    expect(carried.willDrive).toBe(base.willDrive);
    expect(carried.budgetStyle).toBe(base.budgetStyle);
    expect(composerAnsweredFields({ transport: 'undecided', budget: 'unstated' }, false)).toEqual([]);
  });

  it('carries pace, budget, crowds and intensity across without inventing precision', () => {
    const carried = applyComposer(defaultAnswers(CONTEXT), {
      pace: 'packed',
      budget: 'premium',
      crowdTolerance: 'avoid',
      outdoorIntensity: 'strenuous',
    });
    expect(carried.pace).toBe('fast');
    expect(carried.budgetStyle).toBe('premium');
    expect(carried.crowdTolerance).toBe('avoid_crowds');
    expect(carried.dailyIntensity).toBe('intense');
  });

  it('never raises intensity above the floor a declared mobility need sets', () => {
    const base = defaultAnswers(MOBILITY);
    expect(base.dailyIntensity).toBe('light');
    expect(base.mobilityLimited).toBe(true);

    const carried = applyComposer(base, { outdoorIntensity: 'strenuous' });
    /*
     * The screen must not promise a plan the scoring layer will immediately
     * override. A composer answer given before the mobility need was known is
     * not a licence to raise the ceiling back up.
     */
    expect(carried.dailyIntensity).toBe('light');
    expect(composerAnsweredFields({ outdoorIntensity: 'strenuous' }, true)).not.toContain(
      'dailyIntensity',
    );
  });

  it('returns the base untouched when there is no composer at all', () => {
    const base = defaultAnswers(CONTEXT);
    expect(applyComposer(base, undefined)).toEqual(base);
    expect(applyComposer(base, null)).toEqual(base);
  });

  /**
   * PROVENANCE SURVIVES A SAVE.
   *
   * The page used to compute "which answers came from the composer" as
   * `saved ? [] : composerAnsweredFields(…)` — so the first mid-flow save
   * erased every "from your answers" badge and resurrected the budget step the
   * composer had already answered. Carried-ness is a relationship between the
   * composer and the current answers, and it has to be recomputed against
   * whatever is stored, minus only the fields the traveller has overruled.
   */
  describe('carried fields against saved answers', () => {
    const composer = {
      transport: 'public_transport',
      pace: 'slow',
      budget: 'budget',
    } as const;

    it('keeps every undiverged field carried after a save', () => {
      const saved = applyComposer(defaultAnswers(CONTEXT), composer);
      expect(composerCarriedFields(composer, saved).sort()).toEqual(
        ['budgetStyle', 'pace', 'willDrive'].sort(),
      );
    });

    it('drops exactly the field the traveller overruled', () => {
      const saved = { ...applyComposer(defaultAnswers(CONTEXT), composer), pace: 'fast' as const };
      const carried = composerCarriedFields(composer, saved);
      expect(carried).not.toContain('pace');
      expect(carried).toContain('willDrive');
      expect(carried).toContain('budgetStyle');
    });

    it('answers nothing for a trip with no composer', () => {
      expect(composerCarriedFields(undefined, defaultAnswers(CONTEXT))).toEqual([]);
      expect(composerCarriedFields(null, defaultAnswers(CONTEXT))).toEqual([]);
    });

    it('never reports intensity for a mobility-limited traveller', () => {
      const saved = defaultAnswers(MOBILITY);
      expect(
        composerCarriedFields({ ...composer, outdoorIntensity: 'strenuous' }, saved),
      ).not.toContain('dailyIntensity');
    });
  });

  it('reports exactly the fields it wrote, so nothing is both prefilled and re-asked', () => {
    const composer = {
      transport: 'public_transport',
      pace: 'slow',
      budget: 'budget',
      crowdTolerance: 'unbothered',
      outdoorIntensity: 'gentle',
    };
    const fields = composerAnsweredFields(composer, false);
    expect(fields.sort()).toEqual(
      ['budgetStyle', 'crowdTolerance', 'dailyIntensity', 'pace', 'willDrive'].sort(),
    );

    /* And every reported field genuinely differs from the untouched default. */
    const base = defaultAnswers(CONTEXT);
    const carried = applyComposer(base, composer);
    for (const field of fields) {
      expect(carried[field]).not.toEqual(base[field]);
    }
  });
});

describe('a settled car decision reaches the questionnaire seed', () => {
  /*
   * The clarification path of the same defect the file header describes: on the
   * ordinary city journey the composer leaves transport undecided, the car
   * question is asked on the plan flow instead, and a "no" answered there still
   * met `defaultAnswers`' hard-coded `willDrive: true` at the questionnaire.
   */
  it('unticks the car for a traveller whose settled decision is no', () => {
    const base = defaultAnswers(CONTEXT);
    expect(base.willDrive).toBe(true);

    const carried = applyTransportDecision(base, false);
    expect(carried.willDrive).toBe(false);
    /* No car means shuttles and buses, the same reading applyComposer gives. */
    expect(carried.willUseShuttles).toBe(true);
  });

  it('keeps the car for a traveller whose settled decision is yes', () => {
    const carried = applyTransportDecision(
      applyComposer(defaultAnswers(CONTEXT), { transport: 'public_transport' }),
      true,
    );
    /* Applied after the composer because it is the later, more specific statement. */
    expect(carried.willDrive).toBe(true);
  });

  it('writes nothing when nobody has said', () => {
    const base = defaultAnswers(CONTEXT);
    expect(applyTransportDecision(base, null)).toEqual(base);
    expect(applyTransportDecision(base, undefined)).toEqual(base);
  });
});
