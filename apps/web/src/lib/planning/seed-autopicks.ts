import 'server-only';
import type { DiscoveryCandidate, TravelerProfile, Trip } from '@sidequest/core';
import { getSelections, replaceAutoSelections } from '../db/repository';
import { getScanProposalExtras } from '../db/scan-repository';
import { getIntent } from '../db/compiler-repository';
import type { RegionContext } from '../region';
import { plannerAutoPick, type PlannerAutoPick } from './planner-autopick';

/**
 * Sidequest's pre-selection, written: the planner's picks replace Sidequest's
 * previous picks, and the traveller's own rows are never touched
 * (`replaceAutoSelections` inserts with ON CONFLICT DO NOTHING). The one
 * function every seeding door calls — the scan, "Choose for me", and the
 * questionnaire on its way to a board or a build.
 */
export function seedPlannerAutoPicks(input: { trip: Trip; profile: TravelerProfile; region: RegionContext; candidates: readonly DiscoveryCandidate[] }): PlannerAutoPick {
  const picks = plannerAutoPick({
    trip: input.trip,
    profile: input.profile,
    region: input.region,
    candidates: input.candidates,
    selections: getSelections(input.trip.id),
    extras: getScanProposalExtras(input.trip.id),
    composer: getIntent(input.trip.id)?.composer ?? null,
  });
  replaceAutoSelections(input.trip.id, picks.selectedIds);
  return picks;
}
