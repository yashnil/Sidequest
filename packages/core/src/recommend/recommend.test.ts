import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, type TripComposerAnswers } from '../schemas/composer';
import type { ClimateProfile, ClimateNormal } from '../schemas/climate';
import type { DestinationIndexEntry } from '../schemas/destination-index';
import type { DurationGuidance } from '../dates/duration';
import type { SupplyAssessment } from '../schemas/supply';
import { RANK_WEIGHTS } from '../schemas/shortlist';
import { bandFor, exclusionsFor, rankDestination, type CandidateEvidence } from './rank';
import { buildShortlist, ruledOut, shortlistInputKey } from './shortlist';

const NOW = new Date('2026-08-03T00:00:00Z');

function entry(overrides: Partial<DestinationIndexEntry> = {}): DestinationIndexEntry {
  return {
    id: 'cat:a',
    catalog: 'cat',
    sourceId: 'a',
    featureType: 'region',
    displayName: 'Northern Uplands',
    aliases: [],
    hierarchy: ['Someland'],
    center: { lat: 40, lng: 10 },
    countryCode: 'AA',
    ...overrides,
  };
}

function normal(month: number, overrides: Partial<ClimateNormal> = {}): ClimateNormal {
  return {
    month,
    temperature: { low: 12, high: 22 },
    precipitationMm: 30,
    wetDays: 4,
    snowDays: 0,
    daylightHours: 14,
    hotDays: 0,
    freezeDays: 0,
    ...overrides,
  };
}

function climate(overrides: Partial<ClimateNormal> = {}): ClimateProfile {
  return {
    schemaVersion: 1,
    coordinates: { lat: 40, lng: 10 },
    sampleYearFrom: 2005,
    sampleYearTo: 2024,
    months: Array.from({ length: 12 }, (_, index) => normal(index + 1, overrides)),
    provider: 'test',
    dataset: 'test',
    attribution: 'Test',
    retrievedAt: NOW.toISOString(),
  };
}

function duration(minNights = 4, clustersReached = 3): DurationGuidance {
  return {
    kind: 'recommended',
    clusterCount: 4,
    basis: 'four distinct areas',
    options: [
      {
        minNights,
        maxNights: minNights + 3,
        bases: 2,
        label: 'Two bases',
        covers: 'two areas',
        tradeoff: 'Leaves one out.',
        clustersReached,
        transferDays: 0.5,
        recommended: true,
      },
    ],
  };
}

function supply(level: SupplyAssessment['level'] = 'strong'): SupplyAssessment {
  return {
    schemaVersion: 1,
    level,
    funnel: {
      sourceRecords: 400,
      candidates: 120,
      categories: 6,
      clusters: 4,
      anchors: 40,
      supportStops: 12,
      baseCandidates: 3,
      tripDays: 7,
    },
    summary: '120 mapped places across 4 areas.',
    shortfalls: [],
    actions: [],
    repairsAttempted: [],
    assessedAt: NOW.toISOString(),
  };
}

function portfolio(clusters = 4, basesProposed = 2) {
  return {
    gateway: { name: 'Gate', center: { lat: 40, lng: 10 } },
    route: [],
    excluded: [],
    allClusters: Array.from({ length: clusters }, (_, index) => ({
      id: `c${index}`,
      name: `Area ${index}`,
      center: { lat: 40 + index * 0.2, lng: 10 },
      memberCount: 5,
      memberNames: [],
      distanceFromGatewayKm: index * 25,
      transferMinutesFromGateway: index * 30,
    })),
    basesProposed,
    transferDays: 0.5,
    mode: 'drive' as const,
    rationale: 'test',
    binding: 'preference' as const,
  };
}

function answers(overrides: Partial<TripComposerAnswers> = {}): TripComposerAnswers {
  return {
    ...emptyComposerAnswers('help_me_decide', NOW),
    dates: { mode: 'month', month: 7, wantsRecommendation: false },
    duration: { mode: 'fixed', nights: 7, wantsRecommendation: false },
    shape: 'two_bases',
    transport: 'drive',
    themes: ['outdoors'],
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    entry: entry(),
    releaseId: '2026-07-22.0',
    climate: climate(),
    portfolio: portfolio() as unknown as CandidateEvidence['portfolio'],
    duration: duration(),
    supply: supply(),
    indexFeatureCount: 120,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('destination ranking', () => {
  it('keeps every dimension inside its range, and the total finite', () => {
    const ranked = rankDestination({
      candidate: candidate(),
      answers: answers(),
      candidateMonths: [7],
    });

    expect(Number.isFinite(ranked.score)).toBe(true);
    expect(ranked.score).toBeGreaterThanOrEqual(0);
    expect(ranked.score).toBeLessThanOrEqual(100);
    expect(ranked.coverage).toBeGreaterThanOrEqual(0);
    expect(ranked.coverage).toBeLessThanOrEqual(1);
    for (const factor of ranked.factors) {
      if (factor.measure.kind === 'measured') {
        expect(Number.isFinite(factor.measure.value)).toBe(true);
        expect(factor.measure.value).toBeGreaterThanOrEqual(0);
        expect(factor.measure.value).toBeLessThanOrEqual(1);
      }
      expect(factor.contribution).toBeGreaterThanOrEqual(0);
      expect(factor.contribution).toBeLessThanOrEqual(factor.weight);
    }
  });

  it('sums its nominal weights to one, so coverage means something', () => {
    const total = Object.values(RANK_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  /**
   * THE HEADLINE PROPERTY.
   *
   * A destination whose climate we could not read must not be punished the way a
   * destination with a genuinely bad climate is. The two produce different
   * scores, different coverage and different sentences.
   */
  it('does not score unknown as zero', () => {
    const shared = answers();
    const unknownClimate = rankDestination({
      candidate: candidate({ climate: undefined, climateAbsence: 'climate_provider_unavailable' }),
      answers: shared,
      candidateMonths: [7],
    });
    const badClimate = rankDestination({
      candidate: candidate({
        climate: {
          ...climate(),
          months: Array.from({ length: 12 }, (_, index) =>
            normal(index + 1, {
              temperature: { low: 34, high: 46 },
              hotDays: 28,
              wetDays: 22,
              daylightHours: 9,
            }),
          ),
        },
      }),
      answers: shared,
      candidateMonths: [7],
    });

    expect(unknownClimate.score).toBeGreaterThan(badClimate.score);
    expect(unknownClimate.coverage).toBeLessThan(badClimate.coverage);
    expect(unknownClimate.unknowns.join(' ')).toContain('did not answer');
    expect(badClimate.unknowns.join(' ')).not.toContain('did not answer');
  });

  /**
   * And the other half of the same rule: a high score built on almost nothing
   * cannot be presented as a strong match.
   */
  it('gates the band on coverage, whatever the score', () => {
    expect(bandFor(95, 0.4)).toBe('thin_evidence');
    expect(bandFor(95, 0.75)).toBe('strong_match');
    expect(bandFor(95, 0.6)).toBe('worth_a_look');
    expect(bandFor(30, 1)).toBe('possible');
  });

  it('never lets no index coverage read as an empty region', () => {
    const ranked = rankDestination({
      candidate: candidate({ indexFeatureCount: 0, supply: undefined, portfolio: undefined }),
      answers: answers(),
      candidateMonths: [7],
    });
    const supplyFactor = ranked.factors.find((factor) => factor.id === 'supplyFit');
    expect(supplyFactor?.measure.kind).toBe('unknown');
    expect(exclusionsFor({ candidate: candidate({ indexFeatureCount: 0, portfolio: undefined }), answers: answers(), candidateMonths: [7] })).toEqual([]);
  });

  /**
   * The Denali-versus-Delhi class, at destination scale.
   *
   * Being enormous and famous is not a reason to be recommended. Nothing in the
   * ranker reads population or cartographic prominence, so a huge, well-known
   * place with a poor climate fit loses to a small one with a good fit.
   */
  it('never lets fame compensate for a worse fit', () => {
    const famous = rankDestination({
      candidate: candidate({
        entry: entry({ id: 'cat:big', displayName: 'Great City', population: 22_000_000, prominence: 100 }),
        climate: {
          ...climate(),
          months: Array.from({ length: 12 }, (_, index) =>
            normal(index + 1, { temperature: { low: 32, high: 44 }, hotDays: 26 }),
          ),
        },
      }),
      answers: answers(),
      candidateMonths: [7],
    });
    const obscure = rankDestination({
      candidate: candidate({ entry: entry({ id: 'cat:small', displayName: 'Small Valley' }) }),
      answers: answers(),
      candidateMonths: [7],
    });

    expect(obscure.score).toBeGreaterThan(famous.score);
  });

  it('is a pure function of its inputs', () => {
    const input = { candidate: candidate(), answers: answers(), candidateMonths: [7] };
    expect(rankDestination(input)).toEqual(rankDestination(input));
  });
});

describe('hard exclusions', () => {
  it('are not triggered by a missing climate profile', () => {
    const found = exclusionsFor({
      candidate: candidate({ climate: undefined }),
      answers: answers({ avoid: 'we cannot cope with heat' }),
      candidateMonths: [7],
    });
    expect(found).toEqual([]);
  });

  it('fire on a stated limit against a measured climate', () => {
    const found = exclusionsFor({
      candidate: candidate({
        climate: {
          ...climate(),
          months: Array.from({ length: 12 }, (_, index) => normal(index + 1, { hotDays: 25 })),
        },
      }),
      answers: answers({ avoid: 'we cannot cope with heat' }),
      candidateMonths: [7],
    });
    expect(found.map((entry) => entry.code)).toEqual(['climate_conflicts_with_stated_limit']);
    expect(found[0]!.message.length).toBeGreaterThan(10);
  });

  it('treat a merely short trip as a tradeoff rather than an exclusion', () => {
    const short = exclusionsFor({
      candidate: candidate({ duration: duration(9) }),
      answers: answers({ duration: { mode: 'fixed', nights: 7, wantsRecommendation: false } }),
      candidateMonths: [7],
    });
    expect(short).toEqual([]);

    const impossible = exclusionsFor({
      candidate: candidate({ duration: duration(20) }),
      answers: answers({ duration: { mode: 'fixed', nights: 7, wantsRecommendation: false } }),
      candidateMonths: [7],
    });
    expect(impossible.map((entry) => entry.code)).toEqual(['far_too_short_for_this_ground']);
  });

  /**
   * An avoid-list exclusion on an edit-distance match would be the
   * Denali/Delhi failure with worse consequences: two characters of typo
   * silently deleting a country, with nothing on screen to explain it.
   */
  it('rules a destination out only on an exact name, never on a near one', () => {
    expect(ruledOut(answers({ avoid: 'Northern Uplands' }), 'Northern Uplands')).toBe(true);
    expect(ruledOut(answers({ avoid: 'northern uplands, too cold' }), 'Northern Uplands')).toBe(true);
    expect(ruledOut(answers({ avoid: 'Northern Upland' }), 'Northern Uplands')).toBe(false);
    expect(ruledOut(answers({ avoid: 'Deli' }), 'Denali')).toBe(false);
    expect(ruledOut(answers({ avoid: 'nothing too hot' }), 'Northern Uplands')).toBe(false);
  });
});

describe('the shortlist', () => {
  function universe(count: number, spread = true): CandidateEvidence[] {
    return Array.from({ length: count }, (_, index) =>
      candidate({
        entry: entry({
          id: `cat:${index}`,
          displayName: `Place ${index}`,
          countryCode: spread ? String.fromCharCode(65 + (index % 26)) + 'A' : 'AA',
          center: spread ? { lat: 10 + index * 6, lng: index * 7 } : { lat: 40, lng: 10 + index * 0.05 },
        }),
      }),
    );
  }

  it('returns at most eight, ordered, deterministic', () => {
    const first = buildShortlist({
      candidates: universe(40),
      answers: answers(),
      seasonMonths: [],
      climateRequests: 12,
      elapsedMs: 100,
      now: NOW,
    });
    const second = buildShortlist({
      candidates: universe(40),
      answers: answers(),
      seasonMonths: [],
      climateRequests: 12,
      elapsedMs: 100,
      now: NOW,
    });

    expect(first.picks.length).toBeLessThanOrEqual(8);
    expect(first.picks.map((pick) => pick.entryId)).toEqual(second.picks.map((pick) => pick.entryId));
    for (let index = 1; index < first.picks.length; index += 1) {
      expect(first.picks[index - 1]!.score).toBeGreaterThanOrEqual(first.picks[index]!.score);
    }
  });

  /**
   * Forty near-identical candidates in one country must not fill the list with
   * forty variations on one suggestion — and when they are all there is, the
   * relaxation is recorded rather than silent.
   */
  it('diversifies, and says when it had to give up on diversifying', () => {
    const spread = buildShortlist({
      candidates: universe(40, true),
      answers: answers(),
      seasonMonths: [],
      climateRequests: 12,
      elapsedMs: 100,
      now: NOW,
    });
    expect(new Set(spread.picks.map((pick) => pick.countryCode)).size).toBe(spread.picks.length);
    expect(spread.diversityNote).toBeUndefined();

    const clustered = buildShortlist({
      candidates: universe(40, false),
      answers: answers(),
      seasonMonths: [],
      climateRequests: 12,
      elapsedMs: 100,
      now: NOW,
    });
    expect(clustered.picks.length).toBeGreaterThan(1);
    expect(clustered.diversityNote).toBeTruthy();
  });

  it('returns what it removed, with a reason for each', () => {
    const result = buildShortlist({
      candidates: [
        candidate({ entry: entry({ id: 'cat:keep', displayName: 'Keep This' }) }),
        candidate({ entry: entry({ id: 'cat:drop', displayName: 'Drop This' }) }),
      ],
      answers: answers({ avoid: 'Drop This' }),
      seasonMonths: [],
      climateRequests: 2,
      elapsedMs: 10,
      now: NOW,
    });

    expect(result.picks.map((pick) => pick.entryId)).toEqual(['cat:keep']);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]!.exclusion.code).toBe('traveller_ruled_it_out');
    expect(result.excluded[0]!.exclusion.message.length).toBeGreaterThan(5);
  });

  it('always names what the method could not see', () => {
    const result = buildShortlist({
      candidates: universe(3),
      answers: answers(),
      seasonMonths: [],
      climateRequests: 3,
      elapsedMs: 10,
      now: NOW,
    });
    const text = result.blindSpots.join(' ').toLowerCase();
    expect(text).toContain('flight');
    expect(text).toContain('visa');
    expect(text).toContain('safety');
  });

  it('changes its input key when anything that could change the answer changes', () => {
    const base = { answers: answers(), releaseId: 'r1', candidateMonths: [7] };
    const key = shortlistInputKey(base);

    expect(shortlistInputKey({ ...base, releaseId: 'r2' })).not.toBe(key);
    expect(shortlistInputKey({ ...base, candidateMonths: [8] })).not.toBe(key);
    expect(shortlistInputKey({ ...base, answers: answers({ shape: 'one_base' }) })).not.toBe(key);
    expect(shortlistInputKey({ ...base, answers: answers({ transport: 'public_transport' }) })).not.toBe(key);
    expect(shortlistInputKey({ ...base, answers: answers({ themes: ['food'] }) })).not.toBe(key);
    expect(shortlistInputKey({ ...base, answers: answers({ avoid: 'crowds' }) })).not.toBe(key);
    // The same answers in a different theme order are the same request.
    expect(shortlistInputKey({ ...base, answers: answers({ themes: ['outdoors'] }) })).toBe(key);
  });

  it('reports what it cost', () => {
    const result = buildShortlist({
      candidates: universe(5),
      answers: answers(),
      seasonMonths: [],
      climateRequests: 5,
      elapsedMs: 240,
      now: NOW,
    });
    expect(result.climateRequests).toBe(5);
    expect(result.elapsedMs).toBe(240);
    expect(result.considered).toBe(5);
  });
});
