import { uncoveredPlaceIds } from '../access/provider';
import { placesWithoutOperatingCalendar } from '../hours/provider';
import { placeCollectionSchema, type Place } from '../schemas/place';
import { EASTERN_SIERRA_ACCESS } from './access';
import { EASTERN_SIERRA_HOURS } from './hours';
import { EASTERN_SIERRA_PLACES } from './places';
import { EASTERN_SIERRA, REGIONS, resolveRegion } from './regions';

export * from './access';
export * from './hours';
export { EASTERN_SIERRA, EASTERN_SIERRA_PLACES, REGIONS, resolveRegion };

export function placeById(id: string): Place | undefined {
  return EASTERN_SIERRA_PLACES.find((place) => place.id === id);
}

/** Parses the seed data through the schema. Used by tests to catch drift. */
export function validateSeedData(): Place[] {
  return placeCollectionSchema.parse(EASTERN_SIERRA_PLACES);
}

/**
 * Places with no access rule. Must always be empty: a place the access data says
 * nothing about is a place the planner will refuse to schedule, and adding one
 * without a rule should fail a test rather than quietly disappear from boards.
 */
export function placesWithoutAccessRules(): string[] {
  return uncoveredPlaceIds(
    EASTERN_SIERRA_ACCESS,
    EASTERN_SIERRA_PLACES.map((place) => place.id),
  );
}

/**
 * Places with no operating calendar. Must always be empty, for the same reason
 * and with a sharper edge: a place with no hours record is one the planner would
 * otherwise have to guess about, and the guess it would make — "open whenever
 * you like" — is the one that puts someone at a locked door.
 */
export function placesWithoutOperatingHours(): string[] {
  return placesWithoutOperatingCalendar(
    EASTERN_SIERRA_HOURS,
    EASTERN_SIERRA_PLACES.map((place) => place.id),
  );
}
