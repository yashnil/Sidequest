import type { DestinationConcept } from '../destinations/semantics';
import { isAreaType } from '../destinations/semantics';
import type { TravelerProfile } from '../schemas/profile';

/**
 * V10 §11 — WHAT THIS ROUTE HAS TO ACHIEVE, STATED RATHER THAN INFERRED.
 *
 * The composition call was being asked to design a route and left to work out
 * from a destination name and a pile of preferences what the route was *for*.
 * These are the objectives, in priority order, derived deterministically from
 * the traveller's own answers and the destination's own shape — so the model is
 * designing against a brief rather than against a vibe, and so the quality
 * compiler has something to check the result against.
 *
 * Every line is a consequence of something the traveller said or something a
 * provider established. Nothing here is taste, and nothing here names a place.
 */
export function routeObjectivesFor(input: {
  concept: Pick<DestinationConcept, 'type' | 'scale' | 'label' | 'extent'> | null;
  profile: TravelerProfile;
  nights: number;
  /** Core zones the decomposition found, for the coverage objective. */
  coreZones?: number;
}): string[] {
  const { profile, nights } = input;
  const out: string[] = [];

  /* What the traveller ranked highest is what the route is for. */
  const RANK: Record<string, number> = { core: 0, frequent: 1, occasional: 2 };
  const ranked = (Object.keys(profile.interests) as (keyof typeof profile.interests)[])
    .filter((key) => RANK[profile.interests[key] ?? 'low'] !== undefined)
    .sort((a, b) => (RANK[profile.interests[a] ?? 'low'] ?? 9) - (RANK[profile.interests[b] ?? 'low'] ?? 9))
    .slice(0, 3)
    .map((key) => String(key).replace(/_/g, ' '));
  if (ranked.length > 0) out.push(`Put ${ranked.join(', ')} at the centre of the route, not around its edges.`);

  /* How much of a broad destination the days can honestly hold. */
  if (input.concept && isAreaType(input.concept.type) && (input.concept.scale === 'region' || input.concept.scale === 'subregion' || input.concept.scale === 'country')) {
    const zones = input.coreZones ?? 0;
    out.push(
      zones > 0 && nights < zones * 2
        ? `${nights} nights cannot do justice to ${zones} core areas: choose the subset that goes deep and say in omissions which you left and why.`
        : `Cover a coherent part of ${input.concept.label} rather than crossing all of it; depth beats breadth at this length.`,
    );
  }

  /* The traveller's own ceilings, as objectives rather than as filters. */
  const moves = profile.interview?.baseMoveTolerance;
  if (moves === 'stay_put') out.push('One base for the whole trip: reach everything as a day out rather than moving the luggage.');
  else if (moves === 'move_once') out.push('At most one change of base: two halves, each with its own area.');
  else out.push('Move base only where the move buys a materially better day, and always in one direction of travel.');

  const cap = profile.transport.maxDailyDriveMinutes;
  if (cap > 0) out.push(`Keep each day's travel under ${Math.round((cap / 60) * 10) / 10} hours, transfer days included.`);

  const mix = profile.interview?.iconicCrowdStrategy;
  if (mix === 'quieter_alternative') out.push('Where an icon is crowded, take the quieter equivalent rather than the icon.');
  else if (mix === 'go_at_odd_hours') out.push('Keep the icons and reach them at the hours the crowds do not.');

  if (profile.accessibility.mobilityLimited) out.push('Every core experience has to work without steep or rough ground.');

  return out.slice(0, 6);
}
