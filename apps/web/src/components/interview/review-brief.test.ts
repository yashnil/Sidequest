import { describe, expect, it } from 'vitest';
import { isHardLine, reviewFacts, understandingChips } from './review-brief';

const base = { nights: 7, tripDays: 8, adults: 4, children: 0, acceptedWindow: null, timingOpen: false, shapeLabel: 'A moving route', shapeOpen: false, shapeAssumed: true };

describe('reviewFacts', () => {
  it('states length, party, timing and shape from the context, nothing else', () => {
    const facts = reviewFacts(base);
    expect(facts.map((f) => f.id)).toEqual(['length', 'party', 'timing', 'shape']);
    expect(facts[0]).toMatchObject({ value: '7 nights · 8 days', figure: true, assumed: false });
    expect(facts[1]).toMatchObject({ value: '4 adults', figure: true });
    expect(facts[3]).toMatchObject({ value: 'A moving route', assumed: true, figure: false });
  });

  it('shows the accepted window as the traveller’s own when there is one', () => {
    const facts = reviewFacts({ ...base, acceptedWindow: { label: 'Mid April' }, timingOpen: false });
    expect(facts[2]).toMatchObject({ value: 'Mid April', assumed: false });
  });

  it('says Sidequest picks the window while the question is open, marked as assumed', () => {
    const facts = reviewFacts({ ...base, timingOpen: true });
    expect(facts[2]).toMatchObject({ value: 'Sidequest picks the window', assumed: true });
  });

  it('counts people in words and singularises correctly', () => {
    expect(reviewFacts({ ...base, adults: 1, children: 1 })[1]?.value).toBe('1 adult, 1 child');
    expect(reviewFacts({ ...base, nights: 1, tripDays: 2 })[0]?.value).toBe('1 night · 2 days');
  });

  it('an open shape is named as open and assumed', () => {
    expect(reviewFacts({ ...base, shapeOpen: true, shapeAssumed: false })[3]).toMatchObject({ value: 'Not decided yet', assumed: true });
  });
});

describe('isHardLine', () => {
  const hard = [{ label: 'Dietary needs are absolute: Vegetarian, Nut allergy' }, { label: 'Back at base by 21:00' }];

  it('tags a glance line that describes the same rule in its own register', () => {
    expect(isHardLine('Vegetarian, Nut allergy · requirements, not preferences', hard)).toBe(true);
    expect(isHardLine('Back at base by 21:00', hard)).toBe(true);
  });

  it('leaves a preference alone', () => {
    expect(isHardLine('Somewhere good near the day’s route', hard)).toBe(false);
    expect(isHardLine('Two or three meaningful stops', hard)).toBe(false);
  });

  it('never tags anything when there are no hard rules', () => {
    expect(isHardLine('Vegetarian', [])).toBe(false);
  });
});

describe('understandingChips', () => {
  it('keeps short facts, drops the assumption sentence and long prose, and de-duplicates', () => {
    const sentence = 'Getting around: guided or arranged transfers, flights, a hired driver. Not a hire car.';
    const chips = understandingChips(['Several countries', 'Too big to see all of it', sentence, 'Days are hot from June to September, so mornings carry the walking.', 'several countries'], sentence);
    expect(chips).toEqual(['Several countries', 'Too big to see all of it']);
  });

  it('is empty when there is nothing short to say', () => {
    expect(understandingChips([], undefined)).toEqual([]);
  });
});
