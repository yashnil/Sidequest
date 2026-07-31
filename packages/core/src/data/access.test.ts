import { describe, expect, it } from 'vitest';
import { EASTERN_SIERRA_ACCESS, placesWithoutAccessRules } from './index';

describe('access dataset', () => {
  it('parses and covers every seeded place', () => {
    expect(EASTERN_SIERRA_ACCESS.rules.length).toBeGreaterThan(0);
    expect(placesWithoutAccessRules()).toEqual([]);
  });
});
