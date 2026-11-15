import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/(product)/trips/new/actions', () => ({}));

import { statedItinerarySchema } from '@sidequest/core';
import { composerInputForPlan } from './to-composer';

const stated = statedItinerarySchema.parse({
  version: 1,
  source: 'plan_check',
  stops: [
    { id: 's1', label: 'Alpha', nights: 4, nightsProvenance: 'stated', dayTrip: false, fixed: false },
    { id: 's2', label: 'Kyoto', nights: 3, nightsProvenance: 'stated', dayTrip: false, fixed: true },
  ],
  parseConfidence: 1,
  recordedAt: '2026-11-14T00:00:00.000Z',
});

describe('composerInputForPlan — a checked plan keeps its stays and never silently assumes the party', () => {
  const plan = { stops: [{ label: 'Alpha', nights: 4, dayTrip: false }, { label: 'Kyoto', nights: 3, dayTrip: false }], totalNights: 7, startDate: null, endDate: null, month: null, contextCountries: [] as string[] };

  it('carries the stated itinerary through to the composer payload', () => {
    const input = composerInputForPlan({ ...plan, statedItinerary: stated, party: { adults: 1, children: 0, basis: 'stated' } });
    expect(input.statedItinerary?.stops.map((s) => [s.label, s.nights])).toEqual([
      ['Alpha', 4],
      ['Kyoto', 3],
    ]);
    expect(input.nights).toBe(7);
    expect(input.adults).toBe(1);
    expect(input.partyBasis).toBe('stated');
  });

  it('marks the party as assumed when nobody said who is going', () => {
    const input = composerInputForPlan(plan);
    expect(input.adults).toBe(2);
    expect(input.partyBasis).toBe('assumed');
  });
});
