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

/**
 * V11 §37 — THE FOUNDER'S KYRGYZSTAN PACK LIST.
 *
 * Eleven days, a three-day trek over a ~3,900 m pass with two camp nights, and
 * a private driver for every transfer. What shipped: no warm layer, no
 * insulating layer, no gloves, poles and headtorch marked *optional*, and a
 * transit pass.
 */
describe('V11 §37 — a multi-day trek packs like one', () => {
  const trekInput = () =>
    ({
      itinerary: {
        /* The base towns' own weather, which is what the days actually carry: a mild valley. */
        days: [1, 2, 3].map((dayNumber) => ({ dayNumber, weather: { temperatureMinC: 12, temperatureMaxC: 22 } })),
        transportStrategy: { primaryMode: 'private_transfer' },
      },
      profile: profileWith({ hiking: 'core' }),
      categories: ['hike', 'lake', 'viewpoint'],
      international: 'yes' as const,
      drives: false,
      remote: true,
      lodgingKinds: ['camp' as const],
      legModes: ['private_transfer', 'walk', 'four_wheel_drive'],
      weatherBasis: 'climate' as const,
      children: false,
      strenuous: true,
      modelPacking: [],
      episodeKinds: ['trek', 'guided_overland'],
    }) as unknown as Parameters<typeof buildPackingIntelligence>[0];

  const labels = () => buildPackingIntelligence(trekInput()).items.map((item) => item.label.toLowerCase());
  const item = (needle: string) => buildPackingIntelligence(trekInput()).items.find((entry) => entry.label.toLowerCase().includes(needle));

  it('packs warm and insulating layers even though the recorded temperatures are the valley’s', () => {
    expect(labels().some((label) => label.includes('warm layers'))).toBe(true);
    expect(labels().some((label) => label.includes('insulating layer and gloves'))).toBe(true);
  });

  it('packs a waterproof shell for the pass', () => {
    expect(labels().some((label) => label.includes('waterproof shell'))).toBe(true);
  });

  it('does not call poles or a headtorch optional on a multi-day crossing', () => {
    expect(item('trekking poles')?.optional).toBe(false);
    expect(item('headtorch')?.optional).toBe(false);
  });

  it('does not pack a transit pass for a trip whose every transfer is a private driver', () => {
    expect(labels().some((label) => label.includes('transit pass'))).toBe(false);
  });

  it('still packs a transit pass when transit really is how the trip moves', () => {
    const base = trekInput();
    const transit = { ...base, itinerary: { ...base.itinerary, transportStrategy: { primaryMode: 'rail' } } } as unknown as Parameters<typeof buildPackingIntelligence>[0];
    expect(buildPackingIntelligence(transit).items.some((entry) => entry.label.toLowerCase().includes('transit pass'))).toBe(true);
  });

  it('does not put mountain layers on a trip with no trek and no camps', () => {
    const city = { ...trekInput(), episodeKinds: [], lodgingKinds: ['hotel' as const], categories: ['museum', 'food'], strenuous: false };
    expect(buildPackingIntelligence(city).items.some((entry) => entry.label.toLowerCase().includes('insulating layer'))).toBe(false);
  });
});
