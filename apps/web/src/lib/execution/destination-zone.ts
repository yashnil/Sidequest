import 'server-only';
import { isCivilTimeZone } from '@sidequest/core';
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
 */
export function destinationTimeZoneOf(intent: TripIntentRecord | null): string | undefined {
  if (!intent) return undefined;
  const civil = (zone: string | undefined): string | undefined => (zone && isCivilTimeZone(zone) ? zone : undefined);
  const resolution = intent.resolution;
  const chosenId = intent.selectedCandidateId ?? resolution?.unambiguousCandidateId;
  const candidate = resolution?.candidates.find((c) => c.id === chosenId) ?? resolution?.candidates[0] ?? null;
  const fromCandidate = civil(candidate?.timeZones?.[0]);
  if (fromCandidate) return fromCandidate;
  for (const part of intent.destinationIntent?.graph?.children ?? []) {
    const fromPart = civil(part.resolution?.timeZone);
    if (fromPart) return fromPart;
  }
  return undefined;
}
