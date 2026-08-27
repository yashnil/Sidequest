import type { Interest, InterestLevel } from '../schemas/common';
import type { Place } from '../schemas/place';
import type { TravelerProfile } from '../schemas/profile';

/**
 * WHAT ONE STOP COSTS AGAINST THE TRAVELLER'S FREQUENCY CEILINGS — ONE
 * DEFINITION, IN THE ONE PACKAGE ALL THREE SPENDERS CAN REACH.
 *
 * Three layers charge against `derived.frequencyCaps` — the board's auto-pick,
 * the planner's packer, and the validator — and their history is a history of
 * disagreeing ledgers: the auto-pick spent the fit assessment's primary
 * interest, the packer and validator each spent `place.interests[0]`, and for
 * one release the auto-pick spent fractions of secondaries that no other
 * reader of the same number could reproduce. The planner's `frequency.ts`
 * consolidated its two readers and recorded the third as a handoff; this
 * module is that handoff landed, moved to `@sidequest/core` because the
 * auto-pick lives here and a shared definition cannot live downstream of one
 * of its readers.
 *
 * ## The cost model, and the §29 G failure that fixed it
 *
 * One whole unit to **every distinct interest of the place the traveller asked
 * for** — graded `occasional`, `frequent` or `core` — plus the place's own
 * primary interest whatever its grade. Whole units only: fractions are
 * arithmetic no other reader of the same number can reproduce, and §9.3's
 * ceiling is a number of stops.
 *
 * Charging only one interest per stop was the defect the §29 G evaluation
 * caught live: the ledgers charged each stop to a single interest, while the
 * traveller's ceiling is about *how often they do the thing* — and a stop that
 * serves an interest serves it whether or not the ledger filed the stop under
 * it. Five stops matching a four-cap interest were scheduled with every ledger
 * green, because the fifth stop's spend was filed under a different primary.
 * Which five depended on nothing but the order candidates arrived in, so any
 * upstream reordering could overspend a hard traveller constraint. Charging
 * every asked-for interest makes the cap structural: however the stream is
 * ordered, a set that passes the ledger satisfies every ceiling it touches.
 *
 * ## What deliberately does not spend
 *
 * - **An interest the traveller graded `low`** spends nothing as a secondary.
 *   "A little of this, if it is right there" is not an allowance a lakeside
 *   walk should drain because a lake is also technically scenic; the release
 *   gate's own accounting counts only the interests a traveller asked for at
 *   `occasional` or better.
 * - **An interest the traveller was never graded on** has no cap and is never
 *   charged — a limit nobody set cannot refuse a stop.
 * - The **primary interest is the exception to both**: it is what the stop
 *   *is*, so it always spends against whatever cap exists — including a cap of
 *   zero, which is how "avoid" refuses the stops that are mainly the avoided
 *   thing without vetoing every place that lists it third.
 */

/** The profile slice every spender holds: the grades, and the caps derived from them. */
export interface FrequencySpender {
  interests: Partial<Record<Interest, InterestLevel>>;
  derived: Pick<TravelerProfile['derived'], 'frequencyCaps'>;
}

/** The grades at which a matched interest spends its allowance. */
const SPENDING_LEVELS: ReadonlySet<InterestLevel> = new Set(['occasional', 'frequent', 'core']);

/** Whether a traveller's grade makes an interest one they asked for. */
export function interestLevelSpends(level: InterestLevel | undefined): boolean {
  return level !== undefined && SPENDING_LEVELS.has(level);
}

export function frequencyCostOf(
  place: Pick<Place, 'interests'>,
  profile: FrequencySpender,
): [Interest, number][] {
  const caps = profile.derived.frequencyCaps;
  const primary = place.interests[0];
  const costs: [Interest, number][] = [];
  const seen = new Set<Interest>();
  for (const interest of place.interests) {
    if (seen.has(interest)) continue;
    seen.add(interest);
    if (typeof caps[interest] !== 'number') continue;
    if (interest === primary || interestLevelSpends(profile.interests[interest])) {
      costs.push([interest, 1]);
    }
  }
  return costs;
}

/**
 * Whether one more stop fits inside every ceiling it draws on.
 *
 * `spent + cost <= cap` on every charged interest — which is what makes the
 * cap order-independent: a set admitted stop by stop under this test cannot
 * exceed any ceiling however the stops were ordered.
 */
export function withinFrequencyCaps(
  place: Pick<Place, 'interests'>,
  profile: FrequencySpender,
  spent: ReadonlyMap<string, number>,
): boolean {
  return bindingInterestOf(place, profile, spent) === null;
}

/** The ceiling this place is up against first, so a sentence can name one. */
export function bindingInterestOf(
  place: Pick<Place, 'interests'>,
  profile: FrequencySpender,
  spent: ReadonlyMap<string, number>,
): Interest | null {
  const caps = profile.derived.frequencyCaps;
  for (const [interest, cost] of frequencyCostOf(place, profile)) {
    if ((spent.get(interest) ?? 0) + cost > caps[interest]!) return interest;
  }
  return null;
}

/** Adds one stop's cost to a running ledger. */
export function chargeFrequencyCost(
  place: Pick<Place, 'interests'>,
  profile: FrequencySpender,
  spend: Map<string, number>,
): void {
  for (const [interest, cost] of frequencyCostOf(place, profile)) {
    spend.set(interest, (spend.get(interest) ?? 0) + cost);
  }
}
