import { describe, expect, it } from 'vitest';
import { answers, context } from '../testing/fixtures';
import { buildTravelerProfile } from '../questionnaire/transform';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { deriveTravelerIntent } from '../intent/traveler-intent';
import { deriveAffordances, type DestinationAffordanceProfile } from '../destinations/affordances';
import type { DestinationTrait } from '../interview/traits';
import { deriveOperatingModel } from './model';

/**
 * V12 §9 §50 — THE GATE.
 *
 * Hold the ground constant, change only what the traveller wants, and the way
 * the trip is planned must change. A destination is never named: the ground is
 * expressed as the screening traits it produces, because that is all the
 * derivation is allowed to see (§5).
 */

const ground = (traits: DestinationTrait[]): DestinationAffordanceProfile =>
  deriveAffordances({ destination: { traits, basis: Object.fromEntries(traits.map((t) => [t, `screened as ${t}`])) } });

/** A dense, walkable, food-heavy, nightlife-heavy city. */
const CITY: DestinationTrait[] = ['dense_urban', 'transit_rich', 'walk_heavy', 'food_dense', 'nightlife_dense'];
/** A high mountain region you drive through. */
const MOUNTAINS: DestinationTrait[] = ['mountain', 'road_trip_region', 'car_dependent', 'weather_exposed', 'multi_base_likely'];
/** Warm water and islands. */
const ISLANDS: DestinationTrait[] = ['beach', 'island', 'archipelago', 'water_transfer'];

const model = (overrides: Partial<QuestionnaireAnswers>, traits: DestinationTrait[], nights = 8) => {
  const raw = answers(overrides);
  const profile = buildTravelerProfile(raw, context());
  const intent = deriveTravelerIntent({ profile, ...(raw.interestRoles ? { interestRoles: raw.interestRoles } : {}) });
  return deriveOperatingModel({ intent, affordances: ground(traits), nights, willDrive: profile.transport.willDrive });
};

describe('V12 §50 — one city, two intents, two different trips', () => {
  const art = model(
    {
      interests: { history_and_culture: 'core', museums_and_galleries: 'core' },
      interestRoles: { history_and_culture: 'build_around', museums_and_galleries: 'most_days' },
      willDrive: false,
    },
    CITY,
  );
  const food = model(
    {
      interests: { food_and_towns: 'core', markets_and_street_food: 'frequent', neighbourhoods_and_local_life: 'frequent' },
      interestRoles: { food_and_towns: 'build_around' },
      willDrive: false,
    },
    CITY,
  );

  it('chooses a different operating family from the same ground', () => {
    expect(art.type).toBe('urban_culture');
    expect(food.type).toBe('urban_food_nightlife');
  });

  it('changes what food means, and what the evenings are for', () => {
    expect(art.policy.foodPattern).toBe('convenient_fuel');
    expect(food.policy.foodPattern).toBe('named_meals_matter');
    /* A food trip books more and starts later; a museum trip runs to opening hours. */
    expect(food.policy.bookingIntensity).toBeGreaterThan(art.policy.bookingIntensity);
    expect(food.policy.dayRhythm).toBe('slow_morning');
    expect(art.policy.dayRhythm).toBe('standard');
  });

  it('keeps what the two genuinely share, rather than inventing a difference', () => {
    expect(art.policy.basePattern).toBe(food.policy.basePattern);
    expect(art.policy.mobilityPattern).toBe(food.policy.mobilityPattern);
    expect(art.policy.hotelChangeCost).toBe(food.policy.hotelChangeCost);
  });

  it('says why, in sentences rather than in scores', () => {
    expect(art.rationale.join(' ')).toMatch(/History/i);
    expect(art.rationale.every((line) => line.length > 20)).toBe(true);
  });
});

describe('V12 §50 — one mountain region, two intents', () => {
  const serious = model(
    { interests: { hiking: 'core' }, interestRoles: { hiking: 'build_around' }, dailyIntensity: 'intense', willDrive: true },
    MOUNTAINS,
  );
  const family = model(
    {
      interests: { scenic_drives: 'core', scenic_viewpoints: 'frequent', easy_nature_walks: 'frequent' },
      interestRoles: { scenic_drives: 'build_around' },
      dailyIntensity: 'light',
      pace: 'slow',
      willDrive: true,
    },
    MOUNTAINS,
  );

  it('separates a hiking-led trip from a driving-led one', () => {
    expect(serious.type).toBe('mountain_road_trip');
    expect(family.type).toBe('self_drive_road_trip');
    expect(serious.policy.dayRhythm).toBe('early_start');
    expect(family.policy.dayRhythm).toBe('standard');
  });

  it('asks the hiking trip for more recovery than the scenic one', () => {
    expect(serious.policy.recoveryImportance).toBeGreaterThan(family.policy.recoveryImportance);
  });
});

describe('V12 §50 — one archipelago, relaxation against activity', () => {
  const relax = model(
    { interests: { beaches_and_swimming: 'core' }, interestRoles: { beaches_and_swimming: 'build_around' }, pace: 'slow', dailyIntensity: 'light', freeTime: 'lots', budgetStyle: 'premium', willDrive: false },
    ISLANDS,
  );
  const hopping = model(
    { interests: { beaches_and_swimming: 'core', lakes_and_rivers: 'frequent' }, interestRoles: { beaches_and_swimming: 'most_days' }, pace: 'balanced', dailyIntensity: 'moderate', budgetStyle: 'midrange', willDrive: false },
    ISLANDS,
  );

  it('makes a relaxation trip expensive to move and sparse to fill', () => {
    expect(relax.type).toBe('resort_stay');
    expect(relax.policy.activityDensity).toBe('sparse');
    expect(relax.policy.restExpectation).toBeGreaterThan(0.8);
    expect(relax.policy.hotelChangeCost).toBeGreaterThan(0.9);
  });

  it('does not plan the more active trip the same way', () => {
    expect(hopping.type).not.toBe(relax.type);
    expect(hopping.policy.hotelChangeCost).toBeLessThan(relax.policy.hotelChangeCost);
    expect(hopping.policy.activityDensity).not.toBe('sparse');
  });
});

describe('V12 §5 — the ground supports, it never proposes', () => {
  it('does not turn a mountain region into a hiking trip for somebody who did not ask', () => {
    const noInterest = model(
      { interests: { history_and_culture: 'occasional' }, interestRoles: { history_and_culture: 'once' }, willDrive: true },
      MOUNTAINS,
    );
    expect(noInterest.type).not.toBe('mountain_road_trip');
    expect(noInterest.type).not.toBe('multi_day_trek');
  });

  it('refuses a self-driven family to a traveller who is not driving, on identical ground', () => {
    const driver = model({ interests: { scenic_drives: 'core' }, interestRoles: { scenic_drives: 'build_around' }, willDrive: true }, MOUNTAINS);
    const driven = model({ interests: { scenic_drives: 'core' }, interestRoles: { scenic_drives: 'build_around' }, willDrive: false }, MOUNTAINS);
    expect(driver.type).toBe('self_drive_road_trip');
    expect(driven.type).not.toBe('self_drive_road_trip');
    expect(driven.rationale.join(' ')).toMatch(/not driving/);
  });

  it('says "mixed" rather than forcing a family when nothing leads', () => {
    const mixed = model(
      {
        interests: { history_and_culture: 'frequent', food_and_towns: 'frequent' },
        interestRoles: { history_and_culture: 'couple', food_and_towns: 'couple' },
        willDrive: false,
      },
      CITY,
    );
    expect(mixed.type).toBe('mixed_regional');
    expect(mixed.confidence).toBeLessThanOrEqual(0.5);
    expect(mixed.rationale.join(' ')).toMatch(/almost equally|mixed/);
  });

  it('treats an unscreened destination as unknown ground, never as ground that refuses', () => {
    const unknownGround = model({ interests: { hiking: 'core' }, interestRoles: { hiking: 'build_around' }, willDrive: true }, []);
    expect(unknownGround.rationale.join(' ')).toMatch(/Nothing could be screened/);
    /* The traveller's own answers still decide something: this is not a dead end. */
    expect(unknownGround.alternatives.length).toBeGreaterThan(0);
  });
});
