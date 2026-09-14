import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DESTINATION_RANKER_VERSION,
  DESTINATION_SHORTLIST_VERSION,
  RANK_DIMENSION_LABELS,
  RANK_WEIGHTS,
  emptyComposerAnswers,
  type DestinationShortlist,
  type RankBand,
  type RankedDestination,
} from '@sidequest/core';

/*
 * The component calls `useRouter` to refresh after ranking. There is no app
 * router in a unit test and the effect never runs under `renderToStaticMarkup`
 * anyway, so a stub is enough — what is under test is the markup.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { ShortlistView } = await import('./ShortlistView');

/**
 * A RANKING NOBODY STANDS BEHIND, PRESENTED AS A RANKING.
 *
 * A live /decide run produced eight administrative polygons, every one of them
 * in the thin-evidence band — "Not enough to judge" on every card — under a
 * numbered list from 1 to 8. The page above it now says, in words, that we could
 * not tell them apart; the list below it went on numbering them. Numbers beat
 * disclaimers, and somebody acts on the first row.
 *
 * The second half is §26: the disclosure under "why this one" explained the
 * scoring model to the traveller — weights, dimensions, and things that were
 * "unmeasured" — on the screen where they choose where to spend a holiday.
 */

function pick(entryId: string, band: RankBand, score = 94, coverage = 0.4): RankedDestination {
  return {
    entryId,
    releaseId: 'release-1',
    displayName: entryId,
    qualifiedName: `${entryId}, Somewhere`,
    featureType: 'region',
    center: { lat: 10, lng: 20 },
    score,
    coverage,
    band,
    factors: [
      {
        id: 'climateFit',
        label: RANK_DIMENSION_LABELS.climateFit,
        weight: RANK_WEIGHTS.climateFit,
        measure: { kind: 'unknown', reason: 'no_climate_record' },
        contribution: 0,
      },
      {
        id: 'supplyFit',
        label: RANK_DIMENSION_LABELS.supplyFit,
        weight: RANK_WEIGHTS.supplyFit,
        measure: { kind: 'measured', value: 0.6, basis: 'from 40 indexed places' },
        contribution: 0.1,
      },
    ],
    conflicts: [],
    unknowns: [],
    reasons: [],
    tradeoffs: [],
  };
}

function shortlist(
  bands: RankBand[],
  scores?: number[],
  options: { coverages?: number[]; blindSpots?: string[] } = {},
): DestinationShortlist {
  return {
    schemaVersion: DESTINATION_SHORTLIST_VERSION,
    rankerVersion: DESTINATION_RANKER_VERSION,
    inputKey: 'key',
    picks: bands.map((band, index) =>
      pick(`Place ${index + 1}`, band, scores?.[index], options.coverages?.[index]),
    ),
    considered: 40,
    excluded: [],
    blindSpots: options.blindSpots ?? [],
    builtAt: '2026-08-11T00:00:00.000Z',
    elapsedMs: 1200,
    climateRequests: 3,
  };
}

const ANSWERS = {
  ...emptyComposerAnswers('help_me_decide', new Date('2026-09-13T00:00:00Z')),
  themes: ['outdoors' as const],
  dates: { mode: 'month' as const, month: 9, wantsRecommendation: false },
  duration: { mode: 'fixed' as const, nights: 9, wantsRecommendation: false },
};

function render(value: DestinationShortlist | null): string {
  return renderToStaticMarkup(
    createElement(ShortlistView, {
      sessionId: 'session-1',
      shortlist: value,
      answers: ANSWERS,
      answersSummary: 'Two weeks in September',
    }),
  );
}

/** How many destinations the screen actually features, rather than demotes. */
function featured(markup: string): number {
  return [...markup.matchAll(/data-testid="shortlist-featured-card"/g)].length;
}

describe('the answer is three and a wildcard, and it is at the top', () => {
  it('features the best three and one deliberate outlier, and demotes the rest', () => {
    const markup = render(shortlist(['strong_match', 'strong_match', 'worth_a_look', 'worth_a_look', 'possible'], [95, 91, 88, 84, 80]));
    expect(featured(markup), 'three best plus one wildcard').toBe(4);
    expect(markup).toContain('Wildcard');
    /* Demoted, never hidden: the fifth is still on the page and still reachable. */
    expect(markup).toContain('Also scored');
    expect(markup).toContain('Place 5');
  });

  it('never numbers the picks, whatever the scores did', () => {
    /*
     * A LIVE RUN PRODUCED EIGHT ADMINISTRATIVE POLYGONS UNDER A NUMBERED LIST.
     *
     * The page above said, in words, that we could not tell them apart; the list
     * below went on numbering them 1 to 8. Numbers beat disclaimers and somebody
     * acts on the first row. The layout that replaced it has no ordinal to
     * suppress — which is the structural version of the same fix, and this
     * asserts the property rather than the old conditional that produced it.
     */
    for (const value of [
      shortlist(Array<RankBand>(8).fill('worth_a_look'), Array(8).fill(95)),
      shortlist(['strong_match', 'worth_a_look', 'possible'], [91, 84, 77]),
    ]) {
      const markup = render(value);
      expect(markup).not.toMatch(/aria-hidden="true"[^>]*>\d+<\/span>/);
    }
  });

  it('says once, at the top, when nothing separated the picks', () => {
    const markup = render(shortlist(['thin_evidence', 'thin_evidence'], [100, 100], { coverages: [0.24, 0.24] }));
    expect(markup).toContain('The order below is not a verdict');
    expect(markup).not.toContain('Why this one');
  });

  it('leads with the best-evidenced pick when the scores tie, and says why', () => {
    const markup = render(
      shortlist(['worth_a_look', 'worth_a_look', 'worth_a_look'], [95, 95, 95], { coverages: [0.4, 0.85, 0.4] }),
    );
    expect(markup).toContain('the one we could check the most of');
    /* The card the page argues for is the first one offered, and its own heading names it. */
    const first = markup.indexOf('Place 2, Somewhere');
    const second = markup.indexOf('Place 1, Somewhere');
    expect(first).toBeGreaterThan(-1);
    expect(first, 'the destination we argue for is the first one offered').toBeLessThan(second);
  });

  it('claims a choice only where one destination actually outscored the rest', () => {
    expect(render(shortlist(['thin_evidence', 'thin_evidence']))).not.toContain('Why this one');
    expect(render(shortlist(['strong_match', 'possible'], [91, 60]))).toContain('Why this one');
  });
});

/**
 * V11 §A2 — WHAT A FEATURED CARD HAS TO SAY, AND WHAT IT MAY NEVER SAY.
 *
 * The brief asks for seven things per featured destination. The rule that keeps
 * them honest is that each is derived from a measurement the ranking already
 * made, and a missing measurement produces the words rather than a plausible
 * filler — which is the one failure mode a results screen invites.
 */
describe('a featured recommendation states what was measured, and nothing else', () => {
  it('names the trip concept, the budget and the travel burden', () => {
    const value = shortlist(['strong_match', 'possible'], [91, 60]);
    value.picks[0] = { ...value.picks[0]!, suggestedNights: 9, suggestedBases: 2 };
    const markup = render(value);
    expect(markup).toContain('two bases, the trip split between them');
    expect(markup).toContain('Budget');
    expect(markup).toContain('Getting there');
  });

  it('never turns a distance into a price', () => {
    const markup = render(shortlist(['strong_match', 'possible'], [91, 60]));
    expect(markup).not.toMatch(/\$\d|airfare|flight from \$/i);
  });

  it('offers the three actions the brief names', () => {
    const markup = render(shortlist(['strong_match', 'possible'], [91, 60]));
    expect(markup).toContain('Plan this');
    expect(markup).toContain('Why this?');
    expect(markup).toContain('Compare');
  });

  it('never offers a comparison of a destination with itself', () => {
    /*
     * The screen's own default selection is the first featured card, and pressing
     * Compare on it produced `compareDestinations(x, x)` — every dimension tied,
     * reported in a full sentence as though two destinations had been weighed.
     * The rendered comparison section names the *other* side, so a comparison
     * whose two sides are one destination cannot be rendered at all.
     */
    const markup = render(shortlist(['strong_match', 'worth_a_look', 'possible'], [95, 90, 85]));
    expect(markup).toContain('Why Place 1 over…');
    expect(markup).not.toContain('these two came out the same');
  });

  it('frames a picture on every featured card', () => {
    /*
     * A frame is not an argument, but it is an invariant: `DestinationImage`
     * exists so a destination with no licensed photograph still gets a designed
     * graphic rather than an empty box. Four featured cards, plus the hero on
     * the evidence panel below them.
     */
    const markup = render(shortlist(['strong_match', 'worth_a_look', 'possible', 'possible'], [95, 90, 85, 80]));
    /* Four: three best and one wildcard. There is no second hero — the evidence lives on the card it belongs to. */
    expect([...markup.matchAll(/<figure /g)]).toHaveLength(4);
  });
});

describe('the shortlist keeps its caveats behind one disclosure', () => {
  /**
   * A caveat true of every pick is not a fact about the recommendation.
   *
   * The panel listed every dimension its destination was missing, which on the
   * live index is six identical lines directly under the argument for it — the
   * "wall of what the product could not do" the same reviewer flagged on the
   * board. What stays is only the difference between this one and the rest.
   */
  it('does not repeat a list-wide unknown inside the recommendation', () => {
    const markup = render(shortlist(['strong_match', 'possible'], [91, 60]));
    // Climate is unknown for both picks, so it is stated once, in the disclosure.
    expect(markup).toContain('What we checked, one thing at a time');
    expect(markup).not.toContain('What we could not see about this one');
    // Two: the flat dimension and the one nobody could measure — both list-scope.
    expect(markup).toContain('2 things we could not check');
    expect(markup).toContain('Weather at that time of year — There are no climate records');
  });

  it('still names an unknown that is peculiar to the one on screen', () => {
    const value = shortlist(['strong_match', 'possible'], [91, 60]);
    // The second pick could be measured on climate; the first could not. That
    // difference is a fact about the first destination and belongs on its panel.
    value.picks[1] = {
      ...value.picks[1]!,
      factors: value.picks[1]!.factors.map((factor) =>
        factor.id === 'climateFit'
          ? { ...factor, measure: { kind: 'measured', value: 0.8, basis: '2005–2024 records' } }
          : factor,
      ),
    };
    expect(render(value)).toContain('What we could not see about this one');
  });

  it('collapses the blind spots into a counted summary rather than an open list', () => {
    const markup = render(
      shortlist(['strong_match', 'possible'], [91, 60], {
        blindSpots: ['Flights — no fare data.', 'Visas — not sourced.'],
      }),
    );
    /*
     * Four, not two: the two blind spots plus the two facts about the ranking
     * itself — a dimension that came back identical for every pick, and one
     * nobody could measure. They belong in the same place because they are the
     * same kind of thing to a reader, which is the point of counting them
     * together in the summary line.
     */
    expect(markup).toContain('4 things we could not check');
    expect(markup).not.toContain('What this ranking cannot see');
    // Still reachable, which is the half that makes collapsing it legitimate.
    expect(markup).toContain('Flights — no fare data.');
    expect(markup).toContain('Visas — not sourced.');
  });
});

describe('the shortlist explains itself in a traveller’s language', () => {
  it('does not describe its own scoring model to the reader', () => {
    const markup = render(shortlist(['strong_match', 'possible', 'possible']));
    for (const compilerWord of ['unmeasured', 'dimension', 'not measured', 'weights differ']) {
      expect(markup.toLowerCase(), `§26: "${compilerWord}" is not traveller language`).not.toContain(
        compilerWord,
      );
    }
    // And still says the two things that matter: it is rough, and incomplete.
    expect(markup).toContain('not a score out of ten');
    expect(markup).toContain('we could not check');
  });

  it('describes the wait as what it actually does', () => {
    const markup = render(null);
    // "Ranking the world against your trip" promised a global search that is
    // not what runs, on the only screen between the answers and the results.
    expect(markup).not.toContain('Ranking the world');
    expect(markup).toContain('Putting a shortlist together');
    expect(markup).toMatch(/A few seconds\./);
  });
});
