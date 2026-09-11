import { describe, expect, it } from 'vitest';
import { articleFor, fixNumberArticles, sameSentence } from './article';

describe('the article before a number follows its pronunciation', () => {
  it('says "an" before eight, eleven and eighteen and their multiples', () => {
    for (const n of [8, 11, 18, 80, 85, 89, 800, 811, 8000, 11000, 18000, 80000]) expect(articleFor(n), String(n)).toBe('an');
  });
  it('says "a" before everything else', () => {
    for (const n of [1, 2, 3, 5, 7, 9, 10, 12, 17, 19, 21, 100, 110, 180, 1100, 1800]) expect(articleFor(n), String(n)).toBe('a');
  });
  it('corrects the thesis line without touching the rest of the sentence', () => {
    expect(fixNumberArticles('A 8-day Kenya and Tanzania trip built around what you said you enjoy.')).toBe('An 8-day Kenya and Tanzania trip built around what you said you enjoy.');
    expect(fixNumberArticles('an 5-day trip')).toBe('a 5-day trip');
    expect(fixNumberArticles('A 5-day trip, an 11 night stay')).toBe('A 5-day trip, an 11 night stay');
  });
  it('leaves prose with no figure after an article alone', () => {
    const text = 'A food-led trip with an easy pace.';
    expect(fixNumberArticles(text)).toBe(text);
  });
});

describe('one sentence is recognised as one sentence', () => {
  it('ignores case, whitespace, end punctuation and the article before a figure', () => {
    expect(sameSentence('A 8-day Kenya trip built around what you said you enjoy.', 'An 8-day Kenya  trip built around what you said you enjoy')).toBe(true);
    expect(sameSentence('A 5-day trip.', 'A 6-day trip.')).toBe(false);
  });
});
