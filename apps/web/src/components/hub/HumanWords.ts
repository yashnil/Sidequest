import { ASSURANCE_COPY, assuranceForVerification, type TripNodeState, type VerificationState } from '@sidequest/core';

/**
 * V9 — HUMAN WORDS FOR FORENSIC ONES.
 *
 * The verification, feasibility and state vocabulary is exact and it is the
 * right vocabulary for an audit. It is the wrong vocabulary for a traveller:
 * "partially verified" is a claim about a process, "Likely" is a claim about
 * the place. Every traveller surface reads the table below; the forensic
 * account stays behind "How this was checked" and the print appendix, where
 * somebody debugging a plan can find it and nobody else has to read it.
 *
 * The table is `V9-UX.md`'s, verbatim. Colour is always redundant with the
 * word, so every entry carries a tone as well.
 */
export type HumanTone = 'pine' | 'blue' | 'neutral' | 'amber' | 'clay';

/**
 * V11 §20 §21 — THE FOUR WORDS, WITH THE PRECISE STATE BEHIND THEM.
 *
 * These labels are now derived from `ASSURANCE_COPY` rather than written here,
 * so the table and the four-tier vocabulary cannot drift. The blurbs stay
 * specific to what each evidence state actually means, because that is the
 * sentence a traveller reads on disclosure and it is the honest one.
 *
 * Two changes a reader will notice. `partially_verified` is **Planned**, not a
 * badge of its own: "a real place at this name was confirmed, its hours were
 * not" is true of nearly every stop on nearly every trip, and a badge that
 * appears on everything says nothing while costing a line on every row. And
 * `unverified` is **Still checking** rather than "Check before relying" —
 * because it is our own unfinished work, not a task for the traveller, which is
 * the same distinction §39 draws everywhere else.
 */
export const VERIFICATION_WORDS: Record<VerificationState, { label: string; tone: HumanTone; blurb: string }> = {
  verified: { label: ASSURANCE_COPY[assuranceForVerification('verified')].label, tone: 'pine', blurb: 'A real place at a known position, and we checked its hours or access.' },
  partially_verified: { label: ASSURANCE_COPY[assuranceForVerification('partially_verified')].label, tone: 'neutral', blurb: 'A real place at this name. We have not checked its hours or access.' },
  unverified: { label: ASSURANCE_COPY[assuranceForVerification('unverified')].label, tone: 'clay', blurb: 'We have not matched this to a specific place yet. That is not the same as saying it is wrong.' },
};

/** The state graph's own copy, re-exported under the human-words roof so surfaces import one table. */
/**
 * V11 §21 — the graph's states, in the same four words.
 *
 * A few keep a more specific label where the specific word is genuinely more
 * useful than the tier ("Booked" tells a traveller more than "Confirmed", and
 * "Needs booking" more than "Check"). Everything vaguer than its tier now reads
 * as the tier.
 */
export const STATE_WORDS: Record<TripNodeState, { label: string; tone: HumanTone }> = {
  suggested: { label: 'Planned', tone: 'neutral' },
  accepted: { label: 'Decided', tone: 'pine' },
  needs_decision: { label: 'Your call', tone: 'amber' },
  needs_booking: { label: 'Needs booking', tone: 'amber' },
  booked: { label: 'Booked', tone: 'pine' },
  needs_verification: { label: 'Check', tone: 'amber' },
  verified: { label: 'Confirmed', tone: 'pine' },
  changed: { label: 'Changed since planned', tone: 'clay' },
  unavailable: { label: 'Not available', tone: 'clay' },
  cancelled: { label: 'Skipped', tone: 'neutral' },
  optional: { label: 'Optional', tone: 'neutral' },
};

export const FEASIBILITY_WORDS: Record<'blocker' | 'dependency' | 'caution', { word: string; tone: HumanTone }> = {
  blocker: { word: 'Settle', tone: 'clay' },
  dependency: { word: 'We still need this', tone: 'amber' },
  caution: { word: 'Worth reading', tone: 'neutral' },
};

/**
 * Phrases the deterministic engines write for their own audit, and the words a
 * traveller reads instead. Applied to sentences that reach a surface (the
 * quality audit's warnings, a feasibility detail, a leg's provenance) — never
 * to the appendix.
 */
const PHRASES: readonly [RegExp, string][] = [
  [/\bdependency unresolved\b/gi, 'we still need this'],
  [/\bunresolved dependency\b/gi, 'something we still need'],
  [/\bpartially verified\b/gi, 'likely'],
  [/\bnot fully verified\b/gi, 'still to confirm'],
  [/\bunverified\b/gi, 'not yet confirmed'],
  [/\bnot verified\b/gi, 'not yet confirmed'],
  [/\bprovider evidence (?:is )?absent\b/gi, 'we could not confirm this'],
  [/\bno provider evidence\b/gi, 'nothing could confirm this yet'],
  [/\bunmeasured\b/gi, 'not yet timed'],
  [/\bblast radius\b/gi, 'what this would change'],
  [/\bfeasibility contradiction\b/gi, 'a conflict'],
];

export function humanize(text: string): string {
  let out = text;
  for (const [pattern, word] of PHRASES) out = out.replace(pattern, (match) => (match[0] === match[0]?.toUpperCase() && /[A-Z]/.test(match[0] ?? '') ? word.charAt(0).toUpperCase() + word.slice(1) : word));
  return out;
}

/**
 * V11 §8 — WHICH VERIFICATION STATES ARE WORTH A CHIP ON THE ROW.
 *
 * The four assurance tiers say plainly which two of them ask nothing of the
 * traveller: `confirmed` is "Sidequest checked this against a source" and
 * `planned` is "A good working plan. Nothing here needs your attention." A chip
 * on either is a badge on the normal case -- on a healthy plan almost every stop
 * carried "Confirmed" -- and a label that appears on everything conveys nothing
 * while costing a line on every row. This is the rule already settled for a
 * measured travel leg, applied to the stop it sits above.
 *
 * `check` and `unresolved` stay, because they are the two that mean something is
 * outstanding. The quiet states are not hidden: the place sheet states the tier
 * in full with its blurb, and the confidence panel counts all three.
 */
export function verificationNeedsChip(state: VerificationState): boolean {
  const tier = assuranceForVerification(state);
  return tier === 'check' || tier === 'unresolved';
}

/** "Confirmed from source" for a state a surface has only as a string. */
export function verificationWord(state: string | undefined): string | null {
  if (!state) return null;
  return (VERIFICATION_WORDS as Record<string, { label: string }>)[state]?.label ?? null;
}
