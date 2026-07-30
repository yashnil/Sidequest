import { placeCollectionSchema, type Place } from '../schemas/place';
import { EASTERN_SIERRA_PLACES } from './places';
import { EASTERN_SIERRA, REGIONS, resolveRegion } from './regions';

export { EASTERN_SIERRA, EASTERN_SIERRA_PLACES, REGIONS, resolveRegion };

export function placeById(id: string): Place | undefined {
  return EASTERN_SIERRA_PLACES.find((place) => place.id === id);
}

/** Parses the seed data through the schema. Used by tests to catch drift. */
export function validateSeedData(): Place[] {
  return placeCollectionSchema.parse(EASTERN_SIERRA_PLACES);
}
