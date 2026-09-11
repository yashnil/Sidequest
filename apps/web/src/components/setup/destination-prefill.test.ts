import { describe, expect, it } from 'vitest';
import { destinationPrefillFrom, scopeWords } from './destination-prefill';

describe('destinationPrefillFrom', () => {
  it('reads a plain destination from the query', () => {
    expect(destinationPrefillFrom({ destination: 'Kenya and Tanzania' })).toBe('Kenya and Tanzania');
  });

  it('takes the first value when the parameter repeats', () => {
    expect(destinationPrefillFrom({ destination: ['Japan', 'Peru'] })).toBe('Japan');
  });

  it('collapses whitespace and trims', () => {
    expect(destinationPrefillFrom({ destination: '  the   steppes \n' })).toBe('the steppes');
  });

  it('ignores anything too short to be a place and anything absent', () => {
    expect(destinationPrefillFrom({ destination: 'x' })).toBeNull();
    expect(destinationPrefillFrom({ destination: '   ' })).toBeNull();
    expect(destinationPrefillFrom({})).toBeNull();
    expect(destinationPrefillFrom({ destination: undefined })).toBeNull();
  });

  it('bounds the length so a pasted paragraph cannot become the field', () => {
    const long = 'a'.repeat(400);
    expect(destinationPrefillFrom({ destination: long })?.length).toBe(120);
  });
});

describe('scopeWords', () => {
  it('says the scope in human words for the kinds it knows', () => {
    expect(scopeWords('country')).toBe('A whole country');
    expect(scopeWords('municipality')).toBe('A city and its region');
    expect(scopeWords('national_park')).toBe('A national park');
    expect(scopeWords('CITY')).toBe('A city');
  });

  it('says nothing for an unknown or missing kind — never the source vocabulary', () => {
    expect(scopeWords('administrative_boundary_level_7')).toBeNull();
    expect(scopeWords(null)).toBeNull();
    expect(scopeWords(undefined)).toBeNull();
    expect(scopeWords('')).toBeNull();
  });
});
