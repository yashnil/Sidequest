import 'server-only';
import {
  candidatesFromIndexEntry,
  resolveDisplayName,
  type DisplayName,
  type NameCandidate,
} from '@sidequest/core';
import { entriesInCountry } from '../db/destination-index-repository';
import type { DestinationIndexEntry } from '@sidequest/core';
import { straightLineKm } from '@sidequest/core';

/**
 * TURNING SOURCE RECORDS INTO NAME CANDIDATES.
 *
 * The adapter half of the display-name fix. `@sidequest/core` decides *which*
 * name wins and can be tested without a network; this decides *what to offer
 * it*, from the records each provider actually returns.
 *
 * Nothing here translates. Every candidate is a string a source published —
 * an OSM `name:en` tag, an Overture common name, a destination-index alias.
 */

/**
 * OSM name tags that carry a language, and the ones that do not.
 *
 * `name:xx` is the tagged form. `int_name` and `official_name` are untagged but
 * real names, so they are offered without a language rather than dropped —
 * the resolver treats an untagged name as "not asserted to be English", which
 * is the honest reading.
 */
const UNTAGGED_KEYS = new Set(['name', 'int_name', 'official_name', 'alt_name', 'short_name']);

export function candidatesFromNominatim(place: {
  name?: string;
  namedetails?: Record<string, string>;
}): NameCandidate[] {
  const candidates: NameCandidate[] = [];
  const details = place.namedetails ?? {};

  for (const [key, value] of Object.entries(details)) {
    if (typeof value !== 'string' || value.length === 0) continue;

    if (key === 'name') {
      candidates.push({ value, source: 'openstreetmap', primary: true });
      continue;
    }
    if (key.startsWith('name:')) {
      const language = key.slice('name:'.length);
      /*
       * A tag with no language after the colon is malformed, not English. OSM
       * data is user-edited and `name:` appears in the wild.
       */
      if (language.length === 0) continue;
      candidates.push({ value, source: 'openstreetmap', language });
      continue;
    }
    if (UNTAGGED_KEYS.has(key)) {
      candidates.push({ value, source: 'openstreetmap' });
    }
  }

  if (place.name && !candidates.some((candidate) => candidate.primary)) {
    candidates.push({ value: place.name, source: 'openstreetmap', primary: true });
  }
  return candidates;
}

/**
 * How near an indexed feature has to be to be the same place.
 *
 * Five kilometres. A geocoded town centre and the same town's indexed division
 * point disagree by hundreds of metres routinely and by a couple of kilometres
 * occasionally; anything beyond this is a *different* settlement, and borrowing
 * its English name would rename the base to its neighbour.
 */
const SAME_PLACE_KM = 5;

/**
 * The destination index's own names for a coordinate, when it holds that place.
 *
 * This is where a base inherits the English-first resolution the index already
 * performed at build time. It is a **local table read** — no geocoder, no model,
 * no network — which is what makes it affordable to do for every base.
 *
 * Matching is by proximity *and* country, never by name: matching on name would
 * be circular, since the local name is exactly what we are trying to improve on.
 */
export function candidatesFromIndex(input: {
  coordinates: { lat: number; lng: number };
  countryCode?: string;
}): NameCandidate[] {
  if (!input.countryCode) return [];

  let nearest: { entry: DestinationIndexEntry; km: number } | null = null;
  try {
    for (const entry of entriesInCountry(input.countryCode, ['city', 'town', 'county', 'region', 'district'], 400)) {
      const km = straightLineKm(input.coordinates, entry.center);
      if (km > SAME_PLACE_KM) continue;
      /* Ties break on id so the borrowed name is reproducible. */
      if (!nearest || km < nearest.km || (km === nearest.km && entry.id < nearest.entry.id)) {
        nearest = { entry, km };
      }
    }
  } catch {
    /*
     * No index on this deployment is a normal state, not an error: the base
     * keeps whatever the geocoder called it, which is exactly the behaviour
     * before this existed.
     */
    return [];
  }

  return nearest ? candidatesFromIndexEntry(nearest.entry) : [];
}

/**
 * The resolved name for a geographic entity, from every source available.
 *
 * Order is irrelevant — the resolver ranks by language and provenance, not by
 * position — but both sources are offered so that a place present in neither
 * still falls back to what the geocoder said.
 */
export function resolveEntityName(input: {
  fallback: string;
  coordinates: { lat: number; lng: number };
  countryCode?: string;
  place?: { name?: string; namedetails?: Record<string, string> };
}): DisplayName {
  return resolveDisplayName({
    candidates: [
      ...(input.place ? candidatesFromNominatim(input.place) : []),
      ...candidatesFromIndex({
        coordinates: input.coordinates,
        ...(input.countryCode ? { countryCode: input.countryCode } : {}),
      }),
    ],
    fallback: input.fallback,
  });
}
