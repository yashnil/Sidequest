import { describe, expect, it } from 'vitest';
import { applyLearnedInterests, interestsForFeature } from './apply';
import type { LearnedPreference } from './evidence';

const lean = (feature: string, weight: number, band: LearnedPreference['band'] = 'medium'): LearnedPreference => ({ feature, weight, confidence: 0.8, rows: 4, band });

describe('learned leanings reach the plan', () => {
  it('maps interest and theme features to interests', () => {
    expect(interestsForFeature('interest:hiking')).toEqual(['hiking']);
    expect(interestsForFeature('interest:not_a_thing')).toEqual([]);
    expect(interestsForFeature('pace:fast')).toEqual([]);
    expect(interestsForFeature('theme:museums').length).toBeGreaterThan(0);
  });

  it('fills an interest the traveller left unstated, at occasional', () => {
    const { interests, changes } = applyLearnedInterests({ hiking: 'core' }, [lean('interest:food_and_towns', 0.7)]);
    expect(interests).toEqual({ hiking: 'core', food_and_towns: 'occasional' });
    expect(changes).toEqual([{ interest: 'food_and_towns', feature: 'interest:food_and_towns', band: 'medium' }]);
  });

  it('never overrides an answer given for this trip, in either direction', () => {
    expect(applyLearnedInterests({ food_and_towns: 'avoid' }, [lean('interest:food_and_towns', 0.9, 'high')]).interests).toEqual({ food_and_towns: 'avoid' });
    expect(applyLearnedInterests({ food_and_towns: 'core' }, [lean('interest:food_and_towns', -0.9, 'high')]).interests).toEqual({ food_and_towns: 'core' });
  });

  it('a weak, low-band or negative lean changes nothing', () => {
    expect(applyLearnedInterests({}, [lean('interest:food_and_towns', 0.3)]).changes).toEqual([]);
    expect(applyLearnedInterests({}, [lean('interest:food_and_towns', 0.9, 'low')]).changes).toEqual([]);
    expect(applyLearnedInterests({}, [lean('interest:food_and_towns', -0.9, 'high')]).changes).toEqual([]);
  });
});
