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

/**
 * V1 CONVERGENCE — EVERY LINE IS ABOUT THIS TRIP, AND THE MODEL'S LIST IS MERGED.
 *
 * A stop's own kind can ask something of the bag (a temple, an after-dark sky),
 * the line names the stops that put it there, a line that would be true of every
 * trip on earth is not on the list, and a model packing line that repeats a
 * derived need in other words is dropped rather than shown twice.
 */
describe('V1 convergence — packing derived from the stops', () => {
  const base = (over: Partial<PackingInput> = {}): PackingInput => ({
    itinerary: ITINERARY,
    profile: profileWith(),
    categories: [],
    international: 'no',
    drives: false,
    remote: false,
    lodgingKinds: [],
    legModes: [],
    weatherBasis: 'forecast',
    children: false,
    modelPacking: [],
    ...over,
  });
  const stop = (title: string, category: string, startMinute = 600, endMinute = 690, dayNumber = 1) => ({ title, category, dayNumber, startMinute, endMinute });

  it('a place of worship on the plan asks for covered shoulders and knees, and names it', () => {
    const items = buildPackingIntelligence(base({ categories: ['historic'], activities: [stop('Golden Pavilion Temple', 'historic')] })).items;
    const cover = items.find((i) => /cover shoulders and knees/.test(i.label));
    expect(cover?.why).toMatch(/Golden Pavilion Temple/);
  });

  it('a pub called "Temple Bar" is food, not a temple', () => {
    const items = buildPackingIntelligence(base({ categories: ['food'], activities: [stop('Temple Bar', 'food')] })).items;
    expect(items.some((i) => /cover shoulders/.test(i.label))).toBe(false);
  });

  it('an after-dark outdoor stop packs a headtorch and a warm layer; an interest alone does not', () => {
    const night = buildPackingIntelligence(base({ categories: ['viewpoint'], activities: [stop('Dark Sky Stargazing at the Rim', 'viewpoint', 1290, 1380, 3)] })).items;
    expect(night.find((i) => /Headtorch/.test(i.label))?.why).toMatch(/Stargazing at the Rim/);
    expect(night.find((i) => /warm layer for after dark/i.test(i.label))?.why).toMatch(/day 3/);
    const interestOnly = buildPackingIntelligence(base({ profile: profileWith({ stargazing: 'core' }), categories: ['museum'], activities: [stop('City Museum', 'museum')] })).items;
    expect(interestOnly.some((i) => /headtorch/i.test(i.label))).toBe(false);
  });

  it('hiking and beach lines name the stops that put them on the list', () => {
    const items = buildPackingIntelligence(base({ categories: ['hike', 'beach'], activities: [stop('Skyline Trail', 'hike'), stop('Sandy Cove', 'beach', 800, 900, 2)] })).items;
    expect(items.find((i) => /hiking boots/.test(i.label))?.why).toMatch(/Skyline Trail/);
    expect(items.find((i) => /Swimwear/.test(i.label))?.why).toMatch(/Sandy Cove/);
  });

  it('a domestic museum weekend carries no line that every trip on earth would', () => {
    const labels = buildPackingIntelligence(base({ categories: ['museum', 'neighbourhood'], activities: [stop('City Museum', 'museum')] })).items.map((i) => i.label);
    for (const generic of [/^Phone charger/, /^Small first-aid kit$/, /^Comfortable walking shoes$/, /^Prescription medicines/]) {
      expect(labels.some((l) => generic.test(l)), `${generic} is on a list it says nothing about`).toBe(false);
    }
  });

  it('merges the model’s list: a line naming a need already covered is dropped, a new need is kept once', () => {
    const result = buildPackingIntelligence(base({ categories: ['hike'], weatherBasis: 'climate', modelPacking: ['Rain jacket', 'Sturdy hiking boots', 'Reusable water bottle', 'A paperback for the ferry', 'a paperback for the ferry', 'Sunscreen and a hat'] }));
    expect(result.items.some((i) => /Waterproof shell/.test(i.label))).toBe(true);
    expect(result.modelSuggestions).toEqual(['A paperback for the ferry', 'Sunscreen and a hat']);
  });
});
