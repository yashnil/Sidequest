/**
 * WHAT ONE COMPILATION IS ALLOWED TO SPEND.
 *
 * "Turkey" and "Convict Lake" arrive through the same text box. Without a
 * ceiling the first one fans out one search per category per subregion, asks for
 * an N×N matrix over four hundred candidates, and bills for all of it before
 * anybody sees a screen.
 *
 * So every counter that can grow with the size of a destination has a limit, and
 * running out is a **normal outcome** rather than an error: the compiler stops,
 * marks the region partial, and says exactly which stage it stopped in. The
 * alternative — carrying on and quietly returning less — is the one that reads
 * as completeness.
 */

export interface CompilerBudget {
  /** Geographic interpretations to keep from a resolver. */
  maxGeographicCandidates: number;
  maxSubregions: number;
  maxBases: number;
  /** Discovered before any enrichment. Cheap calls, wide net. */
  maxCoarseCandidates: number;
  /** Survive dedup and shortlisting, and get researched. Expensive. */
  maxShortlistedCandidates: number;
  /** Places whose official constraints are researched deeply. */
  maxResearchSubjects: number;
  /** Pages the retrieval layer may fetch across the whole compilation. */
  maxPagesFetched: number;
  /** Pages any single candidate may consume. Stops one subject eating the lot. */
  maxPagesPerSubject: number;
  /** Bytes the retrieval layer may read in total, after decompression. */
  maxRetrievalBytes: number;
  /**
   * Billable web searches. The most expensive counter here at $10/1000, and the
   * one a broad destination would otherwise multiply by the candidate count.
   */
  maxSourceSearches: number;
  /** Model calls spent turning pages into claims. */
  maxExtractionCalls: number;
  /** Wall clock for the whole research funnel, separate from the compilation. */
  maxEnrichmentMs: number;
  /** Calls to a research model. */
  maxModelCalls: number;
  /** Matrix cells. The single largest cost driver, and it grows as N². */
  maxRouteElements: number;
  maxFoodVenues: number;
  maxWeatherLocations: number;
  /** Wall clock. A compilation that has run this long stops wherever it is. */
  maxDurationMs: number;
}

/**
 * Development defaults, chosen so a broad country is expensive rather than
 * unbounded.
 *
 * `maxRouteElements` is the one worth reading twice. It used to be 900 — a 30×30
 * flat matrix — and under the flat all-pairs design roughly seventy per cent of
 * those pairs were cells no consumer could read: a stop in one region against a
 * stop four hours away never shares a day with it.
 *
 * Routing is hierarchical now, so every pair inside this budget is one the board
 * or the planner will actually read, and the same number buys about three times
 * as much usable coverage. It is raised to match the routing layer's own
 * ceiling rather than left at a figure sized for waste: a live country-scale
 * build hit the old value and came back with twelve stops per region where the
 * local matrices had room for twenty-four.
 */
export const DEFAULT_COMPILER_BUDGET: CompilerBudget = {
  maxGeographicCandidates: 5,
  maxSubregions: 7,
  maxBases: 4,
  maxCoarseCandidates: 100,
  maxShortlistedCandidates: 36,
  maxResearchSubjects: 24,
  maxPagesFetched: 40,
  maxPagesPerSubject: 2,
  maxRetrievalBytes: 24_000_000,
  maxSourceSearches: 12,
  maxExtractionCalls: 6,
  maxEnrichmentMs: 120_000,
  maxModelCalls: 20,
  maxRouteElements: 3_600,
  maxFoodVenues: 18,
  maxWeatherLocations: 8,
  maxDurationMs: 180_000,
};

export type BudgetCounter = keyof CompilerBudget;

/**
 * The ledger. Reserve before spending, record after, and never throw for a
 * budget reason — exhaustion is an answer.
 */
export class BudgetLedger {
  readonly limits: CompilerBudget;
  private readonly consumed = new Map<BudgetCounter, number>();
  private readonly exhaustedCounters = new Set<BudgetCounter>();
  private readonly startedAtMs: number;

  constructor(limits: CompilerBudget, startedAtMs: number) {
    this.limits = limits;
    this.startedAtMs = startedAtMs;
  }

  spent(counter: BudgetCounter): number {
    return this.consumed.get(counter) ?? 0;
  }

  remaining(counter: BudgetCounter): number {
    return Math.max(0, this.limits[counter] - this.spent(counter));
  }

  /**
   * How many of `wanted` may be taken. Records the take, and marks the counter
   * exhausted when it hits the ceiling so the coverage report can name it.
   */
  take(counter: BudgetCounter, wanted: number): number {
    const allowed = Math.min(Math.max(0, wanted), this.remaining(counter));
    this.consumed.set(counter, this.spent(counter) + allowed);
    if (this.remaining(counter) === 0) this.exhaustedCounters.add(counter);
    return allowed;
  }

  /** Record spend that has already happened, e.g. calls a provider reported. */
  record(counter: BudgetCounter, amount: number): void {
    this.consumed.set(counter, this.spent(counter) + Math.max(0, amount));
    if (this.remaining(counter) === 0) this.exhaustedCounters.add(counter);
  }

  outOfTime(nowMs: number): boolean {
    return nowMs - this.startedAtMs > this.limits.maxDurationMs;
  }

  exhausted(): BudgetCounter[] {
    return [...this.exhaustedCounters].sort();
  }

  /** The shape `CompilationDiagnostics.budget` wants. */
  snapshot(): {
    consumed: Record<string, number>;
    limits: Record<string, number>;
    exhausted: string[];
  } {
    const consumed: Record<string, number> = {};
    for (const [counter, value] of this.consumed) consumed[counter] = value;
    const limits: Record<string, number> = {};
    for (const [counter, value] of Object.entries(this.limits)) limits[counter] = value;
    return { consumed, limits, exhausted: this.exhausted() };
  }
}

/**
 * A budget scaled to what is actually being compiled.
 *
 * A four-day trip to one town does not need a hundred candidates, and spending
 * for them is waste rather than thoroughness. Breadth raises the ceilings
 * because a country genuinely needs a wider first sweep to find anything at all.
 */
export function budgetFor(input: {
  nights: number;
  breadthRank: number;
  base?: Partial<CompilerBudget>;
}): CompilerBudget {
  const dayScale = Math.min(2, Math.max(0.5, input.nights / 5));
  const breadthScale = 1 + Math.min(4, Math.max(0, input.breadthRank)) * 0.25;
  const scale = (value: number): number => Math.max(1, Math.round(value * dayScale * breadthScale));

  return {
    ...DEFAULT_COMPILER_BUDGET,
    maxCoarseCandidates: scale(DEFAULT_COMPILER_BUDGET.maxCoarseCandidates),
    maxShortlistedCandidates: scale(DEFAULT_COMPILER_BUDGET.maxShortlistedCandidates),
    maxResearchSubjects: scale(DEFAULT_COMPILER_BUDGET.maxResearchSubjects),
    maxFoodVenues: scale(DEFAULT_COMPILER_BUDGET.maxFoodVenues),
    /**
     * Searches scale with the trip, and are capped hard well below the candidate
     * count.
     *
     * A ten-night country trip gets more looking than a weekend in one town, and
     * neither gets one search per candidate — that pattern is what turns a
     * broad destination into a bill. Structured sources close most of the gap
     * for free; search is for the subjects they missed.
     */
    maxSourceSearches: Math.min(30, scale(DEFAULT_COMPILER_BUDGET.maxSourceSearches)),
    maxPagesFetched: Math.min(90, scale(DEFAULT_COMPILER_BUDGET.maxPagesFetched)),
    maxExtractionCalls: Math.min(14, scale(DEFAULT_COMPILER_BUDGET.maxExtractionCalls)),
    // Route elements grow as the square of the shortlist, so they are scaled
    // against the shortlist rather than linearly against the trip length.
    /*
     * Scaled by trip length like everything else, but floored high enough that a
     * multi-region trip still gets a usable local matrix per region. The square
     * of the shortlist was the flat design's arithmetic; hierarchical routing
     * needs *per-cluster* room, which is what the floor represents.
     */
    maxRouteElements: Math.min(
      4_800,
      Math.max(900, Math.round(scale(DEFAULT_COMPILER_BUDGET.maxRouteElements))),
    ),
    ...input.base,
  };
}
