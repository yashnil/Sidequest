import type { DiscoveryCandidate, DiscoverySelection, TravelerProfile, Trip, TripComposerAnswers } from '@sidequest/core';
import type { RegionContext } from '../region';
import type { ScanProposalExtras } from '../db/scan-repository';
import { buildCanonicalTripBuildInput } from './canonical-input';
import { composeWithPlanner } from './planner-composer';
import { critiqueExistingPlan, parseExistingPlan, type PlanCritique } from './plan-critique';

/**
 * V1 CONVERGENCE — AUTO-PICK IS THE PLANNER, ASKED EARLY.
 *
 * "Choose for me" used to run a separate selector (`autoSelect`) whose picks
 * the build then had to fit into days — and on live scanned boards it chose a
 * dinosaur museum and a night-time jet boat over Delicate Arch, while the
 * build reshuffled anyway. Now the same deterministic planner that builds the
 * trip decides the picks: it plans the whole board against the traveller's
 * own decisions (their includes are fixed, their skips and un-ticks are gone),
 * and whatever it schedules — that the traveller did not already include — is
 * Sidequest's pick. So the board and the trip agree by construction, and every
 * pick has a day it fits on.
 *
 * Only the traveller's own rows are inputs: Sidequest's previous picks are
 * this function's previous answer, not a decision to respect.
 */
export interface PlannerAutoPick {
  selectedIds: string[];
  notes: string[];
}

export function plannerAutoPick(input: {
  trip: Trip;
  profile: TravelerProfile;
  region: RegionContext;
  candidates: readonly DiscoveryCandidate[];
  selections: readonly DiscoverySelection[];
  extras: ScanProposalExtras | null;
  /** The setup answers, so car availability and travel ceilings match the build's exactly. */
  composer?: TripComposerAnswers | null;
  now?: Date;
}): PlannerAutoPick {
  const travellerRows = input.selections.filter((s) => s.source === 'user');
  const canonical = buildCanonicalTripBuildInput({ trip: input.trip, composer: input.composer ?? null, profile: input.profile, now: input.now ?? new Date() });
  const composed = composeWithPlanner({
    trip: input.trip,
    profile: input.profile,
    region: input.region,
    candidates: input.candidates,
    selections: travellerRows,
    extras: input.extras,
    destinationName: input.region.region.name,
    carAvailable: canonical.movement.carAvailable !== false,
    maxDailyTravelMinutes: canonical.movement.maxDailyTravelMinutes.value ?? input.profile.transport.maxDailyTransportMinutes,
    ...(canonical.movement.maxDailyDriveMinutes.value ? { maxDailyDriveMinutes: canonical.movement.maxDailyDriveMinutes.value } : {}),
  });
  const userIncluded = new Set(travellerRows.filter((s) => s.status === 'included').map((s) => s.placeId));
  const scheduled = composed.plan.days.flatMap((d) => d.stops.map((s) => s.candidate));
  const selectedIds = scheduled.filter((c) => !userIncluded.has(c.id)).map((c) => c.id);
  const days = composed.plan.days.length;
  const notes: string[] = [];
  notes.push(`We planned ${scheduled.length} place${scheduled.length === 1 ? '' : 's'} across your ${days} days — every pick has a day it fits on.`);
  const full = composed.plan.dropped.filter((d) => d.reason === 'capacity' && d.candidate.fit >= 70).length;
  if (full > 0) notes.push(`${full} more good fit${full === 1 ? '' : 's'} did not fit at your pace; add any of them and the plan makes room.`);
  if (composed.plan.weatherMoves.length > 0) notes.push(`${composed.plan.weatherMoves.length} outdoor stop${composed.plan.weatherMoves.length === 1 ? ' was' : 's were'} put on a day with a better forecast.`);
  if (composed.plan.mustConflicts.length > 0) notes.push(`${composed.plan.mustConflicts.length} of your own picks could not fit; they are flagged on the board.`);
  return { selectedIds, notes };
}

/**
 * "I already have a plan", checked against the same planner the build uses:
 * the same pool, travel minutes, daily windows, pace and forecast. Null when
 * the traveller gave no plan. Pure over its inputs — no model, no provider.
 */
export function plannerCritique(input: Omit<Parameters<typeof plannerAutoPick>[0], 'composer'> & { composer: TripComposerAnswers | null }): PlanCritique | null {
  const plan = parseExistingPlan(input.composer?.existingPlan);
  if (!plan) return null;
  const travellerRows = input.selections.filter((s) => s.source === 'user');
  const canonical = buildCanonicalTripBuildInput({ trip: input.trip, composer: input.composer, profile: input.profile, now: input.now ?? new Date() });
  const carAvailable = canonical.movement.carAvailable !== false;
  const composed = composeWithPlanner({
    trip: input.trip,
    profile: input.profile,
    region: input.region,
    candidates: input.candidates,
    selections: travellerRows,
    extras: input.extras,
    destinationName: input.region.region.name,
    carAvailable,
    maxDailyTravelMinutes: canonical.movement.maxDailyTravelMinutes.value ?? input.profile.transport.maxDailyTransportMinutes,
    ...(canonical.movement.maxDailyDriveMinutes.value ? { maxDailyDriveMinutes: canonical.movement.maxDailyDriveMinutes.value } : {}),
  });
  const provenance = (input.region.matrix as unknown as { provenance?: { kind?: string } }).provenance?.kind;
  return critiqueExistingPlan({ plan, planner: composed.plannerInput, proposal: composed.plan, minutesEstimated: !carAvailable || provenance === 'estimated' });
}
