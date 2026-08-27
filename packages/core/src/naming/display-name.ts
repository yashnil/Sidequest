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
  const clean = input.candidates.flatMap((candidate) =>
    /* Multi-value fields split here, so every part competes on its own. */
    splitMultiValue(sanitizePlaceText(candidate.value)).map((value) => ({ ...candidate, value })),
  );

  const fallback = sanitizePlaceText(input.fallback) || 'this place';
  const sources = [...new Set(clean.map((candidate) => candidate.source))].sort();

  const english = pickAmong(clean.filter((candidate) => isEnglish(candidate.language)));
  const primary = pickAmong(clean.filter((candidate) => candidate.primary === true));
  /*
   * The best non-English, non-primary name — kept for the *local* slot below,
   * never for what leads. A tag naming another language is a source's positive
   * statement that this is not the interface's name for the place.
   */
  const anyOther = pickAmong(
    clean.filter((candidate) => !isEnglish(candidate.language) && candidate.primary !== true),
  );
  /*
   * The only non-primary tier allowed to lead without an English tag: names the
   * source left untagged *and* the refusal net cannot read as another language.
   * A source that did not say what language a name is in has not said it is
   * English — but it has not said it is not, which is more than a tagged or
   * classified third-language name can claim. Those never lead: the primary
   * stands as itself, or the caller's fallback does.
   */
  const readable = pickAmong(
    clean.filter(
      (candidate) =>
        candidate.language === undefined &&
        candidate.primary !== true &&
        !hasRefusalMarker(candidate.value),
    ),
  );

  const chosen = english ?? primary ?? readable;
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
  const canonical = primary?.value ?? chosen?.value ?? anyOther?.value ?? fallback;

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
  /**
   * Names the source *positively tagged* as English — the interface-language
   * entry of a language-keyed name map — offered by callers that still hold
   * the tags. Optional because the pack's normalised records do not: their map
   * was flattened to bare values. When present, these outrank everything,
   * including a Latin-script primary, because a collapse survivor's primary
   * can carry a spelling variant while the tagged name carries the canonical
   * one — and a source's explicit tag is the one statement about language this
   * whole file never has to guess at.
   */
  englishNames?: readonly string[];
  /**
   * Names the card already prints beside the heading — the record's own
   * locality, region and containing division.
   *
   * Read only by `withoutRedundantParenthetical`, to tell a catalogue's index
   * disambiguator ("<name> (<the ward it is in>)") from a parenthetical that
   * actually distinguishes one thing from another. Optional: a caller that does
   * not hold the containment passes nothing and no bracket is stripped on that
   * ground, which is the honest default — a bracket we cannot show to be
   * redundant is kept.
   */
  redundantParentheticals?: readonly string[];
  /** Where the names came from, for provenance. */
  source: string;
}

/**
 * Words that mark a Latin-script name as written in a Romance language —
 * French, Spanish, Portuguese, Italian — which are what a source's untagged
 * alternates mix in with English in practice.
 *
 * A **refusal signal only, never a positive detector of English**. A name that
 * trips this is demoted below alternates that do not; a name that passes has
 * *not* been identified as English — nothing here can do that honestly,
 * because the pack's normaliser keeps only the values of the source's
 * language-keyed name map, so no tag survives to consult. Asserting "this is
 * English" about an untagged string would be an invention; refusing to prefer
 * a string that visibly is not English is an observation.
 *
 * Two pattern families, both chosen to be words that are **not also English
 * words**, matched on folded whole words so "Zoo de Aohama" trips on `de`
 * while "Denver Zoo" trips nothing:
 *
 * 1. Articles, prepositions and connectives — the function words.
 * 2. Place-category nouns ("parc", "parque", "cimetière"). Function words
 *    alone cannot refuse "Parque X" or "Parc X" — two of the five live board
 *    headings this closed — so the obvious category nouns are included.
 *
 * Deliberately high-precision and incomplete: a Romance name built purely from
 * proper nouns passes, and that is the accepted cost of never guessing.
 */
const ROMANCE_MARKER_WORDS = new Set([
  /* Function words. `en` is excluded: it is also an English loan-particle
   * ("en route", "en suite") and this file may name only one language tag. */
  'de', 'du', 'des', 'del', 'della', 'delle', 'dei', 'degli', 'di', 'da', 'das', 'dos',
  'la', 'le', 'les', 'el', 'los', 'las', 'gli', 'une', 'uno', 'una',
  'pour', 'para', 'por', 'et', 'aux', 'sous', 'chez',
  /* Place-category nouns that are not also English words. */
  'parc', 'parque', 'parco', 'jardin', 'jardins', 'jardim', 'jardines', 'giardino', 'giardini',
  'cimetiere', 'cementerio', 'cemiterio', 'cimitero',
  'zoologico', 'zoologique', 'museo', 'museu', 'musee',
  'palacio', 'palazzo', 'palais', 'castillo', 'castelo', 'castello', 'chateau',
  'eglise', 'iglesia', 'igreja', 'chiesa', 'templo', 'tempio', 'santuario', 'sanctuaire',
  'catedral', 'cathedrale', 'cattedrale',
  'plaza', 'praca', 'piazza', 'plage', 'playa', 'praia', 'spiaggia',
  'puente', 'ponte', 'pont', 'gare', 'estacion', 'estacao', 'stazione',
  'rue', 'calle', 'rua', 'avenida', 'torre', 'mercado', 'mercato', 'marche',
  'biblioteca', 'bibliotheque', 'nacional', 'nationale', 'nazionale',
]);

/**
 * The Romance elisions — "d'Aohama", "l'étude", "dell'Arte" — detected on the
 * raw string because folding erases the apostrophe that *is* the signal.
 * Guarded so an apostrophe after a letter ("McDonald's", "Land's End") does
 * not trip it.
 */
const ROMANCE_ELISION = /(^|[^\p{L}'’])[dl]['’]\p{L}/iu;

/**
 * The folded words of a Latin-script name: unaccented, lower-cased, with the
 * eszett expanded to the `ss` it transliterates to — 'ß' is a letter outside
 * `[a-z]` and would otherwise split 'straße' into two meaningless fragments
 * right where a compound marker sits.
 */
function foldedLatinWords(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0);
}

/** Whether a name is recognisably written in a Romance language. Refusal only. */
function hasRomanceMarker(value: string): boolean {
  if (ROMANCE_ELISION.test(value)) return true;
  return foldedLatinWords(value).some((word) => ROMANCE_MARKER_WORDS.has(word));
}

/**
 * The Germanic half of the same refusal net — German and Dutch, which arrive
 * in a source's untagged alternates exactly as the Romance names do and used
 * to sail through it: a freight rail line led an English board under its
 * German compound name because the German alternate was two characters
 * shorter than the source's own English name, and a Dutch nature-reserve
 * heading won the same way.
 *
 * Same contract as `ROMANCE_MARKER_WORDS`: **refusal only, never a positive
 * detector of English**, high precision over completeness — every entry is a
 * word that is not also an English word, matched on folded whole words.
 */
const GERMANIC_MARKER_WORDS = new Set([
  /* Function words and connectives. 'die' and 'am' are excluded: both are
   * English words, and this net may not refuse what it cannot recognise. */
  'und', 'der', 'zum', 'zur', 'im', 'het', 'een', 'aan', 'bij',
  /* Place-category nouns that are not also English words. German first. */
  'strasse', 'platz', 'bahnhof', 'brucke', 'bruecke', 'kirche', 'schloss',
  'friedhof', 'flughafen', 'hafen', 'turm', 'gasse', 'garten', 'markt',
  /* Dutch. */
  'straat', 'plein', 'kerk', 'brug', 'gracht', 'molen', 'tuin', 'eiland',
  'begraafplaats', 'natuurmonument',
]);

/**
 * COMPOUNDS ARE WHY WHOLE WORDS ARE NOT ENOUGH HERE.
 *
 * German and Dutch write the category noun into the name itself — Güterlinie,
 * Hauptbahnhof, Karlsbrücke, Prinsengracht — so a whole-word set never sees
 * it. These endings are matched as suffixes of a folded word, which covers
 * both spellings an umlaut arrives in ('guterlinie' via diacritic stripping,
 * 'gueterlinie' as sources transliterate it). Each is chosen so that no
 * English word ends with it — which is why 'see' (Tennessee) and 'berg'
 * (iceberg) are deliberately absent, at the cost of missing the lakes and
 * hills. High precision over completeness, as everywhere in this net.
 */
const GERMANIC_COMPOUND_ENDINGS = [
  'linie', 'strasse', 'platz', 'brucke', 'bruecke', 'bahnhof', 'bahn',
  'kirche', 'schloss', 'gasse', 'turm', 'markt',
  'straat', 'plein', 'gracht', 'natuurmonument', 'begraafplaats',
] as const;

/** Whether a name is recognisably German or Dutch. Refusal only. */
function hasGermanicMarker(value: string): boolean {
  return foldedLatinWords(value).some(
    (word) =>
      GERMANIC_MARKER_WORDS.has(word) ||
      GERMANIC_COMPOUND_ENDINGS.some(
        (ending) => word.length > ending.length && word.endsWith(ending),
      ),
  );
}

/**
 * ORTHOGRAPHY IS THE CLASS THE WORD LISTS CANNOT REACH.
 *
 * The live gaps the lists missed were names built entirely from proper nouns —
 * a Vietnamese translation of a palace name, a Spanish river variant — where
 * every word is opaque to a vocabulary but the *marks on the letters* are not:
 * English print writes no grave, acute, circumflex, tilde, breve, hook-above,
 * caron, horn or dot-below. Reading marks instead of words is what keeps this
 * a script-class test rather than a per-language, per-destination list — the
 * same reason `isLatinScript` is a script test.
 *
 * Deliberately absent, each because it appears in spellings this resolver must
 * not refuse: the **macron** (the standard romanisation of long vowels — the
 * one honest Latin form many records have), the **diaeresis** (kept by English
 * borrowings), the **ring**, the **cedilla** and the **ogonek**. One accepted
 * cost is a circumflex-based romanisation convention that exists for the same
 * long vowels; sources publish the macron form overwhelmingly, and a refused
 * name loses only to names that trip nothing.
 *
 * Same contract as the word lists: **refusal only, never a positive detector
 * of English** — and refusal only ever ranks *alternates*; a source's own
 * Latin primary is that place's real name and is never judged by this.
 */
const FOREIGN_MARKS = /[\u0300\u0301\u0302\u0303\u0306\u0309\u030c\u031b\u0323]/u;

/** The stroked D pair: no English spelling uses it, and NFD cannot decompose it. */
const FOREIGN_LETTERS = /[\u0110\u0111]/u;

function hasForeignOrthography(value: string): boolean {
  return FOREIGN_LETTERS.test(value) || FOREIGN_MARKS.test(value.normalize('NFD'));
}

/**
 * The whole refusal net: a name recognisably written in a language that is not
 * English may not lead an interface written in English. Still never a
 * positive detector — passing this identifies no language at all.
 */
function hasRefusalMarker(value: string): boolean {
  return hasForeignOrthography(value) || hasRomanceMarker(value) || hasGermanicMarker(value);
}

/**
 * THE ORTHOGRAPHIC ANCHOR: LETTERS THAT PROVE A PLACE'S OWN LANGUAGE WRITES
 * LATIN.
 *
 * The defect this closes: a collapse survivor whose only name was a *Korean
 * transcription* of an Icelandic national park carried its Latin twins as
 * alternates, so the heading resolved to the park's own thorn-spelled name —
 * and the Korean primary then rendered as "Known locally as …" in Hangul on a
 * live card. False twice over: the sentence asserts Hangul is what locals
 * write, and the reader cannot use it.
 *
 * Nothing in this file knows the destination, so "the local language" has to be
 * read off the record itself. What can be read honestly is a *letter*: English
 * print writes no thorn, eth, ø, ł, ŋ, ħ or dotless ı, and no translation fan
 * introduces them either — a French, Spanish, Vietnamese or German rendering of
 * a foreign place strips to plain a–z under mark removal (é, ç, ơ, ü are all
 * combining-mark forms), while these letters survive NFD intact. A Latin
 * rendering that carries one is therefore written in a Latin-based *local*
 * orthography — Icelandic, Faroese, Nordic, Polish, Maltese — which is a
 * positive statement that the place's own script class is Latin, and that a
 * non-Latin rendering beside it is a third-script transcription, not the local
 * name.
 *
 * Deliberately excluded, each because it arrives in renderings that are *not*
 * the local language: `đ/Đ` (Vietnamese translations of anywhere), `ß/ẞ`
 * (German translations), and the `æ/œ` ligature pair (English borrowings keep
 * them). High precision over completeness, like every refusal net in this
 * file: a Latin-local language spelled entirely in a–z (Borgir, Reykjavík
 * after stripping) anchors nothing, and the accepted cost is a local clause
 * that renders where it should not rather than one deleted where it should
 * stay.
 */
const NON_ANCHOR_LATIN_LETTERS = new Set(['đ', 'Đ', 'ß', 'ẞ', 'æ', 'Æ', 'œ', 'Œ']);

function hasLatinLocalOrthography(value: string): boolean {
  const stripped = value.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  for (const char of stripped) {
    if (!/\p{Script=Latin}/u.test(char)) continue;
    if (/[a-zA-Z]/.test(char)) continue;
    if (NON_ANCHOR_LATIN_LETTERS.has(char)) continue;
    return true;
  }
  return false;
}

/**
 * One field, several names: sources join multi-value names with a semicolon or
 * with a spaced slash, and a heading that prints the joined field verbatim is
 * showing the traveller a data format.
 *
 * The spaced slash is not a guess. A collapse survivor on a live dense-metro pack
 * carried the single name field `"<local script> / <roman name> (<initials>)"`,
 * and because nothing split it: `isLatinScript` read the whole field as mixed
 * script and refused it as a primary, so the heading fell through to a
 * three-letter alternate; and the *local* slot then took the entire joined
 * field, so one card printed an acronym as its name and a string containing a
 * different, fuller name beneath it as what locals call it. Two names, one
 * card, and neither the one the source published as the place's name.
 *
 * Spaced deliberately — an unspaced slash is part of a name ("AC/DC", "24/7",
 * "Ann/Eve"), while sources use `" / "` to join two renderings. Split before any
 * selection, select among the parts.
 */
function splitMultiValue(value: string): string[] {
  return value
    .split(/;|\s+\/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * WHETHER A NAME IS AN INITIALISM RATHER THAN THE PLACE'S NAME.
 *
 * The tiers below break ties on *shortest*, which is right when the
 * disagreement is a name plus a qualifier ("City of X" against "X") and exactly
 * wrong when one of the candidates is an acronym: an initialism is the shortest
 * string in every pool, it is pure a–z so no refusal net can see it, and it
 * therefore won outright. On a delivered dense-metro board a destination's largest
 * attraction was carded, scheduled and printed as three capital letters.
 *
 * A refusal signal only, like the language nets, and shaped so it cannot eat a
 * real name: capitals and digits only, no spaces, at most five letters, and at
 * least two of them. Names that are genuinely written in capitals and longer
 * than that are unaffected, and a place whose *only* published name is an
 * initialism still leads with it — refusal only ever ranks a candidate below
 * the alternatives, and nothing is invented when there are none.
 */
function isInitialism(value: string): boolean {
  const letters = value.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2 || letters.length > 5) return false;
  return /^[A-Z0-9]+$/.test(value.replace(/[^A-Za-z0-9]/g, ''));
}

/**
 * A TRAILING PARENTHETICAL THAT ONLY REPEATS WHAT THE CARD ALREADY PRINTS.
 *
 * Catalogues disambiguate rows by appending the containing place in brackets,
 * and the bracket is a property of their index rather than of the place: two
 * of the delivered dense-metro cards led with a ward name in brackets after the
 * place's name, over a card that already prints the locality on its own line.
 *
 * Stripped only when the bracketed text *is* one of the names the caller says
 * are already on the card, and only when a name survives the strip. A
 * parenthetical that distinguishes one thing from another — a terminal, a
 * wing, a numbered section — carries meaning the card cannot recover, and is
 * kept. Both bracket families, because a source writes whichever its own
 * script uses.
 */
function withoutRedundantParenthetical(value: string, redundant: readonly string[]): string {
  const match = /^(.*\S)\s*[(（]([^()（）]+)[)）]\s*$/u.exec(value);
  if (!match) return value;
  const stem = match[1]!.trim();
  const inside = match[2]!.trim();
  if (stem.length === 0 || inside.length === 0) return value;
  const echoes = redundant.some((entry) => {
    const other = entry.trim();
    if (other.length === 0) return false;
    return sameName(other, inside) || other.startsWith(inside) || inside.startsWith(other);
  });
  /*
   * An initialism of the name it follows is the same redundancy in the other
   * direction — the brackets hold the abbreviation of the words in front of
   * them, which the reader has just read.
   */
  return echoes || isInitialism(inside) ? stem : value;
}

/**
 * Whether two names are the same name *ignoring spacing* as well as accents
 * and case. The seam this exists for: a source's primary carrying a spacing
 * variant of the very name a tagged alias spells canonically. Printing the
 * variant beside the canonical form as though it were a different, local name
 * would read as a mistake; loosely, it is one name.
 */
function sameNameLoosely(a: string, b: string): boolean {
  const compact = (value: string) => foldForMatch(value).replace(/ /g, '');
  return compact(a) === compact(b);
}

/**
 * Resolve what a card calls a source record whose alternates carry no language
 * tags.
 *
 * Two defects closed here, in order. First: a compiled board rendered every
 * candidate under its primary local-script name while the records *held*
 * romanised alternates — "Sumida River" verified present and unused — so an
 * English-interface board was a wall of script the traveller could not read.
 * Second, the fix for the first over-corrected: it ordered Latin-script
 * alternates by length alone, and on a live board that picked "Zoo de Ueno"
 * over "Ueno Zoological Gardens" — *a* readable name instead of *the*
 * interface-language name, because the French translation happened to be
 * shorter. Script is not language.
 *
 * Rule 2 of this file is untouched by both: nothing is transliterated or
 * translated, only names the source published are chosen between. And no
 * language tag is ever emitted from this path: the alternates arrive untagged
 * — the normaliser keeps only the values of the source's language-keyed name
 * map — and claiming a language nobody stated would be an invention. A caller
 * that *does* hold tagged names passes them as `englishNames`, or builds
 * `NameCandidate`s and uses `resolveDisplayName`.
 *
 * Every field is split on the multi-value separator first — see
 * `splitMultiValue` — so a semicolon-joined pair competes as two names, never
 * prints as one. Selection, a total order:
 *
 * 1. A name the source positively tagged as English, when the caller has one.
 * 2. A Latin-script primary part — among several parts, one that trips no
 *    refusal marker beats one that does, because a source's multi-value
 *    primary can mix its own name with a translation. A lone Latin primary
 *    still leads as-is, refused or not: it is the place's real name, and a
 *    place genuinely named in another Latin-script language keeps its name.
 * 3. The best Latin-script alternate that trips no refusal marker —
 *    orthographic, Romance or Germanic — which is where a source-published
 *    English name *and* a romanisation of the local name both land,
 *    indistinguishable without tags and both honest headings here.
 * 4. Otherwise the primary leads **as itself** — in its own script, with the
 *    locality gloss the card already carries. A refused alternate is never
 *    the heading: a name classified as a third language, dressed as the
 *    English name of a place, tells the reader the place is called something
 *    it is not. Nothing is invented to replace it.
 *
 * Within a tier: shortest first, then the order the names arrived in. The
 * order tiebreak is load-bearing, not a shrug: a record's own alternates
 * precede names inherited from collapsed twins — that is how the one caller
 * assembles the list — so when two candidates tie on every linguistic
 * criterion, the record's own rendering wins over a neighbour's. The
 * lexicographic tiebreak this replaces decided exactly such a tie by the
 * alphabet, which is how a South Terminal observation deck shipped under its
 * collapsed twin's *North Terminal* name, on a card whose own local name said
 * South. Same inputs still produce the same heading; what changed is that the
 * arbitrary tiebreak became the provenance-bearing one.
 *
 * Whatever leads, the local-script primary stays beside it as the local name
 * (§8.6): promoted, contrasted, never erased — with one refusal. When the
 * record's Latin renderings carry an orthographic anchor (see
 * `hasLatinLocalOrthography`), the place's own language demonstrably writes
 * Latin, and a non-Latin primary is a third-script transcription a collapse
 * happened to leave on top. "Known locally as" may not say that; the clause is
 * omitted, which every consumer of `local` already tolerates.
 */
export function resolveRecordDisplayName(input: RecordNameInput): DisplayName {
  /* Provenance keeps the source's field verbatim; selection works on parts. */
  const canonical = sanitizePlaceText(input.name) || 'this place';
  const primaryParts = splitMultiValue(canonical);
  /* The native form: the non-Latin part when the primary mixes scripts. */
  const native = primaryParts.find((part) => !isLatinScript(part)) ?? primaryParts[0] ?? canonical;

  /* Shortest first; ties keep arrival order (`Array.prototype.sort` is stable). */
  const byPreference = (a: string, b: string) => a.length - b.length;
  const partsOf = (values: readonly string[]) =>
    values.flatMap((value) => splitMultiValue(sanitizePlaceText(value)));

  const tagged = partsOf(input.englishNames ?? []).sort(byPreference)[0];

  const latinPrimary = primaryParts.filter((part) => isLatinScript(part));
  const primaryLead =
    latinPrimary.filter((part) => !hasRefusalMarker(part)).sort(byPreference)[0] ??
    latinPrimary.sort(byPreference)[0];

  /*
   * Within the alternate tier a spelled-out name outranks an initialism, and
   * only then does shortest decide. `byPreference` alone put the acronym first
   * in every case, because an acronym is by construction the shortest string
   * anyone publishes for a place — see `isInitialism`. An initialism still
   * leads where it is the only readable alternate: refusal ranks, never
   * deletes.
   */
  const latinAlternates = partsOf(input.alternateNames).filter(
    (value) => isLatinScript(value) && !hasRefusalMarker(value),
  );
  const readableAlternate =
    latinAlternates.filter((value) => !isInitialism(value)).sort(byPreference)[0] ??
    latinAlternates.sort(byPreference)[0];

  const display = withoutRedundantParenthetical(
    tagged ?? primaryLead ?? readableAlternate ?? native,
    input.redundantParentheticals ?? [],
  );

  /*
   * The third-script refusal, on the local slot only.
   *
   * `native` fills "known locally as", and that sentence is a claim about the
   * destination's own language. A non-Latin native is honest for a place whose
   * language writes that script — and false for one whose own Latin renderings
   * prove the local language writes Latin. The anchor is read across the whole
   * pool rather than just the display, because which Latin variant happens to
   * lead is a length accident and the evidence is the letters themselves.
   */
  const pool = [...primaryParts, ...partsOf(input.alternateNames), ...partsOf(input.englishNames ?? [])];
  const thirdScriptNative =
    !isLatinScript(native) &&
    pool.some((part) => isLatinScript(part) && hasLatinLocalOrthography(part));

  /*
   * The same strip before the same-name test, so a stripped disambiguator does
   * not reappear as a local name. Without it a card whose heading lost its
   * bracket read "<name> · Known locally as <name> (<the ward it is in>)" —
   * the same name twice, which this file's own rule says reads as a bug, plus
   * the index artefact the strip existed to remove.
   */
  const nativeName = withoutRedundantParenthetical(native, input.redundantParentheticals ?? []);
  const local = sameNameLoosely(nativeName, display) || thirdScriptNative ? undefined : nativeName;

  return {
    schemaVersion: DISPLAY_NAME_VERSION,
    display,
    ...(local ? { local } : {}),
    canonical,
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
