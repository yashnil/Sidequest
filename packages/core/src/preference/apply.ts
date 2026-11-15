import { INTERESTS, type Interest, type InterestLevels } from '../schemas/common';
import type { LearnedPreference } from './evidence';
import { interestKeywords } from './extract';

/**
 * FINAL PASS — WHAT SIDEQUEST LEARNED REACHES THE PLAN THAT IS ACTUALLY BUILT.
 *
 * The ledger (`preference_evidence`) and its weights existed, and the profile
 * page showed them, but the only reader was the model brief — and since V1
 * convergence a normal trip is built by the deterministic planner, which never
 * reads the brief. A traveller who told Sidequest after a trip that they loved
 * the markets got a next trip ranked exactly as if they had said nothing.
 *
 * This is the seam: a learned leaning fills an interest the traveller left
 * **unstated for this trip** and nothing else. Taste only (V6): an answer given
 * for this trip always wins (`user_explicit` outranks `sidequest_inferred`),
 * nothing is ever raised to `core` or lowered to `avoid`, and a weak or
 * low-confidence lean changes nothing. A lean away is a no-op, because an
 * unstated interest already reads as `low` everywhere.
 */

/** A lean must be at least this strong, and at least `medium` band, to count. */
export const LEARNED_MIN_WEIGHT = 0.4;

export interface LearnedInterestChange {
  interest: Interest;
  feature: string;
  band: LearnedPreference['band'];
}

/** The interests a learned feature speaks to: `interest:x` directly, `theme:x` through the interest word table. */
export function interestsForFeature(feature: string): Interest[] {
  const [kind, ...rest] = feature.split(':');
  const name = rest.join(':');
  if (kind === 'interest') return (INTERESTS as readonly string[]).includes(name) ? [name as Interest] : [];
  if (kind !== 'theme' || name.length === 0) return [];
  const words = name.replace(/_/g, ' ');
  return interestKeywords()
    .filter((entry) => entry.pattern.test(words))
    .map((entry) => entry.feature.slice('interest:'.length) as Interest);
}

export function applyLearnedInterests(interests: InterestLevels, learned: readonly LearnedPreference[]): { interests: InterestLevels; changes: LearnedInterestChange[] } {
  const next: InterestLevels = { ...interests };
  const changes: LearnedInterestChange[] = [];
  const ordered = [...learned].sort((a, b) => b.weight * b.confidence - a.weight * a.confidence || a.feature.localeCompare(b.feature));
  for (const lean of ordered) {
    if (lean.band === 'low' || lean.weight < LEARNED_MIN_WEIGHT) continue;
    for (const interest of interestsForFeature(lean.feature)) {
      if (next[interest] !== undefined) continue;
      next[interest] = 'occasional';
      changes.push({ interest, feature: lean.feature, band: lean.band });
    }
  }
  return { interests: next, changes };
}
