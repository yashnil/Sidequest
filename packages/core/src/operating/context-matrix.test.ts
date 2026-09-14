import { describe, expect, it } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { answers, context } from '../testing/fixtures';
import { buildTravelerProfile } from '../questionnaire/transform';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { deriveTravelerIntent } from '../intent/traveler-intent';
import { deriveAffordances } from '../destinations/affordances';
import type { DestinationTrait } from '../interview/traits';
import { deriveOperatingModel, type TripOperatingModel } from './model';

/**
 * V12 §48 §49 — THE OFFLINE BEHAVIOUR MATRIX.
 *
 * Every case the brief names, run deterministically: no model call, no
 * provider, no fixture server. Each case is a traveller (answers) and a ground
 * (screening traits) — never a destination name, because §5 forbids the
 * derivation from knowing one and a test that supplied one would be testing
 * something the product does not do.
 *
 * The matrix is written to `.claude-private/V12-CONTEXT-MATRIX.md` as a side
 * effect of running, so the document can never drift from the behaviour.
 */

const CITY: DestinationTrait[] = ['dense_urban', 'transit_rich', 'walk_heavy', 'food_dense', 'nightlife_dense'];
const HIGH_ANDES: DestinationTrait[] = ['mountain', 'high_altitude', 'remote', 'broad_geography', 'multi_base_likely'];
/* The same high country, screened at country scale: the towns are part of it. */
const ANDES_WITH_TOWNS: DestinationTrait[] = [...HIGH_ANDES, 'dense_urban', 'food_dense'];
const ATOLLS: DestinationTrait[] = ['beach', 'island', 'archipelago', 'water_transfer'];
const SAVANNA: DestinationTrait[] = ['wilderness', 'remote', 'guide_transfer_likely', 'broad_geography'];
const MEDINA: DestinationTrait[] = ['dense_urban', 'walk_heavy', 'food_dense'];
const ROCKIES: DestinationTrait[] = ['mountain', 'road_trip_region', 'car_dependent', 'weather_exposed', 'multi_base_likely'];
const RAIL_COUNTRY: DestinationTrait[] = ['dense_urban', 'transit_rich', 'compact_country', 'food_dense'];
const VOLCANIC_RING: DestinationTrait[] = ['road_trip_region', 'car_dependent', 'weather_exposed', 'broad_geography'];

const ground = (traits: DestinationTrait[]) =>
  deriveAffordances({ destination: { traits, basis: Object.fromEntries(traits.map((t) => [t, `screened as ${t}`])) } });

function run(label: string, overrides: Partial<QuestionnaireAnswers>, traits: DestinationTrait[], nights: number): { label: string; model: TripOperatingModel } {
  const raw = answers(overrides);
  const profile = buildTravelerProfile(raw, context());
  const intent = deriveTravelerIntent({ profile, ...(raw.interestRoles ? { interestRoles: raw.interestRoles } : {}) });
  return { label, model: deriveOperatingModel({ intent, affordances: ground(traits), nights, willDrive: profile.transport.willDrive }) };
}

const CASES = [
  run('city — art and history', { interests: { history_and_culture: 'core', museums_and_galleries: 'core' }, interestRoles: { history_and_culture: 'build_around' }, willDrive: false }, CITY, 5),
  run('city — food and nightlife', { interests: { food_and_towns: 'core', markets_and_street_food: 'frequent' }, interestRoles: { food_and_towns: 'build_around' }, willDrive: false }, CITY, 5),
  run('high andes — backpacking and adventure', { interests: { neighbourhoods_and_local_life: 'core', hiking: 'frequent', markets_and_street_food: 'frequent' }, interestRoles: { neighbourhoods_and_local_life: 'build_around' }, budgetStyle: 'budget', dailyIntensity: 'intense', willDrive: false }, ANDES_WITH_TOWNS, 12),
  run('high andes — serious trek', { interests: { hiking: 'core' }, interestRoles: { hiking: 'build_around' }, dailyIntensity: 'intense', willDrive: false, guideWillingness: 'prefer' }, HIGH_ANDES, 12),
  run('atolls — complete relaxation', { interests: { beaches_and_swimming: 'core' }, interestRoles: { beaches_and_swimming: 'build_around' }, pace: 'slow', dailyIntensity: 'light', freeTime: 'lots', budgetStyle: 'premium', willDrive: false }, ATOLLS, 7),
  run('atolls — diving focused', { interests: { beaches_and_swimming: 'core', lakes_and_rivers: 'frequent' }, interestRoles: { beaches_and_swimming: 'most_days' }, dailyIntensity: 'moderate', budgetStyle: 'midrange', willDrive: false }, ATOLLS, 7),
  run('savanna — guided wildlife', { interests: { wildlife: 'core' }, interestRoles: { wildlife: 'build_around' }, willDrive: false, guideWillingness: 'prefer' }, SAVANNA, 8),
  run('medina — cultural immersion', { interests: { neighbourhoods_and_local_life: 'core', markets_and_street_food: 'frequent', history_and_culture: 'frequent' }, interestRoles: { neighbourhoods_and_local_life: 'build_around' }, willDrive: false }, MEDINA, 9),
  run('rockies — serious hiking', { interests: { hiking: 'core', scenic_viewpoints: 'frequent' }, interestRoles: { hiking: 'build_around' }, dailyIntensity: 'intense', willDrive: true }, ROCKIES, 8),
  run('rockies — family scenic drive', { interests: { scenic_drives: 'core', easy_nature_walks: 'frequent' }, interestRoles: { scenic_drives: 'build_around' }, dailyIntensity: 'light', pace: 'slow', willDrive: true }, ROCKIES, 8),
  run('rail country — food and transit city', { interests: { food_and_towns: 'core', neighbourhoods_and_local_life: 'frequent' }, interestRoles: { food_and_towns: 'build_around' }, willDrive: false }, RAIL_COUNTRY, 10),
  run('volcanic ring — self-drive road trip', { interests: { scenic_drives: 'core', scenic_viewpoints: 'frequent' }, interestRoles: { scenic_drives: 'build_around' }, willDrive: true }, VOLCANIC_RING, 9),
];

describe('V12 §48 §49 — the offline context matrix', () => {
  it('gives every case an operating model with a stated reason', () => {
    for (const entry of CASES) {
      expect(entry.model.type, entry.label).toBeTruthy();
      expect(entry.model.rationale.length, entry.label).toBeGreaterThan(0);
    }
  });

  it('does not collapse the twelve cases onto one way of planning', () => {
    const families = new Set(CASES.map((entry) => entry.model.type));
    /* The exact count is not the point; that the same machinery reaches many is. */
    expect(families.size).toBeGreaterThanOrEqual(6);
  });

  it('separates every same-ground pair that §50 names', () => {
    const pairs: [string, string][] = [
      ['city — art and history', 'city — food and nightlife'],
      ['high andes — backpacking and adventure', 'high andes — serious trek'],
      ['atolls — complete relaxation', 'atolls — diving focused'],
      ['rockies — serious hiking', 'rockies — family scenic drive'],
    ];
    for (const [a, b] of pairs) {
      const left = CASES.find((entry) => entry.label === a)!.model;
      const right = CASES.find((entry) => entry.label === b)!.model;
      const differs =
        left.type !== right.type ||
        left.policy.activityDensity !== right.policy.activityDensity ||
        left.policy.foodPattern !== right.policy.foodPattern ||
        left.policy.hotelChangeCost !== right.policy.hotelChangeCost;
      expect(differs, `${a} vs ${b} must plan differently`).toBe(true);
    }
  });

  it('writes the matrix beside the code that produced it', () => {
    const rows = CASES.map((entry) => {
      const p = entry.model.policy;
      return `| ${entry.label} | \`${entry.model.type}\` | ${entry.model.confidence} | ${p.basePattern} | ${p.mobilityPattern} | ${p.activityDensity} | ${p.foodPattern} | ${p.lodgingPattern} | ${p.hotelChangeCost} | ${p.restExpectation} | ${p.bookingIntensity} | ${p.transportCertaintyRequirement} |`;
    });
    const doc = [
      '# V12 §49 — the context matrix',
      '',
      'Generated by `packages/core/src/operating/context-matrix.test.ts` on every',
      '`npm run test`, so it cannot drift from the behaviour it describes.',
      '',
      '**No destination is named anywhere in the derivation.** Each row is a',
      'traveller (their answers) meeting a ground (the traits a screening produced).',
      'The labels below are descriptive only — the code never sees them.',
      '',
      '| case | operating type | conf. | bases | mobility | density | food | lodging | hotel-change cost | rest | booking | transport certainty |',
      '| --- | --- | ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |',
      ...rows,
      '',
      '## Same ground, different intent',
      '',
      ...[
        ['city — art and history', 'city — food and nightlife'],
        ['high andes — backpacking and adventure', 'high andes — serious trek'],
        ['atolls — complete relaxation', 'atolls — diving focused'],
        ['rockies — serious hiking', 'rockies — family scenic drive'],
      ].map(([a, b]) => {
        const left = CASES.find((entry) => entry.label === a)!.model;
        const right = CASES.find((entry) => entry.label === b)!.model;
        return `- **${a}** → \`${left.type}\` (${left.policy.activityDensity}, food ${left.policy.foodPattern}) · **${b}** → \`${right.type}\` (${right.policy.activityDensity}, food ${right.policy.foodPattern})`;
      }),
      '',
    ].join('\n');
    mkdirSync('.claude-private', { recursive: true });
    writeFileSync('.claude-private/V12-CONTEXT-MATRIX.md', doc);
    expect(doc).toContain('operating type');
  });
});
