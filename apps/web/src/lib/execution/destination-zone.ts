import 'server-only';
import { isCivilTimeZone } from '@sidequest/core';
import { zoneForPlace } from '@sidequest/core/zone-lookup';
import { getIntent, type TripIntentRecord } from '@/lib/db/compiler-repository';

/**
 * V9 — THE DESTINATION'S OWN TIME ZONE, WHEN NO COMPILED BASE CARRIES ONE.
 *
 * A trip planned without a compiled region (every live V7+ build) has no
 * per-base zone on the artifact, and a zone derived from longitude alone is
 * solar time — Iceland at −20° reads as UTC−1 when its clocks say UTC. The
 * resolved destination already knows its civil zone, so it is asked first;
 * longitude stays the last resort. A pure database read.
 */
export function destinationTimeZone(tripId: string): string | undefined {
  return destinationTimeZoneOf(getIntent(tripId));
}

/**
 * V9.1 §9 — THE SAME ANSWER, AS A PURE FUNCTION OF THE INTENT RECORD.
 *
 * What the intent knows, in order: the candidate the traveller chose (or the
 * one the resolver found unambiguous, or the first), then the resolved parts
 * of the intent graph — a region typed as "Bariloche and El Calafate" has a
 * zone on each part even when no single candidate was selected. Only a civil
 * zone counts: a fixed offset a source happened to return is not the
 * destination's clock, and returning it here would let solar time in
 * through the front door.
 *
 * For each, the zone at its centre from the IANA boundaries (`zoneAtPoint`)
 * outranks the zone the source carried: a geocoder's or a country's default
 * (the United States' is New York) is only a fallback, and it must still fit
 * the centre's longitude when there is a centre at all.
 */
export function destinationTimeZoneOf(intent: TripIntentRecord | null): string | undefined {
  if (!intent) return undefined;
  const civilAt = (zone: string | undefined, center: { lat: number; lng: number } | undefined, wholeCountry = false): string | undefined => {
    const found = zoneForPlace({ center: center ?? null, published: zone ?? null, wholeCountry });
    return found && isCivilTimeZone(found) ? found : undefined;
  };
  const resolution = intent.resolution;
  const chosenId = intent.selectedCandidateId ?? resolution?.unambiguousCandidateId;
  const candidate = resolution?.candidates.find((c) => c.id === chosenId) ?? resolution?.candidates[0] ?? null;
  const fromCandidate = candidate ? civilAt(candidate.timeZones?.[0], candidate.center, candidate.breadth === 'country') : undefined;
  if (fromCandidate) return fromCandidate;
  for (const part of intent.destinationIntent?.graph?.children ?? []) {
    const fromPart = civilAt(part.resolution?.timeZone, part.resolution?.center, part.resolution?.featureType === 'country');
    if (fromPart) return fromPart;
  }
  return undefined;
}
