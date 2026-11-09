import recorded from '../../../../../../packages/core/src/scan/fixtures/live-scans-2026-11.json';
import type { DietaryNeed } from '@sidequest/core';

/**
 * FOOD EVALUATION — THE TRIPS THE HARNESS REPLAYS.
 *
 * A scenario is geometry and a traveller, nothing else: where the trip sleeps,
 * what it visits, how it moves, and what the traveller said about food. Three
 * are the live release-pass scans already recorded for base choice
 * (`packages/core/src/scan/fixtures/live-scans-2026-11.json`: the model's
 * proposal as Nominatim placed it). Three are hand-authored to cover ground
 * those leave out — a small town, a remote national park and a sparsely mapped
 * non-Latin-script region — and their coordinates are approximate on purpose:
 * they decide which 1.5 km boxes the open place data is read for, and nothing
 * in the product reads them.
 *
 * The venue rows each scenario replays were recorded once from the keyless
 * sources (`record.harness.ts`) and live beside this file; the harness itself
 * never touches the network.
 */

export type ScenarioKind = 'dense_city' | 'island' | 'rural_road_trip' | 'small_town' | 'remote_park' | 'sparse_non_latin';

export interface ScenarioPoint {
  id: string;
  name: string;
  coordinates: { lat: number; lng: number };
  /** Minutes on site. Bases carry none. */
  minutes?: number;
  /** Open ground where nobody expects a kitchen: a trailhead, a pass, a glacier lagoon. */
  wild?: boolean;
}

export interface ScenarioTraveller {
  label: string;
  dietaryNeeds: DietaryNeed[];
  /** What they said they like to eat, in their own words (`cuisine` values a venue may carry). */
  cuisines: string[];
  everydayPriceBand: 'budget' | 'moderate' | 'upscale';
}

export interface FoodScenario {
  label: string;
  kind: ScenarioKind;
  destination: string;
  countryCode: string;
  carFree: boolean;
  nights: number;
  bases: ScenarioPoint[];
  places: ScenarioPoint[];
  travellers: ScenarioTraveller[];
}

const OMNIVORE: ScenarioTraveller = { label: 'no stated needs', dietaryNeeds: [], cuisines: [], everydayPriceBand: 'moderate' };
const VEGETARIAN: ScenarioTraveller = { label: 'vegetarian', dietaryNeeds: ['vegetarian'], cuisines: [], everydayPriceBand: 'moderate' };

function fromLiveScan(label: string, over: Pick<FoodScenario, 'kind' | 'countryCode' | 'carFree' | 'travellers'>): FoodScenario {
  const scan = recorded.scans.find((s) => s.label === label);
  if (!scan) throw new Error(`No recorded live scan "${label}"`);
  return {
    label,
    destination: scan.destination,
    nights: scan.nights,
    bases: scan.bases.map((b) => ({ id: b.id, name: b.name, coordinates: b.coordinates })),
    places: scan.places.map((p) => ({ id: p.id, name: p.name, coordinates: p.coordinates, minutes: p.minutes })),
    ...over,
  };
}

const p = (name: string, lat: number, lng: number, minutes: number, wild = false): ScenarioPoint => ({
  id: `scan-place-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
  name,
  coordinates: { lat, lng },
  minutes,
  ...(wild ? { wild } : {}),
});
const b = (name: string, lat: number, lng: number): ScenarioPoint => ({ id: `scan-base-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, name, coordinates: { lat, lng } });

export const FOOD_SCENARIOS: readonly FoodScenario[] = [
  fromLiveScan('tokyo-kyoto', {
    kind: 'dense_city',
    countryCode: 'JP',
    carFree: true,
    travellers: [OMNIVORE, VEGETARIAN, { label: 'likes ramen and sushi', dietaryNeeds: [], cuisines: ['ramen', 'sushi'], everydayPriceBand: 'moderate' }],
  }),
  fromLiveScan('tenerife-car-b', {
    kind: 'island',
    countryCode: 'ES',
    carFree: false,
    travellers: [OMNIVORE, VEGETARIAN, { label: 'likes seafood and Spanish cooking', dietaryNeeds: [], cuisines: ['seafood', 'spanish'], everydayPriceBand: 'moderate' }],
  }),
  fromLiveScan('scotland-road-trip', {
    kind: 'rural_road_trip',
    countryCode: 'GB',
    carFree: false,
    travellers: [OMNIVORE, VEGETARIAN, { label: 'gluten-free', dietaryNeeds: ['gluten_free'], cuisines: [], everydayPriceBand: 'moderate' }],
  }),
  {
    label: 'keswick-lake-district',
    kind: 'small_town',
    destination: 'Keswick and the northern Lake District',
    countryCode: 'GB',
    carFree: false,
    nights: 4,
    bases: [b('Keswick', 54.6013, -3.1347)],
    places: [
      p('Derwentwater foreshore', 54.5916, -3.1405, 60),
      p('Castlerigg Stone Circle', 54.6028, -3.0984, 45),
      p('Catbells', 54.577, -3.1667, 180, true),
      p('Ashness Bridge', 54.5665, -3.13, 30, true),
      p('Buttermere', 54.5411, -3.277, 150),
      p('Honister Slate Mine', 54.5116, -3.198, 120),
      p('Seatoller and Borrowdale', 54.5143, -3.1687, 90, true),
      p('Whinlatter Forest', 54.6088, -3.2247, 120),
      p('Dodd Wood', 54.647, -3.187, 120, true),
      p('Aira Force', 54.5745, -2.929, 90),
      p('Glenridding and Ullswater', 54.544, -2.95, 120),
      p('Grasmere', 54.4597, -3.0244, 120),
      p('Ambleside', 54.432, -2.962, 90),
    ],
    travellers: [OMNIVORE, VEGETARIAN, { label: 'vegan', dietaryNeeds: ['vegan'], cuisines: [], everydayPriceBand: 'moderate' }],
  },
  {
    label: 'torres-del-paine',
    kind: 'remote_park',
    destination: 'Torres del Paine',
    countryCode: 'CL',
    carFree: false,
    nights: 5,
    bases: [b('Puerto Natales', -51.7236, -72.5064)],
    places: [
      p('Puerto Natales waterfront', -51.7295, -72.5135, 60),
      p('Cueva del Milodón', -51.565, -72.62, 90),
      p('Villa Cerro Castillo', -51.261, -72.342, 30),
      p('Laguna Amarga', -50.981, -72.796, 45, true),
      p('Base Torres trailhead', -50.972, -72.864, 480, true),
      p('Salto Grande', -51.066, -73.001, 60, true),
      p('Mirador Cuernos', -51.043, -73.02, 150, true),
      p('Lago Pehoé', -51.109, -72.987, 60, true),
      p('Lago Grey', -51.125, -73.13, 180, true),
      p('Río Serrano', -51.233, -72.98, 60, true),
      p('Laguna Azul', -50.878, -72.74, 120, true),
    ],
    travellers: [OMNIVORE, VEGETARIAN],
  },
  {
    label: 'karakol-issyk-kul',
    kind: 'sparse_non_latin',
    destination: 'Karakol and Issyk-Kul',
    countryCode: 'KG',
    carFree: false,
    nights: 5,
    bases: [b('Karakol', 42.4907, 78.3936)],
    places: [
      p('Dungan Mosque', 42.496, 78.395, 30),
      p('Holy Trinity Cathedral', 42.488, 78.399, 30),
      p('Karakol bazaar', 42.499, 78.387, 60),
      p('Przhevalsky Museum', 42.577, 78.317, 75),
      p('Jeti-Ögüz', 42.339, 78.233, 120, true),
      p('Altyn Arashan', 42.376, 78.611, 300, true),
      p('Karakol ski base', 42.392, 78.476, 150, true),
      p('Barskoon', 42.156, 77.604, 60),
      p('Skazka Canyon', 42.156, 77.356, 90, true),
      p('Bokonbayevo', 42.118, 76.989, 90),
      p('Cholpon-Ata petroglyphs', 42.659, 77.058, 60),
    ],
    travellers: [OMNIVORE, VEGETARIAN, { label: 'halal', dietaryNeeds: ['halal'], cuisines: [], everydayPriceBand: 'moderate' }],
  },
];

export function scenario(label: string): FoodScenario {
  const found = FOOD_SCENARIOS.find((s) => s.label === label);
  if (!found) throw new Error(`No food scenario "${label}"`);
  return found;
}
