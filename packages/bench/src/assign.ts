import type { Entropy } from './entropy';
import {
  type BlindAssignment,
  BENCHMARK_SESSION_VERSION,
  blindAssignmentSchema,
} from './schemas/session';

/**
 * The two draws, made once.
 *
 * Separate calls to `entropy.next()` rather than one draw used twice, because
 * two bits taken from one number are correlated by construction and the whole
 * reason for two draws is that they must not be.
 */
export function drawAssignment(input: {
  entropy: Entropy;
  now: Date;
  source: 'system' | 'seeded';
  seed?: string;
}): BlindAssignment {
  const drawLabel = input.entropy.next();
  const drawOrder = input.entropy.next();

  const sidequestIsA = drawLabel < 0.5;
  const assignment = {
    schemaVersion: BENCHMARK_SESSION_VERSION,
    labelASystem: sidequestIsA ? ('sidequest' as const) : ('baseline' as const),
    labelBSystem: sidequestIsA ? ('baseline' as const) : ('sidequest' as const),
    firstLabel: drawOrder < 0.5 ? ('A' as const) : ('B' as const),
    source: input.source,
    seed: input.seed ?? null,
    drawLabel,
    drawOrder,
    assignedAt: input.now.toISOString(),
  };

  // Parsed rather than cast: the refinements — different systems on the two
  // labels, seed present exactly when seeded — are the invariants a tampered or
  // hand-edited row would break, and this is the one place they can be checked
  // before the row exists.
  return blindAssignmentSchema.parse(assignment);
}

/**
 * Recompute the mapping from the stored raw draw and compare.
 *
 * A tamper check rather than a correctness check: the assignment is written
 * once and read many times, and a row whose `labelASystem` no longer agrees with
 * the coin that produced it has been edited by something other than this
 * function.
 */
export function assignmentIsConsistent(assignment: BlindAssignment): boolean {
  const sidequestShouldBeA = assignment.drawLabel < 0.5;
  const expectedA = sidequestShouldBeA ? 'sidequest' : 'baseline';
  const expectedFirst = assignment.drawOrder < 0.5 ? 'A' : 'B';
  return assignment.labelASystem === expectedA && assignment.firstLabel === expectedFirst;
}
