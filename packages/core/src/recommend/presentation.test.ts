import { describe, expect, it } from 'vitest';
import {
  budgetFit,
  definingDraws,
  featureRecommendation,
  mainTradeoff,
  recommendedWindow,
  travelBurden,
  tripConcept,
} from './presentation';
import { emptyComposerAnswers, type TripComposerAnswers } from '../schemas/composer';
import { RANK_DIMENSIONS, RANK_WEIGHTS, measured, unknown, type RankFactor, type RankedDestination } from '../schemas/shortlist';

const NOW = new Date('2026-09-13T00:00:00Z');

function factors(overrides: Partial<Record<(typeof RANK_DIMENSIONS)[number], RankFactor['measure']>>): RankFactor[] {
  return RANK_DIMENSIONS.map((id) => {
    const measure = overrides[id] ?? unknown('traveller_did_not_say');
    return {
      id,
      label: id,
      weight: RANK_WEIGHTS[id],
      measure,
      contribution: measure.kind === 'measured' ? RANK_WEIGHTS[id] * measure.value : 0,
    };
  });
}

function pick(overrides: Partial<RankedDestination> = {}): RankedDestination {
  return {
    entryId: 'e1',
    releaseId: 'r1',
    displayName: 'Somewhere',
    qualifiedName: 'Somewhere, Nowhere',
    featureType: 'natural_region',
    center: { lat: 51, lng: -114 },
    score: 80,
    coverage: 0.7,
    band: 'strong_match',
    factors: factors({}),
    conflicts: [],
    unknowns: [],
    reasons: [],
    tradeoffs: [],
    ...overrides,
  };
}

function answers(overrides: Partial<TripComposerAnswers> = {}): TripComposerAnswers {
  return { ...emptyComposerAnswers('help_me_decide', NOW), ...overrides };
}

describe('the recommended sub-window', () => {
  const FREE = { mode: 'flexible' as const, startDate: '2026-12-18', endDate: '2027-01-03', wantsRecommendation: false };

  it('says nothing when the traveller gave no window', () => {
    expect(recommendedWindow(pick(), answers())).toBeNull();
  });

  it('does not dress up the whole window as a choice', () => {
    const window = recommendedWindow(
      pick(),
      answers({ dates: FREE, duration: { mode: 'fixed', nights: 16, wantsRecommendation: false } }),
    )!;
    expect(window.wholeWindow).toBe(true);
    expect(window.startDate).toBe('2026-12-18');
    expect(window.endDate).toBe('2027-01-03');
  });

  it('slides a shorter trip into the month the place is actually best in', () => {
    const window = recommendedWindow(
      pick({ bestMonths: [1] }),
      answers({ dates: FREE, duration: { mode: 'fixed', nights: 8, wantsRecommendation: false } }),
    )!;
    expect(window.nights).toBe(8);
    /* Every offset available spends some nights in January; the most is the last one. */
    expect(window.startDate).toBe('2026-12-26');
    expect(window.endDate).toBe('2027-01-03');
    expect(window.basis).toBe("2 of 8 nights fall in this place's best months, which is the most your window allows");
  });

  it('says the window was not chosen when there are no records to choose with', () => {
    const window = recommendedWindow(
      pick(),
      answers({ dates: FREE, duration: { mode: 'fixed', nights: 8, wantsRecommendation: false } }),
    )!;
    expect(window.startDate).toBe('2026-12-18');
    expect(window.basis).toContain('no records');
  });

  it('says so when none of the free window falls in a best month', () => {
    const window = recommendedWindow(
      pick({ bestMonths: [7] }),
      answers({ dates: FREE, duration: { mode: 'fixed', nights: 8, wantsRecommendation: false } }),
    )!;
    expect(window.basis).toContain("none of it falls in this place's best months");
  });

  it('falls back to the nights the ground supports when the traveller gave no length', () => {
    const window = recommendedWindow(pick({ suggestedNights: 9 }), answers({ dates: FREE }))!;
    expect(window.nights).toBe(9);
    expect(window.wholeWindow).toBe(false);
  });

  it('never reads a free window as a trip length', () => {
    /*
     * Sixteen days free is not a sixteen-night trip. `nightsFrom` would say it
     * is, which is why nothing here calls it.
     */
    const window = recommendedWindow(pick(), answers({ dates: FREE, duration: { mode: 'fixed', nights: 10, wantsRecommendation: false } }))!;
    expect(window.nights).toBe(10);
    expect(window.wholeWindow).toBe(false);
  });
});

describe('the trip concept', () => {
  it('is built from the bases and nights, never from adjectives', () => {
    expect(
      tripConcept(pick({ suggestedBases: 3 }), answers({ duration: { mode: 'fixed', nights: 10, wantsRecommendation: false } })),
    ).toBe('10 nights in a landscape — 3 bases, a route rather than a stay.');
    expect(tripConcept(pick({ suggestedBases: 1, featureType: 'city' }), answers())).toBe(
      'A city and the country around it: one base, days out from it.',
    );
  });

  it('says nothing when neither a length nor a shape is known', () => {
    expect(tripConcept(pick(), answers())).toBeNull();
  });
});

describe('budget, travel and the tradeoff', () => {
  it('never turns a distance into a fare', () => {
    const statement = travelBurden(pick({ factors: factors({ flightBurden: measured(0.3, 'about 9,000 km from where you are starting, against a long appetite for flying') }) }));
    expect(statement.word).toBe('Heavy');
    expect(statement.detail).toContain('km');
    expect(statement.detail).not.toMatch(/[$£€]|\bfare\b|\bairfare\b/);
  });

  it('abstains rather than guessing when the origin never resolved', () => {
    expect(travelBurden(pick()).word).toBe('Not checked');
  });

  it('says what it knows about beds, and distinguishes the two reasons it might not', () => {
    expect(budgetFit(pick(), answers()).detail).toContain('you have not said');
    expect(budgetFit(pick(), answers({ lodgingComfort: 'simple' })).detail).toContain('nothing on record');
    expect(budgetFit(pick({ factors: factors({ comfortFit: measured(1, 'simple places to stay exist here') }) }), answers()).word).toBe('Comfortable');
  });

  it('prefers the ranking’s own tradeoff, then its conflict, then the weakest thing measured', () => {
    expect(mainTradeoff(pick({ tradeoffs: ['You would see one part of this rather than the whole of it.'] }))).toBe(
      'You would see one part of this rather than the whole of it.',
    );
    expect(mainTradeoff(pick({ conflicts: [{ code: 'assumed_no_car', message: 'No car assumed.' }] }))).toBe('No car assumed.');
    expect(mainTradeoff(pick({ factors: factors({ crowdFit: measured(0.2, '90% of its peak busyness in the months you can go') }) }))).toContain(
      'peak busyness',
    );
  });

  it('invents no caveat when everything measured came out well', () => {
    expect(mainTradeoff(pick({ factors: factors({ climateFit: measured(0.9, 'records') }) }))).toBeNull();
  });
});

describe('what it is for', () => {
  it('names the traveller’s own themes and the counted structure, and nothing else', () => {
    const draws = definingDraws(
      pick({
        factors: factors({
          themeFit: measured(0.8, 'from what kind of place this is, which is all the index can say'),
          supplyFit: measured(0.9, '180 things to do on record'),
          varietyFit: measured(0.6, '4 distinct areas'),
        }),
      }),
      answers({ themes: ['outdoors', 'wildlife'] }),
    );
    expect(draws).toHaveLength(3);
    expect(draws[0]).toContain('Hiking and being outside');
    expect(draws[1]).toContain('180 things');
  });

  it('says nothing at all when nothing scored', () => {
    expect(definingDraws(pick(), answers({ themes: ['outdoors'] }))).toEqual([]);
  });
});

describe('the whole featured card', () => {
  it('answers every one of §A2’s seven questions, or says which it cannot', () => {
    const card = featureRecommendation(
      pick({
        reasons: ['The weather suits this trip at that time of year — 2005–2024 records for that month.'],
        suggestedBases: 3,
        bestMonths: [1],
        factors: factors({
          flightBurden: measured(0.4, 'about 9,000 km from where you are starting, against a long appetite for flying'),
          comfortFit: measured(1, 'simple places to stay exist here'),
          supplyFit: measured(0.9, '180 things to do on record'),
        }),
      }),
      answers({
        dates: { mode: 'flexible', startDate: '2026-12-18', endDate: '2027-01-03', wantsRecommendation: false },
        duration: { mode: 'fixed', nights: 10, wantsRecommendation: false },
        themes: ['outdoors'],
        budgetPerPerson: 2500,
        budgetIncludesFlights: false,
      }),
    );
    expect(card.window).not.toBeNull();
    expect(card.concept).toContain('3 bases');
    expect(card.fit).toHaveLength(1);
    expect(card.draws.length).toBeGreaterThan(0);
    expect(card.budget.word).toBe('Comfortable');
    expect(card.travel.word).toBe('Heavy');
    expect(card.answered).toContain('2,500 per person before flights');
  });
});
