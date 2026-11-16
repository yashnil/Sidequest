import type { SemanticPart } from '@sidequest/core';

/**
 * Centres of the destination's named parts that are cities, where a short
 * car-free hop may be the metro (final pass: "Tokyo and Kyoto by train").
 *
 * Audit pass — only parts the traveller's phrase named. An interpreter's
 * representative areas are towns it picked to describe a region, not cities
 * the traveller is going to: a live Cyclades plan took Fira and Naxos Town as
 * metro areas and printed "Train to Plaka Beach" on an island with neither.
 */
export function metroAreaCentres(parts: readonly Pick<SemanticPart, 'center' | 'featureType' | 'source'>[]): { lat: number; lng: number }[] {
  return parts
    .filter((part) => part.center && part.source !== 'interpretation' && (part.featureType === 'city' || part.featureType === 'metro_area' || part.featureType === 'municipality'))
    .map((part) => part.center);
}
