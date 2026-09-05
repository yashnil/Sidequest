import { describe, expect, it } from 'vitest';
import { draftAnchorId, draftStructureIssues, normalizeTripDraft, tripDraftSchema, type TripDraft } from './trip-draft';

export function minimalDraft(overrides: Partial<TripDraft> = {}): TripDraft {
  return {
    archetype: 'single_base',
    purpose: 'A short test trip.',
    routeRationale: 'One base keeps it simple.',
    assumptions: [],
    tradeoffs: [],
    bases: [{ id: 'base', name: 'Test Town', nights: 2, why: 'Central.' }],
    days: [
      { dayNumber: 1, baseId: 'base', theme: 'Arrive', intensity: 'light', anchors: [{ name: 'Old Square', category: 'landmark', role: 'core', why: 'Orientation.' }] },
      { dayNumber: 2, baseId: 'base', theme: 'Out', intensity: 'moderate', anchors: [{ name: 'Big Lake', category: 'water', role: 'core', why: 'Water.', estimatedDurationMinutes: 120 }] },
      { dayNumber: 3, baseId: 'base', theme: 'Leave', intensity: 'light', anchors: [] },
    ],
    omissions: [],
    unresolved: [],
    package: { foodStrategy: [], transport: { summary: 'Walk.', notes: [] }, beforeYouGo: [], packing: [], backups: [] },
    ...overrides,
  };
}

describe('tripDraftSchema', () => {
  it('accepts a complete draft and rejects a URL in prose, a bad enum, and an over-long array', () => {
    expect(tripDraftSchema.safeParse(minimalDraft()).success).toBe(true);
    expect(tripDraftSchema.safeParse(minimalDraft({ purpose: 'See https://example.com' })).success).toBe(false);
    expect(tripDraftSchema.safeParse({ ...minimalDraft(), archetype: 'teleport' }).success).toBe(false);
    expect(tripDraftSchema.safeParse(minimalDraft({ unresolved: Array.from({ length: 9 }, () => 'x') })).success).toBe(false);
  });

  it('never asks the model for provider ids, coordinates, hours or prices', () => {
    const shape = JSON.stringify(tripDraftSchema);
    for (const forbidden of ['placeIndex', 'placeId', 'latitude', 'lat', 'openingHours', 'price', 'permit']) {
      expect(shape).not.toContain(`"${forbidden}"`);
    }
  });
});

describe('normalizeTripDraft', () => {
  it('trims and clips soft prose, records what it touched, and leaves hard fields alone', () => {
    const raw = minimalDraft({ purpose: `  ${'x'.repeat(300)}  `, days: [{ dayNumber: 1, baseId: 'base', theme: 'ok', intensity: 'light', anchors: [{ name: 'Old Square', category: 'landmark', role: 'core', why: 'y'.repeat(200) }] }] });
    const { value, normalizedFields } = normalizeTripDraft(raw);
    const parsed = tripDraftSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    expect(normalizedFields).toContain('purpose (clip)');
    expect(normalizedFields).toContain('days[0].anchors[0].why (clip)');
    // An anchor name over its cap is a hard failure, never clipped into a different place.
    const badName = normalizeTripDraft(minimalDraft({ days: [{ dayNumber: 1, baseId: 'base', theme: 'ok', intensity: 'light', anchors: [{ name: 'n'.repeat(80), category: 'landmark', role: 'core', why: 'w' }] }] }));
    expect(tripDraftSchema.safeParse(badName.value).success).toBe(false);
  });
});

describe('draft structure', () => {
  it('names days out of order and unknown base ids', () => {
    expect(draftStructureIssues(minimalDraft())).toEqual([]);
    const broken = minimalDraft({ days: [{ dayNumber: 2, baseId: 'nowhere', theme: 't', intensity: 'light', anchors: [] }] });
    expect(draftStructureIssues(broken)).toHaveLength(2);
  });

  it('derives a stable anchor id from day, order and name — never from provider identity', () => {
    expect(draftAnchorId(3, 1, 'Jökulsárlón Glacier Lagoon')).toBe('d3-a1-jokulsarlon-glacier-lago');
    expect(draftAnchorId(1, 0, '')).toBe('d1-a0-anchor');
  });
});
