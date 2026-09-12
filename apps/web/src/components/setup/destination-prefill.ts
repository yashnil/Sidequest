/**
 * V8 — ARRIVING AT /trips/new WITH A DESTINATION ALREADY IN HAND.
 *
 * The home page links its example prompts to `/trips/new?destination=<text>`.
 * What arrives is treated exactly as typed text would be: it fills the field,
 * it is placed the same way the traveller's own words are placed, and it is
 * never a gate — a value nothing can place still starts a trip.
 *
 * Pure, so the parsing has a unit test and the page stays a thin reader of
 * `searchParams`.
 */

/** The most anybody can reasonably have typed into a destination field. */
const MAX_PREFILL = 120;

export function destinationPrefillFrom(params: Record<string, string | string[] | undefined>): string | null {
  const raw = params.destination;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim().slice(0, MAX_PREFILL);
  return trimmed.length >= 2 ? trimmed : null;
}

/**
 * THE GEOGRAPHIC SCOPE, IN HUMAN WORDS — ONLY WHEN THERE ARE ANY.
 *
 * A placement answers with the kind of thing it found (`country`, `city`,
 * `national_park`…) in the source's own vocabulary. That vocabulary never
 * reaches a traveller: a handful of kinds map to a phrase a person would say,
 * and every other kind says nothing rather than something machine-shaped.
 * `municipality` is "A city and its region" (V7: an entity type in its own
 * right, urban). Nothing here is a claim about size or about what the trip
 * should cover.
 */
const SCOPE_WORDS: Record<string, string> = {
  country: 'A whole country',
  dependency: 'A territory',
  municipality: 'A city and its region',
  metro_area: 'A city and its region',
  city: 'A city',
  town: 'A town',
  region: 'A region',
  state: 'A region',
  county: 'A region',
  island: 'An island',
  archipelago: 'A group of islands',
  national_park: 'A national park',
  protected_area: 'A protected area',
  /* V8.1 — the semantic reading's own vocabulary, when the gate produced one. */
  natural_region: 'A natural region',
  mountain_region: 'A mountain region',
  coast: 'A coast',
  island_group: 'A group of islands',
  informal_region: 'A travel region',
  admin_area: 'A region',
  settlement: 'A city or town',
  city_region: 'A city and its region',
  multi_country: 'Several countries',
  composite: 'Several areas in one trip',
};

export function scopeWords(featureType: string | null | undefined): string | null {
  if (!featureType) return null;
  return SCOPE_WORDS[featureType.toLowerCase()] ?? null;
}
