import tzLookup from '@photostructure/tz-lookup';

import { isCivilTimeZone, isKnownTimeZone, zoneFitsLongitude, type ZoneResolver } from './zone';

export type { ZoneResolver };

/**
 * THE CLOCK AT A POINT, READ FROM THE ZONE BOUNDARIES.
 *
 * Eval v3 found a destination's zone taken from its country's default — the
 * United States' is New York — and applied to Kauai, which put a sunset at
 * midnight. `zoneFitsLongitude` was the guard: a zone that cannot be this
 * point's clock made the sky unknown. This is the fix the guard was waiting
 * for: an offline lookup against the published IANA zone boundaries
 * (`@photostructure/tz-lookup`, CC0, no network, no clock), so whenever a
 * coordinate exists, the coordinate decides the zone and a geocoder's or a
 * country's default is only a fallback.
 *
 * Answers:
 * - a civil IANA zone the runtime can reason about (validated through `Intl`,
 *   because a lookup table newer than the runtime's tzdata could name a zone
 *   this process would throw on);
 * - `null` for an invalid coordinate, a lookup failure, a zone the runtime does
 *   not know, and **open ocean**. Over international waters the table answers
 *   a nautical `Etc/GMT±N`, which is a fixed offset rather than anybody's civil
 *   clock; returning it would let a caller treat it as resolved. A caller that
 *   gets `null` keeps its own fallback chain, whose last step
 *   (`deriveTimeZoneFromLongitude`) produces the same solar offset, labelled
 *   as derived.
 *
 * Kept out of the package root (`@sidequest/core/zone-lookup`) on purpose: the
 * boundary table is ~88 KB, and the root is imported by client components that
 * never need it. Core code that needs a point's zone takes a resolver instead.
 */
export function zoneAt(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  let zone: string;
  try {
    zone = tzLookup(lat, lng);
  } catch {
    return null;
  }
  if (typeof zone !== 'string' || zone.startsWith('Etc/')) return null;
  return isKnownTimeZone(zone) ? zone : null;
}

/** `zoneAt` over an optional point: the shape most callers hold. */
export function zoneAtPoint(point: { lat: number; lng: number } | null | undefined): string | null {
  if (!point || (point.lat === 0 && point.lng === 0)) return null;
  return zoneAt(point.lat, point.lng);
}

/**
 * A PLACE'S ZONE, WITH THE COORDINATE AS THE AUTHORITY.
 *
 * The one ordering every "what clock is this destination on" site uses:
 *
 *   1. the zone at the place's centre, from the boundaries;
 *   2. the zone a source carried (a geocoder row, a country's reference zone),
 *      only when it is a civil zone the runtime knows and — when there is a
 *      centre at all — fits the centre's longitude (`zoneFitsLongitude`, the
 *      last-resort sanity check: New York on Kauai is refused);
 *   3. `null`, so the caller's own last resort (solar time, labelled) applies.
 *
 * A whole country is the one exception, and it is structural rather than by
 * name: a country's centroid is not anywhere anybody stays (the middle of a
 * continent-wide country can sit in a zone few of its travellers use), so for
 * `wholeCountry` a published civil zone is kept ahead of the centroid lookup.
 * Every base and stop inside it is still resolved from its own coordinates.
 */
export function zoneForPlace(input: {
  center?: { lat: number; lng: number } | null;
  published?: string | null;
  wholeCountry?: boolean;
}): string | null {
  const center = input.center && !(input.center.lat === 0 && input.center.lng === 0) ? input.center : null;
  const published = input.published && isCivilTimeZone(input.published) && isKnownTimeZone(input.published) ? input.published : null;
  if (input.wholeCountry && published) return published;
  const located = zoneAtPoint(center);
  if (located) return located;
  if (!published) return null;
  return !center || zoneFitsLongitude(published, center.lng) ? published : null;
}
