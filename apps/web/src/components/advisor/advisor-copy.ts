import type { AdvisorPick } from '@sidequest/core';

/**
 * WHAT A SHORTLIST CARD SAYS ABOUT WHERE ITS READING CAME FROM.
 *
 * The advisor now ranks two kinds of record side by side: destinations a
 * person at Sidequest read and wrote up, and destinations derived from open
 * travel guides and map data that nobody has checked. A card must say which it
 * is in a sentence, and how much evidence stands behind it in a word — never as
 * a number, a field name or an identifier.
 *
 * Pure functions, so the wording is tested rather than eyeballed.
 */

export interface PickProvenance {
  /** Who read this place: us, or open data nobody reviewed. */
  reading: string;
  /** How much the open sources say about it; null for an editorial reading, which needs no such caveat. */
  documentation: 'well documented' | 'moderately documented' | 'thinly documented' | null;
  /** Set when a research model proposed the place before the atlas verified and ranked it. */
  suggested: string | null;
}

export const EDITORIAL_READING = 'Sidequest’s own reading';
export const OPEN_DATA_READING = 'Read from open travel guides and map data, not checked by an editor';
export const SUGGESTED_READING = 'Suggested by a research model, then verified and ranked against our atlas';

export function documentationWord(confidence: number): NonNullable<PickProvenance['documentation']> {
  if (confidence >= 0.75) return 'well documented';
  if (confidence >= 0.55) return 'moderately documented';
  return 'thinly documented';
}

export function provenanceOf(pick: Pick<AdvisorPick, 'basis' | 'confidence' | 'suggested'>): PickProvenance {
  const editorial = pick.basis === 'editorial';
  return {
    reading: editorial ? EDITORIAL_READING : OPEN_DATA_READING,
    documentation: editorial ? null : documentationWord(pick.confidence),
    suggested: pick.suggested || pick.basis === 'research' ? SUGGESTED_READING : null,
  };
}

/** The provenance in a few words, for a table cell. */
export function provenanceShort(pick: Pick<AdvisorPick, 'basis' | 'confidence' | 'suggested'>): string {
  const provenance = provenanceOf(pick);
  const reading = provenance.documentation ? `Open data, ${provenance.documentation}` : 'Our own reading';
  return provenance.suggested ? `${reading}; suggested by a research model` : reading;
}

export interface SourceReference {
  /** What the traveller reads. Never an identifier. */
  text: string;
  /** Where it leads, when the reference names a page we can link. */
  href: string | null;
  /** True when the words do not say which place the page is about, so a link needs the place named beside it. */
  generic: boolean;
}

/**
 * A stored reference as something to show. "Wikivoyage: Hunza Valley" links to
 * that guide; "Wikidata: Q5469" links to the record but is shown as "Wikidata
 * record", because a Q-number is an identifier and means nothing to a
 * traveller. Anything else is shown as written.
 */
export function sourceReference(reference: string): SourceReference {
  const text = reference.trim();
  const wikivoyage = /^Wikivoyage:\s*(.+)$/i.exec(text);
  if (wikivoyage) {
    const title = wikivoyage[1]!.trim();
    return { text: `Wikivoyage: ${title}`, href: `https://en.wikivoyage.org/wiki/${encodeURIComponent(title.replace(/\s+/g, '_'))}`, generic: false };
  }
  const wikidata = /^Wikidata:\s*(Q\d+)$/i.exec(text);
  if (wikidata) return { text: 'Wikidata record', href: `https://www.wikidata.org/wiki/${wikidata[1]!.toUpperCase()}`, generic: true };
  return { text, href: null, generic: false };
}

/** A count as a traveller reads it: 36,512, never 36512. */
export function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

/** Required by the sources' licences wherever a shortlist is shown. */
export const DATA_ATTRIBUTION = 'Destination data: Wikivoyage (CC BY-SA 4.0), Wikidata (CC0), CHELSA climate normals, NOAA ETOPO & OISST, OurAirports, World Bank, Natural Earth, GMBA Mountain Inventory v2 (CC BY 4.0, Snethlage et al. 2022). Wildlife from GBIF occurrence data. Night lights: Chen et al. 2021 from VIIRS. Waves generated using E.U. Copernicus Marine Service Information. Ski areas: OpenSkiData / OpenSkiMap.org, © OpenStreetMap contributors (ODbL), Skimap.org, Who’s On First, © Mapterhorn. Travel advice from the U.S. Department of State, the UK FCDO (Open Government Licence v3.0) and the Government of Canada (Open Government Licence – Canada).';

/** How wide the comparison was and how many places were read in full, in one sentence. */
export function comparedSentence(stats: { catalog: number; considered: number }): string {
  const compared = `We compared ${formatCount(stats.catalog)} destinations`;
  if (stats.considered <= 0) return `${compared}.`;
  if (stats.considered >= stats.catalog) return `${compared} and read every one closely.`;
  return `${compared} and read ${formatCount(stats.considered)} closely.`;
}
