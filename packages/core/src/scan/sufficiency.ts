import type { Interest } from '../schemas/common';
import { estimateLegMinutes, haversineKm } from '../travel/estimate';

/**
 * V1 — IS THERE ENOUGH ON THE BOARD TO PLAN FROM?
 *
 * A scan that placed a handful of places cannot give a planner real choices,
 * and the build then falls back to composition — the exception, not the
 * architecture. What "enough" means depends on the trip: the days that can
 * hold sightseeing, the traveller's own stops per day, a little room to
 * choose (15% more) and some variety of kinds. A priority interest with no
 * place is reported, so a supplement can ask for it, but does not by itself
 * make a board unplannable. It never asks for more than the scan asked the
 * model for.
 *
 * Sparse-itinerary pass (2026-11) — a count is not coverage. A live Tanzania
 * scan placed 29 places against 28 needed and was called sufficient, but three
 * of its four places to sleep had failed to place, so most of the 29 were
 * three hours from the one base that remained and nine days held seven stops.
 * When the caller says how many placed candidates a placed base can actually
 * reach in a day (`inReach`), that is what has to fill the days.
 */
export interface ScanSufficiencyInput {
  days: number;
  /** The traveller's own pace: daytime stops a day holds. */
  stopsPerDay: number;
  /** The fewest candidates the scan asked for. */
  requested: number;
  placed: readonly { kind: string; interests: readonly Interest[] }[];
  /** Interests the traveller made a priority (core or often). */
  priorities: readonly Interest[];
  /** How many of `placed` sit within a day out of some placed base (`candidatesInReach`). Absent: not judged. */
  inReach?: number;
}

export interface ScanSufficiency {
  sufficient: boolean;
  needed: number;
  have: number;
  /** Placed candidates within a day out of a placed base, when the caller judged it. */
  inReach?: number;
  distinctKinds: number;
  neededKinds: number;
  missingInterests: Interest[];
  reasons: ('too_few_places' | 'too_little_variety' | 'priority_uncovered' | 'too_little_in_reach')[];
}

export function scanSufficiency(input: ScanSufficiencyInput): ScanSufficiency {
  const activeDays = Math.max(1, input.days - 1);
  const needed = Math.max(6, Math.min(input.requested, Math.ceil(activeDays * Math.max(1, input.stopsPerDay) * 1.15)));
  const have = input.placed.length;
  const distinctKinds = new Set(input.placed.map((p) => p.kind)).size;
  const neededKinds = Math.min(5, Math.max(3, Math.ceil(needed / 5)));
  const covered = new Set(input.placed.flatMap((p) => p.interests));
  const missingInterests = [...new Set(input.priorities)].filter((i) => !covered.has(i));
  const reasons: ScanSufficiency['reasons'] = [];
  if (have < needed) reasons.push('too_few_places');
  if (distinctKinds < neededKinds) reasons.push('too_little_variety');
  if (missingInterests.length > 0) reasons.push('priority_uncovered');
  /* Only a shortfall the count does not already explain: every active day needs something a place to sleep can reach. */
  const reachShort = input.inReach !== undefined && have >= needed && input.inReach < Math.min(needed, Math.ceil(activeDays * Math.max(1, input.stopsPerDay)));
  if (reachShort) reasons.push('too_little_in_reach');
  /* An uncovered priority alone does not make a board unplannable; it shapes what a supplement asks for. */
  const sufficient = have >= needed && distinctKinds >= neededKinds && !reachShort;
  return { sufficient, needed, have, ...(input.inReach !== undefined ? { inReach: input.inReach } : {}), distinctKinds, neededKinds, missingInterests, reasons };
}

/**
 * How many places sit within a day out of some place to sleep: half the
 * traveller's daily travel each way, estimated from coordinates with the same
 * mode-aware estimator the scan matrix falls back to. An estimate the
 * estimator declines (no road plausibly joins the two) counts as out of reach
 * — this only decides whether to ask for more, it never removes anything.
 */
export function candidatesInReach(input: {
  bases: readonly { lat: number; lng: number }[];
  places: readonly { lat: number; lng: number }[];
  carAvailable: boolean;
  maxDailyTravelMinutes: number;
}): number {
  if (input.bases.length === 0) return 0;
  const oneWay = Math.max(45, Math.floor(input.maxDailyTravelMinutes / 2));
  const minutes = (a: { lat: number; lng: number }, b: { lat: number; lng: number }): number | null => {
    if (!input.carAvailable && haversineKm(a, b) <= 1.6) return estimateLegMinutes({ from: a, to: b, mode: 'walk' })?.minutes ?? null;
    return estimateLegMinutes({ from: a, to: b, mode: input.carAvailable ? 'drive' : 'rail' })?.minutes ?? null;
  };
  return input.places.filter((place) =>
    input.bases.some((base) => {
      const m = minutes(base, place);
      return m !== null && m <= oneWay;
    }),
  ).length;
}
