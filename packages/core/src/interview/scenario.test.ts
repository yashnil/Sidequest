import { describe, expect, it } from 'vitest';
import { defaultAnswers } from '../questionnaire/transform';
import { interviewCatalog, type InterviewContext } from './catalog';
import { screenDestination } from './traits';
import { withScreening } from './state';

/**
 * MVP V3, Stage 20 — BEHAVIOUR BEATS SELF-IMAGE.
 *
 * Everybody says they like hiking. Far fewer will choose the six-hour climb
 * over the cable car when the two are put side by side, and the second answer
 * is the one a day plan can be built from. So the questions that decide pace,
 * crowds, spending and effort are framed as a situation with alternatives
 * rather than as a rating of the traveller's own character.
 *
 * This test guards that framing rather than the wording: it asserts that the
 * dimensions most vulnerable to aspiration are asked as scenarios with real
 * alternatives, and that no scenario is a disguised single answer.
 */

/* An invented destination with no traits, so the assertions are about framing rather than about anywhere. */
const CONTEXT: InterviewContext = {
  destination: screenDestination({ name: 'Somewhere', tripDays: 6, startDate: '2026-08-12' }),
  traveller: { travelerNeeds: [], tripDays: 6, adults: 2, children: 0, offeredInterests: [], carried: [] },
};
const ANSWERS = withScreening(defaultAnswers({ travelerNeeds: [], tripDays: 6 }), CONTEXT.destination);

/** The dimensions where stated preference and revealed preference come apart. */
const ASPIRATION_PRONE = ['day_shape', 'iconic_crowds', 'food_tradeoff', 'convenience_spend', 'hike_appetite'];

describe('the questions that decide a day are scenarios', () => {
  const catalog = interviewCatalog(CONTEXT, ANSWERS);

  it.each(ASPIRATION_PRONE)('%s puts the traveller in a situation, not in front of a mirror', (id) => {
    const question = catalog.find((entry) => entry.id === id);
    expect(question, `${id} is missing from the catalog`).toBeDefined();
    expect(question!.kind).toBe('scenario');
  });

  it('every scenario offers alternatives that lead somewhere different', () => {
    for (const question of catalog.filter((entry) => entry.kind === 'scenario')) {
      const options = question.options?.(CONTEXT, ANSWERS) ?? [];
      expect(options.length, `${question.id} offers no choice`).toBeGreaterThanOrEqual(2);
      // A scenario whose options all apply the same thing is one answer wearing three labels.
      const outcomes = new Set(options.map((option) => JSON.stringify(question.apply(option.value, ANSWERS, CONTEXT))));
      expect(outcomes.size, `${question.id} options all do the same thing`).toBe(options.length);
      // And each one says what it means, not only what it is called.
      for (const option of options) expect(option.detail, `${question.id}/${option.value} has no consequence`).toBeTruthy();
    }
  });
});
