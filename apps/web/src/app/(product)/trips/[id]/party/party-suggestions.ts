import { DIETARY_NEED_KIND, DIETARY_NEED_LABELS, FUNCTIONAL_NEED_LABELS, type Traveler } from '@sidequest/core';

/**
 * V8 — THE PARTY EDITOR'S PURE PARTS.
 *
 * Suggested phrases for the private notes, in the vocabulary the planner
 * actually uses (a planning consequence, never a diagnosis), and the sorting
 * of one person's facts into the three groups their card shows: what binds
 * the plan, what shapes it, and what is written only for the planning.
 */

/** Phrases a person can drop into their notes with one press. Each is a consequence for the plan, not a condition. */
export const PARTY_NOTE_SUGGESTIONS: readonly string[] = [
  'Needs frequent seated breaks',
  'Cannot walk more than ~2 km continuously',
  'Avoids steep descents',
  'Needs step-free access',
  'Severe peanut allergy',
  'Cannot start before 9am',
];

/** Append a phrase to the notes as its own sentence, once; the notes are the traveller's words and are never rewritten. */
export function appendPhrase(notes: string | undefined, phrase: string): string {
  const current = (notes ?? '').trim();
  if (current.toLowerCase().includes(phrase.toLowerCase())) return current;
  if (current.length === 0) return phrase;
  return /[.;!?]$/.test(current) ? `${current} ${phrase}` : `${current}. ${phrase}`;
}

/** Whether the notes already carry a phrase, so its chip reads as pressed. */
export function hasPhrase(notes: string | undefined, phrase: string): boolean {
  return (notes ?? '').toLowerCase().includes(phrase.toLowerCase());
}

export interface PersonFacts {
  /** What the plan may not break: strict diets, allergies, functional needs that bind. */
  hard: string[];
  /** What shapes the plan without binding it. */
  preferences: string[];
  /** Words written for the planning only — never shared, never printed. */
  privateNotes: string[];
}

const CAPACITY_WORDS: Record<string, string> = { low: 'Takes it easy', moderate: 'Average activity level', high: 'Very fit' };
const SLEEP_WORDS: Record<string, string> = { early: 'Early riser', normal: 'Normal mornings', late: 'Late riser' };

/**
 * One person's facts, sorted.
 *
 * A diet is hard when the person said "cannot, not would-rather-not" or when
 * it is an allergy — an allergy is never a preference. A functional need is
 * hard when the person's needs bind the plan; when they said their needs do
 * not bind it, the same need is shown among the preferences with a word
 * saying so, so nothing recorded disappears from view.
 */
export function personFacts(traveler: Pick<Traveler, 'diet' | 'needs' | 'needsNotes' | 'profile'>, member: { preferencesApply: boolean; constraintsApply: boolean }): PersonFacts {
  const hard: string[] = [];
  const preferences: string[] = [];
  const privateNotes: string[] = [];

  for (const need of traveler.diet.needs) {
    const label = DIETARY_NEED_LABELS[need];
    if (traveler.diet.strict || DIETARY_NEED_KIND[need] === 'allergy') hard.push(label);
    else preferences.push(label);
  }
  for (const need of traveler.needs) {
    const label = FUNCTIONAL_NEED_LABELS[need];
    if (member.constraintsApply) hard.push(label);
    else preferences.push(`${label} (noted, does not bind the plan)`);
  }
  if (traveler.profile.physicalCapability) preferences.push(CAPACITY_WORDS[traveler.profile.physicalCapability] ?? traveler.profile.physicalCapability);
  if (traveler.profile.sleepRhythm) preferences.push(SLEEP_WORDS[traveler.profile.sleepRhythm] ?? traveler.profile.sleepRhythm);
  if (traveler.profile.transportComfort.includes('drives')) preferences.push('Can drive on this trip');
  if (!member.preferencesApply) preferences.push('Tastes do not shape the plan');
  if (traveler.diet.notes) privateNotes.push(traveler.diet.notes);
  if (traveler.needsNotes) privateNotes.push(traveler.needsNotes);

  return { hard, preferences, privateNotes };
}
