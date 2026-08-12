import { describe, expect, it } from 'vitest';
import {
  INTERESTS,
  placeEvidences,
  placeRoleTag,
  type Interest,
  type InterestEvidenceSubject,
} from '@sidequest/core';
import { classifySourceCategory, knownCategoryKeys } from './taxonomy';

/**
 * THE TWO TABLES THAT DECIDE WHAT AN INTEREST MEANS, HELD AGAINST EACH OTHER.
 *
 * There are exactly two answers to "which interest does this kind of place
 * serve", and the product needs them to be the same answer:
 *
 *   - `INTEREST_EVIDENCE` (core, `interests/vocabulary.ts`) decides which rows a
 *     destination has earned the right to *offer* the traveller;
 *   - the classifier in `taxonomy.ts` decides which interests a place *claims*,
 *     and `scoring/fit.ts` reads nothing else.
 *
 * They were separate tables and they came apart on the whole built-and-inhabited
 * half of the vocabulary. Every compiled region offered architecture, markets or
 * museums as graded rows on the basis of its own evidence, and no place in any
 * of them carried those interests — so a traveller who marked museums `core` in
 * a city full of museums had `interestMatch` fall from 0.90 to 0.30 on exactly
 * the places they had asked the trip to be built around.
 *
 * `interestsFor` closed it by making the classifier *read* the offer's table.
 * This file is the guard on that arrangement: it fails if either table is edited
 * in a way that reopens the gap, so the next attempt breaks the build rather
 * than the product.
 *
 * Nothing here names a destination. Every key is a word from somebody else's
 * global category vocabulary, taken from the table itself rather than listed.
 */

const KEYS = (() => {
  const { leaves, branches } = knownCategoryKeys();
  return [...leaves, ...branches];
})();

/**
 * A compiled place, built from one source category exactly as `inventory.ts`
 * builds one.
 *
 * The three channels the offer reads are all here and all in the shape the
 * inventory writes them: the planning category, the display noun, and the
 * source's own leaf under the `=` convention that is the only tag the keyword
 * channel looks inside. The `role:` and `attr:` tags travel with it because
 * their presence is half of what the offer's keyword rule has to survive.
 */
function compiledPlaceFor(sourceCategory: string): InterestEvidenceSubject {
  const taxonomy = classifySourceCategory({ category: sourceCategory });
  return {
    category: taxonomy.category,
    ...(taxonomy.displayKind ? { displayKind: taxonomy.displayKind } : {}),
    interests: taxonomy.interests,
    tags: [
      `places=${sourceCategory}`,
      placeRoleTag(taxonomy.role),
      'attr:website',
      'attr:marketing_name',
    ],
  };
}

describe('the intake and the classifier agree about what an interest means', () => {
  it('can stamp every interest the intake is allowed to offer', () => {
    /*
     * The offer's widest basis is `whole_vocabulary` — "we know nothing, so we
     * withhold nothing" — which means any member of `INTERESTS` can reach a
     * traveller as a graded row. An interest no source category can ever produce
     * is therefore a question whose answer changes nothing, wherever it appears.
     */
    const stampable = new Set<Interest>();
    for (const key of KEYS) {
      for (const interest of classifySourceCategory({ category: key }).interests) {
        stampable.add(interest);
      }
    }
    const unstampable = INTERESTS.filter((interest) => !stampable.has(interest));
    expect(
      unstampable,
      `the intake can offer ${unstampable.join(', ')} and no source category the compiler ` +
        'recognises produces a place carrying them — grading one of those rows would be inert',
    ).toEqual([]);
  });

  it('stamps every interest a place built from that category would evidence', () => {
    /*
     * The finer half, and the one that catches a change to *either* side: an
     * evidence rule gaining a keyword, a display noun, or a whole new channel
     * that the stamper is not fed. The claim is per category rather than
     * aggregate, because the failure is per place — a museum that evidences
     * museums without carrying them is scored as though the traveller had never
     * mentioned museums, however many other places in the region carry it.
     */
    const disagreements: string[] = [];
    for (const key of KEYS) {
      const place = compiledPlaceFor(key);
      for (const interest of INTERESTS) {
        if (placeEvidences(place, interest) && !place.interests.includes(interest)) {
          disagreements.push(`${key} → ${interest}`);
        }
      }
    }
    expect(
      disagreements,
      `these categories offer an interest the place they produce cannot match: ${disagreements.join(
        '; ',
      )}`,
    ).toEqual([]);
  });

  it('leads with the archetype’s own interest rather than a derived one', () => {
    /*
     * `interests[0]` is not decoration: the planner's frequency ledger charges
     * it and the board falls back to it when a fit named no interest. Deriving
     * the rest must not reorder the first, or a hike starts spending a
     * viewpoint's allowance.
     */
    expect(classifySourceCategory({ category: 'hiking_trail' }).interests[0]).toBe('hiking');
    expect(classifySourceCategory({ category: 'museum' }).interests[0]).toBe('history_and_culture');
    expect(classifySourceCategory({ category: 'night_market' }).interests[0]).toBe('food_and_towns');
  });
});
