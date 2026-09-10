import { describe, expect, it } from 'vitest';
import { extractPreferences } from './extract';

describe('preference extraction from a refinement request', () => {
  it('"fewer temples, more neighbourhoods" is two leanings in two directions', () => {
    const found = extractPreferences('Fewer temples, more neighbourhoods please');
    expect(found.find((f) => f.feature === 'theme:temples')?.polarity).toBe(-1);
    expect(found.find((f) => f.feature === 'theme:neighbourhoods')?.polarity).toBe(1);
  });
  it('"we always prefer a gentle final day" is a lean towards rest (live Hokkaido refinement left no evidence)', () => {
    const found = extractPreferences('Drop the Obihiro night and give us a third night at Akan-ko instead, so the last full day is slower. We always prefer a gentle final day.');
    expect(found.some((f) => f.feature === 'theme:rest' && f.polarity === 1)).toBe(true);
  });
  it('a request with no direction produces nothing', () => {
    expect(extractPreferences('Why did you pick Furano?')).toHaveLength(0);
  });
  it('never yields a hard constraint', () => {
    expect(extractPreferences('no more halal restaurants').some((f) => /halal/.test(f.feature))).toBe(false);
  });
});
