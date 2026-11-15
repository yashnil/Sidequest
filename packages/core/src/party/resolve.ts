/**
 * WHO IS GOING — FROM WHAT IS KNOWN, NEVER A SILENT "TWO ADULTS".
 *
 * Every door into a trip used to fill the party with two adults when nobody
 * had said. Two adults is a fine planning assumption and a bad fact: it sizes
 * rooms, prices and how strenuous a day may be, and printing it as the
 * traveller's answer is the defaults-as-answers failure the composer schema
 * exists to prevent.
 *
 * The order is fixed: what the traveller wrote ("for my family of four",
 * "solo", "the two of us"), then the people they have already described on
 * their account or browser (`travelers`), then — only when neither says — an
 * assumption that travels as `assumed` so every surface can label it. The
 * reading is a phrase table over their own words; nothing here is a model.
 */

export type PartyBasis = 'stated' | 'profile' | 'assumed';

export interface PartyReading {
  adults: number;
  children: number;
  /** What in their words settled it, for the "we read" line. */
  label: string;
  /** True when the words gave a whole party; false when only part of it ("with our two kids"). */
  complete: boolean;
}

export interface ResolvedParty {
  adults: number;
  children: number;
  basis: PartyBasis;
  /** One short phrase a screen can show beside the counts. */
  label: string;
}

/** Sidequest's assumption when nobody has said. Always labelled `assumed`. */
export const ASSUMED_PARTY = { adults: 2, children: 0 } as const;

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUM = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;

function num(raw: string | undefined): number | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return WORDS[t] ?? null;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * The party their words give, or null when they say nothing about it.
 * "Family of four" is two adults and two children — the common shape, said
 * as a reading so the traveller can correct it; "with our kids" alone gives
 * children but not adults, which is incomplete.
 */
export function readPartyFromText(raw: string | null | undefined): PartyReading | null {
  const t = ` ${String(raw ?? '').toLowerCase().replace(/\s+/g, ' ')} `;
  if (!t.trim()) return null;

  const kidsMatch = new RegExp(String.raw`\b(?:with|and|plus|bringing)\s+(?:my|our|the)?\s*${NUM}\s+(?:kids|children|little ones|boys|girls|toddlers|teens|teenagers)\b`).exec(t);
  const kids = kidsMatch ? num(kidsMatch[1]) : null;
  const someKids = /\b(?:with|and|plus|bringing)\s+(?:my|our|the)\s+(?:kids|children|little ones|toddler|baby|son|daughter)\b/.test(t);

  const family = new RegExp(String.raw`\bfamily\s+of\s+${NUM}\b`).exec(t);
  if (family) {
    const size = clamp(num(family[1]) ?? 0, 1, 24);
    if (size >= 1) {
      const children = kids !== null ? clamp(kids, 0, size - 1) : Math.max(0, size - 2);
      return { adults: clamp(size - children, 1, 12), children: clamp(children, 0, 12), label: `A family of ${size}`, complete: true };
    }
  }

  if (/\b(solo|by myself|on my own|just me|alone|travell?ing alone|me myself)\b/.test(t) && !/\b(not|never)\s+(solo|alone)\b/.test(t)) {
    return { adults: 1, children: kids ?? 0, label: kids ? `You and ${kids} child${kids === 1 ? '' : 'ren'}` : 'Solo', complete: true };
  }

  const count = new RegExp(String.raw`\b(?:for|party of|group of|we are|we're|there are|there will be)?\s*${NUM}\s+(?:of us|people|persons|travell?ers|adults|friends|mates|guys|girls)\b`).exec(t);
  if (count) {
    const n = num(count[1]);
    if (n && n >= 1) {
      const adults = clamp(n, 1, 12);
      return { adults, children: kids ?? 0, label: kids ? `${adults} adults and ${kids} child${kids === 1 ? '' : 'ren'}` : `${adults} ${adults === 1 ? 'person' : 'people'}`, complete: true };
    }
  }

  if (/\b(the two of us|two of us|my (partner|wife|husband|girlfriend|boyfriend|fianc[ée]e?)|our honeymoon|honeymoon|a couple|as a couple)\b/.test(t)) {
    return { adults: 2, children: kids ?? 0, label: kids ? `Two adults and ${kids} child${kids === 1 ? '' : 'ren'}` : 'Two of you', complete: true };
  }

  if (kids !== null) return { adults: ASSUMED_PARTY.adults, children: clamp(kids, 0, 12), label: `With ${kids} child${kids === 1 ? '' : 'ren'}`, complete: false };
  if (someKids) return { adults: ASSUMED_PARTY.adults, children: 1, label: 'With children', complete: false };
  return null;
}

export interface SavedPartyHint {
  /** People described on the account or browser, with their age group. */
  travellers: readonly { ageGroup?: string | null }[];
}

/** The party the saved travellers describe, or null when there are none. */
export function partyFromSaved(saved: SavedPartyHint | null | undefined): ResolvedParty | null {
  const people = saved?.travellers ?? [];
  if (people.length === 0) return null;
  const children = people.filter((p) => p.ageGroup === 'child' || p.ageGroup === 'infant' || p.ageGroup === 'teen').length;
  const adults = Math.max(1, people.length - children);
  return { adults: clamp(adults, 1, 12), children: clamp(children, 0, 12), basis: 'profile', label: 'From your saved travellers' };
}

/**
 * The party for a new trip and how it is known. `explicit` is a party the
 * traveller chose on a screen; it always wins. Words come next, then saved
 * travellers; otherwise the assumption, labelled. `needsQuestion` is true
 * exactly when the answer is an assumption — the one case worth one question.
 */
export function resolveParty(input: { explicit?: { adults: number; children: number } | null; texts?: readonly (string | null | undefined)[]; saved?: SavedPartyHint | null }): ResolvedParty & { needsQuestion: boolean } {
  if (input.explicit) return { adults: clamp(input.explicit.adults, 1, 12), children: clamp(input.explicit.children, 0, 12), basis: 'stated', label: 'As you said', needsQuestion: false };
  for (const text of input.texts ?? []) {
    const reading = readPartyFromText(text);
    if (reading?.complete) return { adults: reading.adults, children: reading.children, basis: 'stated', label: reading.label, needsQuestion: false };
  }
  const saved = partyFromSaved(input.saved);
  if (saved) return { ...saved, needsQuestion: false };
  const partial = (input.texts ?? []).map((t) => readPartyFromText(t)).find((r) => r !== null) ?? null;
  return { adults: partial?.adults ?? ASSUMED_PARTY.adults, children: partial?.children ?? ASSUMED_PARTY.children, basis: 'assumed', label: 'Assumed — nobody said', needsQuestion: true };
}

/** "2 adults, 1 child" with "(assumed)" when it is. */
export function describePartyCounts(party: { adults: number; children: number; basis?: PartyBasis | null }): string {
  const adults = `${party.adults} adult${party.adults === 1 ? '' : 's'}`;
  const counts = party.children > 0 ? `${adults}, ${party.children} child${party.children === 1 ? '' : 'ren'}` : adults;
  return party.basis === 'assumed' ? `${counts} (assumed)` : counts;
}
