import { describe, expect, it } from 'vitest';
import { interestOfferFromEntityType } from '../interests/offer';
import type { Interest, InterestLevel } from '../schemas/common';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { defaultAnswers } from '../questionnaire/transform';
import { OPERATING_MODE_QUESTIONS, questionById, type InterviewContext } from './catalog';
import { diagnoseTrip } from './diagnosis';
import { planInterview } from './selector';
import { withScreening } from './state';
import { screenDestination, type ScreeningSignals } from './traits';
import { buildTravelReality } from '../reality/build';
import { withTravelReality } from '../reality/interview';

/**
 * V12.1 §30 §46 — THE SAME GROUND, TWO DIFFERENT TRIPS, TWO DIFFERENT INTAKES.
 *
 * This is the test §25 is really asking for: *"The user should notice: Sidequest
 * asks different questions for different journeys."* Before this pass every
 * traveller got the same questions in the same order whatever they had said they
 * wanted, because the intake never read the intent it was collecting.
 *
 * Every shape below is a set of **screening signals and interest roles**, never
 * a destination name in the code under test — the last test in the file holds
 * that. The cases are named after real places because a test has to be about
 * something, and because §30 names them.
 *
 * What is asserted is the *set of follow-ups*, not the wording. §30: "Do not
 * assert exact wording if not needed."
 */

function contextFor(signals: Partial<ScreeningSignals> & { name: string; tripDays: number }): InterviewContext {
  const destination = screenDestination({ ...signals });
  const offer = interestOfferFromEntityType(signals.entityType ?? 'unknown');
  return { destination, traveller: { travelerNeeds: [], tripDays: signals.tripDays, adults: 2, children: 0, offeredInterests: offer.interests, carried: [] } };
}

/**
 * A traveller who has answered the priorities screen and nothing else.
 *
 * `interestRoles` as well as `interests`, because that is what makes the role
 * **stated** rather than inferred, and `intentIsSpecified` — the gate that keeps
 * operating-mode questions off a blank interview — reads the basis, not the
 * level.
 */
const ROLE_FOR: Record<string, 'build_around' | 'most_days' | 'couple' | 'once'> = { core: 'build_around', frequent: 'most_days', occasional: 'couple', low: 'once', avoid: 'once' };

function traveller(ctx: InterviewContext, roles: Partial<Record<Interest, InterestLevel>>, over: Partial<QuestionnaireAnswers> = {}): QuestionnaireAnswers {
  const base = withScreening(defaultAnswers({ travelerNeeds: [], tripDays: ctx.traveller.tripDays }), ctx.destination);
  const stated = Object.fromEntries(Object.entries(roles).map(([interest, level]) => [interest, ROLE_FOR[level as string] ?? 'couple']));
  return {
    ...base,
    interests: { ...base.interests, ...roles },
    interestRoles: { ...(base.interestRoles ?? {}), ...stated },
    ...over,
    provenance: { ...base.provenance, priorities: { source: 'explicit', strength: 'strong', confidence: 1 }, priority_roles: { source: 'explicit', strength: 'strong', confidence: 1 }, ...(over.provenance ?? {}) },
  } as QuestionnaireAnswers;
}

/** The operating-mode follow-ups this trip earns, by id. */
function followUps(ctx: InterviewContext, answers: QuestionnaireAnswers): string[] {
  const bank = new Set(OPERATING_MODE_QUESTIONS.map((question) => question.id));
  return planInterview({ ctx, answers, mode: 'deep' })
    .questions.filter((question) => bank.has(question.id) && !question.hidden && question.score > 0)
    .map((question) => question.id)
    .sort();
}

/** Every question the walked interview would show, for counting what was avoided. */
function shown(ctx: InterviewContext, answers: QuestionnaireAnswers): string[] {
  return planInterview({ ctx, answers }).shown;
}

// ── the grounds ────────────────────────────────────────────────────────────

const city = (days: number) =>
  contextFor({ name: 'Riverine Capital', tripDays: days, entityType: 'city', breadth: 'city', featureType: 'city', population: 2_150_000, prominence: 98, center: { lat: 48.86, lng: 2.35 }, startDate: '2026-06-10' });

/** A high mountain region inside a protected area: screened as mountain, remote and wilderness. */
const andes = (days: number) =>
  contextFor({
    name: 'High Cordillera',
    tripDays: days,
    entityType: 'protected_area',
    breadth: 'region',
    featureType: 'national_park',
    center: { lat: -13.5, lng: -71.97 },
    semantic: { type: 'mountain_region', scale: 'region' },
    compiled: { placeCount: 40, maxElevationMetres: 3400 },
    startDate: '2026-07-01',
  });

/** A rail-served country: transit-rich, no car in the scope. */
const cantons = (days: number) =>
  contextFor({
    name: 'Lakeshore Cantons',
    tripDays: days,
    entityType: 'country',
    breadth: 'country',
    featureType: 'country',
    population: 8_700_000,
    center: { lat: 46.8, lng: 8.2 },
    scopeTransport: { primaryMode: 'rail', allowedModes: ['rail', 'walk', 'ferry'], carAvailable: false },
    startDate: '2026-07-04',
  });

const atolls = (days: number) =>
  contextFor({
    name: 'Coral Atolls',
    tripDays: days,
    entityType: 'country',
    breadth: 'country',
    featureType: 'country',
    center: { lat: 3.2, lng: 73.2 },
    bounds: { southWest: { lat: -0.7, lng: 72.6 }, northEast: { lat: 7.1, lng: 73.7 } },
    semantic: { type: 'island_group', scale: 'country' },
    offerClasses: ['coastal'],
    startDate: '2026-02-08',
  });

const rockies = (days: number) =>
  contextFor({
    name: 'Cordilleran Parks',
    tripDays: days,
    entityType: 'subregion',
    breadth: 'region',
    featureType: 'region',
    center: { lat: 51.4, lng: -116.2 },
    bounds: { southWest: { lat: 50.6, lng: -118 }, northEast: { lat: 52.9, lng: -114.9 } },
    semantic: { type: 'mountain_region', scale: 'region' },
    compiled: { placeCount: 60, carOnlyShare: 0.7 },
    startDate: '2026-08-02',
  });

describe('one destination, several trips', () => {
  describe('a capital city', () => {
    const ctx = city(5);

    it('an art-and-history trip and a food-and-nightlife trip are not the same interview', () => {
      const art = traveller(ctx, { museums_and_galleries: 'core', history_and_culture: 'core' });
      const food = traveller(ctx, { food_and_towns: 'core', markets_and_street_food: 'frequent' }, { lateNights: 'fine' });
      expect(shown(ctx, art)).not.toEqual(shown(ctx, food));
    });

    it('a family trip is not the same interview as either', () => {
      const family = contextFor({ ...{ name: 'Riverine Capital', tripDays: 5, entityType: 'city', breadth: 'city', featureType: 'city', population: 2_150_000, center: { lat: 48.86, lng: 2.35 } } });
      const withChildren: InterviewContext = { ...family, traveller: { ...family.traveller, children: 2, adults: 2 } };
      const kids = traveller(withChildren, { easy_nature_walks: 'core', history_and_culture: 'occasional' });
      const art = traveller(ctx, { museums_and_galleries: 'core', history_and_culture: 'core' });
      expect(shown(withChildren, kids)).not.toEqual(shown(ctx, art));
    });

    it('asks a budget traveller moving between cities about overnight transport, and nobody else', () => {
      const backpacker = traveller(city(10), { neighbourhoods_and_local_life: 'core', markets_and_street_food: 'frequent' }, { budgetStyle: 'budget', lodgingStyle: 'hostel', rusticLodgingOk: true, willDrive: false });
      expect(followUps(city(10), backpacker)).toContain('overnight_transport');
      const art = traveller(ctx, { museums_and_galleries: 'core', history_and_culture: 'core' }, { budgetStyle: 'premium', rusticLodgingOk: false });
      expect(followUps(ctx, art)).not.toContain('overnight_transport');
    });

    it('never asks a city traveller where they sleep on a trail', () => {
      const art = traveller(ctx, { museums_and_galleries: 'core', history_and_culture: 'core' });
      expect(followUps(ctx, art)).not.toContain('trek_nights');
      expect(followUps(ctx, art)).not.toContain('wildlife_vehicle');
      expect(followUps(ctx, art)).not.toContain('resort_shape');
    });
  });

  describe('a high mountain region', () => {
    const ctx = andes(12);

    it('asks a trekker about the nights on the route and the load', () => {
      const trek = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', rusticLodgingOk: true, hikeAppetite: 'full_day', trailSetting: 'backcountry', willDrive: false });
      const asked = followUps(ctx, trek);
      expect(asked).toContain('trek_nights');
      expect(asked).toContain('trek_load');
    });

    it('does not ask the same traveller about resort splits or rail passes', () => {
      const trek = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', rusticLodgingOk: true, hikeAppetite: 'full_day', willDrive: false });
      const asked = followUps(ctx, trek);
      expect(asked).not.toContain('resort_shape');
      expect(asked).not.toContain('rail_booking');
    });

    it('asks a comfortable-culture traveller on the same ground a different set', () => {
      const culture = traveller(ctx, { history_and_culture: 'core', food_and_towns: 'frequent' }, { budgetStyle: 'premium', rusticLodgingOk: false, dailyIntensity: 'light', hikeAppetite: 'short' });
      const trek = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', rusticLodgingOk: true, hikeAppetite: 'full_day', trailSetting: 'backcountry', willDrive: false });
      expect(followUps(ctx, culture)).not.toEqual(followUps(ctx, trek));
      expect(shown(ctx, culture)).not.toEqual(shown(ctx, trek));
    });

  });

  describe('a rail-served country', () => {
    const ctx = cantons(10);

    it('asks how the long train legs should be booked', () => {
      const rail = traveller(ctx, { history_and_culture: 'core', scenic_viewpoints: 'frequent' }, { willDrive: false });
      expect(followUps(ctx, rail)).toContain('rail_booking');
    });

    it('does not ask a trekker’s questions of a rail traveller', () => {
      const rail = traveller(ctx, { history_and_culture: 'core', scenic_viewpoints: 'frequent' }, { willDrive: false });
      const asked = followUps(ctx, rail);
      expect(asked).not.toContain('trek_nights');
      expect(asked).not.toContain('wildlife_vehicle');
    });
  });

  describe('an archipelago', () => {
    const ctx = atolls(8);

    it('asks a relaxation traveller about the shape of the stay, not about gear', () => {
      const relax = traveller(ctx, { beaches_and_swimming: 'core' }, { budgetStyle: 'premium', rusticLodgingOk: false, dailyIntensity: 'light', freeTime: 'lots', willDrive: false });
      const asked = followUps(ctx, relax);
      expect(asked).toContain('resort_shape');
      expect(asked).toContain('resort_balance');
      expect(asked).not.toContain('trek_load');
    });

    it('asks a diving-and-wildlife traveller how many islands instead', () => {
      const relax = traveller(ctx, { beaches_and_swimming: 'core' }, { budgetStyle: 'premium', rusticLodgingOk: false, dailyIntensity: 'light', freeTime: 'lots', willDrive: false });
      const diving = traveller(ctx, { beaches_and_swimming: 'core', wildlife: 'core' }, { dailyIntensity: 'moderate', freeTime: 'packed', willDrive: false });
      expect(followUps(ctx, diving)).toContain('island_count');
      expect(followUps(ctx, relax)).not.toEqual(followUps(ctx, diving));
    });
  });

  describe('a mountain park region', () => {
    const ctx = rockies(9);

    it('a serious-hiking trip and a family road trip are not the same interview', () => {
      const hiker = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', hikeAppetite: 'full_day', willDrive: true });
      const withChildren: InterviewContext = { ...ctx, traveller: { ...ctx.traveller, children: 2 } };
      const family = traveller(withChildren, { scenic_drives: 'core', easy_nature_walks: 'frequent' }, { dailyIntensity: 'light', hikeAppetite: 'short', willDrive: true });
      expect(shown(ctx, hiker)).not.toEqual(shown(withChildren, family));
    });

    it('never asks either of them about ferries between islands', () => {
      const hiker = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', willDrive: true });
      expect(followUps(ctx, hiker)).not.toContain('island_count');
    });
  });
});

describe('the questions are earned, not scattered', () => {
  it('asks nothing operating-specific before the traveller has said what the trip is for', () => {
    /* §29's other side: with no stated priority, no family has evidence and none of its questions is worth a screen. */
    const ctx = andes(10);
    const blank = withScreening(defaultAnswers({ travelerNeeds: [], tripDays: 10 }), ctx.destination);
    expect(followUps(ctx, blank)).toEqual([]);
  });

  it('asks at most a handful even on the most specific trip', () => {
    const ctx = andes(12);
    const trek = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', rusticLodgingOk: true, hikeAppetite: 'full_day', trailSetting: 'backcountry', willDrive: false });
    expect(followUps(ctx, trek).length).toBeLessThanOrEqual(4);
  });

  it('names no destination and no operating family in anything a traveller reads', () => {
    const ctx = andes(12);
    const trek = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', rusticLodgingOk: true });
    for (const question of OPERATING_MODE_QUESTIONS) {
      const text = [question.prompt(ctx, trek), question.why(ctx), ...(question.options?.(ctx, trek) ?? []).flatMap((option) => [option.label, option.detail ?? ''])].join(' ');
      for (const forbidden of ['operating model', 'multi_day_trek', 'resort_stay', 'island_hopping', 'rail_journey', 'guided_wildlife', 'overland_backpacking', 'mixed_regional', 'archetype']) {
        expect(text.toLowerCase(), `${question.id} says "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });
});

describe('the diagnosis itself', () => {
  it('reads a stated trekking intent on mountain ground as a trek', () => {
    const ctx = andes(12);
    const trek = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', rusticLodgingOk: true, hikeAppetite: 'full_day', willDrive: false });
    expect(diagnoseTrip(ctx, trek).type).toBe('multi_day_trek');
  });

  it('reads the same ground with a cultural intent as something else', () => {
    const ctx = andes(12);
    const culture = traveller(ctx, { history_and_culture: 'core', museums_and_galleries: 'frequent' }, { budgetStyle: 'premium', rusticLodgingOk: false, dailyIntensity: 'light' });
    expect(diagnoseTrip(ctx, culture).type).not.toBe('multi_day_trek');
  });

  it('is stable while nothing changes and recomputes when something does', () => {
    const ctx = andes(12);
    const answers = traveller(ctx, { hiking: 'core' }, { dailyIntensity: 'intense', willDrive: false });
    expect(diagnoseTrip(ctx, answers)).toBe(diagnoseTrip(ctx, answers));
    const changed = traveller(ctx, { wildlife: 'core' }, { dailyIntensity: 'light', willDrive: false, guideWillingness: 'prefer' });
    expect(diagnoseTrip(ctx, changed).type).not.toBe(diagnoseTrip(ctx, answers).type);
  });
});

/**
 * V12.1 §12 — A RAIL COUNTRY HAS TO BE ABLE TO OFFER RAIL.
 *
 * Found by the fixture dry run of the §49 live acceptance, before a paid call
 * rather than after one: a ten-day trip to Japan was offered exactly two ways of
 * getting around — **"Rent a car"** and **"A mix"**. The Shinkansen is
 * `recommended` in the country's compiled reality and there was no way to choose
 * it.
 *
 * The transport options required `urbanTransit && regionalRail`, and `urban` is
 * populated only where the screening read the destination as urban. A whole
 * country typed as one phrase is not read that way, so the country's own
 * *regional* answer was discarded because nothing had been established about its
 * cities — our gap in reading the ground, turned into a restriction on the
 * traveller.
 */
/** The country's own compiled reality, built the way `travelRealityFor` builds it. */
function realityFor(ctx: InterviewContext) {
  return buildTravelReality({
    label: ctx.destination.proseName,
    countries: ['JP'],
    crossBorder: false,
    entityType: 'country',
    traits: ctx.destination.traits,
    tripDays: ctx.traveller.tripDays,
  });
}

describe('a country whose backbone is rail', () => {
  const railCountry = (): InterviewContext =>
    contextFor({
      name: 'Rail Republic',
      tripDays: 10,
      entityType: 'country',
      breadth: 'country',
      featureType: 'country',
      center: { lat: 36.57, lng: 139.24 },
      countryCode: 'JP',
      countries: ['JP'],
      startDate: '2026-10-10',
    });

  function transportOptions(ctx: InterviewContext, answers: QuestionnaireAnswers): string[] {
    const question = questionById(ctx, answers, 'transport_mode')!;
    return (question.options?.(ctx, answers) ?? []).map((option) => option.value);
  }

  it('offers trains even when nothing established how urban it is', () => {
    const ctx = withTravelReality(railCountry().destination, realityFor(railCountry()));
    const full: InterviewContext = { ...railCountry(), destination: ctx };
    const answers = traveller(full, { food_and_towns: 'core', history_and_culture: 'frequent' });
    const options = transportOptions(full, answers);
    expect(options, `offered: ${options.join(', ')}`).toContain('rail_transfers');
  });

  it('does not make a hire car the only real answer', () => {
    const ctx = withTravelReality(railCountry().destination, realityFor(railCountry()));
    const full: InterviewContext = { ...railCountry(), destination: ctx };
    const answers = traveller(full, { food_and_towns: 'core' });
    const options = transportOptions(full, answers);
    expect(options.filter((value) => value !== 'rent_car' && value !== 'mixed').length).toBeGreaterThan(0);
  });
});
