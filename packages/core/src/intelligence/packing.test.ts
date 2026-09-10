import { describe, expect, it } from 'vitest';
import { buildPackingIntelligence, type PackingInput } from './packing';
import { buildTravelerProfile, defaultAnswers } from '../questionnaire/transform';
import type { Interest, InterestLevel } from '../schemas/common';
import type { Itinerary } from '../schemas/itinerary';

/**
 * PACKING ADVICE IS ABOUT THIS TRIP, NOT ABOUT A CATEGORY.
 *
 * PRODUCTION LOCK V5 §22/§26. A live Hong Kong build — food, markets and
 * neighbourhoods, on foot and by transit — packed "swimwear and a quick-dry
 * towel". Its only `water` stop was the Star Ferry, which is a harbour
 * crossing: transport, not swimming. Nobody on that trip gets in the water.
 *
 * The rule this states: a beach and a geothermal pool are places somebody
 * swims, so they stand on their own; a plain `water` stop counts only when the
 * traveller said swimming matters to them.
 */

function profileWith(interests: Partial<Record<Interest, InterestLevel>> = {}) {
  const answers = defaultAnswers({ travelerNeeds: [], tripDays: 6 });
  const profile = buildTravelerProfile(answers, { travelerNeeds: [], tripDays: 6 });
  return { ...profile, interests: { ...profile.interests, ...interests } };
}

const ITINERARY = { days: [] } as unknown as Itinerary;

function packing(categories: string[], interests: Partial<Record<Interest, InterestLevel>> = {}) {
  const input: PackingInput = {
    itinerary: ITINERARY,
    profile: profileWith(interests),
    categories,
    international: 'unknown',
    drives: false,
    remote: false,
    lodgingKinds: [],
    legModes: [],
    weatherBasis: 'climate',
    children: false,
    modelPacking: [],
  };
  return buildPackingIntelligence(input).items.map((item) => item.label);
}

describe('swimwear needs a swimming signal', () => {
  it('is not packed for a ferry crossing on a city trip', () => {
    /* The Star Ferry is `water`. It is a way across the harbour. */
    expect(packing(['water', 'market', 'neighbourhood', 'food'])).not.toContain('Swimwear and a quick-dry towel');
  });

  it('is packed for a beach', () => {
    expect(packing(['beach', 'town'])).toContain('Swimwear and a quick-dry towel');
  });

  it('is packed for a geothermal pool', () => {
    expect(packing(['geothermal', 'nature'])).toContain('Swimwear and a quick-dry towel');
  });

  it('is packed for a plain water stop when the traveller said swimming matters', () => {
    expect(packing(['water', 'town'], { beaches_and_swimming: 'core' })).toContain('Swimwear and a quick-dry towel');
  });
});
