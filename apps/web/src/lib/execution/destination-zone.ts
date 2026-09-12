import 'server-only';
import { getIntent } from '@/lib/db/compiler-repository';

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
  const intent = getIntent(tripId);
  if (!intent) return undefined;
  const candidate = intent.resolution?.candidates.find((c) => c.id === (intent.selectedCandidateId ?? intent.resolution?.unambiguousCandidateId)) ?? intent.resolution?.candidates[0] ?? null;
  return candidate?.timeZones?.[0];
}
