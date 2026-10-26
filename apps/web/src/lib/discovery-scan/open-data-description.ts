import type { WikidataPlaceDetails } from '../providers/wikidata-details';

/**
 * WHAT AN OPEN-DATA PLACE IS, IN ITS OWN FACTS.
 *
 * The open-data scan used to give every candidate the same sentence shape —
 * "On Wikidata as a fort, about 7 km from Lisbon; matches your interest in
 * history." — which is a statement about our record (where it was listed, how
 * far from the centre, which interest it matched) stored in the field every
 * surface prints as *what the place is*. On a Lisbon board that was twenty
 * near-identical paragraphs, and the interest clause duplicated the fit
 * scorer's own reason.
 *
 * Now the description is built only from what a source states about the place:
 *
 * - the Wikidata English description ("Moorish castle in Lisbon, Portugal"),
 *   with the trailing administrative chain trimmed, and dropped where the same
 *   description is shared by another place in the pool ("building in Lisbon,
 *   Lisbon District, Portugal" told four palaces apart from nothing);
 * - the inception at its stated precision (a year, a decade, a century — never
 *   sharper than the source), the architect(s), the architectural style and a
 *   heritage designation that is an actual listing (not "pending" or "without
 *   legal protection");
 * - OpenStreetMap tags that state a fact about the place (`heritage`,
 *   `start_date`, `wheelchair=yes`).
 *
 * When nothing is known beyond a name and a kind the answer is a bare label
 * ("Square") — no filler sentence. `descriptionAboutThePlace` (core) treats a
 * label as no description, so the card shows none rather than a stub.
 *
 * Nothing about the traveller and nothing about distance goes in here: fit is
 * the scorer's job and travel time is the router's.
 */

/** Longest description we write; the proposal normaliser clips at 240. */
const MAX_LENGTH = 230;

/** Kinds whose inception is a founding rather than a construction. */
const FOUNDED_KINDS = new Set(['museum', 'gallery', 'wildlife', 'theme_park', 'park_or_garden', 'easy_walk']);

/** P31 labels too general to name what a place is. */
const GENERIC_INSTANCE = /^(cultural heritage|tourist attraction|building|structure|architectural heritage monument|heritage site|cultural property|monument|organization|business|geographic location|human-geographic territorial entity|architectural structure|landmark)$/i;

/** Descriptions that are about the item's bookkeeping, never the place. */
const NON_DESCRIPTION = /\b(wikimedia|disambiguation|category|list of|template)\b/i;

/** A description whose head noun is a bare building class says only where the place is. */
const GENERIC_LEAD = /^(building|structure|edifice|architectural structure|cultural heritage monument|cultural property|heritage site|monument|place)\s+(in|of|at|on|located)\b/i;

/** Heritage labels that are not a listing worth stating. */
const NOT_A_LISTING = /without legal protection|pending|included in|candidate|proposed|cultural heritage$/i;

export interface DescribableOpenDataPlace {
  /** The category noun from the map tag table, e.g. "castle". */
  noun: string;
  /** The scan kind, to choose "founded" vs "dates from". */
  kind: string;
  tags: Readonly<Record<string, string>>;
  details?: WikidataPlaceDetails | undefined;
}

const capitalise = (text: string) => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/**
 * The Wikidata description, tidied: a leading article dropped, the trailing
 * ", Region, Country" chain trimmed while at least one "in X" survives, the
 * first letter capitalised. Null when it is not a description of a place.
 */
export function tidyDescription(raw: string | undefined): string | null {
  if (!raw) return null;
  let text = raw.trim().replace(/\.+$/, '');
  if (!text || NON_DESCRIPTION.test(text)) return null;
  text = text.replace(/^(a|an|the)\s+/i, '');
  /* "Building in X" says where, not what: the label ("Monastery") and the facts say more. */
  if (GENERIC_LEAD.test(text)) return null;
  /* Trim ", Lisbon District, Portugal" — capitalised admin segments only; a clause with lowercase words is content. */
  for (;;) {
    const m = /^(.*\S),\s*([A-Z][^,]*)$/.exec(text);
    if (!m) break;
    const [, head, tail] = m;
    if (!/^(?:[A-Z][\p{L}'’.-]*)(?:\s+(?:[A-Z][\p{L}'’.-]*|of|de|do|da|del|di|du|la|le))*$/u.test(tail!.trim())) break;
    if (!/\bin\b/.test(head!)) break;
    text = head!;
  }
  return capitalise(text);
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

/** A year at the precision the source gave it — never sharper. */
export function datePhrase(inception: { year: number; precision: number }): string | null {
  const { year, precision } = inception;
  const bce = year < 0;
  const abs = Math.abs(year);
  if (precision >= 9) return bce ? `${abs} BC` : String(abs);
  if (precision === 8) return bce ? `the ${Math.floor(abs / 10) * 10}s BC` : `the ${Math.floor(abs / 10) * 10}s`;
  if (precision === 7) {
    const century = Math.ceil(abs / 100);
    return `the ${ordinal(century)} century${bce ? ' BC' : ''}`;
  }
  return null;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and others`;
}

/** The facts clause: date, style, architect, listing, access — each only when a source states it. */
export function factsFor(place: DescribableOpenDataPlace): string[] {
  const facts: string[] = [];
  const d = place.details;
  const osmYear = /^(\d{3,4})$/.exec(place.tags.start_date?.trim() ?? '')?.[1];
  const date = d?.inception ? datePhrase(d.inception) : osmYear ? osmYear : null;
  if (date) facts.push(FOUNDED_KINDS.has(place.kind) ? `founded in ${date}` : `dates from ${date}`);
  const styles = (d?.styles ?? []).map((s) => s.replace(/\s+architecture$/i, '')).filter(Boolean).slice(0, 2);
  if (styles.length > 0) facts.push(`${styles.join(' and ')} style`);
  if ((d?.architects.length ?? 0) > 0) facts.push(`designed by ${joinNames(d!.architects)}`);
  const listings = (d?.heritage ?? []).filter((h) => !NOT_A_LISTING.test(h));
  if (listings.some((h) => /world heritage/i.test(h))) facts.push('part of a UNESCO World Heritage Site');
  else if (listings[0]) facts.push(`listed as ${listings[0].replace(/^(a|an|the)\s+/i, '')}`);
  else if (!d && place.tags.heritage) facts.push('heritage-listed');
  if (place.tags.wheelchair === 'yes') facts.push('step-free access is mapped');
  return facts;
}

/** What it is, in a word or two: the most specific P31 label, else the map category noun. */
export function labelFor(place: DescribableOpenDataPlace): string {
  const instance = (place.details?.instances ?? []).find((i) => !GENERIC_INSTANCE.test(i) && i.length <= 40);
  return capitalise(instance ?? place.noun);
}

/**
 * One place's description. `lead` is the tidied description to use, or null
 * when it was missing or shared with another place in the pool.
 */
export function composeDescription(place: DescribableOpenDataPlace, lead: string | null): string {
  const facts = factsFor(place);
  let parts = [...facts];
  const render = () => {
    const clause = parts.join('; ');
    if (lead) return clause ? `${lead}. ${capitalise(clause)}.` : `${lead}.`;
    return clause ? `${labelFor(place)} — ${clause}.` : labelFor(place);
  };
  let text = render();
  while (text.length > MAX_LENGTH && parts.length > 0) {
    parts = parts.slice(0, -1);
    text = render();
  }
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH - 1).trimEnd()}…` : text;
}

/**
 * Describe a whole pool at once, so no two places lead with the same sentence:
 * a Wikidata description shared by two or more places in the pool says nothing
 * that tells them apart and is dropped for all of them.
 */
export function describePool<T extends DescribableOpenDataPlace & { key: string }>(places: readonly T[]): Map<string, string> {
  const leads = new Map(places.map((p) => [p.key, tidyDescription(p.details?.description)] as const));
  const counts = new Map<string, number>();
  for (const lead of leads.values()) if (lead) counts.set(lead.toLowerCase(), (counts.get(lead.toLowerCase()) ?? 0) + 1);
  return new Map(
    places.map((p) => {
      const lead = leads.get(p.key) ?? null;
      return [p.key, composeDescription(p, lead && (counts.get(lead.toLowerCase()) ?? 0) === 1 ? lead : null)] as const;
    }),
  );
}
