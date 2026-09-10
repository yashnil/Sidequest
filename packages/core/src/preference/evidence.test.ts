import { describe, expect, it } from 'vitest';
import { featureIsLearnable, learnPreferences, learnedHints, type PreferenceEvidenceRow } from './evidence';

const NOW = new Date('2026-09-10T00:00:00Z');
function row(patch: Partial<PreferenceEvidenceRow>): PreferenceEvidenceRow {
  return { id: 'r', userId: 'u', ownerToken: null, travelerId: null, tripId: 't', scope: 'account', signal: 'place_included', feature: 'interest:markets', polarity: 1, strength: 0.4, source: 'behaviour', context: {}, createdAt: '2026-09-01T00:00:00Z', ...patch };
}

describe('the preference evidence ledger', () => {
  it('never learns a hard constraint from anything', () => {
    for (const feature of ['diet:nut_allergy', 'need:wheelchair', 'religion:halal', 'interest:vegan_food', 'medical:knee']) expect(featureIsLearnable(feature), feature).toBe(false);
    expect(learnPreferences([row({ feature: 'diet:nut_allergy' })])).toHaveLength(0);
    expect(featureIsLearnable('interest:hiking')).toBe(true);
  });
  it('a single click is low confidence; repeated explicit answers become medium or high', () => {
    const one = learnPreferences([row({})], NOW);
    expect(one[0]?.band).toBe('low');
    const explicit = learnPreferences([row({ source: 'explicit', strength: 0.9, signal: 'interest_selected' }), row({ id: 'r2', source: 'explicit', strength: 0.9, signal: 'interest_frequency', tripId: 't2' })], NOW);
    expect(explicit[0]?.band).toMatch(/medium|high/);
    expect(explicit[0]?.weight).toBeGreaterThan(0.9);
  });
  it('"fewer temples, more neighbourhoods" is two leanings, and a refinement alone stays trip-local in confidence', () => {
    const rows = [
      row({ feature: 'theme:temples', polarity: -1, signal: 'refinement_requested', strength: 0.5, scope: 'trip' }),
      row({ id: 'r2', feature: 'theme:neighbourhoods', polarity: 1, signal: 'refinement_requested', strength: 0.5, scope: 'trip' }),
    ];
    const learned = learnPreferences(rows, NOW);
    expect(learned.find((p) => p.feature === 'theme:temples')?.weight).toBeLessThan(0);
    expect(learned.every((p) => p.band === 'low')).toBe(true);
    expect(learnedHints(learned)).toHaveLength(0);
  });
  it('post-trip verdicts outweigh clicks and produce hints the brief can carry', () => {
    const rows = [row({ feature: 'interest:viewpoints', source: 'post_trip', signal: 'post_trip_loved', strength: 1 }), row({ id: 'r2', feature: 'interest:viewpoints', source: 'behaviour', polarity: -1 })];
    const learned = learnPreferences(rows, NOW);
    expect(learned[0]?.weight).toBeGreaterThan(0.5);
    expect(learnedHints(learned)[0]).toMatch(/leans towards viewpoints/);
  });
  it('old behaviour decays', () => {
    const fresh = learnPreferences([row({ createdAt: '2026-09-09T00:00:00Z' })], NOW)[0]!;
    const stale = learnPreferences([row({ createdAt: '2024-09-09T00:00:00Z' })], NOW)[0]!;
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });
});
