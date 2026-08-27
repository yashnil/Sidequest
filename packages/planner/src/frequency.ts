/**
 * THE FREQUENCY LEDGER, RE-EXPORTED FROM WHERE ALL THREE SPENDERS CAN REACH IT.
 *
 * This module used to hold the definition and recorded the board's auto-pick as
 * a handoff — three layers spending against `derived.frequencyCaps` with three
 * different ledgers, reconciled two-at-a-time. The §29 G evaluation then caught
 * the remaining disagreement live: every ledger charged one interest per stop,
 * so five stops matching a four-cap interest were scheduled with every ledger
 * green, the fifth filed under a different primary — and *which* five depended
 * on nothing but candidate order, so any upstream reordering could overspend a
 * hard traveller constraint.
 *
 * The definition now lives in `@sidequest/core` (`scoring/frequency.ts`), where
 * the auto-pick can read it too, and it charges every interest the traveller
 * asked for that a stop serves — see that module for the cost model and its
 * exclusions. The packer and the validator import through this file so the
 * planner's own seam stays where its tests and its callers know it.
 */
export {
  bindingInterestOf,
  chargeFrequencyCost,
  frequencyCostOf,
  withinFrequencyCaps,
  type FrequencySpender,
} from '@sidequest/core';
