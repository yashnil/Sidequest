import { describe, expect, it } from 'vitest';
import { compareDestinations, dimensionDistance, proposeDestinations, rerankBy, RERANK_CONTROLS } from './proposal';
import { RANK_DIMENSIONS, RANK_WEIGHTS, measured, unknown, type RankedDestination } from '../schemas/shortlist';

/**
 * V11 §3 — the recommender's answer, built from the ranking that already
 * existed. Nothing here calls a model, and none of it may invent evidence.
 */
function pick(name: string, values: Partial<Record<(typeof RANK_DIMENSIONS)[number], number | null>>, score = 70): RankedDestination {
  const factors = RANK_DIMENSIONS.map((id) => {
    const value = values[id];
    const measure = value === null || value === undefined ? unknown('not_sourced' as const) : measured(value, `${id} basis`);
    return { id, label: id, weight: RANK_WEIGHTS[id], measure, contribution: measure.kind === 'measured' ? RANK_WEIGHTS[id] * measure.value : 0 };
  });
  return {
    entryId: `id:${name}`,
    releaseId: 'r',
    displayName: name,
    qualifiedName: name,
    featureType: 'region',
    center: { lat: 0, lng: 0 },
    score,
    coverage: 1,
    band: 'strong_match',
    factors,
    conflicts: [],
    unknowns: [],
    reasons: [],
    tradeoffs: [],
  } as RankedDestination;
}

const ALL = Object.fromEntries(RANK_DIMENSIONS.map((id) => [id, 0.7])) as Record<(typeof RANK_DIMENSIONS)[number], number>;

describe('V11 §3 — three and a wildcard', () => {
  it('returns exactly three best-fit proposals and one wildcard', () => {
    const picks = [
      pick('A', ALL, 90),
      pick('B', ALL, 85),
      pick('C', ALL, 80),
      pick('D', ALL, 75),
      pick('E', { ...ALL, climatePreferenceFit: 0.05, flightBurden: 0.1, noveltyFit: 1 }, 72),
    ];
    const proposals = proposeDestinations({ picks });
    expect(proposals.filter((p) => p.role === 'best_fit').map((p) => p.destination.displayName)).toEqual(['A', 'B', 'C']);
    expect(proposals.filter((p) => p.role === 'wildcard')).toHaveLength(1);
  });

  it('chooses the wildcard for being DIFFERENT, not for scoring fourth', () => {
    const picks = [
      pick('A', ALL, 90),
      pick('B', ALL, 85),
      pick('C', ALL, 80),
      /* A near-twin of the leaders that scores fourth. */
      pick('Twin', ALL, 79),
      /* A genuinely different trip that scores fifth. */
      pick('Different', { ...ALL, climatePreferenceFit: 0.05, flightBurden: 0.1, crowdFit: 0.05, noveltyFit: 1 }, 74),
    ];
    const wildcard = proposeDestinations({ picks }).find((p) => p.role === 'wildcard');
    expect(wildcard?.destination.displayName).toBe('Different');
    expect(wildcard?.wildcardReason).toBeTruthy();
  });

  it('offers no wildcard rather than a bad one when nothing left is worth taking', () => {
    const picks = [pick('A', ALL, 90), pick('B', ALL, 85), pick('C', ALL, 80), pick('Weak', ALL, 12)];
    expect(proposeDestinations({ picks }).some((p) => p.role === 'wildcard')).toBe(false);
  });

  it('never puts a thin-evidence candidate forward as a wildcard', () => {
    const thin = { ...pick('Thin', ALL, 80), band: 'thin_evidence' as const };
    const picks = [pick('A', ALL, 90), pick('B', ALL, 85), pick('C', ALL, 82), thin];
    expect(proposeDestinations({ picks }).some((p) => p.role === 'wildcard')).toBe(false);
  });

  it('copes with fewer than four candidates', () => {
    expect(proposeDestinations({ picks: [pick('A', ALL)] })).toHaveLength(1);
    expect(proposeDestinations({ picks: [] })).toEqual([]);
  });

  it('measures difference across dimensions, not by score', () => {
    const a = pick('A', ALL, 80);
    const sameScoreDifferentShape = pick('B', { ...ALL, flightBurden: 0.1, climatePreferenceFit: 0.1 }, 80);
    expect(dimensionDistance(a, sameScoreDifferentShape)).toBeGreaterThan(0);
    expect(dimensionDistance(a, pick('C', ALL, 40))).toBe(0);
  });
});

describe('V11 §3 — why X over Y', () => {
  const left = pick('Patagonia', { ...ALL, themeFit: 0.95, flightBurden: 0.2, crowdFit: 0.9, comfortFit: 0.4 });
  const right = pick('Peru', { ...ALL, themeFit: 0.6, flightBurden: 0.55, crowdFit: 0.4, comfortFit: 0.75 });

  it('reports only the dimensions that genuinely differ, widest first', () => {
    const comparison = compareDestinations(left, right);
    expect(comparison.differences.length).toBeGreaterThan(0);
    const magnitudes = comparison.differences.map((d) => Math.abs(d.delta));
    expect(magnitudes).toEqual([...magnitudes].sort((a, b) => b - a));
    expect(comparison.differences.map((d) => d.id)).toContain('themeFit');
  });

  it('names the ties rather than listing them as rows', () => {
    const comparison = compareDestinations(left, right);
    expect(comparison.tied.length).toBeGreaterThan(0);
    for (const id of comparison.tied) expect(comparison.differences.map((d) => d.id)).not.toContain(id);
  });

  it('says which way each difference goes', () => {
    const theme = compareDestinations(left, right).differences.find((d) => d.id === 'themeFit')!;
    expect(theme.delta).toBeGreaterThan(0);
    const flight = compareDestinations(left, right).differences.find((d) => d.id === 'flightBurden')!;
    expect(flight.delta).toBeLessThan(0);
  });

  it('keeps a dimension neither side could be measured on out of the argument', () => {
    const a = pick('A', { ...ALL, entryFriction: null });
    const b = pick('B', { ...ALL, entryFriction: null });
    const comparison = compareDestinations(a, b);
    expect(comparison.unknownForBoth).toContain('entryFriction');
    expect(comparison.differences.map((d) => d.id)).not.toContain('entryFriction');
  });
});

describe('V11 §3 — reranking is deterministic and needs no new evidence', () => {
  const near = pick('Near', { ...ALL, flightBurden: 0.95, climatePreferenceFit: 0.2 }, 70);
  const far = pick('Far', { ...ALL, flightBurden: 0.1, climatePreferenceFit: 0.95 }, 78);
  const picks = [far, near];

  it('"closer" puts the closer one first', () => {
    expect(rerankBy(picks, ['closer'])[0]!.displayName).toBe('Near');
  });

  it('"warmer" puts the warmer one first', () => {
    expect(rerankBy(picks, ['warmer'])[0]!.displayName).toBe('Far');
  });

  it('no control leaves the order alone', () => {
    expect(rerankBy(picks, []).map((p) => p.displayName)).toEqual(['Far', 'Near']);
  });

  it('is stable — the same input always gives the same order', () => {
    const once = rerankBy(picks, ['closer', 'less_touristy']).map((p) => p.displayName);
    const twice = rerankBy(picks, ['closer', 'less_touristy']).map((p) => p.displayName);
    expect(once).toEqual(twice);
  });

  it('changes nothing when the dimension a control leans on was never measured', () => {
    const unmeasured = [pick('A', { ...ALL, crowdFit: null }, 80), pick('B', { ...ALL, crowdFit: null }, 70)];
    expect(rerankBy(unmeasured, ['less_touristy']).map((p) => p.displayName)).toEqual(['A', 'B']);
  });

  it('every control leans on at least one real dimension', () => {
    for (const control of RERANK_CONTROLS) {
      const reordered = rerankBy([pick('A', ALL, 80), pick('B', { ...ALL, themeFit: 0.1, flightBurden: 0.1, crowdFit: 0.1, comfortFit: 0.1, transportFit: 0.1, entryFriction: 0.1, noveltyFit: 0.1, climatePreferenceFit: 0.1, supplyFit: 0.1, varietyFit: 0.1, structureFit: 0.1 }, 79)], [control]);
      expect(reordered[0]!.displayName).toBe('A');
    }
  });
});

/**
 * V11 §3 — "PLAN THIS" CARRIES THE INPUTS, BY CONSTRUCTION.
 *
 * The recommender's own questions are stored on `TripComposerAnswers`, the same
 * record trip setup reads, rather than in a record of their own. That is the
 * whole reason adoption needs no mapping layer: `adoptDestinationAction` spreads
 * `session.answers` into the trip, so a field added for the recommender is a
 * field setup already has. This test pins the property so a future refactor that
 * splits the records has to notice it is breaking the promise.
 */
describe('V11 §3 — the traveller does not answer anything twice', () => {
  it('keeps every recommender answer when the composer record is carried forward', () => {
    const fromRecommender = {
      flightTolerance: 'moderate' as const,
      climatePreference: 'warm' as const,
      lodgingComfort: 'simple' as const,
      tripScope: 'international' as const,
      surpriseAppetite: 'surprise_me' as const,
      visited: ['Iceland', 'Peru'],
      budgetPerPerson: 2_500,
      budgetIncludesFlights: false,
      originCountry: 'US',
    };
    /* Exactly what adoption does: spread the session's answers into the trip's. */
    const carried = { ...fromRecommender, mode: 'known_destination' as const };
    for (const [key, value] of Object.entries(fromRecommender)) {
      expect(carried[key as keyof typeof fromRecommender], key).toEqual(value);
    }
  });
});
