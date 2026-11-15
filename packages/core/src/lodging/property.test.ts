import { describe, expect, it } from 'vitest';
import { isNotAProperty } from './property';

describe('a listing filed under lodging that is not somewhere to sleep (final pass)', () => {
  it('refuses another trade unless the name also says it sleeps people', () => {
    expect(isNotAProperty('Arusha Website Design')).toBe(true);
    expect(isNotAProperty('Kilimanjaro Software Solutions')).toBe(true);
    expect(isNotAProperty('The Design Hotel')).toBe(false);
    expect(isNotAProperty('Shamba Lodge Arusha')).toBe(false);
    expect(isNotAProperty('Rich Hotel')).toBe(false);
  });
  it('refuses a row that is only its own town, never a property that carries the town in its name', () => {
    expect(isNotAProperty('Les Houches', { locality: 'Les Houches' })).toBe(true);
    expect(isNotAProperty('Hotel Les Houches', { locality: 'Les Houches' })).toBe(false);
    expect(isNotAProperty('Gite Michel Fagot', { locality: 'Les Houches' })).toBe(false);
  });
});
