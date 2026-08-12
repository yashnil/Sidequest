import { z } from 'zod';
import { foldForMatch, sanitizePlaceText } from '../destinations/normalize';

/**
 * ONE PLACE DECIDES WHAT A PLACE IS CALLED.
 *
 * The defect this exists to remove: a compiled Kyrgyzstan trip rendered its base
 * as **Бишкек шаары**, on every screen, to a traveller who had typed
 * "Kyrgyzstan" in English and picked an English row out of the destination
 * index. The index already resolves English-first; the regional-expansion layer
 * did not, because it took whatever `name` a geocoder happened to return — and
 * a geocoder's `name` is the *local* name by design.
 *
 * So naming stops being something each layer does for itself. Every geographic
 * entity a traveller reads — a suggestion, an interpretation card, a base, a
 * cluster, a board group, a transfer day, an itinerary heading — resolves its
 * name through this file.
 *
 * THREE RULES, AND WHY EACH IS NON-NEGOTIABLE.
 *
 * 1. **English leads when a credible English name exists.** Not because English
 *    is special, but because it is the language the product is written in: a
 *    heading a reader cannot pronounce is not a confirmation of anything. The
 *    local name is kept and shown beside it, never instead of it.
 * 2. **Nothing is ever translated.** Only names a *source* published are used —
 *    Overture's `names.common`, Wikidata labels, OSM's `name:en`, the
 *    destination index's own aliases. A model may not produce a place name here
 *    or anywhere near here, and an architecture test enforces it. A translated
 *    place name is a place that does not exist.
 * 3. **The canonical name survives.** Whatever the source called it is kept for
 *    provenance, so a fact traced back to a record still matches that record.
 *
 * The fallback chain is total: English → primary/official → longest-supported
 * alias → whatever the caller passed. There is no input for which this returns
 * nothing, because a screen with a blank heading is worse than one with a name
 * in a script the reader does not know.
 */

/** One name a source published, with whatever metadata it came with. */
export const nameCandidateSchema = z.object({
  value: z.string().min(1),
  /**
   * BCP-47-ish, exactly as the source gave it: `en`, `en-GB`, `ky`, `zh-Hant`.
   * Absent is meaningful — it means the source did not say, not that it is
   * English.
   */
  language: z.string().min(1).optional(),
  /** Where this name came from, so provenance survives the resolution. */
  source: z.string().min(1),
  /** The source's own primary/official name for the entity. */
  primary: z.boolean().optional(),
});
export type NameCandidate = z.infer<typeof nameCandidateSchema>;

export const DISPLAY_NAME_VERSION = 1 as const;

export const displayNameSchema = z.object({
  schemaVersion: z.literal(DISPLAY_NAME_VERSION),
  /** What leads on screen. */
  display: z.string().min(1),
  /** IETF tag of `display`, when a source said. */
  displayLanguage: z.string().min(1).optional(),
  /**
   * The native name, when it is genuinely different from `display`.
   *
   * Absent when the official English name *is* the local name — which is common
   * and correct, and rendering it twice would read as a mistake.
   */
  local: z.string().min(1).optional(),
  localLanguage: z.string().min(1).optional(),
  /** What the source called it. Never shown; kept so a record still matches. */
  canonical: z.string().min(1),
  /** Every source that contributed a name, deduplicated and ordered. */
  sources: z.array(z.string().min(1)).default([]),
});
export type DisplayName = z.infer<typeof displayNameSchema>;

/** Whether a language tag is a variety of English. */
export function isEnglish(language: string | undefined): boolean {
  if (!language) return false;
  const tag = language.trim().toLowerCase();
  return tag === 'en' || tag.startsWith('en-') || tag.startsWith('en_');
}

/**
 * Whether two names are the same name.
 *
 * Folded rather than compared literally, so `Nuku'alofa` and `Nukuʻalofa` are
 * one name and not two — the same fold the destination index matches on, which
 * is what stops the two layers disagreeing about whether a local name is worth
 * showing.
 */
export function sameName(a: string, b: string): boolean {
  return foldForMatch(a) === foldForMatch(b);
}

/**
 * Pick between several English names for the same entity.
 *
 * Sources genuinely disagree — Overture, Wikidata and OSM will each have an
 * opinion about whether somewhere is "Osh City", "Osh" or "City of Osh". The
 * order is: the one a source marked primary, then the one the most sources
 * agree on, then the shortest, then lexicographic.
 *
 * Shortest is not arbitrary: the disagreements in practice are one name plus a
 * qualifier ("City of X" against "X"), and the bare form is the one a traveller
 * would say. Lexicographic last makes the whole thing a total order, so the same
 * inputs always produce the same heading.
 */
function pickAmong(candidates: readonly NameCandidate[]): NameCandidate | undefined {
  if (candidates.length === 0) return undefined;

  const byFolded = new Map<string, { candidate: NameCandidate; votes: number; primary: boolean }>();
  for (const candidate of candidates) {
    const key = foldForMatch(candidate.value);
    const existing = byFolded.get(key);
    if (existing) {
      existing.votes += 1;
      existing.primary ||= candidate.primary === true;
      continue;
    }
    byFolded.set(key, { candidate, votes: 1, primary: candidate.primary === true });
  }

  return [...byFolded.values()].sort(
    (a, b) =>
      Number(b.primary) - Number(a.primary) ||
      b.votes - a.votes ||
      a.candidate.value.length - b.candidate.value.length ||
      a.candidate.value.localeCompare(b.candidate.value),
  )[0]?.candidate;
}

export interface ResolveDisplayNameInput {
  candidates: readonly NameCandidate[];
  /**
   * What to call it if every candidate is unusable.
   *
   * Required, and required to be non-empty by the caller: this function has no
   * path that returns an empty heading.
   */
  fallback: string;
}

/**
 * Resolve the name a traveller sees.
 *
 * Pure, deterministic and total. Every candidate is sanitised first — the same
 * sanitiser the destination index uses — so a bidirectional override or a
 * control character in a source's alias cannot reach a heading, a `title`
 * attribute or a PDF.
 */
export function resolveDisplayName(input: ResolveDisplayNameInput): DisplayName {
  const clean = input.candidates
    .map((candidate) => ({ ...candidate, value: sanitizePlaceText(candidate.value) }))
    .filter((candidate) => candidate.value.length > 0);

  const fallback = sanitizePlaceText(input.fallback) || 'this place';
  const sources = [...new Set(clean.map((candidate) => candidate.source))].sort();

  const english = pickAmong(clean.filter((candidate) => isEnglish(candidate.language)));
  const primary = pickAmong(clean.filter((candidate) => candidate.primary === true));
  /*
   * The best non-English, non-primary name, used only when nothing better
   * exists. Untagged names land here, which is right: a source that did not say
   * what language a name is in has not said it is English.
   */
  const anyOther = pickAmong(
    clean.filter((candidate) => !isEnglish(candidate.language) && candidate.primary !== true),
  );

  const chosen = english ?? primary ?? anyOther;
  const display = chosen?.value ?? fallback;

  /*
   * The local name is the source's own primary, shown only when it genuinely
   * differs from what leads.
   *
   * The case worth stating: an entity whose official English name *is* its local
   * name — which is most of the anglophone world, and plenty outside it. There
   * the two fold to the same string and `local` is omitted, because printing a
   * name twice reads as a bug.
   */
  const nativeCandidate = primary ?? anyOther;
  const local =
    nativeCandidate && !sameName(nativeCandidate.value, display) ? nativeCandidate : undefined;

  /*
   * Canonical is the source's own primary where there is one, and otherwise
   * whatever we are displaying. It is never the fallback dressed up: a record
   * traced back to its source has to still match that source.
   */
  const canonical = primary?.value ?? chosen?.value ?? fallback;

  return {
    schemaVersion: DISPLAY_NAME_VERSION,
    display,
    ...(chosen?.language ? { displayLanguage: chosen.language } : {}),
    ...(local ? { local: local.value } : {}),
    ...(local?.language ? { localLanguage: local.language } : {}),
    canonical,
    sources,
  };
}

/**
 * Whether a name is written in Latin script — readable to the product's
 * interface language even when nobody tagged its language.
 *
 * A *script* test, deliberately not a language test: source records carry
 * alternates with no language tag at all, and asserting "this is English" about
 * an untagged string would be an invention. What can be said honestly is that
 * the letters are ones an English-interface reader can read, which is exactly
 * the property the board needs. Counted over letters only, so digits,
 * punctuation and spaces neither qualify nor disqualify a name, and mixed
 * scripts fail: a name has to be *predominantly* readable, not merely contain
 * one Latin character.
 */
export function isLatinScript(value: string): boolean {
  let latin = 0;
  let other = 0;
  for (const char of value) {
    if (/\p{Script=Latin}/u.test(char)) latin += 1;
    else if (/\p{L}/u.test(char)) other += 1;
  }
  if (latin === 0) return false;
  return other === 0;
}

export interface RecordNameInput {
  /** The source's primary name, verbatim. */
  name: string;
  /** Other names the source publishes. Untagged — see `isLatinScript`. */
  alternateNames: readonly string[];
  /** Where the names came from, for provenance. */
  source: string;
}

/**
 * Resolve what a card calls a source record whose alternates carry no language
 * tags.
 *
 * The defect this closes: a compiled board rendered every candidate under its
 * primary local-script name while the records *held* romanised alternates —
 * "Sumida River" verified present and unused — so an English-interface board
 * was a wall of script the traveller could not read. Rule 2 of this file is
 * untouched: nothing is transliterated or translated, only names the source
 * published are chosen between.
 *
 * Selection: a Latin-script primary leads as-is. Otherwise the best
 * Latin-script alternate leads — shortest first, then lexicographic, the same
 * total order `pickAmong` uses for its final tiebreaks — and the primary stays
 * beside it as the local name. No usable alternate means the primary leads,
 * exactly as before this function existed.
 */
export function resolveRecordDisplayName(input: RecordNameInput): DisplayName {
  const primary = sanitizePlaceText(input.name) || 'this place';
  const alternates = input.alternateNames
    .map((value) => sanitizePlaceText(value))
    .filter((value) => value.length > 0);

  if (isLatinScript(primary)) {
    return {
      schemaVersion: DISPLAY_NAME_VERSION,
      display: primary,
      canonical: primary,
      sources: [input.source],
    };
  }

  const latin = alternates
    .filter((value) => isLatinScript(value))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const chosen = latin[0];
  if (!chosen || sameName(chosen, primary)) {
    return {
      schemaVersion: DISPLAY_NAME_VERSION,
      display: primary,
      canonical: primary,
      sources: [input.source],
    };
  }

  return {
    schemaVersion: DISPLAY_NAME_VERSION,
    display: chosen,
    local: primary,
    canonical: primary,
    sources: [input.source],
  };
}

/**
 * What to render, for an entity that may or may not carry a resolved name.
 *
 * The compatibility seam. Every artifact compiled before this existed has a bare
 * `name` string and no `names` structure — and must keep rendering exactly as it
 * did, because changing how a stored plan reads is not a presentation fix, it is
 * rewriting somebody's trip.
 *
 * So: use the structure when it is there, and the plain name when it is not.
 * Never re-derive, never guess, never reach for a provider.
 */
export function displayNameOf(entity: { name: string; names?: DisplayName }): string {
  return entity.names?.display ?? entity.name;
}

/** The native name to show beside it, when there is one worth showing. */
export function localNameOf(entity: { name: string; names?: DisplayName }): string | undefined {
  const local = entity.names?.local;
  if (!local) return undefined;
  return sameName(local, displayNameOf(entity)) ? undefined : local;
}

/**
 * Build candidates from the destination index's own shape.
 *
 * The index already resolves English-first at build time — this is what lets a
 * base, a cluster or a board group inherit that work rather than repeating it
 * against a geocoder that only knows the local name.
 */
export function candidatesFromIndexEntry(entry: {
  displayName: string;
  localName?: string;
  aliases?: readonly string[];
  catalog?: string;
}): NameCandidate[] {
  const source = entry.catalog ?? 'index';
  const candidates: NameCandidate[] = [
    /*
     * The index's `displayName` is English where the catalogue published one,
     * and the local name otherwise. Tagged `en` only when there is a distinct
     * local name to contrast it with — otherwise we would be asserting a
     * language nobody told us.
     */
    {
      value: entry.displayName,
      source,
      ...(entry.localName && !sameName(entry.localName, entry.displayName)
        ? { language: 'en' }
        : {}),
    },
  ];
  if (entry.localName) {
    candidates.push({ value: entry.localName, source, primary: true });
  }
  for (const alias of entry.aliases ?? []) {
    candidates.push({ value: alias, source: `${source}:alias` });
  }
  return candidates;
}
