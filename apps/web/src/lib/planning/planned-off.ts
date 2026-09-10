import type { Itinerary, PackageAnchor } from '@sidequest/core';

/**
 * WHAT A DAY WAS FOR, WHEN THE DAY ENDED UP EMPTY.
 *
 * Every anchor the plan proposes reaches exactly one disposition
 * (`preservation.ts`), and one that did not make it carries a traveller-facing
 * reason on `itinerary.unscheduled`. Both records already existed; what did not
 * exist was a way for a *day* to answer for itself.
 *
 * The live Kyrgyzstan trip showed why that matters: day 11 was themed "Scenic
 * return via Burana Tower" and printed "Nothing scheduled", with the explanation
 * four screens away at the foot of the plan. The traveller is left holding two
 * statements and no reconciliation.
 *
 * This is disclosure and nothing more. It does not schedule anything, it does not
 * rewrite the day's own words, and it never invents a reason: an anchor with no
 * recorded sentence gets the honest general one for its disposition.
 */

/** Dispositions that mean the plan wanted this and the plan does not have it. */
const DROPPED: ReadonlySet<PackageAnchor['disposition']> = new Set(['rejected_contradiction', 'rejected_hard_constraint', 'unscheduled_capacity']);

/** The sentence when no traveller-facing reason was recorded for a dropped stop. */
const FALLBACK: Partial<Record<PackageAnchor['disposition'], string>> = {
  rejected_contradiction: 'the evidence contradicted it, so it was taken off rather than left as a false promise.',
  rejected_hard_constraint: 'it did not fit something you told Sidequest was fixed.',
  unscheduled_capacity: 'the day did not have room for it once the travel was counted.',
};

const LAST_RESORT = 'it is not on the plan; what was left off, and why, is at the foot of this plan.';

export interface PlannedOffEntry {
  name: string;
  reason: string;
}

/** Dropped anchors by the day number they were proposed for, in the order the record holds them. */
export function plannedOffByDay(itinerary: Itinerary): Record<number, PlannedOffEntry[]> {
  const byDay: Record<number, PlannedOffEntry[]> = {};
  const reasonByName = new Map((itinerary.unscheduled ?? []).map((entry) => [entry.name, entry.reason] as const));
  for (const anchor of itinerary.package?.anchors ?? []) {
    if (!DROPPED.has(anchor.disposition)) continue;
    const reason = reasonByName.get(anchor.name) ?? FALLBACK[anchor.disposition] ?? LAST_RESORT;
    (byDay[anchor.dayNumber] ??= []).push({ name: anchor.name, reason });
  }
  return byDay;
}
