import { describe, expect, it } from 'vitest';
import { dayStrain, mergePartyDiet } from './strain';
import type { ItineraryDay } from '../schemas/itinerary';

type Day = Pick<ItineraryDay, 'items' | 'intensity' | 'totals' | 'split' | 'warnings'>;
const item = (title: string, extra: Partial<ItineraryDay['items'][number]> = {}) => ({ id: title, kind: 'activity', title, startMinute: 600, endMinute: 660, durationMinutes: 60, ...extra }) as ItineraryDay['items'][number];
const day = (items: ItineraryDay['items'], intensity: Day['intensity'] = 'moderate', strenuousCount = 0): Day =>
  ({ items, intensity, totals: { strenuousCount } as ItineraryDay['totals'], warnings: [] }) as Day;

describe('dayStrain — evidence, not the intensity word', () => {
  it('a jeep safari day called intense names no demanding ground', () => {
    const strain = dayStrain(day([item('National park morning safari'), item('National park evening safari')], 'intense'));
    expect(strain.demanding).toEqual([]);
    expect(strain.full).toBe(true);
    expect(strain.accommodated).toBe(false);
  });
  it('a summit trail is demanding ground; a rest stop accommodates it', () => {
    const bare = dayStrain(day([item('Ridge Summit Trail')]));
    expect(bare.demanding).toEqual(['Ridge Summit Trail']);
    expect(bare.accommodated).toBe(false);
    const rested = dayStrain(day([item('Ridge Summit Trail'), item('Rest at the lodge', { reason: 'Amma can sit this out.' })]));
    expect(rested.accommodated).toBe(true);
  });
  it('a strenuous-rated stop or a split counts without any words', () => {
    expect(dayStrain(day([item('Gorge walk', { physicalIntensity: 'strenuous' })])).demanding).toEqual(['Gorge walk']);
    expect(dayStrain({ ...day([item('Gorge walk', { physicalIntensity: 'strenuous' })]), split: { who: 'Mum', does: 'the museum' } }).accommodated).toBe(true);
  });
});

describe('mergePartyDiet — the group kitchen rule for Sidequest’s own checks', () => {
  const profile = { food: { dietaryNeeds: [] as ('no_beef' | 'vegetarian' | 'nut_allergy')[], dietaryStrict: false, other: 1 } };
  it('unions every applying member’s needs and goes strict when any member is', () => {
    const merged = mergePartyDiet(profile, [
      { constraintsApply: true, diet: { needs: ['no_beef'], strict: true } },
      { constraintsApply: true, diet: { needs: ['vegetarian'], strict: false } },
      { constraintsApply: false, diet: { needs: ['nut_allergy'], strict: true } },
    ]);
    expect(merged.food.dietaryNeeds).toEqual(['no_beef', 'vegetarian']);
    expect(merged.food.dietaryStrict).toBe(true);
    expect(merged.food.other).toBe(1);
  });
  it('returns the same profile when nothing changes', () => {
    expect(mergePartyDiet(profile, [])).toBe(profile);
    expect(mergePartyDiet(profile, [{ constraintsApply: true, diet: { needs: [], strict: true } }])).toBe(profile);
  });
});
