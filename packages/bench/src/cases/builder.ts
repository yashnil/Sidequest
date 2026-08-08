import type { z } from 'zod';
import {
  BENCHMARK_REQUEST_VERSION,
  INTERESTS,
  benchmarkTripRequestSchema,
  type interestLevelSchema,
  type BenchmarkInterest,
  type BenchmarkTripRequest,
} from '../schemas/request';

/**
 * HOW A CASE IS DECLARED.
 *
 * Two jobs, and both are about making the case files readable enough that a
 * human can see what a traveller actually asked for.
 *
 * The first is `interestLevels`. Zod treats a record keyed by an enum as
 * exhaustive, so a request must state a level for all twenty-eight interests or
 * it does not parse at all. Written out longhand every time, the interesting
 * three lines of a case would be buried under twenty-five saying "not really".
 * So the helper fills the floor and each case overrides only what the traveller
 * cared about — which is also honest, because `low` is exactly the level whose
 * meaning is "only if it is right there".
 *
 * The second is `defineCase`, which parses. A case that does not satisfy the
 * request schema's refinements throws at import rather than at the first test
 * that touches it, so a broken fixture cannot sit unnoticed behind a filtered
 * test run.
 */

export type BenchmarkInterestLevel = z.infer<typeof interestLevelSchema>;

/**
 * Every interest at `low`, with the traveller's real answers laid over the top.
 *
 * `low` rather than `avoid` because the two are not interchangeable: `avoid` is
 * a statement, and a case library that silently told every traveller to avoid
 * twenty-five things would be scoring both systems against a person nobody
 * invented.
 */
export function interestLevels(
  stated: Partial<Record<BenchmarkInterest, BenchmarkInterestLevel>>,
): Record<BenchmarkInterest, BenchmarkInterestLevel> {
  const levels = {} as Record<BenchmarkInterest, BenchmarkInterestLevel>;
  for (const interest of INTERESTS) levels[interest] = stated[interest] ?? 'low';
  return levels;
}

export const CASE_KINDS = ['city', 'country', 'road_trip', 'outdoor', 'island', 'park'] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const CASE_DATA_STRENGTHS = ['strong', 'weak'] as const;
export type CaseDataStrength = (typeof CASE_DATA_STRENGTHS)[number];

export const CASE_LENGTHS = ['short', 'medium', 'long'] as const;
export type CaseLength = (typeof CASE_LENGTHS)[number];

/**
 * The dashboard breakdown axes.
 *
 * Deliberately four coarse facts rather than a free-form tag list. A results
 * view that can slice by them can answer "does one system only win on cities?",
 * which is the question a single aggregate number hides — and a closed set is
 * what stops the slices multiplying until every case is its own category and no
 * comparison has more than one sample in it.
 */
export interface BenchmarkCaseTraits {
  kind: CaseKind;
  /** Whether the traveller expects to get around by public transport. */
  transit: boolean;
  /** How much open data the destination plausibly has. Sets expectations, not rules. */
  dataStrength: CaseDataStrength;
  length: CaseLength;
}

export interface BenchmarkCase {
  /** Stable for the life of the library. Sessions are stored against it. */
  caseId: string;
  /** One line, for a human reading a results table. */
  title: string;
  traits: BenchmarkCaseTraits;
  request: BenchmarkTripRequest;
}

/** Everything about a request except the two fields the library itself owns. */
export type CaseRequestSpec = Omit<
  z.input<typeof benchmarkTripRequestSchema>,
  'schemaVersion' | 'requestId'
>;

export function defineCase(input: {
  caseId: string;
  title: string;
  traits: BenchmarkCaseTraits;
  request: CaseRequestSpec;
}): BenchmarkCase {
  return {
    caseId: input.caseId,
    title: input.title,
    traits: input.traits,
    request: benchmarkTripRequestSchema.parse({
      ...input.request,
      schemaVersion: BENCHMARK_REQUEST_VERSION,
      // Derived from the case id rather than declared, so two cases can never
      // share a request identity — which would make two sessions collide on the
      // single-flight key and silently reuse one run's plans for the other.
      requestId: `req-${input.caseId}`,
    }),
  };
}

/**
 * The length band a night count falls in.
 *
 * Exported so the trait a case declares and the dates it carries can be checked
 * against each other rather than trusted to stay in step by hand.
 */
export function lengthForNights(nights: number): CaseLength {
  if (nights <= 3) return 'short';
  if (nights <= 7) return 'medium';
  return 'long';
}
