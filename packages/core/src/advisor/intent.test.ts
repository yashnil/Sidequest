import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, type TripComposerAnswers } from '../schemas/composer';
import { FOCUS_KEYS, emptyAdvisorAnswers } from './answers';
import { conceptDescribesTrip, conceptIsGentle, ownWishes } from './concept';
import { parseTravelRequest } from './parse';
import { profileFrom } from './profile';
import { advisorQuestionById, answerAdvisorQuestion } from './questions';

/**
 * A VAGUE, RESTFUL OR FAMILY REQUEST STAYS WHAT IT SAID THROUGH THE INTERVIEW.
 *
 * Staging (2026-11): "a nice retreat with my family … feel good … outdoors
 * stuff" was asked "what do you want the trip to be about?" with "Mountains
 * and trekking" offered first; answered that way, the list was ranked and
 * labelled on mountains and trekking. These are the rules that stop a leaning
 * becoming a pursuit, tested on requests the product was never tuned on.
 */

const NOW = new Date('2026-11-15T12:00:00Z');
function base(): TripComposerAnswers {
  return { ...emptyComposerAnswers('help_me_decide', NOW), dates: { mode: 'month', wantsRecommendation: false }, discovery: emptyAdvisorAnswers() };
}
const read = (text: string) => parseTravelRequest(text, base(), NOW).answers;
const focusQuestion = advisorQuestionById('focus')!;

describe('the focus question', () => {
  it('counts as answered when the kind of trip carries the request', () => {
    for (const text of [
      'We are exhausted and need a calm, restorative week somewhere green in May.',
      'A peaceful retreat with the family in April, nothing hectic.',
    ]) {
      const answers = read(text);
      expect(conceptDescribesTrip(answers.discovery?.concept ?? []), text).toBe(true);
      expect(focusQuestion.answered(answers), text).toBe(true);
    }
  });

  it('is still asked when the words only say "outdoors" or "beautiful"', () => {
    for (const text of ['Somewhere outdoors in August', 'Somewhere beautiful in September']) {
      const answers = read(text);
      expect(focusQuestion.answered(answers), text).toBe(false);
    }
  });

  it('offers first what a restful request leans to, never mountains and trekking', () => {
    const answers = read('Need a slow, restful break with my parents and kids in October; we like being outside.');
    const options = focusQuestion.options(answers);
    expect(options).toHaveLength(FOCUS_KEYS.length);
    expect(options[0]!.id).not.toBe('mountains');
    expect(['lakes', 'beaches', 'volcanoes']).toContain(options[0]!.id);
    expect(options.findIndex((option) => option.id === 'mountains')).toBeGreaterThan(2);
    /* The leaning is also the likelier answer, which is what the interview's value of asking reads. */
    const prior = (id: string) => options.find((option) => option.id === id)!.prior;
    expect(prior(options[0]!.id)).toBeGreaterThan(prior('mountains'));
    expect(options.reduce((sum, option) => sum + option.prior, 0)).toBeCloseTo(1, 6);
  });

  it('keeps the catalog order and uniform priors when nothing was leaned', () => {
    const options = focusQuestion.options(base());
    expect(options.map((option) => option.id)).toEqual([...FOCUS_KEYS]);
    for (const option of options) expect(option.prior).toBeCloseTo(1 / FOCUS_KEYS.length, 6);
  });
});

describe('the party question after "with my family"', () => {
  it('offers children first', () => {
    const answers = read('A week with my family in June, somewhere relaxing by a lake.');
    const options = advisorQuestionById('party')!.options(answers);
    expect(options[0]!.id).toBe('kids');
    expect(advisorQuestionById('party')!.options(base())[0]!.id).toBe('adults');
  });
});

describe('an interest chosen beside a restful kind of trip', () => {
  it('is read at its gentle end, and what was asked for stays the traveller’s own wish', () => {
    const answers = answerAdvisorQuestion(read('Feeling burnt out; a quiet family break in March, outdoors.'), 'focus', ['mountains']);
    expect(conceptIsGentle(answers.discovery?.concept ?? [])).toBe(true);
    const profile = profileFrom(answers);
    expect(profile.wants.multi_day_trekking ?? 0).toBe(0);
    expect(profile.wants.day_hiking ?? 0).toBeGreaterThan(profile.wants.high_mountains ?? 0);
    expect((profile.wants.lakes ?? 0) > 0).toBe(true);
    /* "Mountains" was their word: peaks are never held against the trip they asked for. */
    expect(ownWishes(profile.interests, profile.concept).has('high_mountains')).toBe(true);
  });

  it('is never softened when harder days were asked for', () => {
    const hut = answerAdvisorQuestion(answerAdvisorQuestion(read('A calm family trip in July.'), 'focus', ['mountains']), 'mountain_style', ['hut_to_hut']);
    expect(profileFrom(hut).wants.multi_day_trekking ?? 0).toBeGreaterThan(0.3);
    const rugged = answerAdvisorQuestion(answerAdvisorQuestion(read('A calm family trip in July.'), 'focus', ['mountains']), 'adventure', ['rugged']);
    expect(profileFrom(rugged).wants.multi_day_trekking ?? 0).toBeGreaterThan(0.1);
  });

  it('is not softened by words that only name an activity or the scenery', () => {
    for (const text of ['Big mountain scenery in August without spending much.', 'Asia in July, beaches or mountains either is fine.']) {
      const answers = read(text);
      expect(conceptIsGentle(answers.discovery?.concept ?? []), text).toBe(false);
      expect(profileFrom(answers).wants.multi_day_trekking ?? 0, text).toBeGreaterThan(0);
    }
  });
});
