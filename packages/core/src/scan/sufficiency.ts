import type { Interest } from '../schemas/common';

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
}

export interface ScanSufficiency {
  sufficient: boolean;
  needed: number;
  have: number;
  distinctKinds: number;
  neededKinds: number;
  missingInterests: Interest[];
  reasons: ('too_few_places' | 'too_little_variety' | 'priority_uncovered')[];
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
  /* An uncovered priority alone does not make a board unplannable; it shapes what a supplement asks for. */
  const sufficient = have >= needed && distinctKinds >= neededKinds;
  return { sufficient, needed, have, distinctKinds, neededKinds, missingInterests, reasons };
}
