import { describe, expect, it } from 'vitest';
import { CLARIFICATION_SET_VERSION, type ClarificationSet } from '@sidequest/core';
import { BudgetLedger, DEFAULT_COMPILER_BUDGET } from './budget';
import { compileRegion } from './compile';
import { deriveScope } from './scope';
import { SYNTHETIC_WORLDS, fakeProviders, syntheticCandidate } from './testing/fakes';

/**
 * THE OVERALL TIME CEILING, OBEYED RATHER THAN PRINTED.
 *
 * `maxDurationMs` shipped for months as a number with no reader:
 * `BudgetLedger.outOfTime` had zero call sites anywhere in the tree, the
 * operational ledger printed the ceiling on every job, and observed live builds
 * ran two and three times past it. Nothing in the product stopped a long build
 * — a person noticing did.
 *
 * The contract asserted here is deliberately *not* "the build aborts". This
 * pipeline's stated property is that running out is normal: the purchased
 * counters go to zero at the next stage boundary, the enrichment stages degrade
 * to what they degrade to when nobody publishes anything, and the region comes
 * back `partial` naming `maxDurationMs`. A traveller gets the trip that was
 * built by the deadline instead of a failure, and the artifact says why.
 */

const CLARIFICATIONS: ClarificationSet = {
  schemaVersion: CLARIFICATION_SET_VERSION,
  questions: [],
  answers: [],
};

describe('the ledger’s time ceiling', () => {
  it('zeroes what a long build would still have bought, and only that', () => {
    const ledger = new BudgetLedger(DEFAULT_COMPILER_BUDGET, Date.now() - 10 * 60_000);
    expect(ledger.remaining('maxModelCalls')).toBeGreaterThan(0);
    expect(ledger.enforceTimeCeiling(Date.now())).toBe(true);

    /* Everything that costs a provider call is spent. */
    for (const counter of [
      'maxResearchSubjects',
      'maxPagesFetched',
      'maxSourceSearches',
      'maxExtractionCalls',
      'maxRecoveryQueries',
      'maxModelCalls',
    ] as const) {
      expect(ledger.remaining(counter), counter).toBe(0);
    }

    /*
     * And the structural budgets are untouched: zeroing the route matrix would
     * turn a late build into an unplannable one, which is a worse answer.
     */
    expect(ledger.remaining('maxRouteElements')).toBe(DEFAULT_COMPILER_BUDGET.maxRouteElements);
    expect(ledger.remaining('maxWeatherLocations')).toBe(
      DEFAULT_COMPILER_BUDGET.maxWeatherLocations,
    );
    expect(ledger.remaining('maxBases')).toBe(DEFAULT_COMPILER_BUDGET.maxBases);
  });

  it('names itself in the coverage report, so a partial region can say why', () => {
    const ledger = new BudgetLedger(DEFAULT_COMPILER_BUDGET, Date.now() - 10 * 60_000);
    ledger.enforceTimeCeiling(Date.now());
    expect(ledger.exhausted()).toContain('maxDurationMs');
    /* The purchased counters are spent, not slandered as exhausted-by-demand. */
    expect(ledger.exhausted()).not.toContain('maxPagesFetched');
    expect(ledger.snapshot().consumed.maxModelCalls).toBe(DEFAULT_COMPILER_BUDGET.maxModelCalls);
  });

  it('fires once and stays fired', () => {
    const ledger = new BudgetLedger(DEFAULT_COMPILER_BUDGET, Date.now() - 10 * 60_000);
    expect(ledger.enforceTimeCeiling(Date.now())).toBe(true);
    expect(ledger.enforceTimeCeiling(Date.now())).toBe(false);
  });

  it('does nothing at all while the build is inside its ceiling', () => {
    const ledger = new BudgetLedger(DEFAULT_COMPILER_BUDGET, Date.now());
    expect(ledger.enforceTimeCeiling(Date.now())).toBe(false);
    expect(ledger.exhausted()).toEqual([]);
    expect(ledger.remaining('maxModelCalls')).toBe(DEFAULT_COMPILER_BUDGET.maxModelCalls);
  });
});

describe('a compilation past its ceiling', () => {
  const compile = async (maxDurationMs: number) => {
    const spec = SYNTHETIC_WORLDS.transit_city!;
    return compileRegion({
      compilationId: `deadline-${maxDurationMs}`,
      scope: deriveScope({
        candidate: syntheticCandidate(spec),
        clarifications: CLARIFICATIONS,
        nights: 3,
        revision: 1,
      }),
      dates: ['2027-05-18', '2027-05-19'],
      months: [5],
      providers: fakeProviders(spec),
      now: new Date('2027-05-01T09:00:00.000Z'),
      budget: { maxDurationMs },
    });
  };

  it('still produces a region, marked partial, rather than failing', async () => {
    /*
     * Zero means "the ceiling passed before the first stage boundary" — the
     * strongest form of the case, and the one that proves the enforcement is
     * not merely cosmetic.
     */
    const result = await compile(1);
    expect(result.ok, result.ok ? '' : `${result.code}: ${result.message}`).toBe(true);
    if (!result.ok) return;
    expect(result.partial).toBe(true);
    expect(result.operational.budget.exhausted).toContain('maxDurationMs');
  });

  it('leaves an ordinary build untouched', async () => {
    const result = await compile(10 * 60_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operational.budget.exhausted).not.toContain('maxDurationMs');
  });
});
