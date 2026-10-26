import { catalogDestinationSchema, type CatalogDestination } from './schema';
import { AFRICA_MIDDLE_EAST } from './regions/africa-middle-east';
import { ASIA } from './regions/asia';
import { EUROPE } from './regions/europe';
import { NORTH_AMERICA } from './regions/north-america';
import { SOUTH_AMERICA_OCEANIA } from './regions/south-america-oceania';

export * from './schema';

/**
 * The catalog, parsed once.
 *
 * Parsed rather than cast, so a malformed entry fails the first import (and the
 * catalog test) instead of reaching a traveller as a NaN. Order carries no
 * meaning: nothing downstream may read position as preference.
 */
let parsed: readonly CatalogDestination[] | null = null;

export function destinationCatalog(): readonly CatalogDestination[] {
  if (parsed) return parsed;
  const raw = [...EUROPE, ...NORTH_AMERICA, ...SOUTH_AMERICA_OCEANIA, ...AFRICA_MIDDLE_EAST, ...ASIA];
  parsed = Object.freeze(raw.map((entry) => catalogDestinationSchema.parse(entry)));
  return parsed;
}

export function catalogDestinationById(id: string): CatalogDestination | null {
  return destinationCatalog().find((entry) => entry.id === id) ?? null;
}

/** The catalog's own version, stamped on every shortlist built from it. */
export const DESTINATION_CATALOG_VERSION = '2026-10.1';
