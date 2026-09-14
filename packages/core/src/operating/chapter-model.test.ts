import { describe, expect, it } from 'vitest';
import { answers, context } from '../testing/fixtures';
import { buildTravelerProfile } from '../questionnaire/transform';
import { deriveTravelerIntent } from '../intent/traveler-intent';
import { deriveAffordances } from '../destinations/affordances';
import type { Chapter } from '../experience/chapters';
import type { DestinationTrait } from '../interview/traits';
import type { Interest } from '../schemas/common';
import { deriveOperatingModel } from './model';
import { chapterChangesPlanning, chapterInterests, deriveChapterModels } from './chapter-model';

const ANDES: DestinationTrait[] = ['mountain', 'high_altitude', 'remote', 'broad_geography'];

const tripModel = () => {
  const raw = answers({ interests: { hiking: 'core' }, interestRoles: { hiking: 'build_around' }, dailyIntensity: 'intense', willDrive: false, guideWillingness: 'prefer' });
  const profile = buildTravelerProfile(raw, context());
  const intent = deriveTravelerIntent({ profile, interestRoles: raw.interestRoles! });
  const affordances = deriveAffordances({ destination: { traits: ANDES, basis: Object.fromEntries(ANDES.map((t) => [t, `screened as ${t}`])) } });
  return { intent, trip: deriveOperatingModel({ intent, affordances, nights: 10, willDrive: false }) };
};

/** The live Kyrgyzstan shape, as V11 finally derived it. */
const CHAPTERS: Chapter[] = [
  { id: 'c1', title: 'Bishkek', role: 'arrival', dayNumbers: [1], stayIds: ['bishkek'], nights: 1 },
  { id: 'c2', title: 'Song-Köl', role: 'exploration', dayNumbers: [2, 3], stayIds: ['song-kol'], nights: 2 },
  { id: 'c3', title: 'Ala-Kul crossing', role: 'expedition', dayNumbers: [6, 7, 8], stayIds: ['trek'], nights: 2, experience: 'Ala-Kul crossing' },
  { id: 'c4', title: 'Karakol', role: 'recovery', dayNumbers: [9], stayIds: ['karakol'], nights: 1 },
  { id: 'c5', title: 'Bishkek', role: 'finale', dayNumbers: [10, 11], stayIds: ['bishkek'], nights: 1 },
];

describe('V12 §8 — a chapter carries how it works', () => {
  const { intent, trip } = tripModel();
  const models = deriveChapterModels({ chapters: CHAPTERS, trip, intent, strenuousDays: new Set([6, 7]) });
  const byId = new Map(models.map((model) => [model.chapterId, model]));

  it('plans the expedition as an expedition, whatever the trip is', () => {
    const trek = byId.get('c3')!;
    expect(trek.basis).toBe('experience');
    expect(trek.operatingType).toBe('multi_day_trek');
    expect(trek.policy.foodPattern).toBe('operator_provided');
    expect(trek.policy.lodgingPattern).toBe('experience_owned');
    expect(trek.verificationPriority).toBe('operator');
    expect(trek.criticalDependencies.join(' ')).toMatch(/arranged before the trip/);
  });

  it('plans the day after it as recovery, which the trip policy alone would not', () => {
    const recovery = byId.get('c4')!;
    expect(recovery.basis).toBe('recovery');
    expect(recovery.policy.activityDensity).toBe('light');
    expect(recovery.policy.restExpectation).toBeGreaterThan(trip.policy.restExpectation);
    expect(recovery.verificationPriority).toBe('nothing_special');
    /* And the two are genuinely different plans, not two labels on one. */
    expect(recovery.policy.activityDensity).not.toBe(byId.get('c3')!.policy.activityDensity);
  });

  it('keeps arrival and departure lighter than the middle of the trip', () => {
    expect(byId.get('c1')!.policy.activityDensity).toBe('light');
    expect(byId.get('c5')!.policy.activityDensity).toBe('light');
  });

  it('lets an ordinary chapter inherit, and says that is what it did', () => {
    const ordinary = byId.get('c2')!;
    expect(ordinary.basis).toBe('inherited');
    expect(ordinary.operatingType).toBe(trip.type);
    /* §8's own warning: inherited data is not decorative, it is explicitly the trip's. */
    expect(chapterChangesPlanning(ordinary, trip)).toBe(false);
    /* The recovery chapter genuinely plans differently from the trip around it. */
    expect(chapterChangesPlanning(byId.get('c4')!, trip)).toBe(true);
    /*
     * And where the trip is *already* an expedition, its expedition chapter
     * changes nothing — which is the honest answer rather than a difference
     * invented to justify the field.
     */
    expect(trip.type).toBe('multi_day_trek');
    expect(chapterChangesPlanning(byId.get('c3')!, trip)).toBe(false);
  });

  it('gives every chapter a goal a person could read', () => {
    for (const model of models) {
      expect(model.primaryGoal.length).toBeGreaterThan(3);
      expect(model.primaryGoal).not.toMatch(/_/);
    }
  });
});

describe('V12 §8 §31 — a chapter exists for an interest only when most of it does', () => {
  const { intent } = tripModel();

  it('does not let one day inside a chapter claim the whole chapter', () => {
    const dayInterests = new Map<number, Interest[]>([
      [2, ['hiking']],
      [3, []],
    ]);
    const claimed = chapterInterests([CHAPTERS[1]!], intent, dayInterests);
    expect(claimed.c2).toBeUndefined();
  });

  it('claims it when the chapter really is about it', () => {
    const dayInterests = new Map<number, Interest[]>([
      [2, ['hiking']],
      [3, ['hiking']],
    ]);
    const claimed = chapterInterests([CHAPTERS[1]!], intent, dayInterests);
    expect(claimed.c2).toEqual(['hiking']);
  });
});
