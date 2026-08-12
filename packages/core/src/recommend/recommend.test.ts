import { describe, expect, it } from 'vitest';
import { emptyComposerAnswers, type TripComposerAnswers } from '../schemas/composer';
import type { ClimateProfile, ClimateNormal } from '../schemas/climate';
import type { DestinationIndexEntry } from '../schemas/destination-index';
import type { DurationGuidance } from '../dates/duration';
import type { SupplyAssessment } from '../schemas/supply';
import { RANK_WEIGHTS } from '../schemas/shortlist';
import { bandFor, exclusionsFor, rankDestination, type CandidateEvidence } from './rank';
import type { RankedDestination } from '../schemas/shortlist';
import {
  buildShortlist,
  catalogueBlindSpot,
  ruledOut,
  shortlistInputKey,
  shortlistLead,
  shortlistSeparation,
} from './shortlist';

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
    /*
     * The sentence `assessSupply` actually produces, day clause and all.
     *
     * It read '120 mapped places across 4 areas.' — no day count — which made
     * the test below that asserts the day count is dropped pass whether or not
     * anything dropped it. A fixture that cannot exhibit the defect is not
     * evidence about the fix.
     */
    summary: '120 mapped places across 4 areas — comfortably enough to build 8 days from.',
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

/**
 * THE SCREEN THAT SAID "WE COULD NOT TELL THESE APART" OVER EIGHT IDENTICAL CARDS.
 *
 * A fresh reviewer opened "Help me decide" — one of three doors on the homepage
 * — and got eight administrative polygons under that headline, numbered 1 to 8,
 * with a "why this one" panel beside the first. Reproduced against the live
 * 109,853-entry index with the current tree, an ordinary set of answers scores
 * `themeFit` at exactly 0.50 for **240 of 240** candidates and puts 38 of them
 * in one tie at the top of the order.
 *
 * The two defects behind it are both here: a dimension that returned a number
 * where it had no reading, and a screen that had no way to ask whether the order
 * it was numbering was an order.
 */
describe('the ranking does not invent a reading it does not have', () => {
  /**
   * A region is a polygon drawn for governing. Its feature type says nothing
   * about whether there are mountains in it, and 0.5 is not a middling fit — it
   * is the starting value of a function that never found any evidence.
   */
  it('reports theme fit as unmeasured for an administrative unit', () => {
    for (const featureType of ['region', 'county', 'town'] as const) {
      const ranked = rankDestination({
        candidate: candidate({ entry: entry({ featureType }) }),
        answers: answers({ themes: ['outdoors'] }),
        candidateMonths: [7],
      });
      const theme = ranked.factors.find((factor) => factor.id === 'themeFit')!;
      expect(theme.measure.kind, `${featureType} carries no theme evidence`).toBe('unknown');
      expect(theme.contribution).toBe(0);
      expect(ranked.unknowns.join(' ')).toContain('Matches what you came for');
    }
  });

  /** And still measures it where the feature type genuinely carries the signal. */
  it('still measures theme fit where the index does say something', () => {
    const wild = rankDestination({
      candidate: candidate({ entry: entry({ featureType: 'national_park' }) }),
      answers: answers({ themes: ['outdoors'] }),
      candidateMonths: [7],
    });
    const urban = rankDestination({
      candidate: candidate({ entry: entry({ featureType: 'city' }) }),
      answers: answers({ themes: ['outdoors'] }),
      candidateMonths: [7],
    });
    const wildTheme = wild.factors.find((factor) => factor.id === 'themeFit')!.measure;
    const urbanTheme = urban.factors.find((factor) => factor.id === 'themeFit')!.measure;
    expect(wildTheme.kind).toBe('measured');
    expect(urbanTheme.kind).toBe('measured');
    expect(wildTheme.kind === 'measured' && wildTheme.value).toBeGreaterThan(
      urbanTheme.kind === 'measured' ? urbanTheme.value : 1,
    );
  });

  /**
   * The consequence the traveller sees: an unmeasured dimension must not buy
   * confidence. Twelve hundredths of the nominal weight was being counted as
   * measured for every candidate in the catalogue.
   */
  it('does not let the unmeasured dimension inflate coverage', () => {
    const administrative = rankDestination({
      candidate: candidate({ entry: entry({ featureType: 'region' }) }),
      answers: answers({ themes: ['outdoors'] }),
      candidateMonths: [7],
    });
    const wild = rankDestination({
      candidate: candidate({ entry: entry({ featureType: 'national_park' }) }),
      answers: answers({ themes: ['outdoors'] }),
      candidateMonths: [7],
    });
    expect(wild.coverage - administrative.coverage).toBeCloseTo(RANK_WEIGHTS.themeFit, 10);
  });

  /**
   * AND IT DOES NOT QUOTE A SENTENCE ABOUT A TRIP LENGTH NOBODY GAVE.
   *
   * `assessSupply` phrases its verdict against the days it was handed, the
   * shortlist hands it a zero when the traveller has not said, and the result
   * reached the screen as the first bullet of the lead recommendation: "182
   * mapped places across 8 areas — comfortably enough to build 0 days from."
   * The counts are true; the clause about days is not.
   */
  it('drops the day count from the supply sentence when no trip length was given', () => {
    const open = rankDestination({
      candidate: candidate(),
      answers: answers({ duration: { mode: 'unknown', wantsRecommendation: false } }),
      candidateMonths: [7],
    });
    const measure = open.factors.find((factor) => factor.id === 'supplyFit')!.measure;
    expect(measure.kind).toBe('measured');
    const basis = measure.kind === 'measured' ? measure.basis : '';
    expect(basis).not.toContain('days');
    expect(basis).toContain('120 mapped places across 4 areas');
    expect(open.reasons.join(' ')).not.toContain('0 days');
  });

  it('keeps the sentence the assessment made once a trip length exists', () => {
    const fixed = rankDestination({
      candidate: candidate(),
      answers: answers(),
      candidateMonths: [7],
    });
    const measure = fixed.factors.find((factor) => factor.id === 'supplyFit')!.measure;
    expect(measure.kind === 'measured' && measure.basis).toBe(
      '120 mapped places across 4 areas — comfortably enough to build 8 days from.',
    );
  });
});

describe('a shortlist says whether its own order is an order', () => {
  /** Eight picks that scored the same are eight picks in alphabetical order. */
  function tied(count: number): RankedDestination[] {
    return Array.from({ length: count }, (_, index) =>
      rankDestination({
        candidate: candidate({ entry: entry({ id: `cat:${index}`, displayName: `Place ${index}` }) }),
        answers: answers(),
        candidateMonths: [7],
      }),
    );
  }

  it('calls an all-equal list undifferentiated, and offers the answers that would break the tie', () => {
    const verdict = shortlistSeparation(tied(8));
    expect(verdict.undifferentiated).toBe(true);
    expect(verdict.separates).toBe(false);
    expect(verdict.tiedAtTop).toBe(8);
    // Theme fit is unmeasured for every one of them, so it did not separate
    // anything and must be named rather than counted.
    expect(verdict.unmeasured.map((entry) => entry.id)).toContain('themeFit');
    // And what *was* measured came back identical, which is the other half of
    // the sentence the screen has to say.
    expect(verdict.flat.map((entry) => entry.id)).toContain('supplyFit');
  });

  it('refuses to call a list ranked when any adjacent pair ties', () => {
    const picks = tied(3);
    // A leader, then two that tie with each other: the shape the live index
    // actually produces, and the one the old band test called "ranked".
    picks[0] = { ...picks[0]!, score: 91 };
    const verdict = shortlistSeparation(picks);
    expect(verdict.undifferentiated).toBe(false);
    expect(verdict.tiedAtTop).toBe(1);
    expect(verdict.separates).toBe(false);
  });

  it('calls a strictly descending list ranked', () => {
    const picks = tied(3).map((pick, index) => ({ ...pick, score: 90 - index * 5 }));
    const verdict = shortlistSeparation(picks);
    expect(verdict.separates).toBe(true);
    expect(verdict.undifferentiated).toBe(false);
    expect(verdict.tiedAtTop).toBe(1);
  });

  it('prefers the reason a traveller can act on when the picks disagree about why', () => {
    // Our gap first, so the ordering cannot be what makes this pass: this pick
    // has a shape but no portfolio, so structure is unknown for `no_index_coverage`.
    const ourGap = rankDestination({
      candidate: candidate({ portfolio: undefined }),
      answers: answers(),
      candidateMonths: [7],
    });
    // This one has a portfolio and no stated shape: `traveller_did_not_say`.
    const askable = rankDestination({
      candidate: candidate(),
      answers: answers({ shape: undefined }),
      candidateMonths: [7],
    });
    const verdict = shortlistSeparation([ourGap, askable]);
    const structure = verdict.unmeasured.find((entry) => entry.id === 'structureFit');
    // Both picks are unknown on this dimension for different reasons. The
    // actionable one wins, because it is the only one with a form behind it.
    expect(structure?.reason).toBe('traveller_did_not_say');
  });

  it('says nothing about an order of one', () => {
    const verdict = shortlistSeparation(tied(1));
    expect(verdict.undifferentiated).toBe(false);
    expect(verdict.separates).toBe(true);
  });
});

/**
 * WHAT THE CATALOGUE IS MADE OF, MEASURED RATHER THAN INFERRED.
 *
 * The index holds regions, counties, cities and towns and nothing else — the
 * live release supplies 203 regions and 37 counties to the universe scan and not
 * one island, park or protected area — so every shortlist the product can
 * produce today is administrative geometry. A traveller reading "Akershus,
 * Tirana County, Zagreb County" deserves to know that is the catalogue and not
 * the answer.
 *
 * This used to be derived from the picks, and the derivation was unsound in the
 * one case that matters: an index carrying five national parks, none of which
 * reached the top eight, still produced "that is all our place index holds".
 * The sentence is a claim about the release, so it is made from what the release
 * returned.
 */
describe('a shortlist admits what kind of places it is made of', () => {
  it('names the kinds the index could not supply', () => {
    const spots = catalogueBlindSpot({
      requested: ['region', 'county', 'island', 'national_park', 'protected_area'],
      supplied: ['region', 'region', 'county'],
    });
    expect(spots.join(' ')).toContain('administrative region or county');
    expect(spots.join(' ')).toContain('islands, national parks or protected areas');
  });

  it('says nothing of the sort once the index supplies a landscape kind', () => {
    expect(
      catalogueBlindSpot({
        requested: ['region', 'county', 'island', 'national_park', 'protected_area'],
        supplied: ['region', 'county', 'national_park'],
      }),
    ).toEqual([]);
  });

  /**
   * The false inference, held out as a case rather than described in a comment.
   *
   * Two administrative picks on screen, and an index that did supply a national
   * park to the scan. The old rule read the picks and would have announced that
   * the catalogue holds no parks — a claim about our data derived from a scoring
   * outcome, and false.
   */
  it('does not conclude the index is empty of parks from a list that has none', () => {
    expect(
      catalogueBlindSpot({
        requested: ['region', 'county', 'national_park'],
        supplied: ['region', 'county', 'national_park'],
      }),
    ).toEqual([]);

    const result = buildShortlist({
      candidates: [
        candidate({ entry: entry({ id: 'cat:a', featureType: 'region' }) }),
        candidate({ entry: entry({ id: 'cat:b', featureType: 'county', countryCode: 'BB' }) }),
      ],
      answers: answers(),
      seasonMonths: [],
      climateRequests: 0,
      elapsedMs: 10,
      now: NOW,
    });
    expect(
      result.blindSpots.join(' '),
      'buildShortlist must not invent a claim about the catalogue from its own output',
    ).not.toContain('administrative region or county');
  });

  it('says nothing when the caller only ever asked for administrative kinds', () => {
    expect(catalogueBlindSpot({ requested: ['region', 'county'], supplied: ['region'] })).toEqual([]);
  });
});

/**
 * A NO-CONFIDENCE RESULT IS STILL A SCREEN SOMEBODY HAS TO USE.
 *
 * `shortlistSeparation` established that the live list is not a ranking. On its
 * own that produced a page headed "We could not tell these apart" over eight
 * identical cards — the method's self-assessment served instead of an answer.
 * `shortlistLead` is what turns the same verdict into one recommendation with a
 * true account of why it is first.
 */
describe('a shortlist that cannot rank still leads with one', () => {
  function scored(values: readonly { score: number; coverage: number }[]): RankedDestination[] {
    return values.map((value, index) => ({
      ...rankDestination({
        candidate: candidate({ entry: entry({ id: `cat:${index}`, displayName: `Place ${index}` }) }),
        answers: answers(),
        candidateMonths: [7],
      }),
      ...value,
    }));
  }

  it('claims a winner only where one outscored the rest', () => {
    const picks = scored([{ score: 91, coverage: 0.6 }, { score: 80, coverage: 0.6 }]);
    const lead = shortlistLead(picks, shortlistSeparation(picks));
    expect(lead?.basis).toBe('outscored');
    expect(lead?.entryId).toBe('cat:0');
    expect(lead?.tiedWith).toBe(1);
  });

  /**
   * The shape the live index produces: level on score, and one of them is the
   * one we could actually check. That is not a claim that it fits better — it is
   * a checkable reason to start there, which is what the screen says.
   */
  it('leads on evidence when the scores are level', () => {
    const picks = scored([
      { score: 95, coverage: 0.4 },
      { score: 95, coverage: 0.8 },
      { score: 95, coverage: 0.4 },
    ]);
    const lead = shortlistLead(picks, shortlistSeparation(picks));
    expect(lead?.basis).toBe('best_evidenced');
    expect(lead?.entryId).toBe('cat:1');
    expect(lead?.tiedWith).toBe(3);
  });

  it('admits it when score and evidence are both level', () => {
    const picks = scored([
      { score: 100, coverage: 0.24 },
      { score: 100, coverage: 0.24 },
    ]);
    const lead = shortlistLead(picks, shortlistSeparation(picks));
    expect(lead?.basis).toBe('arbitrary');
    expect(lead?.entryId).toBe('cat:0');
    expect(lead?.tiedWith).toBe(2);
  });

  /**
   * One question, and the one that pays.
   *
   * Trip length carries 0.18 of the nominal weight, what they came for 0.12, the
   * number of bases 0.10 and getting around 0.04 — so a page with room for a
   * single ask must ask about the nights. The page used to list all of them,
   * which is a form.
   *
   * The assertion above the verdict is load-bearing: with one askable dimension
   * in the fixture, `[0]` would pass however the list were ordered, and the
   * test would be evidence of nothing.
   */
  it('asks for the heaviest answer the traveller could still give', () => {
    /*
     * Bases and what-you-came-for left open, and nothing else.
     *
     * The pair is chosen so that declaration order and weight order disagree:
     * `RANK_DIMENSIONS` lists `structureFit` before `themeFit`, and the weights
     * run the other way — 0.10 against 0.12. An earlier version of this test
     * left trip length open too, and trip length is both the heaviest *and* the
     * earliest, so deleting the sort entirely did not fail it. A fixture whose
     * two orderings agree cannot be evidence about which one is used.
     */
    const picks = [
      rankDestination({
        candidate: candidate(),
        answers: answers({ shape: undefined, themes: [] }),
        candidateMonths: [7],
      }),
    ];
    const separation = shortlistSeparation(picks);
    const asked = separation.unmeasured.filter((entry) => entry.reason === 'traveller_did_not_say');
    expect(
      asked.map((entry) => entry.id),
      'the fixture must ask in declaration order, or the sort proves nothing',
    ).toEqual(['structureFit', 'themeFit']);
    expect(RANK_WEIGHTS.themeFit).toBeGreaterThan(RANK_WEIGHTS.structureFit);

    const lead = shortlistLead(picks, separation);
    expect(lead?.nextQuestion?.id).toBe('themeFit');
    expect(lead?.nextQuestion?.action).toContain('what you are going for');
  });

  it('asks nothing when every gap is ours rather than theirs', () => {
    const picks = [
      rankDestination({
        candidate: candidate({ climate: undefined, climateAbsence: 'climate_provider_unavailable' }),
        answers: answers(),
        candidateMonths: [7],
      }),
    ];
    const lead = shortlistLead(picks, shortlistSeparation(picks));
    expect(lead?.nextQuestion).toBeUndefined();
  });
});
