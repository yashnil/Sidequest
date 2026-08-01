import { describe, expect, it } from 'vitest';
import {
  assessCandidateQuality,
  featureScale,
  isSkipOutcome,
  recordedAttributes,
  type Place,
  type PlaceEvidence,
} from '../index';

/**
 * The defect these tests exist for, stated once: a mapped object with a name and
 * a matching tag ranked beside a museum, because "has a name and a matching tag"
 * was the whole test.
 *
 * Every case below is written against a *class* of feature, never a place. The
 * same assertions would hold in any country, which is the property that makes
 * this a quality layer rather than a blocklist.
 */

function place(overrides: Partial<Place> & { id: string; tags: string[] }): Place {
  return {
    regionId: 'compiled-test',
    name: 'A thing on a map',
    locality: 'Somewhere',
    shortDescription: 'A short description that is long enough to count as a description.',
    coordinates: { lat: 10, lng: 10 },
    source: {
      name: 'OpenStreetMap',
      kind: 'osm',
      confidence: 0.7,
      lastVerified: '2026-07-01',
    },
    relationship: 'satellite',
    category: 'historic_site',
    interests: ['history_and_culture'],
    typicalDurationMinutes: 45,
    costLevel: 0,
    physicalIntensity: 'easy',
    crowdLevel: 'quiet',
    popularityScore: 0.4,
    hiddenGemScore: 0.5,
    weather: {
      exposure: 'mixed',
      precipitation: 'moderate',
      wind: 'low',
      heat: 'moderate',
      cold: 'moderate',
      visibilityDependent: false,
      poorWeatherBackup: false,
      approachDegradesWhenWet: false,
    },
    bestTimeOfDay: 'any',
    seasonalAccess: { openMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], closureRisk: 'none' },
    access: {
      roadSurface: 'paved',
      mountainRoad: false,
      parkingDifficulty: 'moderate',
      remoteNoServices: false,
    },
    travelFromBase: { distanceKm: 5, driveMinutes: 10, driveIsScenic: false },
    ...overrides,
  } as Place;
}

const BASE_INPUT = {
  fitScore: 0.6,
  detourMinutes: 10,
  categoryCount: 0,
  supersededByParent: false,
  duplicate: false,
  usableOnTripDates: true,
  openingUncertain: false,
  detourToleranceMinutes: 60,
};

const RICH_EVIDENCE: PlaceEvidence = {
  subjectId: 'x',
  officialUrl: 'https://operator.example/visit',
  aliases: [],
  booking: {
    reservationRequired: 'no',
    timedEntry: 'no',
    permitRequired: 'no',
    guideRequired: 'unknown',
    claim: { state: 'verified' },
  },
  costs: [
    {
      kind: 'admission',
      free: false,
      money: { currency: 'EUR', amount: 12, unit: 'per_person', estimated: false, taxesUncertain: true },
      advancePurchaseRequired: 'no',
      claim: { state: 'verified' },
    },
  ],
  closures: [],
  safety: [],
  suggestedDurationMinutes: 90,
  resolved: [{ subjectId: 'x', factPath: 'hours.weekly', state: 'verified', factIds: ['f'], independentSources: 1, rationale: 'Stated by the operator.' }],
};

describe('candidate quality', () => {
  it('classifies a single mapped object as a micro feature from its tag alone', () => {
    expect(featureScale(place({ id: 'a', tags: ['historic=memorial'] }))).toBe('micro');
    expect(featureScale(place({ id: 'b', tags: ['tourism=artwork'] }))).toBe('micro');
    expect(featureScale(place({ id: 'c', tags: ['leisure=nature_reserve'] }))).toBe('area');
    expect(featureScale(place({ id: 'd', tags: ['tourism=museum'] }))).toBe('site');
  });

  it('drops a micro feature nobody publishes anything about', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({ id: 'grave', tags: ['historic=grave'], shortDescription: 'A grave.' }),
    });
    expect(assessment.outcome).toBe('insufficient_evidence');
    expect(isSkipOutcome(assessment.outcome)).toBe(true);
  });

  it('keeps the same class of feature when a source actually publishes about it', () => {
    /**
     * The asymmetry that makes this generic rather than a blocklist: the feature
     * class is an input, not a veto. A monument with an operator, a ticket price
     * and a stated visit duration is a real stop and stays one.
     */
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({ id: 'monument', tags: ['historic=monument'], shortDescription: 'A monument.' }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'monument' },
    });
    expect(assessment.outcome).not.toBe('insufficient_evidence');
    expect(assessment.signals.publicVisitation).toBe(true);
  });

  it('never ranks on popularity', () => {
    const famousPoorFit = assessCandidateQuality({
      ...BASE_INPUT,
      fitScore: 0.2,
      place: place({ id: 'famous', tags: ['tourism=attraction'], popularityScore: 0.95 }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'famous' },
    });
    const nichGoodFit = assessCandidateQuality({
      ...BASE_INPUT,
      fitScore: 0.85,
      place: place({ id: 'niche', tags: ['tourism=attraction'], popularityScore: 0.05 }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'niche' },
    });
    expect(nichGoodFit.score).toBeGreaterThan(famousPoorFit.score);
  });

  it('calls a detour past what the traveller stated not worth it, and says the number', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      detourMinutes: 140,
      detourToleranceMinutes: 60,
      place: place({ id: 'far', tags: ['tourism=attraction'] }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'far' },
    });
    expect(assessment.outcome).toBe('not_worth_detour');
    expect(assessment.reason).toContain('140');
  });

  it('demotes a place that is closed on the dates, ahead of every other judgement', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      usableOnTripDates: false,
      place: place({ id: 'shut', tags: ['tourism=museum'] }),
      evidence: { ...RICH_EVIDENCE, subjectId: 'shut' },
    });
    expect(assessment.outcome).toBe('closed_or_unavailable');
  });

  it('flags a thin record with unknown hours for verification rather than dropping it', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      openingUncertain: true,
      place: place({ id: 'thin', tags: ['tourism=museum'] }),
    });
    expect(assessment.outcome).toBe('low_confidence');
  });

  it('demotes the tenth of a category without touching the first', () => {
    const first = assessCandidateQuality({
      ...BASE_INPUT,
      categoryCount: 0,
      place: place({ id: 'v1', tags: ['tourism=viewpoint'], category: 'viewpoint' }),
    });
    const tenth = assessCandidateQuality({
      ...BASE_INPUT,
      categoryCount: 9,
      place: place({ id: 'v10', tags: ['tourism=viewpoint'], category: 'viewpoint' }),
    });
    expect(tenth.score).toBeLessThan(first.score);
  });

  it('marks a duplicate redundant rather than showing it twice', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      duplicate: true,
      place: place({ id: 'dupe', tags: ['tourism=museum'] }),
    });
    expect(assessment.outcome).toBe('redundant');
  });

  it('gives every skip a reason a person could argue with', () => {
    for (const input of [
      { ...BASE_INPUT, duplicate: true },
      { ...BASE_INPUT, usableOnTripDates: false },
      { ...BASE_INPUT, detourMinutes: 200 },
    ]) {
      const assessment = assessCandidateQuality({
        ...input,
        place: place({ id: 'x', tags: ['tourism=museum'] }),
      });
      expect(assessment.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('what the source database recorded is evidence in its own right', () => {
  it('keeps a place the map data describes, even before anything is researched', () => {
    /**
     * The live defect this covers: before recorded attributes counted, the only
     * pre-research signal was how long a sentence our own classifier had written,
     * and a New York compile dropped fifteen of twenty candidates on that basis.
     */
    const thin = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({ id: 'bare', tags: ['tourism=attraction'], shortDescription: 'A thing.' }),
    });
    const described = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'described',
        tags: ['tourism=attraction', 'attr:website', 'attr:opening_hours', 'attr:wikidata'],
        shortDescription: 'A thing.',
      }),
    });

    expect(thin.outcome).toBe('insufficient_evidence');
    expect(described.outcome).not.toBe('insufficient_evidence');
    expect(described.signals.publicVisitation).toBe(true);
    expect(described.score).toBeGreaterThan(thin.score);
  });

  it('reads only attribute names, never values', () => {
    expect(
      recordedAttributes(place({ id: 'x', tags: ['tourism=museum', 'attr:website', 'attr:fee'] })),
    ).toEqual(['website', 'fee']);
  });

  it('still demotes a micro feature whose only attributes say nothing about visiting', () => {
    const assessment = assessCandidateQuality({
      ...BASE_INPUT,
      place: place({
        id: 'plaque',
        tags: ['historic=memorial', 'attr:ele'],
        shortDescription: 'A plaque.',
      }),
    });
    expect(assessment.outcome).toBe('insufficient_evidence');
  });
});
