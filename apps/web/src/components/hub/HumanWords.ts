import type { TripNodeState, VerificationState } from '@sidequest/core';

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

export const VERIFICATION_WORDS: Record<VerificationState, { label: string; tone: HumanTone; blurb: string }> = {
  verified: { label: 'Confirmed from source', tone: 'pine', blurb: 'A real place at a known position, with evidence for its hours or access.' },
  partially_verified: { label: 'Likely', tone: 'blue', blurb: 'A real place at this name was confirmed. Its hours and access were not.' },
  unverified: { label: 'Check before relying', tone: 'neutral', blurb: 'Nothing could be matched to a specific place yet. That is not the same as saying it is wrong.' },
};

/** The state graph's own copy, re-exported under the human-words roof so surfaces import one table. */
export const STATE_WORDS: Record<TripNodeState, { label: string; tone: HumanTone }> = {
  suggested: { label: 'Suggested', tone: 'neutral' },
  accepted: { label: 'Decided', tone: 'pine' },
  needs_decision: { label: 'We still need this', tone: 'clay' },
  needs_booking: { label: 'Needs booking', tone: 'amber' },
  booked: { label: 'Booked', tone: 'pine' },
  needs_verification: { label: 'Check before relying', tone: 'amber' },
  verified: { label: 'Confirmed from source', tone: 'pine' },
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
  [/\bprovider evidence (?:is )?absent\b/gi, 'check before relying'],
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

/** "Confirmed from source" for a state a surface has only as a string. */
export function verificationWord(state: string | undefined): string | null {
  if (!state) return null;
  return (VERIFICATION_WORDS as Record<string, { label: string }>)[state]?.label ?? null;
}
