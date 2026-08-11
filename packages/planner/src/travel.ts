/**
 * WHICH WAY THE TRAVELLER ACTUALLY GETS FROM ONE POINT TO THE NEXT — RE-EXPORTED.
 *
 * The rules themselves moved to `@sidequest/core` (`src/travel/reach.ts`) in
 * Phase 15D, and the reason is the whole point of that pass: the Discovery Board
 * was making its own transport decisions off a scalar named `driveMinutes`,
 * arriving at "too far" for a place the planner would have reached by metro.
 * Two modules answering one question two ways is the defect, and a second
 * implementation in `packages/core` would have been the same defect with a
 * different address — so there is exactly one, and it lives in the package both
 * the board and the planner already depend on.
 *
 * This file stays as a re-export rather than being deleted so that every
 * planner-internal import (`./travel`) is unchanged, which keeps the move a move
 * and not a rewrite. Nothing here may add behaviour: a rule written on this side
 * would be invisible to the board and would recreate the divergence.
 */
export {
  countsTowardRoadDistance,
  dailyCapFor,
  detourToleranceMinutesFor,
  permittedModesFor,
  reachFromBase,
  resolveCandidateReach,
  resolveLeg,
  transitModeOf,
  travelBucketFor,
  travelKnowledgeFor,
  type BaseReach,
  type LegProvenance,
  type LegRule,
  type ReachFromBase,
  type ReachStatus,
  type ResolvedLeg,
  type TravelBucket,
  type TravelKnowledge,
  type TravelOption,
  type UnresolvedLeg,
} from '@sidequest/core';
