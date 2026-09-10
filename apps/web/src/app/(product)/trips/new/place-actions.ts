'use server';

import { countryFromText, foldForMatch, sanitizePlaceText, type DestinationIndexEntry } from '@sidequest/core';
import { entriesByPrefix } from '@/lib/db/destination-index-repository';
import { verificationProviders } from '@/lib/planning/verification-providers';
import { guardAction } from '@/lib/net/caller';

/**
 * WHERE THE TYPED WORDS ARE, BEFORE ANY TRIP EXISTS.
 *
 * STAGING PARITY §1, §4. The defect this closes, stated as a class: the setup
 * flow's map and its "tell me when it is best" both needed a *coordinate*, and
 * the only thing that could produce one was the traveller picking a row out of
 * the local destination index. A deployment whose database has no index — which
 * is every fresh deployment, because the index is built by an offline scan —
 * therefore had no coordinate for anything anybody typed. "Japan" became the
 * empty-world map captioned ANYWHERE, and the seasons screen said the
 * destination could not be placed. Neither statement was true, and neither had
 * asked anybody.
 *
 * It was invisible in development for the obvious reason: the development
 * database has an index, so a pick was always available.
 *
 * The hierarchy below is the fix, and its order is the point:
 *
 * 1. **The local index**, when this deployment has one. It carries a published
 *    centre *and* extent, which is the best answer available and costs nothing.
 * 2. **The bundled country reference.** Offline, instant, and enough to place any
 *    country the app already ships facts for — including inside a phrase, so
 *    "rural Japan" places without "Japan" being a case in the code.
 * 3. **The configured geocoder.** For everything a country name cannot answer: a
 *    city, a region, a national park, a delta. One round trip, behind the fence
 *    that already exists for exactly this call, and never while somebody is
 *    typing — the geocoder's own policy forbids autocomplete and so does
 *    `api/destinations/suggest`.
 * 4. **Unresolved**, said plainly, blocking nothing.
 *
 * What this deliberately does not do is decide anything. It answers "where is
 * this", and every consequence — what the map frames, what the climate lookup
 * reads, what the traveller is told — belongs to the caller.
 */

export interface PlacedDestination {
  /** What the traveller typed, kept as their words. */
  query: string;
  /** The name of the thing that was found, which may be more specific than the query. */
  name: string;
  center: { lat: number; lng: number };
  bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } | null;
  /** `country`, `city`, `region`… as the source published it. Drives how wide the map frames. */
  featureType?: string;
  countryCode?: string;
  /** Which tier answered. Never rendered as-is; the UI decides what to say about certainty. */
  source: 'index' | 'reference' | 'geocoder';
  /** The populated place a country-scale coordinate names, so a climate answer can say where it was read. */
  referencePoint?: string;
}

export type PlaceResult =
  | { ok: true; placed: PlacedDestination }
  | { ok: true; placed: null; reason: 'too_short' | 'unresolved' | 'no_resolver' | 'provider_failed' | 'rate_limited' };

/** Long enough to be a name rather than a keystroke, short enough not to be a paragraph. */
const MAX_QUERY = 120;

export async function placeDestinationAction(raw: { text: string }): Promise<PlaceResult> {
  const query = sanitizePlaceText(String(raw?.text ?? '')).slice(0, MAX_QUERY).trim();
  const folded = foldForMatch(query);
  if (folded.length < 2) return { ok: true, placed: null, reason: 'too_short' };

  /* 1 — the local index, when this deployment built one. Free, offline, and carries an extent. */
  const indexed = confidentIndexHit(folded);
  if (indexed) {
    return {
      ok: true,
      placed: {
        query,
        name: indexed.displayName,
        center: indexed.center,
        bounds: indexed.bounds ?? null,
        ...(indexed.featureType ? { featureType: indexed.featureType } : {}),
        ...(indexed.countryCode ? { countryCode: indexed.countryCode } : {}),
        source: 'index',
      },
    };
  }

  /* 2 — the bundled country reference. No network, no database, no failure mode. */
  const country = countryFromText(query);
  if (country) {
    return {
      ok: true,
      placed: {
        query,
        name: country.how === 'name' ? country.facts.name : query,
        center: { lat: country.point.lat, lng: country.point.lng },
        bounds: null,
        featureType: 'country',
        countryCode: country.facts.code,
        source: 'reference',
        referencePoint: country.point.place,
      },
    };
  }

  /* 3 — the configured geocoder, once, behind the fence that exists for it. */
  const { resolver } = verificationProviders();
  if (!resolver) return { ok: true, placed: null, reason: 'no_resolver' };

  const limited = await guardAction('destination_resolve');
  if (limited) return { ok: true, placed: null, reason: 'rate_limited' };

  try {
    const resolution = await resolver.resolve({ query, now: new Date() });
    const candidate = resolution.candidates[0];
    if (!candidate) return { ok: true, placed: null, reason: 'unresolved' };
    return {
      ok: true,
      placed: {
        query,
        name: candidate.displayName,
        center: candidate.center,
        bounds: candidate.bounds ?? null,
        featureType: candidate.entityType,
        ...(candidate.countryCode ? { countryCode: candidate.countryCode } : {}),
        source: 'geocoder',
      },
    };
  } catch (error) {
    /*
     * A provider that failed is not a place that does not exist (§5). The caller
     * gets "not placed", never "not there", and the traveller's answer stands.
     */
    console.warn('A typed destination could not be placed', { reason: error instanceof Error ? error.name : 'unknown' });
    return { ok: true, placed: null, reason: 'provider_failed' };
  }
}

/**
 * The index row this text is unambiguously about, or nothing.
 *
 * Deliberately stricter than the dropdown. The dropdown offers a ranked list for
 * a person to choose from; this has to choose *for* them, so it accepts only an
 * exact folded name match, and only when one row has it. Anything less certain
 * falls through to a tier that cannot be wrong about identity.
 */
function confidentIndexHit(folded: string): DestinationIndexEntry | null {
  let rows: DestinationIndexEntry[];
  try {
    rows = entriesByPrefix(folded, 40);
  } catch {
    return null;
  }
  const exact = rows.filter((row) => foldForMatch(row.displayName) === folded || row.aliases.some((alias) => foldForMatch(alias) === folded));
  if (exact.length === 0) return null;
  /* Ties are broken by prominence, which is what the dropdown would have shown first. */
  const best = [...exact].sort((a, b) => (b.prominence ?? 0) - (a.prominence ?? 0));
  const leader = best[0]!;
  if (best.length > 1 && (best[1]!.prominence ?? 0) === (leader.prominence ?? 0)) return null;
  return leader;
}
