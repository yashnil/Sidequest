import { describe, expect, it } from 'vitest';
import { tripHomeHref } from './trip-home';

describe('tripHomeHref', () => {
  it('goes to the itinerary when a plan exists', () => {
    expect(tripHomeHref('t1', true)).toBe('/trips/t1/itinerary');
  });
  it('goes to the interview when nothing is built, never to /plan', () => {
    expect(tripHomeHref('t1', false)).toBe('/trips/t1/questionnaire');
    expect(tripHomeHref('t1', false)).not.toContain('/plan');
  });
});
