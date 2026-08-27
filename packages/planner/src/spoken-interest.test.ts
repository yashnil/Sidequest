import { describe, expect, it } from 'vitest';
import type { DiscoveryCandidate, DiscoverySelection, Interest, Place } from '@sidequest/core';
import type { TravelTimeMatrix } from '@sidequest/geo';
import { resolveCandidates } from './candidates';
import { themeFor } from './schedule';
import type { PlanningCandidate } from './types';

/**
 * WHAT THE PLAN MAY SAY A PLACE *IS* — HELD TO THE PLACE'S OWN KIND.
 *
 * The audited live artifact: a seven-hour amusement park scheduled under the
 * day theme "Easy nature walks", with the card reason "Matches your interest
 * in easy nature walks". The interest was stamped through the coarse category
 * bucket; nothing checked it against what the record says about itself, and
 * the theme and the reason were both built from the stamp.
 *
 * The contract: where a record names its own kind (display noun or source
 * leaf category), the interest the planner speaks — reasons, themes — must be
 * one that kind evidences. Where it is not, no interest is spoken and the
 * theme derives from the place's own category instead.
 */

function place(id: string, overrides: Partial<Place>): Place {
  return {
    id,
    regionId: 'fixture',
    name: id,
    shortDescription: 'A fixture place that exists to carry a kind and an interest.',
    coordinates: { lat: 1, lng: 1 },
    relationship: 'satellite',
    category: 'town_and_food',
    interests: ['easy_nature_walks'],
    typicalDurationMinutes: 90,
    costLevel: 1,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.5,
    hiddenGemScore: 0.5,
    tags: [],
    weather: {
      exposure: 'mixed',
      precipitation: 'low',
      wind: 'low',
      heat: 'low',
      cold: 'low',
      visibilityDependent: false,
      poorWeatherBackup: false,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: 'easy',
      remoteNoServices: false,
    },
    travelFromBase: { distanceKm: 2, driveMinutes: 10, driveIsScenic: false },
    locality: 'Fixture Town',
    ...overrides,
  } as Place;
}

function candidateOf(entry: Place, primaryInterest: Interest): DiscoveryCandidate {
  return {
    place: entry,
    fit: {
      score: 80,
      band: 'strong',
      matchedInterests: [primaryInterest],
      primaryInterest,
      blockers: [],
      cautions: [],
      reasons: [],
      transportFit: 1,
      seasonFit: 1,
    },
    quality: { outcome: 'kept', reason: 'fixture', score: 1, signals: [] },
    detourClass: 'in_tolerance',
    season: { band: 'open', note: 'fixture', months: [8] },
    access: { requiredModes: [], cautions: [], available: true, summary: 'fixture' },
    operating: { status: 'open', note: 'fixture' },
  } as unknown as DiscoveryCandidate;
}

function matrixFor(ids: string[]): TravelTimeMatrix {
  const all = ['base', ...ids];
  return {
    mode: 'car',
    ids: all,
    minutes: all.map((from) => all.map((to) => (from === to ? 0 : 10))),
    km: all.map((from) => all.map((to) => (from === to ? 0 : 5))),
    provenance: { kind: 'measured', note: 'fixture', source: 'spoken-interest.test.ts' },
  };
}

function included(ids: string[]): DiscoverySelection[] {
  return ids.map((placeId) => ({
    placeId,
    status: 'included' as const,
    source: 'user' as const,
    updatedAt: '2026-08-10T09:00:00.000Z',
  }));
}

describe('the interest a candidate may speak', () => {
  it('withholds an interest the record’s own kind contradicts', () => {
    /* The audited shape: an amusement park stamped as an easy nature walk. */
    const park = place('fixture-park', { tags: ['places=theme_park'] });
    const { eligible } = resolveCandidates(
      [candidateOf(park, 'easy_nature_walks')],
      included([park.id]),
      matrixFor([park.id]),
    );
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.primaryInterest).toBeUndefined();
  });

  it('keeps an interest the kind actually evidences', () => {
    const garden = place('fixture-garden', { tags: ['places=garden'], category: 'easy_walk' });
    const { eligible } = resolveCandidates(
      [candidateOf(garden, 'easy_nature_walks')],
      included([garden.id]),
      matrixFor([garden.id]),
    );
    expect(eligible[0]!.primaryInterest).toBe('easy_nature_walks');
  });

  it('an authored record that names no kind keeps its curated verdict', () => {
    const curated = place('fixture-curated', { tags: [] });
    const { eligible } = resolveCandidates(
      [candidateOf(curated, 'easy_nature_walks')],
      included([curated.id]),
      matrixFor([curated.id]),
    );
    expect(eligible[0]!.primaryInterest).toBe('easy_nature_walks');
  });
});

describe('the theme of a day whose stops carry no speakable interest', () => {
  function planning(entry: Place): PlanningCandidate {
    return {
      place: entry,
      priority: 1,
      boardPriority: 1,
      manual: false,
      selectionStatus: 'included',
      fitScore: 80,
      matchedInterests: [],
      durationMinutes: 420,
      travelMinutesFromBase: 10,
      travelModeFromBase: 'walk',
      /* No primaryInterest: the kind gate withheld it. */
    } as unknown as PlanningCandidate;
  }

  it('derives the theme from what the place is, not from a stamp', () => {
    const park = place('fixture-park', { tags: ['places=theme_park'] });
    const theme = themeFor([planning(park)], 'Fixture Town');
    expect(theme).not.toMatch(/easy nature walks/i);
    expect(theme).not.toMatch(/^Mixed/);
    /* `town_and_food` is the park's own planning category. */
    expect(theme).toContain('Town & food');
  });

  it('a day with stops in two categories themes by where the time goes', () => {
    const park = place('fixture-park', { tags: ['places=theme_park'] });
    const short = place('fixture-museum', { category: 'museum', tags: ['places=museum'] });
    const theme = themeFor(
      [planning(park), { ...planning(short), durationMinutes: 60 } as PlanningCandidate],
      'Fixture Town',
    );
    expect(theme).toContain('Town & food');
  });
});
