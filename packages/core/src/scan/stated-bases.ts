import { sameStatedPlace } from '../contract/stated-itinerary';
import type { ScanBaseProposal, ScanProposal } from './proposal';

/**
 * MODE 3 — EVERY STAY THE TRAVELLER NAMED IS A PROPOSED BASE, IN THEIR ORDER.
 *
 * The scan's one model call is told the stated stays and asked to propose them
 * as bases, but a proposal is evidence, not a promise: a fixture, the open-data
 * fallback or a model that renamed "Kyoto" to "Higashiyama" may not have. So
 * after the proposal, each stated stay is matched to a proposed base by name
 * (`sameStatedPlace`: the same words after folding, or one containing the
 * other) and, when none matches, added as a base under the traveller's own
 * label — placed afterwards by the same geocoder as every other base. The
 * stated bases lead the list in the stated order, so the six-base search
 * window always includes them. Nothing here knows any place by name.
 */
export function withStatedBases(
  proposal: ScanProposal,
  stays: readonly { label: string; nights: number; fixed?: boolean }[],
): { proposal: ScanProposal; keys: string[] } {
  if (stays.length === 0) return { proposal, keys: [] };
  const remaining = [...proposal.bases];
  const leading: ScanBaseProposal[] = [];
  const keys: string[] = [];
  const taken = new Set(proposal.bases.map((b) => b.key));
  for (const [i, stay] of stays.entries()) {
    const already = leading.find((b) => sameStatedPlace(stay.label, b.name));
    if (already) {
      keys.push(already.key);
      continue;
    }
    const at = remaining.findIndex((b) => sameStatedPlace(stay.label, b.name) || sameStatedPlace(stay.label, b.locality));
    if (at >= 0) {
      const [base] = remaining.splice(at, 1);
      leading.push({ ...base!, nightsHint: stay.nights });
      keys.push(base!.key);
      continue;
    }
    let key = `stated${i + 1}`;
    while (taken.has(key)) key = `${key}x`;
    taken.add(key);
    leading.push({ key, name: stay.label, locality: stay.label, nightsHint: stay.nights, why: stay.fixed ? 'A stay you have already booked.' : 'A stay in your own plan.' });
    keys.push(key);
  }
  return { proposal: { ...proposal, bases: [...leading, ...remaining] }, keys };
}
