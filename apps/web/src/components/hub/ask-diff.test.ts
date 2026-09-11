import { describe, expect, it } from 'vitest';
import { groupByDay, suggestionsFor } from './ask-diff';

describe('a change, grouped by the day it names', () => {
  it('puts whole-trip lines first and days in order', () => {
    const grouped = groupByDay(['Day 3: fewer stops', 'The pace across the trip is easier', 'Day 2 — the harbour walk moved earlier', 'day 3: the big walk kept']);
    expect(grouped.map((entry) => entry.day)).toEqual([null, 2, 3]);
    expect(grouped[0]!.lines).toEqual(['The pace across the trip is easier']);
    expect(grouped[2]!.lines).toEqual(['Fewer stops', 'The big walk kept']);
  });
  it('drops blank lines and keeps a line that only names a day', () => {
    expect(groupByDay(['', '  ', 'Day 4'])).toEqual([{ day: 4, lines: ['Day 4'] }]);
  });
});

describe('the example prompts use the trip they are on', () => {
  it('names the middle day and the first base when they are known', () => {
    const prompts = suggestionsFor({ dayCount: 8, baseNames: ['Nairobi', 'Arusha'] });
    expect(prompts).toContain('Give me a harder day 4');
    expect(prompts).toContain('Find a more interesting place to stay in Nairobi');
    expect(prompts[0]).toBe('Make this less rushed');
    expect(prompts[prompts.length - 1]).toBe('Why did you put this here?');
  });
  it('invents nothing when the trip is not known', () => {
    const prompts = suggestionsFor();
    expect(prompts).toContain('Give me a harder day');
    expect(prompts).toContain('Find a more interesting place to stay');
    expect(prompts.join(' ')).not.toMatch(/day \d/);
  });
});
