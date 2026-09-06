import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultAnswers } from '../questionnaire/transform';
import { interestOfferFromEntityType } from '../interests/offer';
import { INTEREST_LABELS, type Interest } from '../schemas/common';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { FIRST_SCREEN_INTERESTS, INTEREST_FAMILY, MAX_PER_FAMILY, priorityOffer, questionById, type InterviewContext } from './catalog';
import { SHAPES } from './interview.test';
import { planInterview, nextOpenQuestion } from './selector';
import { applySmartDefaults, withScreening } from './state';
import { screenDestination, type ScreeningSignals } from './traits';

/**
 * DESTINATION-AWARE INTERVIEW GLOBALITY — THE REGRESSION, THEN THE BATTERY.
 *
 * A real founder test on a seven-million-person harbour city opened its
 * interview with hiking, nature walks, lakes, scenic drives, geothermal and
 * hot springs, assumed a hire car and drew a fifty-kilometre driving radius.
 * The city had been picked from the destination index, which hands the
 * screening a feature type, a centre and (in its own row) a population; none
 * of that reached the traits, so the destination screened as nothing at all,
 * and "nothing at all" inherited the vocabulary's outdoor-first order and the
 * questionnaire's car-first defaults.
 *
 * Every shape here is a set of signals, never a name; the last test proves
 * the interview code names no destination.
 */
const NOW = new Date('2026-09-06T10:00:00Z');

function contextFor(signals: Partial<ScreeningSignals> & { name: string; tripDays: number }): InterviewContext {
  const destination = screenDestination({ ...signals });
  const offer = interestOfferFromEntityType(signals.entityType ?? 'unknown');
  return { destination, traveller: { travelerNeeds: [], tripDays: signals.tripDays, adults: 2, children: 0, offeredInterests: offer.interests, carried: [] } };
}

function fresh(ctx: InterviewContext): QuestionnaireAnswers {
  return withScreening(defaultAnswers({ travelerNeeds: [], tripDays: ctx.traveller.tripDays }), ctx.destination);
}

/** The founder's stored shape: an index pick (feature type city, population in the row), no resolver, no scope, no preflight. */
const indexCity = (): InterviewContext =>
  contextFor({ name: 'Harbour Metropolis', tripDays: 6, entityType: 'city', breadth: 'city', featureType: 'city', population: 7_534_200, prominence: 99, center: { lat: 22.28, lng: 114.16 }, startDate: '2026-10-13' });
/** The same pick before this pass: nothing but a name, a centre and a feature type. */
const indexCityUnmapped = (): InterviewContext => contextFor({ name: 'Harbour Metropolis', tripDays: 6, featureType: 'city', center: { lat: 22.28, lng: 114.16 }, startDate: '2026-10-13' });
const unknownPlace = (): InterviewContext => contextFor({ name: 'Somewhere', tripDays: 6 });
const railRegion = (): InterviewContext =>
  contextFor({ name: 'Lakeshore Cantons', proseName: 'the cantons', tripDays: 7, entityType: 'country', breadth: 'country', population: 8_700_000, bounds: { southWest: { lat: 45.8, lng: 5.9 }, northEast: { lat: 47.8, lng: 10.5 } }, center: { lat: 46.8, lng: 8.2 }, startDate: '2026-07-04', scopeTransport: { primaryMode: 'rail', allowedModes: ['rail', 'walk', 'ferry'], carAvailable: null, acceptsWaterOrAirTransfers: false } });

const OUTDOOR_MONOPOLY: Interest[] = ['lakes_and_rivers', 'scenic_drives', 'geology_and_geothermal', 'hot_springs', 'wildlife'];
const URBAN_SET: Interest[] = ['food_and_towns', 'neighbourhoods_and_local_life', 'history_and_culture', 'scenic_viewpoints', 'markets_and_street_food', 'museums_and_galleries', 'hiking', 'easy_nature_walks', 'beaches_and_swimming'];

function familiesOf(interests: readonly Interest[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const interest of interests) out.set(INTEREST_FAMILY[interest], (out.get(INTEREST_FAMILY[interest]) ?? 0) + 1);
  return out;
}

describe('the dense-city regression, reproduced and fixed', () => {
  it('BEFORE: a pick that reaches the screening as a bare name screens to nothing and inherits the outdoor-first vocabulary', () => {
    // The old page mapped no entity type from a composer pick; this is what that produced.
    const ctx = indexCityUnmapped();
    const legacyFirstScreen = ctx.traveller.offeredInterests.slice(0, 8);
    expect(legacyFirstScreen).toEqual(['hiking', 'easy_nature_walks', 'scenic_viewpoints', 'lakes_and_rivers', 'scenic_drives', 'wildlife', 'geology_and_geothermal', 'hot_springs']);
    expect(fresh(ctx).willDrive).toBe(true);
    expect(fresh(ctx).regionalExpansion).toBe('nearby_60');
  });

  it('the feature type alone now reads as a city, so even an unmapped pick is no longer an outdoor interview', () => {
    const ctx = indexCityUnmapped();
    expect(ctx.destination.traits).toContain('dense_urban');
    const first = priorityOffer(ctx, fresh(ctx));
    expect(first.filter((i) => OUTDOOR_MONOPOLY.includes(i)).length).toBeLessThanOrEqual(1);
  });

  it('AFTER: the founder shape screens as a dense, transit-rich, food-dense city and its first screen is a city trip', () => {
    const ctx = indexCity();
    for (const trait of ['dense_urban', 'transit_rich', 'walk_heavy', 'food_dense', 'nightlife_dense']) expect(ctx.destination.traits, trait).toContain(trait);
    for (const trait of ['road_trip_region', 'car_dependent', 'mountain', 'wilderness']) expect(ctx.destination.traits, trait).not.toContain(trait);
    expect(ctx.destination.evidence).toBe('screened');
    const first = priorityOffer(ctx, fresh(ctx));
    expect(first).toHaveLength(FIRST_SCREEN_INTERESTS);
    expect(first.filter((i) => URBAN_SET.includes(i)).length).toBeGreaterThanOrEqual(6);
    expect(first.filter((i) => OUTDOOR_MONOPOLY.includes(i))).toEqual([]);
    // Hills and water stay reachable: hiking is on the first screen of a city, not hidden behind it.
    expect(first).toContain('hiking');
    expect(first.slice(0, 3)).toContain('food_and_towns');
  });

  it('AFTER: transport is a confident transit-and-walking read, never a car; the reach is a day-trip question, not a radius', () => {
    const ctx = indexCity();
    expect(ctx.destination.assumption).toMatchObject({ movement: 'transit_walk', bases: 'one', confidence: 'high' });
    const answers = fresh(ctx);
    const transport = questionById(ctx, answers, 'transport_mode')!;
    expect(transport.smartDefault!(ctx, answers)).toMatchObject({ value: 'transit_walk', source: 'destination_prior' });
    const plan = planInterview({ ctx, answers });
    expect(plan.shown).toContain('day_trips');
    expect(plan.shown).not.toContain('scenic_reach');
    expect(plan.shown).not.toContain('daily_driving');
    expect(plan.shown).not.toContain('base_moves');
    expect(plan.shown).not.toContain('internal_flights');
  });

  it('AFTER: smart defaults for the city choose transit, city priorities and no scenic drives', () => {
    const ctx = indexCity();
    const { answers, decisions } = applySmartDefaults({ answers: fresh(ctx), ctx, now: NOW });
    expect(answers.willDrive).toBe(false);
    expect(decisions.find((d) => d.id === 'transport_mode')?.decision.value).toBe('transit_walk');
    const priorities = decisions.find((d) => d.id === 'priorities')?.decision.value as Interest[];
    expect(priorities.some((i) => URBAN_SET.includes(i))).toBe(true);
    expect(priorities).not.toContain('scenic_drives');
    expect(answers.interests.scenic_drives).not.toBe('core');
    expect(answers.regionalExpansion).not.toBe('nearby_120');
  });
});

describe('safe defaults when the evidence is thin', () => {
  it('an unscreened destination assumes no mode, no shape and no radius, and asks transport first after priorities', () => {
    const ctx = unknownPlace();
    expect(ctx.destination.traits).toEqual([]);
    expect(ctx.destination.assumption).toBeUndefined();
    const plan = planInterview({ ctx, answers: fresh(ctx) });
    expect(plan.shown[0]).toBe('priorities');
    // Roles come right after priorities by design; transport is the first question that is not about interests.
    const nonInterest = plan.shown.filter((id) => id !== 'priorities' && id !== 'priority_roles' && !id.startsWith('priority_role:'));
    expect(nonInterest[0]).toBe('transport_mode');
    const first = priorityOffer(ctx, fresh(ctx));
    // Balanced, not outdoor: food and culture are guaranteed, and no family holds more than two rows.
    expect(first).toContain('food_and_towns');
    expect(first).toContain('history_and_culture');
    for (const [family, n] of familiesOf(first)) expect(n, family).toBeLessThanOrEqual(MAX_PER_FAMILY);
  });

  it('when nothing supports a mode, "decide for me" never picks a car outright', () => {
    const ctx = unknownPlace();
    const answers = fresh(ctx);
    const decision = questionById(ctx, answers, 'transport_mode')!.smartDefault!(ctx, answers);
    expect(decision.value).not.toBe('rent_car');
    expect(decision.source).toBe('smart_default');
    expect(decision.reason).toMatch(/don't know .* well enough/);
  });

  it('a rail-oriented country reads as transit-rich and leads with trains, not a hire car', () => {
    const ctx = railRegion();
    expect(ctx.destination.traits).toContain('transit_rich');
    expect(ctx.destination.assumption?.movement).toBe('transit_walk');
    expect(ctx.destination.assumption?.confidence).toBe('high');
  });

  it('a car is assumed with confidence only on access evidence: a compact country alone is a question, a car-only region is a read', () => {
    // The shape fixture's compact country carries a driving scope, which is access evidence; strip it and the car becomes a question.
    const compact = contextFor({ name: 'Green Isle', proseName: 'the island', tripDays: 8, entityType: 'country', breadth: 'country', population: 5_100_000, bounds: { southWest: { lat: 51.4, lng: -10.5 }, northEast: { lat: 55.4, lng: -5.4 } }, center: { lat: 53.4, lng: -8 }, startDate: '2026-05-10' });
    expect(compact.destination.traits).toContain('compact_country');
    expect(compact.destination.assumption?.movement).toBe('car');
    expect(compact.destination.assumption?.confidence).toBe('low');
    expect(SHAPES.compactCountry().destination.assumption).toMatchObject({ movement: 'car', confidence: 'high' });
    const mountain = SHAPES.mountainRegion();
    expect(mountain.destination.traits).toContain('car_dependent');
    expect(mountain.destination.assumption).toMatchObject({ movement: 'car', confidence: 'high' });
  });
});

describe('the global battery: first screens are diverse and sensible for every shape', () => {
  const battery: [string, () => InterviewContext, { includes: Interest[]; excludes?: Interest[]; modules: string[]; never: string[] }][] = [
    ['dense transit city', indexCity, { includes: ['food_and_towns', 'neighbourhoods_and_local_life'], excludes: ['hot_springs', 'scenic_drives'], modules: ['urban_mobility'], never: ['road_trip', 'island_water'] }],
    ['outdoor mountain region', SHAPES.mountainRegion, { includes: ['hiking', 'scenic_viewpoints', 'food_and_towns', 'history_and_culture'], modules: ['road_trip'], never: ['urban_mobility', 'island_water'] }],
    ['broad country', SHAPES.remoteMountainCountry, { includes: ['history_and_culture', 'food_and_towns'], modules: ['broad_scope'], never: ['urban_mobility'] }],
    ['archipelago', SHAPES.broadArchipelago, { includes: ['beaches_and_swimming', 'food_and_towns'], modules: ['island_water'], never: ['urban_mobility'] }],
    ['wilderness basin', SHAPES.wildernessBasin, { includes: ['wildlife', 'hiking'], modules: ['remote_wilderness'], never: ['urban_mobility'] }],
    ['safari delta', SHAPES.safariDelta, { includes: ['wildlife'], modules: ['remote_wilderness'], never: ['urban_mobility'] }],
    // Its scope allows ferries, so a boats question is fair; a city's metro questions are not.
    ['rail-oriented region', railRegion, { includes: ['history_and_culture', 'food_and_towns', 'scenic_viewpoints'], modules: [], never: ['urban_mobility'] }],
    // Unknown asks the generic reach question (how far to look) but never the driving-burden, metro, boat or guide modules.
    ['unknown destination', unknownPlace, { includes: ['food_and_towns', 'history_and_culture'], modules: [], never: ['urban_mobility', 'island_water', 'remote_wilderness', 'broad_scope'] }],
  ];

  for (const [label, make, expected] of battery) {
    it(`${label}: balanced first screen, the right modules, no irrelevant ones`, () => {
      const ctx = make();
      const answers = fresh(ctx);
      const first = priorityOffer(ctx, answers);
      expect(first.length).toBeGreaterThanOrEqual(Math.min(FIRST_SCREEN_INTERESTS, ctx.traveller.offeredInterests.length));
      for (const [family, n] of familiesOf(first)) expect(n, `${label}: ${family}`).toBeLessThanOrEqual(MAX_PER_FAMILY);
      for (const interest of expected.includes) expect(first, `${label} should offer ${INTEREST_LABELS[interest]}`).toContain(interest);
      for (const interest of expected.excludes ?? []) expect(first, `${label} should not lead with ${INTEREST_LABELS[interest]}`).not.toContain(interest);
      const plan = planInterview({ ctx, answers });
      if (label === 'unknown destination') for (const id of ['daily_driving', 'road_comfort', 'base_moves', 'internal_flights', 'guide_willingness']) expect(plan.shown, id).not.toContain(id);
      const modules = new Set(plan.questions.filter((q) => plan.shown.includes(q.id)).map((q) => q.module));
      for (const module of expected.modules) expect(modules.has(module as never), `${label} should ask ${module}`).toBe(true);
      for (const module of expected.never) expect(modules.has(module as never), `${label} should not ask ${module}`).toBe(false);
      // The transport read is either confident or the question comes early; it is never a car without evidence.
      const a = ctx.destination.assumption;
      if (a && a.movement === 'car') expect(ctx.destination.traits.some((t) => t === 'car_dependent' || t === 'road_trip_region' || t === 'mountain' || t === 'compact_country' || t === 'wilderness')).toBe(true);
      if (!a || a.confidence !== 'high') {
        const next = nextOpenQuestion(planInterview({ ctx, answers: { ...answers, provenance: { ...answers.provenance, priorities: { source: 'explicit', strength: 'strong', confidence: 1 }, priority_roles: { source: 'explicit', strength: 'strong', confidence: 1 } } } }));
        expect(next?.id, `${label} should ask transport as soon as interests are known`).toBe('transport_mode');
      }
    });
  }

  it('the interview code names no destination', () => {
    const dir = resolve(__dirname);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const forbidden = /hong ?kong|mammoth|ireland|tasmania|iceland|tokyo|singapore|kenya|tanzania|zanzibar|paris|london/i;
    for (const file of files) {
      // Code only: a comment may cite a place as an example, a branch may not test for one.
      const text = readFileSync(resolve(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(forbidden.test(text), `${file} must not branch on a destination's name`).toBe(false);
    }
  });
});
