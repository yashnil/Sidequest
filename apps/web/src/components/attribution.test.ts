import { describe, expect, it } from 'vitest';
import { compactAttribution } from './DestinationImage';

describe('compactAttribution', () => {
  it('keeps the creator and licence, in the short form a credit line uses', () => {
    expect(compactAttribution('Diego Delso, Creative Commons Attribution-ShareAlike 3.0, Wikimedia Commons')).toBe('Diego Delso, CC BY-SA 3.0');
    expect(compactAttribution('M.Peinado, Creative Commons Attribution 2.0, Wikimedia Commons')).toBe('M.Peinado, CC BY 2.0');
    expect(compactAttribution('Unknown author, public domain')).toBe('Unknown author, public domain');
  });
});
