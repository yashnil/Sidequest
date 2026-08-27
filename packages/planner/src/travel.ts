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
  /**
   * The modelled walk, from the same source as everything else here.
   *
   * The planner grew this repair first and kept its own copy of both the pace
   * and the arithmetic after the rules moved. The two agreed numerically, which
   * is exactly the state that reads as safe and is one edit from a plan and a
   * board disagreeing about whether the same 1.2 km is walkable — the defect
   * this module's own docstring says it exists to end. So the derivation has one
   * address, and `modelled-walk.ts` calls it.
   *
   * The *cap* is deliberately not shared. Core's is `maxAccessWalkMinutes` —
   * the furthest the traveller said they would walk to reach a place, which is
   * the right ceiling for "can I get in at all". The planner's is their detour
   * tolerance, which is the right ceiling for a leg taken mid-day between two
   * stops they have already accepted. `modelled-walk.ts` documents how it passes
   * its own.
   */
  deriveModelledWalk,
  detourToleranceMinutesFor,
  DETOUR_STRETCH_MULTIPLIER,
  MODELLED_WALK_KMH,
  permittedModesFor,
  reachFromBase,
  resolveCandidateReach,
  resolveLeg,
  scheduledTransportUnmeasured,
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
