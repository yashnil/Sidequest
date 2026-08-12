import type { Interest, Place, TravelerProfile } from '@sidequest/core';

/**
 * WHAT ONE STOP COSTS AGAINST THE TRAVELLER'S FREQUENCY CEILINGS — ONE DEFINITION.
 *
 * Three layers charge against `derived.frequencyCaps` and they were charging
 * three different ledgers:
 *
 *   - the board's auto-pick (`packages/core/src/discovery/autoselect.ts`) spends
 *     a full unit of `fit.primaryInterest` — the interest of *the traveller's*
 *     that a place best serves — and half a unit of every other interest in
 *     `fit.matchedInterests`;
 *   - the planner's packer spends a full unit of `place.interests[0]` — the
 *     interest the *place* primarily is;
 *   - the validator afterwards counts `place.interests[0]` the same way and
 *     writes a caution when the total goes over.
 *
 * Those are not the same ledger. A lakeside hike is `interests[0] = 'hiking'`
 * for the planner and can be `primaryInterest = 'lakes_and_rivers'` for a
 * traveller who grades lakes higher, so the board can hand over a set it
 * believes compliant that the planner then refuses a stop from, and the
 * validator can warn about a ceiling neither of the other two thought was near.
 * Three answers to "how many of these did you ask for" is a product that cannot
 * explain itself.
 *
 * **This is the definition.** It is derived from the **place** rather than from
 * the fit assessment on purpose: the validator only ever holds `Place` records,
 * so a definition it cannot compute is a definition the three cannot share. The
 * traveller still enters it — an interest they were never graded on has no cap
 * and is not charged, which is exactly "the ones you told us about".
 *
 * The cost model is one full unit to the place's primary interest and nothing
 * to the rest. That is what the planner and the validator have always spent, so
 * adopting it here changes no behaviour; what it changes is that there is now
 * one function to change. Charging secondaries — the auto-pick's half-unit
 * model, which is arguably the better one — is a single edit *here*, and the
 * reason it is not made here is that it moves all three ledgers at once and the
 * board must move with it: a planner stricter than the board silently deletes
 * stops the board offered, which is measurably worse than the disagreement it
 * would be fixing.
 */
export function frequencyCostOf(
  place: Place,
  caps: TravelerProfile['derived']['frequencyCaps'],
): [Interest, number][] {
  const primary = place.interests[0];
  if (primary === undefined || typeof caps[primary] !== 'number') return [];
  return [[primary, 1]];
}

/**
 * Whether one more stop fits inside every ceiling it draws on.
 *
 * `spent + cost <= cap`, which for a whole unit is the `spent < cap` the packer
 * always used, and which stays correct if the cost model ever grows fractions.
 */
export function withinFrequencyCaps(
  place: Place,
  caps: TravelerProfile['derived']['frequencyCaps'],
  spent: ReadonlyMap<string, number>,
): boolean {
  return bindingInterestOf(place, caps, spent) === null;
}

/** The ceiling this place is up against first, so a sentence can name one. */
export function bindingInterestOf(
  place: Place,
  caps: TravelerProfile['derived']['frequencyCaps'],
  spent: ReadonlyMap<string, number>,
): Interest | null {
  for (const [interest, cost] of frequencyCostOf(place, caps)) {
    if ((spent.get(interest) ?? 0) + cost > caps[interest]!) return interest;
  }
  return null;
}

/** Adds one stop's cost to a running ledger. */
export function chargeFrequencyCost(
  place: Place,
  caps: TravelerProfile['derived']['frequencyCaps'],
  spend: Map<string, number>,
): void {
  for (const [interest, cost] of frequencyCostOf(place, caps)) {
    spend.set(interest, (spend.get(interest) ?? 0) + cost);
  }
}
