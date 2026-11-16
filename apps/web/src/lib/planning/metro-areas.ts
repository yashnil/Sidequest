import type { SemanticPart } from '@sidequest/core';

const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Centres of the destination's named parts that are cities, where a short
 * car-free hop may be the metro (final pass: "Tokyo and Kyoto by train").
 *
 * Audit pass — only parts the traveller's own phrase named. An interpreter's
 * representative areas are towns it picked to describe a region (and they are
 * stored as geocoder rows once placed), not cities the traveller is going to:
 * a live "Cyclades island hopping" plan took Naxos and Mykonos as metro areas
 * and printed "Train to Halki Village" on an island with neither. A part
 * counts when its name is one of the phrase's own parts.
 */
export function metroAreaCentres(parts: readonly Pick<SemanticPart, 'label' | 'center' | 'featureType' | 'source'>[], phraseParts: readonly string[]): { lat: number; lng: number }[] {
  const named = new Set(phraseParts.map(fold).filter(Boolean));
  return parts
    .filter((part) => part.center && part.source !== 'interpretation' && (part.featureType === 'city' || part.featureType === 'metro_area' || part.featureType === 'municipality'))
    .filter((part) => named.has(fold(part.label)))
    .map((part) => part.center);
}
