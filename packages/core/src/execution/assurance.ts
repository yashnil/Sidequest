import type { TripNodeState } from './state-graph';
import type { VerificationState } from '../schemas/itinerary';
import type { TravelDurationState } from '../travel/estimate';

/**
 * V11 §17 §21 — FOUR WORDS, AND ONLY FOUR.
 *
 * A traveller reading a day of the founder's Kyrgyzstan trip met, on one screen:
 * *Suggested · 3 open · moderate · times approximate · Likely · Check before
 * relying · allowance — not timed · operator-timed · We still need this · Worth
 * reading · 2 to check before relying · A real place at this name was confirmed;
 * hours and access have not been*.
 *
 * Every one of those is *true*, and each was added to fix a real dishonesty.
 * Together they are a forensic report, not a plan. Counted across the product
 * there are **eighteen** distinct traveller-facing status labels drawn from four
 * separate vocabularies — the state graph's eleven, verification's three,
 * feasibility's three, and the travel-duration states — each with its own tone
 * and its own badge.
 *
 * §21 says what the traveller should see instead. Four tiers:
 *
 *   CONFIRMED   Sidequest checked this
 *   PLANNED     A good working plan
 *   CHECK       Verify before relying
 *   UNRESOLVED  Sidequest still needs this
 *
 * **The exact evidence state is not deleted and must not be.** It stays on the
 * record, in "How this was checked", in the print appendix and in the logs. This
 * module is the one place the precise vocabulary is folded into the coarse one,
 * so a surface cannot invent a nineteenth word and the fold happens once rather
 * than differently in each component.
 */

export const ASSURANCE_TIERS = ['confirmed', 'planned', 'check', 'unresolved'] as const;
export type AssuranceTier = (typeof ASSURANCE_TIERS)[number];

export const ASSURANCE_COPY: Record<AssuranceTier, { label: string; blurb: string; tone: 'pine' | 'neutral' | 'amber' | 'clay' }> = {
  confirmed: { label: 'Confirmed', blurb: 'Sidequest checked this against a source.', tone: 'pine' },
  planned: { label: 'Planned', blurb: 'A good working plan. Nothing here needs your attention.', tone: 'neutral' },
  check: { label: 'Check', blurb: 'Worth verifying before you rely on it.', tone: 'amber' },
  unresolved: { label: 'Still checking', blurb: 'Sidequest is still working this out.', tone: 'clay' },
};

/** Strongest first, so a day or a chapter can take the weakest tier among its parts. */
const SEVERITY: Record<AssuranceTier, number> = { confirmed: 0, planned: 1, check: 2, unresolved: 3 };

export function weakestAssurance(tiers: readonly AssuranceTier[]): AssuranceTier {
  return tiers.reduce<AssuranceTier>((worst, tier) => (SEVERITY[tier] > SEVERITY[worst] ? tier : worst), 'confirmed');
}

/**
 * A node's state, as one of the four.
 *
 * `needs_decision` splits on ownership, which is the whole of §39 in one line:
 * a choice the traveller has to make is `check` (there is something to do), and
 * our own unfinished work is `unresolved` (there is not).
 */
export function assuranceForNodeState(state: TripNodeState, owner: 'traveller' | 'sidequest' = 'traveller'): AssuranceTier {
  switch (state) {
    case 'verified':
    case 'booked':
      return 'confirmed';
    case 'accepted':
    case 'suggested':
    case 'optional':
    case 'cancelled':
      return 'planned';
    case 'needs_verification':
    case 'needs_booking':
    case 'changed':
      return 'check';
    case 'unavailable':
      return 'check';
    case 'needs_decision':
      return owner === 'sidequest' ? 'unresolved' : 'check';
  }
}

/**
 * A place's verification state, as one of the four.
 *
 * `partially_verified` is `planned`, not `check`. "A real place at this name was
 * confirmed; hours and access have not been" is true of almost every stop on
 * almost every trip, and a badge that appears on almost everything conveys
 * nothing while costing a line of type on every row. It becomes a `check` only
 * when something else about the stop actually needs checking.
 */
export function assuranceForVerification(state: VerificationState): AssuranceTier {
  switch (state) {
    case 'verified':
      return 'confirmed';
    case 'partially_verified':
      return 'planned';
    case 'unverified':
      return 'unresolved';
  }
}

/** A leg's timing, as one of the four. An operator's own timetable is a plan, not a gap. */
export function assuranceForTravel(state: TravelDurationState): AssuranceTier {
  switch (state) {
    case 'measured':
      return 'confirmed';
    case 'scheduled':
      return 'confirmed';
    case 'model_estimate':
    case 'geo_estimate':
      return 'planned';
    case 'unknown':
      return 'unresolved';
  }
}

/**
 * One sentence for a whole day, instead of a badge on every row.
 *
 * §21's example, generalised: "Day 4 — 2 route timings still being checked"
 * rather than six epistemic badges. Returns null when there is nothing to say,
 * which is the common case and the point.
 */
export function assuranceSummary(input: { unresolvedLegs: number; unresolvedPlaces: number; toCheck: number }): string | null {
  const parts: string[] = [];
  if (input.unresolvedLegs > 0) parts.push(`${input.unresolvedLegs} journey time${input.unresolvedLegs === 1 ? '' : 's'} still being worked out`);
  if (input.unresolvedPlaces > 0) parts.push(`${input.unresolvedPlaces} place${input.unresolvedPlaces === 1 ? '' : 's'} still being located`);
  if (input.toCheck > 0) parts.push(`${input.toCheck} thing${input.toCheck === 1 ? '' : 's'} to check before you rely on ${input.toCheck === 1 ? 'it' : 'them'}`);
  if (parts.length === 0) return null;
  const sentence = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}
