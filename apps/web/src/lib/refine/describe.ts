import type { TripDraft } from '../planning/trip-draft';
import { anchorIndex } from './patch';
import type { PreservationContract } from './state';

/**
 * THE PRESERVATION CONTRACT, IN THE TRAVELLER'S WORDS.
 *
 * PRODUCTION LOCK V5 §11 and §44. The contract (`blast-radius.ts`) addresses
 * things the way the system has to address them — `activity:d1-a0-ala-too-square`,
 * `day:6:travel`, `trip_fact:booked_facts` — because preservation has to be
 * checkable by identity, not by prose. None of that may reach a traveller: the
 * first live refinement put `activity:d1-a0-ala-too-square` under a "Kept"
 * heading, which is the system talking to itself in front of a customer.
 *
 * So the addresses stay internal and this module is the one boundary that turns
 * them into sentences, by resolving each address against the draft it came from.
 * It invents nothing: a name here is the thing's own name, a day number is its
 * own day, and an address that no longer resolves is dropped rather than guessed
 * at. Rendering is capped, because "everything that stayed the same" on an
 * eleven-day trip is a wall of text, not reassurance.
 */

/** How many individually named things a list will show before it starts counting. */
const NAMED_LIMIT = 4;

/** "a", "a and b", "a, b and c" — the product's list voice, never an Oxford comma. */
function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function dayPhrase(days: readonly number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.length === 1 ? `Day ${sorted[0]}` : `Days ${listOf(sorted.map(String))}`;
}

/** An address is `kind:ref` or `kind:ref:aspect`; the ref may itself hold no colon. */
function partsOf(address: string): { kind: string; ref: string; aspect?: string } {
  const segments = address.split(':');
  return { kind: segments[0] ?? '', ref: segments[1] ?? '', aspect: segments[2] };
}

const FACT_PHRASES: Record<string, string> = {
  diet: 'What you can and cannot eat',
  booked_facts: 'Everything you have already booked',
  hard_rules: 'The things you told Sidequest were fixed',
  timing: 'Your dates',
  transport: 'How you get around',
  pace: 'How full the days are',
  thesis: 'What this trip is about',
};

/**
 * What stayed, as the traveller would describe it.
 *
 * Days preserved whole absorb their own activities — naming a day and then
 * re-naming each thing on it says the same thing twice. Activities that survive
 * that fold are the ones the traveller locked inside the changing scope, which
 * is exactly the case worth spelling out.
 */
export function describeKept(input: { preserve: readonly string[]; draft: TripDraft }): string[] {
  const wholeDays: number[] = [];
  const baseIds: string[] = [];
  const activityIds: string[] = [];
  const facts: string[] = [];

  for (const address of input.preserve) {
    const { kind, ref, aspect } = partsOf(address);
    if (aspect !== undefined) continue;
    if (kind === 'day') {
      const day = Number(ref);
      if (Number.isInteger(day)) wholeDays.push(day);
    } else if (kind === 'base' || kind === 'lodging') baseIds.push(ref);
    else if (kind === 'activity') activityIds.push(ref);
    else if (kind === 'trip_fact') facts.push(ref);
  }

  const preservedDays = new Set(wholeDays);
  const index = anchorIndex(input.draft);
  const named: string[] = [];
  for (const id of activityIds) {
    const address = index.get(id);
    if (!address || preservedDays.has(address.dayNumber)) continue;
    const name = input.draft.days.find((day) => day.dayNumber === address.dayNumber)?.anchors[address.index]?.name;
    if (name) named.push(`${name} on day ${address.dayNumber}`);
  }

  const baseNames: string[] = [];
  for (const id of baseIds) {
    const base = input.draft.bases.find((entry) => entry.id === id);
    if (base) baseNames.push(base.name);
  }

  const lines: string[] = [];
  if (wholeDays.length > 0) lines.push(`${dayPhrase(wholeDays)} exactly as ${wholeDays.length === 1 ? 'it was' : 'they were'}`);
  if (named.length > 0) lines.push(named.length > NAMED_LIMIT ? `${listOf(named.slice(0, NAMED_LIMIT))}, and ${named.length - NAMED_LIMIT} more` : listOf(named));
  if (baseNames.length > 0) {
    lines.push(
      baseNames.length === input.draft.bases.length && input.draft.bases.length > 1
        ? 'Every place you sleep'
        : `Where you sleep in ${baseNames.length > NAMED_LIMIT ? `${listOf(baseNames.slice(0, NAMED_LIMIT))} and ${baseNames.length - NAMED_LIMIT} more` : listOf(baseNames)}`,
    );
  }
  for (const fact of facts) {
    const phrase = FACT_PHRASES[fact];
    if (phrase) lines.push(phrase);
  }
  return lines;
}

/**
 * What Sidequest is checking again, as the traveller would describe it.
 *
 * These are honest: a changed day's travel times and opening hours are the two
 * things a local edit can quietly invalidate, so they are named rather than
 * folded into a spinner.
 */
export function describeRechecking(input: { recheck: readonly string[]; draft: TripDraft }): string[] {
  const travel: number[] = [];
  const hours: number[] = [];
  const areas: string[] = [];

  for (const address of input.recheck) {
    const { kind, ref, aspect } = partsOf(address);
    if (kind === 'day' && Number.isInteger(Number(ref))) {
      if (aspect === 'travel') travel.push(Number(ref));
      else if (aspect === 'hours') hours.push(Number(ref));
    } else if (kind === 'base' && aspect === 'area') {
      const base = input.draft.bases.find((entry) => entry.id === ref);
      if (base) areas.push(base.name);
    }
  }

  const lines: string[] = [];
  if (travel.length > 0) lines.push(`Travel times on ${dayPhrase(travel).toLowerCase()}`);
  if (hours.length > 0) lines.push(`Opening hours on ${dayPhrase(hours).toLowerCase()}`);
  if (areas.length > 0) lines.push(`What is near ${listOf(areas)}`);
  return lines;
}

/**
 * A refusal, in the traveller's words.
 *
 * The internal reasons are written for a developer reading a log ("no such
 * activity in this draft"). The traveller needs to know one thing: why their
 * request did not happen, and that their trip is intact. Anything unrecognised
 * falls through to the honest general sentence rather than being shown raw.
 */
export function describeRefusal(reason: string): string {
  const text = reason.toLowerCase();
  if (text.includes('outside the scope')) return 'That was outside the scope of this change, so it stayed as it was.';
  if (text.includes('locked')) return 'You asked Sidequest to keep that, so it stayed as it was.';
  if (text.includes('five experiences')) return 'That day is already as full as Sidequest will make it.';
  if (text.includes('no such')) return 'Sidequest could not find that in your trip.';
  if (text.includes('not valid')) return 'That change would have left the trip inconsistent, so nothing changed.';
  return 'Sidequest did not make that change.';
}

/** Both halves of the traveller-facing summary, from one contract. */
export function describeContract(input: { contract: PreservationContract | undefined; draft: TripDraft }): { kept: string[]; rechecking: string[] } {
  if (!input.contract) return { kept: [], rechecking: [] };
  return {
    kept: describeKept({ preserve: input.contract.preserve, draft: input.draft }),
    rechecking: describeRechecking({ recheck: input.contract.recheck, draft: input.draft }),
  };
}
