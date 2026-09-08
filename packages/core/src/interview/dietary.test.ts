import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DIETARY_NEEDS,
  DIETARY_NEED_KIND,
  DIETARY_NEED_LABELS,
  dietaryNeedsOfKind,
} from '../schemas/food';
import { interviewCatalog } from './catalog';
import { defaultAnswers } from '../questionnaire/transform';
import type { InterviewContext } from './catalog';

/**
 * DIET, AS THE TRAVELLER STATED IT — AND NOTHING INFERRED FROM IT.
 *
 * MVP V3, Stage 16. The rule with teeth is the negative one, and it is worth
 * saying precisely: **no code may derive a religious diet from an ingredient
 * exclusion, or an ingredient exclusion from a religious diet.** "No beef" is a
 * statement about beef. Reading it as Hindu, or expanding `halal` into a list of
 * ingredients nobody ticked, is the product deciding it knows something about a
 * person that they did not tell it — and then planning a trip on it.
 *
 * `halal` and `kosher` remain choosable because a traveller may choose them for
 * themselves. That is a statement they made.
 */

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const context = (): InterviewContext => ({
  destination: { name: 'Somewhere', proseName: 'Somewhere', traits: [], basis: {}, evidence: 'none', tripDays: 7, nights: 6, understanding: [] },
  traveller: { travelerNeeds: [], tripDays: 7, adults: 2, children: 0, offeredInterests: [], carried: [] },
});

function dietaryQuestion() {
  const answers = defaultAnswers({ travelerNeeds: [], tripDays: 7, offeredInterests: [] });
  const question = interviewCatalog(context(), answers).find((entry) => entry.id === 'dietary');
  if (!question) throw new Error('the dietary question is no longer in the catalog');
  return { question, answers };
}

describe('the dietary vocabulary is composable', () => {
  it('covers a whole way of eating, a single ingredient, and an allergy', () => {
    expect(dietaryNeedsOfKind('diet')).toContain('vegetarian');
    expect(dietaryNeedsOfKind('diet')).toContain('pescatarian');
    expect(dietaryNeedsOfKind('diet')).toContain('jain');
    expect(dietaryNeedsOfKind('exclusion')).toEqual(expect.arrayContaining(['no_beef', 'no_pork', 'no_shellfish', 'no_egg', 'no_alcohol', 'no_onion_garlic']));
    expect(dietaryNeedsOfKind('allergy')).toContain('nut_allergy');
  });

  it('every need has a label and exactly one kind', () => {
    for (const need of DIETARY_NEEDS) {
      expect(DIETARY_NEED_LABELS[need]).toBeTruthy();
      expect(DIETARY_NEED_KIND[need]).toBeTruthy();
    }
  });

  it('says what the founder could not say before', () => {
    const { question, answers } = dietaryQuestion();
    // "Hindu non-veg: no beef or pork" — two exclusions and the sentence itself.
    const patch = question.apply({ needs: ['no_beef', 'no_pork'], strict: true, notes: 'Hindu non-veg: no beef or pork' }, answers, context());
    expect(patch.dietaryNeeds).toEqual(['no_beef', 'no_pork']);
    expect(patch.dietaryStrict).toBe(true);
    expect(patch.dietaryNotes).toBe('Hindu non-veg: no beef or pork');
  });

  it('keeps "vegetarian, but I eat eggs" as written', () => {
    const { question, answers } = dietaryQuestion();
    const patch = question.apply({ needs: ['vegetarian'], strict: false, notes: 'Vegetarian, but I eat eggs' }, answers, context());
    expect(patch.dietaryNeeds).toEqual(['vegetarian']);
    expect(patch.dietaryNotes).toBe('Vegetarian, but I eat eggs');
  });

  it('lets free text alone be a requirement', () => {
    const { question, answers } = dietaryQuestion();
    const patch = question.apply({ needs: [], strict: true, notes: 'Severe peanut allergy — cross-contamination matters' }, answers, context());
    expect(patch.dietaryNeeds).toEqual([]);
    expect(patch.dietaryStrict).toBe(true);
  });
});

describe('nothing is inferred between a religion and an ingredient', () => {
  it('an exclusion stays exactly itself', () => {
    const { question, answers } = dietaryQuestion();
    const patch = question.apply({ needs: ['no_beef'], strict: false, notes: '' }, answers, context());
    expect(patch.dietaryNeeds).toEqual(['no_beef']);
    expect(patch.dietaryNeeds).not.toContain('halal');
    expect(patch.dietaryNeeds).not.toContain('kosher');
    expect(patch.dietaryNeeds).not.toContain('no_pork');
    expect(patch.dietaryNeeds).not.toContain('vegetarian');
  });

  it('a religious diet is never expanded into ingredients nobody ticked', () => {
    const { question, answers } = dietaryQuestion();
    for (const chosen of ['halal', 'kosher', 'jain'] as const) {
      const patch = question.apply({ needs: [chosen], strict: false, notes: '' }, answers, context());
      expect(patch.dietaryNeeds).toEqual([chosen]);
    }
  });

  it('no source file maps one group onto the other', () => {
    /*
     * A structural check, not a semantic one: an inference like this is written
     * as a table or a conditional naming a value from each group, and a reviewer
     * reading a diff would not necessarily notice it. Anything that names a
     * religious diet and an ingredient exclusion in the same expression fails
     * here and has to be justified in a way this test can see.
     */
    const files = [
      'packages/core/src/schemas/food.ts',
      'packages/core/src/interview/catalog.ts',
      'packages/core/src/questionnaire/transform.ts',
      'packages/core/src/intelligence/food.ts',
      'packages/core/src/interview/brief.ts',
    ];
    const religious = /\b(halal|kosher|jain)\b/;
    const ingredient = /\bno_(beef|pork|shellfish|egg|alcohol|onion_garlic)\b/;
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const line of source.split('\n')) {
        // The vocabulary declarations themselves list every value; a *mapping* is what is banned.
        if (/^\s*'(halal|kosher|jain|no_[a-z_]+)',?\s*$/.test(line)) continue;
        if (/^\s*(halal|kosher|jain|no_[a-z_]+):/.test(line.trimStart())) continue;
        expect(religious.test(line) && ingredient.test(line), `${file}: "${line.trim().slice(0, 100)}" relates a religious diet to an ingredient`).toBe(false);
      }
    }
  });
});
