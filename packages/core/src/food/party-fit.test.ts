import { describe, expect, it } from 'vitest';
import { describePartyFit, partyVenueFit } from './party-fit';

/** V6 §16 — the worked example from the spec: A no beef/no pork, B vegetarian with eggs, C a severe peanut allergy. */
const party = [
  { name: 'A', needs: ['no_beef', 'no_pork'] as const, strict: true },
  { name: 'B', needs: ['vegetarian'] as const, strict: false },
  { name: 'C', needs: ['nut_allergy'] as const, strict: true },
];

describe('per-person restaurant fit', () => {
  it('a steakhouse conflicts for A and B, and never claims safety for C', () => {
    const fit = partyVenueFit(party, { types: ['steak_house', 'restaurant'] });
    expect(fit.perPerson.map((p) => [p.name, p.fit])).toEqual([['A', 'conflict'], ['B', 'conflict'], ['C', 'unknown']]);
    expect(fit.overall).toBe('conflict');
    expect(describePartyFit(fit)).toMatch(/Not for A or B/);
  });
  it('a vegetarian restaurant fits A and B, and C stays unknown until the kitchen publishes nut handling', () => {
    const fit = partyVenueFit(party, { types: ['vegetarian_restaurant'], claims: ['vegetarian'] });
    expect(fit.perPerson.find((p) => p.name === 'A')?.fit).toBe('fits');
    expect(fit.perPerson.find((p) => p.name === 'B')?.fit).toBe('fits');
    expect(fit.perPerson.find((p) => p.name === 'B')?.publishedEvidence).toBe(true);
    expect(fit.perPerson.find((p) => p.name === 'C')?.fit).toBe('unknown');
    expect(fit.askTheKitchen).toBe(true);
    expect(describePartyFit(fit)).toMatch(/Ask the kitchen for C/);
  });
  it('a published nut-free claim makes C fit — on published evidence, never on inference', () => {
    const fit = partyVenueFit(party, { types: ['vegetarian_restaurant'], claims: ['vegetarian', 'nut_free'] });
    const c = fit.perPerson.find((p) => p.name === 'C')!;
    expect(c.fit).toBe('fits');
    expect(c.publishedEvidence).toBe(true);
    expect(describePartyFit(fit)).toMatch(/published claims/);
  });
  it('a soft preference at an ordinary place fits without a claim; a strict one is unknown', () => {
    const soft = partyVenueFit([{ name: 'D', needs: ['no_pork'], strict: false }], { types: ['ramen_restaurant'] });
    expect(soft.overall).toBe('fits');
    const strict = partyVenueFit([{ name: 'E', needs: ['halal'], strict: true }], { types: ['ramen_restaurant'] });
    expect(strict.overall).toBe('unknown');
    expect(strict.askTheKitchen).toBe(true);
  });
});
