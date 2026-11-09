import { haversineKm } from '../travel/estimate';

/**
 * IS THIS THE SAME PLACE TWICE?
 *
 * One restaurant reaches a trip more than once: Overture carries a Meta record
 * and a Foursquare record of it, OpenStreetMap maps it as a node and as its
 * building, and the two sources each have their own row. A list that names
 * "Casa Pepe" and "Restaurante Casa Pepe" forty metres apart has spent two of
 * its few slots on one table.
 *
 * The previous rule compared names after stripping everything outside `a–z0–9`,
 * so every name in Japanese, Cyrillic, Arabic or Thai folded to the empty
 * string — and two *different* restaurants within 150 m of each other were
 * "the same venue" as long as neither was written in Latin script. In Tokyo
 * that quietly removed real places; it never removed a real duplicate.
 *
 * Three signals, all read off the records themselves:
 *
 *  1. **the name**, folded in any script (letters and digits kept, accents and
 *     punctuation dropped, bracketed notes dropped);
 *  2. **how far apart** the two points are — the same name counts up to 150 m
 *     (a building and its entrance node), a contained name only up to 60 m;
 *  3. **the words that carry no identity here** — a word most venues around
 *     share ("restaurante", "café", "食堂") is ignored when comparing, and which
 *     words those are is counted from the names at hand, never typed in.
 *
 * Deliberately conservative: two venues are one only on affirmative evidence.
 * A doubt keeps both, because losing a real restaurant is worse than listing
 * one twice.
 */

/** Letters and digits of any script, lower-cased, accents and bracketed notes removed. */
export function venueNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function venueNameTokens(name: string): string[] {
  return venueNameKey(name).split(' ').filter(Boolean);
}

/**
 * The words that say what kind of place something is rather than which one:
 * those that appear in at least 6% of the names given (and at least four
 * times). Counted from the names, so it is "restaurante" in Tenerife, "cafe" in
 * Keswick and nothing at all where names share no words.
 */
export function genericNameTokens(names: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const name of names) for (const token of new Set(venueNameTokens(name))) counts.set(token, (counts.get(token) ?? 0) + 1);
  const floor = Math.max(4, Math.ceil(names.length * 0.06));
  return new Set([...counts.entries()].filter(([, n]) => n >= floor).map(([token]) => token));
}

const SAME_NAME_KM = 0.15;
const CONTAINED_NAME_KM = 0.06;

/** A token that can identify a venue on its own: three letters, or two characters of a script without spaces. */
function distinctive(token: string): boolean {
  return token.length >= 3 || (token.length >= 2 && /[^\p{Script=Latin}\p{N}]/u.test(token));
}

export interface VenueIdentity {
  name: string;
  coordinates: { lat: number; lng: number };
}

/**
 * Whether two records are one venue. `generic` is the set from
 * `genericNameTokens`; omitted, every word counts.
 */
export function sameVenue(a: VenueIdentity, b: VenueIdentity, generic: ReadonlySet<string> = new Set()): boolean {
  const km = haversineKm(a.coordinates, b.coordinates);
  if (km > SAME_NAME_KM) return false;
  const keyA = venueNameKey(a.name);
  const keyB = venueNameKey(b.name);
  // A name with nothing left after folding identifies nothing; never a match.
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;

  const strip = (key: string) => {
    const kept = key.split(' ').filter((token) => !generic.has(token));
    return kept.length > 0 ? kept : key.split(' ');
  };
  const tokensA = strip(keyA);
  const tokensB = strip(keyB);
  if (tokensA.join(' ') === tokensB.join(' ') && tokensA.some(distinctive)) return true;
  // Containment needs one name to be genuinely shorter: "Bar 1" and "Bar 2" have the same words of different values.
  if (km > CONTAINED_NAME_KM || tokensA.length === tokensB.length) return false;
  const [small, large] = tokensA.length <= tokensB.length ? [tokensA, new Set(tokensB)] : [tokensB, new Set(tokensA)];
  return small.some(distinctive) && small.every((token) => large.has(token));
}

/**
 * The part of a name that stays the same across a chain's branches: no
 * bracketed note, no trailing branch word (`… 新宿東口店`, `… Branch`).
 */
export function chainNameKey(name: string): string {
  const parts = venueNameKey(name.normalize('NFKC')).split(' ');
  if (parts.length > 1 && /(店|支店|branch|filial|sucursal|filiale)$/.test(parts[parts.length - 1]!)) parts.pop();
  return parts.join(' ');
}

/** How a venue was recognised as an outlet of something, strongest first. */
export const CHAIN_EVIDENCE = ['brand_wikidata', 'brand_name', 'repeated_name'] as const;
export type ChainEvidence = (typeof CHAIN_EVIDENCE)[number];

/** The tags a chain venue carries: `chain` and `chain:<evidence>`. */
export function chainTags(evidence: ChainEvidence): string[] {
  return ['chain', `chain:${evidence}`];
}

export function isChainVenue(venue: { tags: readonly string[] }): boolean {
  return venue.tags.includes('chain');
}

export function chainEvidenceOf(venue: { tags: readonly string[] }): ChainEvidence | null {
  for (const evidence of CHAIN_EVIDENCE) if (venue.tags.includes(`chain:${evidence}`)) return evidence;
  return null;
}
