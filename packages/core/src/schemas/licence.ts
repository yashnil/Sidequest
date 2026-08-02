import { z } from 'zod';
import { httpUrlSchema } from './common';

/**
 * WHOSE DATA THIS IS, AND WHAT THAT OBLIGES US TO DO.
 *
 * Sidequest's durable artifacts are now built on openly licensed data, which is
 * what makes storing them lawful at all. That is not a free pass: an open
 * licence is a contract, and ODbL's is the demanding kind — attribution
 * wherever the data appears, and share-alike on any derived database we
 * publish.
 *
 * So a licence is a first-class field rather than a line in a footer. Every
 * compiled artifact carries the licences its contents came under, every place
 * records which one applies to it, and the attribution string is data the UI
 * renders rather than copy somebody remembered to write.
 */

export const LICENCE_IDS = [
  /** OpenStreetMap. Attribution **and** share-alike on a derived database. */
  'ODbL-1.0',
  /** Open-Meteo. Attribution only. */
  'CC-BY-4.0',
  /**
   * Overture's place records from most contributors. Share the licence text with
   * shared data; §3.1 puts no obligation at all on results. **No share-alike.**
   * Keeping this distinguishable from `ODbL-1.0` at the record level is the whole
   * reason a region pack holds layers rather than one merged table.
   */
  'CDLA-Permissive-2.0',
  /** Overture's Foursquare-sourced place records. NOTICE travels with the data. */
  'Apache-2.0',
  /** Overture's AllThePlaces-sourced records. No obligation; attributed anyway. */
  'CC0-1.0',
  /** A public body's own published information, terms unread. Attribution, no reuse claim. */
  'official-source',
  /** Written by us from sources we read. Ours to keep. */
  'sidequest-authored',
] as const;
export const licenceIdSchema = z.enum(LICENCE_IDS);
export type LicenceId = z.infer<typeof licenceIdSchema>;

export const dataLicenceSchema = z.object({
  id: licenceIdSchema,
  name: z.string().min(1),
  url: httpUrlSchema.optional(),
  /**
   * The exact words to put on screen. Data rather than copy, because the
   * obligation is to render *this*, and a component that paraphrases it has
   * quietly stopped complying.
   */
  attribution: z.string().min(1),
  /**
   * Whether publishing a derived database triggers a reciprocal-licence
   * obligation. True for ODbL, and the reason `docs/osm-database-boundary.md`
   * exists.
   */
  shareAlike: z.boolean(),
  /** Which parts of the artifact came under it: `places`, `routing`, `weather`. */
  appliesTo: z.array(z.string().min(1)).default([]),
});
export type DataLicence = z.infer<typeof dataLicenceSchema>;

export const LICENCES: Record<LicenceId, Omit<DataLicence, 'appliesTo'>> = {
  'ODbL-1.0': {
    id: 'ODbL-1.0',
    name: 'Open Database License 1.0',
    url: 'https://opendatacommons.org/licenses/odbl/1-0/',
    attribution: '© OpenStreetMap contributors',
    shareAlike: true,
  },
  'CC-BY-4.0': {
    id: 'CC-BY-4.0',
    name: 'Creative Commons Attribution 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Weather data by Open-Meteo.com',
    shareAlike: false,
  },
  'CDLA-Permissive-2.0': {
    id: 'CDLA-Permissive-2.0',
    name: 'Community Data License Agreement — Permissive 2.0',
    url: 'https://cdla.dev/permissive-2-0/',
    /**
     * CDLA-2.0 mandates carrying the licence text, not a credit line. Overture
     * asks for this wording, and a product that shows where its data came from
     * is a better product than one that has worked out it need not.
     */
    attribution: 'Place data © Overture Maps Foundation, overturemaps.org',
    shareAlike: false,
  },
  'Apache-2.0': {
    id: 'Apache-2.0',
    name: 'Apache License 2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
    attribution: 'Copyright 2024 Foursquare Labs, Inc., via Overture Maps Foundation',
    shareAlike: false,
  },
  'CC0-1.0': {
    id: 'CC0-1.0',
    name: 'Creative Commons Zero 1.0',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: 'Public-domain place records via Overture Maps Foundation',
    shareAlike: false,
  },
  'official-source': {
    id: 'official-source',
    name: 'Published by the managing authority',
    attribution: 'Facts read from the operators’ own published information',
    shareAlike: false,
  },
  'sidequest-authored': {
    id: 'sidequest-authored',
    name: 'Written by Sidequest',
    attribution: 'Descriptions and scoring by Sidequest',
    shareAlike: false,
  },
};

export function licence(id: LicenceId, appliesTo: string[] = []): DataLicence {
  return { ...LICENCES[id], appliesTo };
}

/**
 * The attribution lines an artifact obliges us to show, deduplicated and ordered.
 *
 * Ordered with share-alike licences first, because those are the ones with a
 * legal consequence for getting it wrong, and a UI that truncates a list should
 * truncate the optional end of it.
 */
export function requiredAttributions(licences: readonly DataLicence[]): string[] {
  const seen = new Set<string>();
  const ordered = [...licences].sort((a, b) => Number(b.shareAlike) - Number(a.shareAlike));
  const lines: string[] = [];
  for (const entry of ordered) {
    if (seen.has(entry.attribution)) continue;
    seen.add(entry.attribution);
    lines.push(entry.attribution);
  }
  return lines;
}

/** True when anything in the artifact carries a reciprocal obligation. */
export function hasShareAlikeObligation(licences: readonly DataLicence[]): boolean {
  return licences.some((entry) => entry.shareAlike);
}

/**
 * A reference back into the source database.
 *
 * Kept because ODbL attribution is only meaningful if a reader can get back to
 * the original — and because a normalized record that cannot be traced to the
 * element it came from is one nobody can correct upstream. The timestamp is the
 * source's own, not ours: it is how a later run notices the element changed.
 */
export const sourceElementSchema = z.object({
  /** `node/240109189`, `way/27784372`. The source's own identifier. */
  elementId: z.string().min(1),
  /** Which database: `openstreetmap`, `nominatim`. */
  database: z.string().min(1),
  licenceId: licenceIdSchema,
  /** The element's own last-modified time where the source publishes one. */
  sourceTimestamp: z.string().min(1).optional(),
  /** A link a reader can follow to the original element. */
  url: httpUrlSchema.optional(),
});
export type SourceElement = z.infer<typeof sourceElementSchema>;
