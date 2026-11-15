import { describe, expect, it } from 'vitest';
import { ASSUMED_PARTY, describePartyCounts, partyFromSaved, readPartyFromText, resolveParty } from './resolve';

describe('readPartyFromText — who is going, from their own words', () => {
  it.each([
    ['for my family of four', { adults: 2, children: 2 }],
    ['family of 3 with our 2 kids', { adults: 1, children: 2 }],
    ['travelling solo', { adults: 1, children: 0 }],
    ['just me this time', { adults: 1, children: 0 }],
    ['the two of us', { adults: 2, children: 0 }],
    ['with my partner', { adults: 2, children: 0 }],
    ['6 friends from university', { adults: 6, children: 0 }],
    ['for 3 people', { adults: 3, children: 0 }],
  ])('reads "%s"', (text, party) => {
    const reading = readPartyFromText(text);
    expect(reading).toMatchObject({ ...party, complete: true });
  });

  it('reads children without adults as incomplete, and says nothing when nothing is said', () => {
    expect(readPartyFromText('Tokyo and Kyoto with our 2 kids')).toMatchObject({ children: 2, complete: false });
    expect(readPartyFromText('Tokyo and Kyoto in 10 days')).toBeNull();
    expect(readPartyFromText('a 10 day trip')).toBeNull();
  });
});

describe('resolveParty — never a silent two adults', () => {
  it('takes a party chosen on a screen first, then words, then saved travellers', () => {
    expect(resolveParty({ explicit: { adults: 3, children: 1 }, texts: ['solo'] })).toMatchObject({ adults: 3, children: 1, basis: 'stated', needsQuestion: false });
    expect(resolveParty({ texts: ['for my family of four'], saved: { travellers: [{ ageGroup: 'adult' }] } })).toMatchObject({ adults: 2, children: 2, basis: 'stated' });
    expect(resolveParty({ texts: ['Rome and Florence'], saved: { travellers: [{ ageGroup: 'adult' }, { ageGroup: 'child' }] } })).toMatchObject({ adults: 1, children: 1, basis: 'profile', needsQuestion: false });
  });

  it('assumes only when nothing says, labels it, and asks the one question', () => {
    const unknown = resolveParty({ texts: ['Rome and Florence'] });
    expect(unknown).toMatchObject({ ...ASSUMED_PARTY, basis: 'assumed', needsQuestion: true });
    expect(describePartyCounts(unknown)).toBe('2 adults (assumed)');
    expect(describePartyCounts({ adults: 1, children: 0, basis: 'stated' })).toBe('1 adult');
  });

  it('keeps partial words (children) inside the assumption', () => {
    expect(resolveParty({ texts: ['with our 3 kids'] })).toMatchObject({ adults: 2, children: 3, basis: 'assumed', needsQuestion: true });
  });

  it('reads saved travellers by age group', () => {
    expect(partyFromSaved({ travellers: [] })).toBeNull();
    expect(partyFromSaved({ travellers: [{ ageGroup: 'adult' }, { ageGroup: 'senior' }, { ageGroup: 'infant' }] })).toMatchObject({ adults: 2, children: 1 });
  });
});
