import type { PlaceCategory } from '../schemas/common';

/**
 * WHAT A DEFICIT-DIRECTED SEARCH CAN ACTUALLY ASK FOR.
 *
 * A small, closed vocabulary that both ends of the acquisition seam understand:
 * the compiler names what the board is short of, and a provider decides how to
 * go and look for it. It is deliberately coarser than the interest vocabulary —
 * a source's tags do not distinguish a shrine from a castle in a way any single
 * query can exploit, and asking for six near-synonyms produces six requests and
 * one answer.
 */
export const ACQUISITION_INTENTS = [
  'culture',
  'landmark',
  'nature',
  'market',
  'meal',
  'provisioning',
] as const;
export type AcquisitionIntent = (typeof ACQUISITION_INTENTS)[number];

/**
 * Which intent would go looking for more of this kind of place.
 *
 * Shared so a provider answering an acquisition can decide what it already
 * holds against the same vocabulary the request was written in. Without this the
 * two ends agree only by coincidence, and a second look silently returns
 * everything or nothing.
 */
const INTENT_BY_CATEGORY: Record<PlaceCategory, AcquisitionIntent> = {
  viewpoint: 'landmark',
  gondola_or_tram: 'landmark',
  national_monument: 'culture',
  museum: 'culture',
  historic_site: 'culture',
  town_and_food: 'market',
  lake: 'nature',
  easy_walk: 'nature',
  day_hike: 'nature',
  wildlife_area: 'nature',
  geothermal: 'nature',
  hot_spring: 'nature',
  scenic_drive: 'landmark',
};

export function acquisitionIntentForCategory(category: PlaceCategory): AcquisitionIntent {
  return INTENT_BY_CATEGORY[category];
}

/** True when a place of this category is the sort of thing these intents wanted. */
export function matchesAcquisitionIntent(
  category: PlaceCategory,
  intents: readonly string[],
): boolean {
  return intents.includes(acquisitionIntentForCategory(category));
}
