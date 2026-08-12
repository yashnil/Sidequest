import { tryLeg } from '@sidequest/geo';
import type { TransportMode, TravelerProfile } from '@sidequest/core';
import {
  deriveModelledWalk as deriveWalkWithin,
  detourToleranceMinutesFor,
  resolveLeg,
  MODELLED_WALK_KMH,
  type LegRule,
  type TravelKnowledge,
  type TravelOption,
  type UnresolvedLeg,
} from './travel';

/**
 * Re-exported so `MODELLED_WALK_KMH` still has an address inside the planner —
 * it is the same constant, from the one module that owns it.
 */
export { MODELLED_WALK_KMH };

/**
 * THE PLANNER'S ANSWER TO A CAR-FREE TRIP HANDED A ROAD MATRIX.
 *
 * The contract says the compiler measures the network a trip is made on. When
 * that contract breaks — a car-free scope stored with a `car` matrix, which a
 * live Tokyo compilation actually produced — `resolveLeg` correctly refuses
 * every pair: a road duration is not a walk, and the traveller may not drive.
 * The refusal was right about every leg and wrong about the trip, because it
 * turned "the matrix measured the wrong network" into "there is no legal way in
 * to any of the 6 places you picked" — a dead end over stops that were a
 * fifteen-minute stroll from the hotel.
 *
 * This module is the narrow, honest repair. When nothing measured can carry a
 * leg, and the road matrix holds a *distance* for the pair, and that distance is
 * short enough that a person would plainly walk it, the leg becomes a **derived
 * walk**: the road kilometres at a deliberately slow pace, labelled
 * `modelled` so no surface can present it as a measurement.
 *
 * The three invariants it must never break, in the words of the module it
 * extends:
 *
 *   - a road *time* never stands in for any other mode — only the distance is
 *     read, and only to derive a walk;
 *   - it never renders as transit — the mode is `walk`, always;
 *   - unknown stays unknown — no distance, or a distance past what this
 *     traveller would walk, stays a refusal, now with the distance named.
 *
 * The cap is the traveller's own walking radius, not a constant: what they said
 * they would walk to reach something, widened by their stated detour tolerance.
 * A modelled number is a guess stacked on a distance, so unlike a *measured*
 * long walk — which `resolveLeg` offers and lets the traveller judge — a
 * modelled long walk is refused outright.
 */

/** How the walk cap is derived: the traveller's own answers, nothing else. */
export function modelledWalkCapMinutes(profile: TravelerProfile): number {
  return detourToleranceMinutesFor(profile, 'walk');
}

/**
 * The rule vocabulary, widened by the one value only the planner can produce.
 *
 * Kept out of core's `LegRule` on purpose: core resolves *measured* journeys,
 * and a derived walk is not one. A consumer that switches on the rule sees a
 * distinct name; a consumer that only reads `provenance` sees `modelled`, which
 * is the same fact in the vocabulary the stored artifact already has.
 */
export type PlannerLegRule = LegRule | 'modelled_walk';

export type PlannerResolvedLeg =
  | ({ ok: true; fromId: string; toId: string; rule: PlannerLegRule } & TravelOption)
  | UnresolvedLeg;

/**
 * A walk derived from the road distance, against **this** traveller's cap.
 *
 * The derivation itself — the pace, the arithmetic, and every part of the
 * honesty test around it — belongs to `@sidequest/core`, which is where the
 * board reads it from too. This function exists for one reason: the cap.
 *
 * Core caps a derived walk at `maxAccessWalkMinutes`, the furthest the traveller
 * said they would walk *to reach a place*, which is the right ceiling for the
 * question core asks ("is there a way in at all"). The planner asks a narrower
 * one — a leg taken mid-day between two stops already accepted — and the right
 * ceiling for that is the traveller's detour tolerance. The difference is
 * deliberate and predates the move; it is carried here by handing core a
 * knowledge whose walking ceiling is the planner's, so the two callers share one
 * derivation and keep their own limits.
 *
 * Null whenever any part of core's honesty test fails, or the derived walk is
 * past the cap given.
 */
export function deriveModelledWalk(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
  capMinutes: number,
): (TravelOption & { mode: 'walk'; provenance: 'modelled' }) | null {
  return deriveWalkWithin({ ...knowledge, maxWalkMinutes: capMinutes }, fromId, toId);
}

/**
 * `resolveLeg`, then the modelled walk as the answer of last resort.
 *
 * Everything measured wins first, through the same ordered rules as always.
 * Only a pair nothing measured can carry — the exact state that emptied the
 * Tokyo plan — falls through to the derivation, and only within the cap.
 *
 * When even the derivation cannot answer, the refusal is *upgraded*, not
 * replaced: a pair the road matrix holds a distance for is not "nothing
 * configured here can measure this journey", it is a stop this traveller's own
 * constraints rule out, and the sentence names the distance so they can weigh
 * it themselves. `conflict: true` is what routes that to a decision rather
 * than to a retry.
 */
export function resolvePlannerLeg(
  knowledge: TravelKnowledge,
  fromId: string,
  toId: string,
  allowed: TransportMode | readonly TransportMode[],
  options: { walkCapMinutes: number; spent?: { driveMinutes: number } },
): PlannerResolvedLeg {
  const resolved = resolveLeg(knowledge, fromId, toId, allowed, options.spent);
  if (resolved.ok) return resolved;

  /*
   * Walking is always permitted — the tolerance bounds how far, not whether —
   * so the only gate here is whether an honest walk can be derived at all.
   */
  const walk = deriveModelledWalk(knowledge, fromId, toId, options.walkCapMinutes);
  if (walk) return { ok: true, fromId, toId, rule: 'modelled_walk', ...walk };

  const road = knowledge.matrix.mode === 'car' ? tryLeg(knowledge.matrix, fromId, toId) : null;
  if (road && road.km > 0 && !knowledge.permitted.has('drive')) {
    const walkMinutes = Math.ceil((road.km * 60) / MODELLED_WALK_KMH);
    return {
      ok: false,
      fromId,
      toId,
      reason: 'mode_not_routed',
      conflict: true,
      detail: `The only measured way here is ${formatKm(road.km)} km by road — this trip has no car, and at roughly ${formatSpan(walkMinutes)} on foot it is past what you said you would walk.`,
    };
  }
  return resolved;
}

/**
 * Whether any honest way from the base to this place — and back — exists for
 * this traveller: measured in a permitted mode, or a derivable walk.
 *
 * This is the mode-aware answer to the funnel's "measurable" gate. The old
 * definition was `hasPoint(matrix, id)`, which counted a road row as
 * measurable for somebody with no car — so the refusal screen said
 * "MEASURABLE 6" one line above "6 with no measured travel time", two claims
 * about the same six places that cannot both be true.
 *
 * Both directions, like every reach question here: a walk out that cannot be
 * walked back is a trip that ends there.
 */
export function plannerReachResolves(
  knowledge: TravelKnowledge,
  baseId: string,
  placeId: string,
  walkCapMinutes: number,
): boolean {
  const legal: TransportMode =
    knowledge.matrix.mode === 'car' ? 'drive' : knowledge.matrix.mode === 'foot' ? 'walk' : 'unsupported';
  const out = resolvePlannerLeg(knowledge, baseId, placeId, legal, { walkCapMinutes });
  if (!out.ok) return false;
  const back = resolvePlannerLeg(knowledge, placeId, baseId, legal, { walkCapMinutes });
  return back.ok;
}

function formatKm(km: number): string {
  return (Math.round(km * 10) / 10).toString();
}

function formatSpan(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
