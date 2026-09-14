import { describe, expect, it } from 'vitest';
import { answers, context } from '../testing/fixtures';
import { buildTravelerProfile } from '../questionnaire/transform';
import type { QuestionnaireAnswers } from '../schemas/profile';
import { deriveTravelerIntent } from './traveler-intent';
import { PREFERENCE_ROLE_RANK, ROLE_DEMANDS, roleFor } from './roles';

const intentFor = (overrides: Partial<QuestionnaireAnswers>, party?: { children?: number }) => {
  const raw = answers(overrides);
  const profile = buildTravelerProfile(raw, context());
  return deriveTravelerIntent({ profile, ...(raw.interestRoles ? { interestRoles: raw.interestRoles } : {}), ...(party ? { party } : {}) });
};

describe('V12 §2 — the role a preference plays survives into the planner', () => {
  it('keeps "build the trip around it" and "most days" apart, which the level cannot', () => {
    /*
     * This is the defect the V12 audit found: `ROLE_LEVEL` folds both answers
     * onto `core`, so the two trips below arrive at the planner identical.
     */
    const buildAround = roleFor('hiking', { levels: { hiking: 'core' }, roles: { hiking: 'build_around' } });
    const mostDays = roleFor('hiking', { levels: { hiking: 'core' }, roles: { hiking: 'most_days' } });
    expect(buildAround.role).toBe('core');
    expect(mostDays.role).toBe('most_days');
    expect(buildAround.basis).toBe('stated');
    /* Only the stronger one is allowed to demand that the trip be built differently. */
    expect(ROLE_DEMANDS[buildAround.role].shapesStructure).toBe(true);
    expect(ROLE_DEMANDS[mostDays.role].shapesStructure).toBe(false);
  });

  it('reads a role back from the level when nobody was asked, and says it inferred it', () => {
    const inferred = roleFor('wildlife', { levels: { wildlife: 'frequent' } });
    expect(inferred).toEqual({ role: 'several_times', basis: 'inferred' });
    /*
     * A level of `core` reads back as `most_days`, never as `core`: it is all
     * that survives of either answer, so claiming the stronger one would invent
     * a statement the traveller may not have made.
     */
    expect(roleFor('hiking', { levels: { hiking: 'core' } })).toEqual({ role: 'most_days', basis: 'inferred' });
  });

  it('resolves a role for an interest nobody mentioned, rather than leaving a hole', () => {
    const intent = intentFor({});
    expect(Object.keys(intent.roles).length).toBeGreaterThan(15);
    expect(intent.roles.stargazing).toBe('opportunistic');
  });
});

describe('V12 §5 — the same destination and different intent are different trips', () => {
  /*
   * §5's own examples, expressed as answers rather than as destinations. Not one
   * of these tests names a place: the whole point is that the behaviour comes
   * from the traveller, and a test that mentioned Paris would be asserting the
   * hardcoding §5 forbids.
   */
  const artAndHistory = intentFor({
    interests: { history_and_culture: 'core', museums_and_galleries: 'core', food_and_towns: 'occasional' },
    interestRoles: { history_and_culture: 'build_around', museums_and_galleries: 'most_days' },
    pace: 'balanced',
    dailyIntensity: 'moderate',
  });
  const foodAndNightlife = intentFor({
    interests: { food_and_towns: 'core', markets_and_street_food: 'core', neighbourhoods_and_local_life: 'frequent' },
    interestRoles: { food_and_towns: 'build_around', markets_and_street_food: 'most_days' },
    pace: 'balanced',
    dailyIntensity: 'moderate',
  });

  it('leads with different goals, and the leading goal is the one they said to build around', () => {
    expect(artAndHistory.primaryGoals.map((g) => g.interest)).toEqual(['history_and_culture']);
    expect(foodAndNightlife.primaryGoals.map((g) => g.interest)).toEqual(['food_and_towns']);
    expect(artAndHistory.primaryGoals[0]?.basis).toBe('stated');
  });

  it('produces a different trip identity from the same destination-free inputs', () => {
    expect(artAndHistory.tripIdentity).not.toBe(foodAndNightlife.tripIdentity);
    expect(artAndHistory.tripIdentity).toMatch(/history/i);
    expect(foodAndNightlife.tripIdentity).toMatch(/food/i);
  });

  it('reads a different feeling from each, with the evidence that implied it', () => {
    expect(artAndHistory.desiredFeeling.map((f) => f.feeling)).toContain('culturally_rich');
    expect(foodAndNightlife.desiredFeeling.map((f) => f.feeling)).toContain('immersive');
    for (const signal of [...artAndHistory.desiredFeeling, ...foodAndNightlife.desiredFeeling]) {
      expect(signal.evidence.length).toBeGreaterThan(0);
    }
  });

  it('separates relaxation from a trek on roughness and flexibility, not on interests alone', () => {
    const relaxation = intentFor({
      interests: { beaches_and_swimming: 'core' },
      interestRoles: { beaches_and_swimming: 'build_around' },
      pace: 'slow',
      dailyIntensity: 'light',
      freeTime: 'lots',
      budgetStyle: 'premium',
    });
    const expedition = intentFor({
      interests: { hiking: 'core' },
      interestRoles: { hiking: 'build_around' },
      pace: 'balanced',
      dailyIntensity: 'intense',
      freeTime: 'packed',
      budgetStyle: 'midrange',
      willDrive: false,
      guideWillingness: 'prefer',
    });

    expect(relaxation.roughnessTolerance).toBe('comfort_first');
    expect(expedition.roughnessTolerance).not.toBe('comfort_first');
    expect(relaxation.planningFlexibility).toBe('improvised');
    expect(expedition.planningFlexibility).toBe('pinned');
    expect(expedition.independencePreference).toBe('guided');
    expect(relaxation.desiredFeeling.map((f) => f.feeling)).toContain('restful');
    expect(expedition.desiredFeeling.map((f) => f.feeling)).toContain('challenging');
    /* And the traveller who wants empty time is told it is the plan working. */
    expect(relaxation.comfortTradeoffs.join(' ')).toMatch(/empty afternoon is the plan working/);
  });

  it('never lets an avoided interest outrank a wanted one', () => {
    const intent = intentFor({ interests: { hiking: 'core', markets_and_street_food: 'avoid' }, interestRoles: { hiking: 'build_around' } });
    expect(PREFERENCE_ROLE_RANK[intent.roles.hiking]).toBeGreaterThan(PREFERENCE_ROLE_RANK.opportunistic);
    expect(intent.hardAvoidances.length).toBeGreaterThan(0);
  });
});
