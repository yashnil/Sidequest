import { describe, expect, it } from 'vitest';
import { countryFromText } from './countries';

describe('countryFromText', () => {
  it('places obvious countries', () => {
    for (const [text, place] of [['Japan', 'Tokyo'], ['japan', 'Tokyo'], ['Iceland', 'Reykjavík'], ['Kyrgyzstan', 'Bishkek'], ['France', 'Paris'], ['Brazil', 'São Paulo'], ['Hong Kong', 'Hong Kong'], ['USA', 'New York'], ['the netherlands', 'Amsterdam'], ['Türkiye', 'Istanbul'], ['Turkey', 'Istanbul']] as const) {
      expect(countryFromText(text)?.point.place, text).toBe(place);
    }
  });
  it('places a country named inside a short phrase', () => {
    expect(countryFromText('rural Japan')?.point.place).toBe('Tokyo');
    expect(countryFromText('the steppes of Kyrgyzstan')?.point.place).toBe('Bishkek');
    expect(countryFromText('rural Japan')?.how).toBe('phrase');
  });
  it('refuses what it does not know, rather than guessing', () => {
    for (const text of ['New York City', 'Patagonia', 'Okavango Delta', 'inland Alaska', '', 'zzzz', 'a very long sentence about where I would like to go this year']) {
      expect(countryFromText(text), text).toBeNull();
    }
  });
  it('refuses an ambiguous phrase naming two countries', () => {
    expect(countryFromText('Japan and Korea')).toBeNull();
  });
});
