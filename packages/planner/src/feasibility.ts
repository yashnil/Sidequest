import { tryLeg, type TravelTimeMatrix } from '@sidequest/geo';
import type { PlanningCandidate } from './types';

/**
 * TOO MANY MUST-DOS IS A CONFLICT, NOT A DISAPPOINTMENT.
 *
 * The planner already distinguishes "this plan does not work" from "we could
 * not give you something you asked for", and that distinction is right: one
 * attraction shut on the traveller's dates should be reported by name, not used
 * to refuse an otherwise good trip.
 *
 * What it could not distinguish is the case section 26.2 asks for. A traveller
 * who hand-picks eleven places for a three-day trip is not disappointed by one
 * of them — they have asked for something arithmetically impossible, and the
 * honest answer is to say the *set* conflicts and let them choose what gives.
 * Deciding for them, silently, by dropping whichever ones the greedy packer
 * reached last, is the "obediently producing an impossible itinerary" the
 * contract names.
 *
 * So this runs **before** the planner, on the traveller's own picks, and does
 * arithmetic they can check:
 *
 *   time the must-dos need  =  Σ (time on site) + Σ (travel between them)
 *   time the trip has       =  usable minutes per day × planning days
 *
 * Both sides are conservative in the traveller's favour. The travel term is a
 * nearest-neighbour lower bound rather than a real route, so it *understates*
 * what the trip will cost; the day length is generous. A conflict reported here
 * is therefore one that no ordering, no clustering and no optimiser could have
 * fixed — which is exactly the claim worth making, and the only one that
 * justifies stopping to ask.
 */

/**
 * Minutes a day can actually hold stops in.
 *
 * Not twenty-four and not the daylight window: a day that is nine hours of
 * stops is already a full one, and a bound that assumed more would report
 * "this fits" for trips nobody would enjoy. Deliberately generous against the
 * planner's own per-pace limits, because this is a test for *impossible*, not
 * for *ambitious* — anything short of impossible is the planner's business.
 */
export const USABLE_MINUTES_PER_DAY = 540;

/**
 * How much over the available time a set has to be before it is a conflict.
 *
 * A set that needs 101% of the trip is not a conflict; it is a tight trip, and
 * the planner will shave it. A set that needs 130% cannot be shaved into place
 * by any ordering. The margin exists so this stays silent on every trip the
 * planner can still do something useful with.
 */
export const CONFLICT_MARGIN = 1.3;

export interface MustDoConflict {
  /** The hand-picked places that cannot all fit, by id and name. */
  places: { placeId: string; name: string; minutesOnSite: number }[];
  /** Minutes the set needs: time on site plus a lower bound on travel. */
  minutesRequired: number;
  /** Minutes the trip has. */
  minutesAvailable: number;
  /** Planning days the trip has. */
  days: number;
  /**
   * The fewest picks that would have to go for the rest to fit.
   *
   * Computed by removing the most expensive first, which is the cheapest
   * honest answer to "how bad is it". Never applied — naming a number is the
   * point, and choosing *which* is the traveller's decision.
   */
  fewestToDrop: number;
  /** Days that would make the current set fit, if they would rather add time. */
  daysNeeded: number;
  /** One sentence a traveller can check against the numbers above. */
  summary: string;
}

export interface FeasibilityInput {
  candidates: readonly PlanningCandidate[];
  matrix: TravelTimeMatrix;
  /** Days the trip can actually plan into. Arrival and departure days count. */
  days: number;
}

/**
 * Whether the traveller's own picks can fit in the time they have.
 *
 * Returns `null` when they can — which is the overwhelmingly common case, and
 * the reason this is cheap to call unconditionally.
 */
export function assessMustDoFeasibility(input: FeasibilityInput): MustDoConflict | null {
  const manual = input.candidates.filter((candidate) => candidate.manual);
  /*
   * Two or fewer hand-picks can always be argued to fit somewhere, and a
   * conflict claim about them would be about the trip's length rather than
   * about the set. The planner's existing per-place reporting covers those.
   */
  if (manual.length < 3 || input.days < 1) return null;

  const onSite = manual.reduce((total, candidate) => total + candidate.durationMinutes, 0);
  const travel = lowerBoundTravelMinutes(manual, input.matrix);
  const minutesRequired = onSite + travel;
  const minutesAvailable = input.days * USABLE_MINUTES_PER_DAY;

  if (minutesRequired <= minutesAvailable * CONFLICT_MARGIN) return null;

  /*
   * How many would have to go, removing the most expensive first.
   *
   * The travel term is recomputed as each is removed rather than scaled, because
   * dropping the outlier that sits two hours from everything else can save far
   * more than its own visit length — and telling a traveller "drop four" when
   * dropping one would do is its own kind of wrong answer.
   */
  const byCost = [...manual].sort(
    (a, b) => b.durationMinutes - a.durationMinutes || a.place.id.localeCompare(b.place.id),
  );
  let fewestToDrop = 0;
  let remaining = [...byCost];
  while (remaining.length > 0) {
    const need =
      remaining.reduce((total, candidate) => total + candidate.durationMinutes, 0) +
      lowerBoundTravelMinutes(remaining, input.matrix);
    if (need <= minutesAvailable) break;
    remaining = remaining.slice(1);
    fewestToDrop += 1;
  }

  const daysNeeded = Math.ceil(minutesRequired / USABLE_MINUTES_PER_DAY);

  return {
    places: manual.map((candidate) => ({
      placeId: candidate.place.id,
      name: candidate.place.name,
      minutesOnSite: candidate.durationMinutes,
    })),
    minutesRequired,
    minutesAvailable,
    days: input.days,
    fewestToDrop,
    daysNeeded,
    summary: `The ${manual.length} places you picked by hand need about ${hours(minutesRequired)} between them once travel is counted, and ${input.days} day${input.days === 1 ? '' : 's'} holds about ${hours(minutesAvailable)}. Something has to give: ${
      fewestToDrop === 1
        ? 'dropping one of them'
        : `dropping ${fewestToDrop} of them`
    }, or ${daysNeeded} days instead of ${input.days}.`,
  };
}

/**
 * A LOWER BOUND ON THE TRAVEL A SET COSTS.
 *
 * Nearest-neighbour over the measured matrix, which is a *lower* bound on the
 * real tour and deliberately so: this function's answer is used to refuse a
 * trip, and a refusal has to be one the traveller could not have argued their
 * way out of with a cleverer route. Overstating travel here would refuse trips
 * that a good ordering could have delivered.
 *
 * Pairs the matrix cannot answer for contribute nothing rather than a guess.
 * That keeps the bound a bound — an unmeasured leg makes the estimate smaller,
 * never larger, so an unmeasurable region can never manufacture a conflict.
 */
function lowerBoundTravelMinutes(
  candidates: readonly PlanningCandidate[],
  matrix: TravelTimeMatrix,
): number {
  if (candidates.length < 2) return 0;
  const ids = candidates.map((candidate) => candidate.place.id);
  const visited = new Set<string>([ids[0]!]);
  let cursor = ids[0]!;
  let total = 0;

  while (visited.size < ids.length) {
    let nearest: string | null = null;
    let nearestMinutes = Number.POSITIVE_INFINITY;
    for (const id of ids) {
      if (visited.has(id)) continue;
      const measured = tryLeg(matrix, cursor, id);
      /* Unmeasured pairs are skipped, which keeps this a lower bound. */
      if (measured === null || !Number.isFinite(measured.minutes)) continue;
      if (measured.minutes < nearestMinutes) {
        nearestMinutes = measured.minutes;
        nearest = id;
      }
    }
    if (nearest === null) {
      /* Nothing else is reachable from here; take the next unvisited for free. */
      const next = ids.find((id) => !visited.has(id));
      if (next === undefined) break;
      visited.add(next);
      cursor = next;
      continue;
    }
    total += nearestMinutes;
    visited.add(nearest);
    cursor = nearest;
  }

  return Math.round(total);
}

function hours(minutes: number): string {
  const value = minutes / 60;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} hours`;
}
