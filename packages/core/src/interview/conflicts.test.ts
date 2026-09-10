import { describe, expect, it } from 'vitest';
import { defaultAnswers } from '../questionnaire/transform';
import { detectConflicts, materialConflicts } from './conflicts';
import type { QuestionnaireAnswers } from '../schemas/profile';

/**
 * V6 §8 — two answers that pull in different directions are found, judged,
 * and only the material ones interrupt anybody.
 */
function answers(patch: Partial<QuestionnaireAnswers>, explicit: string[] = []): QuestionnaireAnswers {
  const base = defaultAnswers({ travelerNeeds: [], tripDays: 8 });
  const provenance = Object.fromEntries(explicit.map((id, i) => [id, { source: 'explicit', strength: 'soft', confidence: 1, at: `2026-09-0${(i % 9) + 1}T00:00:00Z` }]));
  return { ...base, ...patch, provenance: { ...base.provenance, ...provenance } } as QuestionnaireAnswers;
}

describe('the contradiction engine', () => {
  it('finds a four-hour driving ceiling against a one-hour detour range, and offers both readings', () => {
    const found = detectConflicts(answers({ maxDailyTravelMinutes: 240, detourToleranceMinutes: 60, willDrive: true }, ['daily_driving', 'scenic_reach']));
    const conflict = found.find((c) => c.id === 'drive_ceiling_vs_detour_range')!;
    expect(conflict.severity).toBe('material');
    expect(conflict.resolutions.map((r) => r.id)).toEqual(['keep_ceiling', 'keep_range']);
    expect(conflict.moreRecent).toBe(1);
  });
  it('reads the same pair safely when one side was a default', () => {
    const found = detectConflicts(answers({ maxDailyTravelMinutes: 240, detourToleranceMinutes: 60, willDrive: true }, ['daily_driving']));
    const conflict = found.find((c) => c.id === 'drive_ceiling_vs_detour_range')!;
    expect(conflict.severity).toBe('minor');
    expect(conflict.safeReading).toMatch(/detours off the route stay short/);
    expect(materialConflicts(answers({ maxDailyTravelMinutes: 240, detourToleranceMinutes: 60, willDrive: true }, ['daily_driving']))).toHaveLength(0);
  });
  it('intense days against a party member who cannot do steep ground is always material, with a split as one way out', () => {
    const found = materialConflicts(answers({ dailyIntensity: 'intense' }, ['effort']), { partyNeeds: ['avoid_steep_descents'] });
    expect(found.map((c) => c.id)).toContain('intense_days_vs_party_need');
    const conflict = found.find((c) => c.id === 'intense_days_vs_party_need')!;
    expect(conflict.resolutions.some((r) => r.id === 'split')).toBe(true);
  });
  it('a cold-sensitive traveller in winter is a quiet reading, never an interruption', () => {
    const found = detectConflicts(answers({}), { partyNeeds: ['cold_sensitive'], months: [1, 2], latitude: 43 });
    expect(found.find((c) => c.id === 'winter_trip_vs_cold_sensitive')?.severity).toBe('minor');
    expect(materialConflicts(answers({}), { partyNeeds: ['cold_sensitive'], months: [1], latitude: 43 })).toHaveLength(0);
    /* Southern hemisphere: January is summer. */
    expect(detectConflicts(answers({}), { partyNeeds: ['cold_sensitive'], months: [1], latitude: -41 })).toHaveLength(0);
  });
  it('no driving at a road-trip destination is material only when the traveller said so', () => {
    expect(materialConflicts(answers({ willDrive: false }, ['transport_mode']), { destinationTraits: ['road_trip'] }).map((c) => c.id)).toContain('no_driving_vs_road_trip_destination');
    expect(materialConflicts(answers({ willDrive: false }), { destinationTraits: ['road_trip'] })).toHaveLength(0);
    expect(detectConflicts(answers({ willDrive: false }, ['transport_mode']), { destinationTraits: ['road_trip', 'transit_city'] })).toHaveLength(0);
  });
  it('is silent on answers that agree', () => {
    expect(detectConflicts(answers({}))).toHaveLength(0);
  });
});
