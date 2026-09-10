import { describe, expect, it } from 'vitest';
import { DIETARY_NEED_LABELS } from '../schemas/food';
import { FUNCTIONAL_NEEDS, NEED_CONSEQUENCES, PLANNING_CONSEQUENCES, STRENUOUS_BLOCKERS, dietaryRulesOf, travelerSchema } from './traveler';

/** V6 §4 — every need maps to a planning consequence, and nothing here is a diagnosis. */
describe('functional needs', () => {
  it('every need has at least one planning consequence from the known list', () => {
    for (const need of FUNCTIONAL_NEEDS) {
      expect(NEED_CONSEQUENCES[need].length, need).toBeGreaterThan(0);
      for (const consequence of NEED_CONSEQUENCES[need]) expect(PLANNING_CONSEQUENCES).toContain(consequence);
    }
  });
  it('the strenuous blockers are needs, and no need reads as a medical term', () => {
    for (const need of STRENUOUS_BLOCKERS) expect(FUNCTIONAL_NEEDS).toContain(need);
    for (const need of FUNCTIONAL_NEEDS) expect(need).not.toMatch(/diagnos|disease|disorder|syndrome|condition/);
  });
  it('a traveller parses with defaults, and an allergy is strict whatever the box said', () => {
    const traveler = travelerSchema.parse({ id: 't', version: 1, displayName: 'Noor', diet: { needs: ['nut_allergy', 'no_pork'], strict: false }, createdAt: 'x', updatedAt: 'x' });
    const rules = dietaryRulesOf(traveler.diet, DIETARY_NEED_LABELS);
    expect(rules.find((r) => /nut/i.test(r.label))?.strict).toBe(true);
    expect(rules.find((r) => /pork/i.test(r.label))?.strict).toBe(false);
    expect(traveler.privacy.hideFromPrint).toBe(false);
  });
});
