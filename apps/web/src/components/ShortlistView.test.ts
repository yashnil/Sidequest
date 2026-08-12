import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  DESTINATION_RANKER_VERSION,
  DESTINATION_SHORTLIST_VERSION,
  RANK_DIMENSION_LABELS,
  RANK_WEIGHTS,
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

function render(value: DestinationShortlist | null): string {
  return renderToStaticMarkup(
    createElement(ShortlistView, {
      sessionId: 'session-1',
      shortlist: value,
      answersSummary: 'Two weeks in September',
    }),
  );
}

/** The ordinal is the only bare integer in a card's title row. */
function ordinals(markup: string): string[] {
  return [...markup.matchAll(/<span aria-hidden="true" class="text-xs text-ink-faint">(\d+)<\/span>/g)].map(
    (match) => match[1]!,
  );
}

describe('the shortlist does not number an order it cannot defend', () => {
  it('drops the ordinals when every pick scored the same', () => {
    const markup = render(shortlist(['thin_evidence', 'thin_evidence', 'thin_evidence']));
    expect(ordinals(markup)).toEqual([]);
    // The cards are still there — this is about the rank, not the list.
    expect(markup).toContain('Place 1');
    expect(markup).toContain('Place 3');
  });

  it('keeps them when every pick actually outscored the next', () => {
    const markup = render(shortlist(['strong_match', 'worth_a_look', 'thin_evidence'], [91, 84, 77]));
    expect(ordinals(markup)).toEqual(['1', '2', '3']);
  });

  /**
   * THE SHAPE THE BAND TEST LET THROUGH.
   *
   * Measured over the live index, a fully answered composer scores its eight
   * picks 91, 87, 87, 87, 87, 87, 87, 87 — every one of them `worth_a_look`, so
   * the old `every pick is thin_evidence` test called this a ranking and numbered
   * the seven-way tie 2 to 8. An ordinal is a claim about this row against the
   * next one; one tie anywhere and there is no such claim to make.
   */
  it('drops them when a leader is followed by a block of equals', () => {
    const markup = render(
      shortlist(['worth_a_look', 'worth_a_look', 'worth_a_look'], [91, 87, 87]),
    );
    expect(ordinals(markup)).toEqual([]);
    expect(markup).toContain('so they are in no particular order');
    /*
     * And the leader keeps its claim. 91 against two at 87 is the live shape of
     * a fully answered composer: the list below the first row is not ranked, so
     * the numbers go — but the first row did outscore the rest, so withholding
     * "why this one" from it would be as inaccurate as numbering the tie was.
     */
    expect(markup).toContain('Why this one');
  });

  /**
   * And the panel beside the list may only claim a choice was made when one was.
   */
  it('does not say "why this one" about a pick that outscored nobody', () => {
    expect(render(shortlist(['thin_evidence', 'thin_evidence']))).not.toContain('Why this one');
    expect(render(shortlist(['strong_match', 'possible'], [91, 60]))).toContain('Why this one');
  });
});

/**
 * A NO-CONFIDENCE RESULT IS STILL A SCREEN SOMEBODY HAS TO USE.
 *
 * The reviewer's release blocker, as markup: eight equal cards in a column under
 * a headline admitting we could not tell them apart. Not-numbering them was
 * necessary and nowhere near sufficient — the layout still allocated a ranked
 * list to a thing that is not ranked, and the traveller's whole screen was our
 * uncertainty. What replaces it is one recommendation with its picture and its
 * argument, the rest as a short secondary list, and the caveats behind one
 * disclosure.
 */
describe('a shortlist that cannot rank leads with one recommendation', () => {
  /**
   * WHAT ACTUALLY SEPARATES THE TWO LAYOUTS: ARGUMENTS, NOT PICTURES.
   *
   * This counted image frames by their exact class and asserted zero of them in
   * the tie layout, under the words "one picture and one argument, not eight".
   * Half of that was right and the half about pictures was a licence defect
   * waiting to happen — and then happened. The secondary list was the only
   * card-shaped surface on the screen, so a shortlist whose hero had no
   * strongly-matched photograph rendered *no photograph at all*, with six
   * licensed and credited files sitting in `destination_images` for the
   * destinations on it. `imagery.spec.ts` caught it as an unreachable
   * attribution, which is the correct alarm for it.
   *
   * So the rule the layout has to hold is the one about arguments: **one panel
   * makes a case, and the rest are options.** Every card frames something,
   * because that is the invariant `DestinationImage` exists to keep, and a
   * frame is not an argument.
   */
  function argued(markup: string): number {
    return [...markup.matchAll(/aria-labelledby="shortlist-detail-heading"/g)].length;
  }

  /** Every image frame on the page: one hero, and one per card. */
  function frames(markup: string): number {
    return [...markup.matchAll(/<figure /g)].length;
  }

  it('shows one argued recommendation instead of a column of equal cards', () => {
    const tied = shortlist(Array<RankBand>(8).fill('worth_a_look'), Array(8).fill(95));
    const markup = render(tied);

    // One argument, not eight — and eight pictures, because a picture is the
    // comparison a traveller can make between places nothing else separates.
    expect(argued(markup), 'eight equal argued cards is the pattern this replaces').toBe(1);
    expect(frames(markup), 'every card frames something').toBe(9);
    expect(markup).toContain('Somewhere to start');
    expect(markup).toContain('The other 7, and how they compare');
    // Every option is still reachable — this demotes them, it does not hide them.
    expect(markup).toContain('Place 8');
  });

  it('keeps the comparison layout when the ranking actually separates', () => {
    const markup = render(
      shortlist(['strong_match', 'worth_a_look', 'possible'], [91, 84, 77]),
    );
    expect(frames(markup), 'a real ranking is a comparison and keeps its cards').toBe(4);
    expect(argued(markup)).toBe(1);
    expect(markup).not.toContain('The other 2, and how they compare');
  });

  /**
   * THE THREE THINGS THAT MUST NAME THE SAME DESTINATION.
   *
   * When nothing outscores anything the lead is the best-evidenced pick, which
   * is not necessarily `picks[0]`. The panel, the first row of the list and the
   * "Plan …" button all have to follow it — a version where they did not is one
   * that plans a trip to somewhere the page never recommended.
   */
  it('promotes the best-evidenced pick to the panel, the first row and the button', () => {
    const markup = render(
      shortlist(
        ['worth_a_look', 'worth_a_look', 'worth_a_look'],
        [95, 95, 95],
        { coverages: [0.4, 0.85, 0.4] },
      ),
    );
    expect(markup).toContain('Where we would start');
    expect(markup).toContain('>Plan Place 2<');
    const firstRow = markup.indexOf('Place 2, Somewhere', markup.indexOf('Suggested destinations'));
    const secondRow = markup.indexOf('Place 1, Somewhere', markup.indexOf('Suggested destinations'));
    expect(firstRow).toBeGreaterThan(-1);
    expect(firstRow, 'the destination we argue for is the first one offered').toBeLessThan(secondRow);
  });

  it('says outright when nothing chose the one it put first', () => {
    const markup = render(
      shortlist(['thin_evidence', 'thin_evidence'], [100, 100], { coverages: [0.24, 0.24] }),
    );
    expect(markup).toContain('not because it won');
    expect(markup).not.toContain('Where we would start');
  });
});

/**
 * §26: one statement per unknown, at the highest scope that is true, and not in
 * front of the answer. Four separate confessions used to sit under the results.
 */
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
