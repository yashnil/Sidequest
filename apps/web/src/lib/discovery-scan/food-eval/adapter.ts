import type { FoodDataset, ItineraryDay, ScanPoint, TravelerProfile } from '@sidequest/core';
import { nameVenuesForDay } from '../../planning/reconcile';
import type { OverpassResult } from '../../providers/overpass';
import { chainKey, markChainsFromBox, overtureFoodRow, type OvertureFoodBoxResult, type OvertureFoodRow } from '../../providers/overture-food';
import type { BoundingBox } from '../../providers/overture/scan';
import { groundScanFood, type ScanFoodGrounding } from '../food';
import { asOverpassElement, asOvertureRow, overpassAnswer, recordedBoxFor, type RecordedFoodFixture } from './replay';

/**
 * FOOD EVALUATION — THE ONLY FILE THAT TOUCHES THE PRODUCT.
 *
 * The harness (`eval.ts`) measures outputs; this adapter is where the recorded
 * world is fed into the product's own functions — the scan's food step and the
 * meal-naming step — exactly as the live readers would feed them. When the
 * product's seams move, this file moves with them and the measurements do not.
 */

const noCache = { read: () => null, write: () => undefined };

/** What the live Overture reader does with one box's rows, on recorded rows. */
function replayOvertureBox(fixture: RecordedFoodFixture, box: BoundingBox): OvertureFoodBoxResult | null {
  const recorded = recordedBoxFor(fixture, box);
  if (!recorded?.overture) return null;
  const brandedKeys = new Set<string>(recorded.overture.brandedKeys);
  const seenKeys = new Map<string, number>();
  const rows: OvertureFoodRow[] = [];
  for (const raw of recorded.overture.rows) {
    const key = chainKey(raw.name);
    if (key && (raw.brand || raw.brandWikidata)) brandedKeys.add(key);
    if (key) seenKeys.set(key, (seenKeys.get(key) ?? 0) + 1);
    const row = overtureFoodRow(asOvertureRow(raw));
    if (row) rows.push(row);
  }
  return { rows: markChainsFromBox(rows, brandedKeys, seenKeys), bytes: 0, ms: 0, cacheHit: false };
}

/** The meal selector group the scan asks Overpass for (`fetchMealPois`). */
const MEAL_AMENITIES = new Set(['restaurant', 'cafe', 'fast_food', 'food_court', 'pub', 'bar']);

function replayOverpassBox(fixture: RecordedFoodFixture, box: BoundingBox): OverpassResult {
  const recorded = recordedBoxFor(fixture, box);
  // Nobody answered for this box when it was recorded: the same absence now.
  if (!recorded?.osm) throw new Error('Overpass did not answer for this box when the fixture was recorded.');
  return overpassAnswer(recorded.osm.filter((element) => MEAL_AMENITIES.has(element.tags.amenity ?? '')).map(asOverpassElement));
}

export async function groundFromFixture(input: {
  fixture: RecordedFoodFixture;
  regionId: string;
  destinationName: string;
  countryCode: string;
  points: readonly ScanPoint[];
  today: string;
}): Promise<ScanFoodGrounding> {
  const center = input.points[0]!.coordinates;
  return groundScanFood(
    { regionId: input.regionId, destinationName: input.destinationName, points: input.points, foodAreas: [], center, maxDistanceKm: 2_000, countryCode: input.countryCode, today: input.today },
    {
      cache: noCache,
      geocodeArea: null,
      overpass: true,
      overture: async (boxes) => boxes.map((box) => replayOvertureBox(input.fixture, box)),
      fetchMeals: async (box) => replayOverpassBox(input.fixture, box),
    },
  );
}

export interface NameMealsInput {
  day: ItineraryDay;
  food: FoodDataset;
  profile: TravelerProfile;
  anchorCoordinates: ReadonlyMap<string, { lat: number; lng: number }>;
  base: { lat: number; lng: number } | null;
  baseName: string;
  venueUse: Map<string, number>;
  carFree: boolean;
}

/** The product's meal-naming step, on one day. Mutates `day.items` exactly as the build does. */
export function nameMeals(input: NameMealsInput): number {
  return nameVenuesForDay(input.day, input.food, input.profile, input.anchorCoordinates, input.base, input.venueUse, input.carFree);
}

/** Which behaviour the adapter is wired to, written into the report. */
export const ADAPTER_SEAMS = 'overtureFoodRow + markChainsFromBox → groundScanFood → reconcile.nameVenuesForDay';
