import 'server-only';
import { loadWaterIndex } from '@sidequest/atlas';
import { COAST_SNAP_KM } from '@sidequest/core';

/**
 * Audit pass (2026-11) — A COUNTRY'S RAILWAY DOES NOT REACH ITS SMALL ISLANDS.
 *
 * Whether a train runs is read from the country's facts and the ISO 3166-2
 * rows that may remove it (`reality/networks.ts`). Those rows name a handful of
 * island regions, and a live Cyclades plan printed "≈55 min train" on Naxos
 * because Greece runs trains on its mainland. The land index knows what the
 * rows do not: when both ends of a leg stand on one landmass smaller than this,
 * an intercity train between them is not a fact anybody checked, so it is not
 * claimed. Metro is untouched (a city-state keeps its metro), and so are large
 * islands, which the rows still decide. Unknown ≠ false: with no index, or an
 * end that cannot be placed, nothing changes.
 */
export const SMALL_ISLAND_KM2 = 1000;

type Point = { lat: number; lng: number } | null | undefined;

export function onSmallIsland(points: readonly Point[]): boolean {
  const index = loadWaterIndex();
  if (!index || points.length === 0) return false;
  let shared: number | null = null;
  for (const point of points) {
    if (!point) return false;
    const id = index.land.nearest(point, COAST_SNAP_KM);
    if (!id) return false;
    if (shared === null) shared = id;
    else if (shared !== id) return false;
  }
  const area = shared === null ? 0 : index.land.areaKm2(shared);
  return area > 0 && area < SMALL_ISLAND_KM2;
}
