import type { Interest } from '@sidequest/core';
import { cx } from '../ui';

/**
 * THE ATLAS GLYPH SET.
 *
 * One monoline family (1.5px, round caps) drawn for the things the interview
 * asks about. Every glyph is decorative beside a text label — `aria-hidden`
 * always — so nothing here is the only carrier of meaning.
 */
export type GlyphId =
  | 'hike'
  | 'walk'
  | 'viewpoint'
  | 'lake'
  | 'drive'
  | 'wildlife'
  | 'geology'
  | 'hotspring'
  | 'history'
  | 'food'
  | 'camera'
  | 'stars'
  | 'museum'
  | 'landmark'
  | 'neighbourhood'
  | 'market'
  | 'beach'
  | 'car'
  | 'transit'
  | 'taxi'
  | 'guide'
  | 'boat'
  | 'plane'
  | 'bed'
  | 'tent'
  | 'compass'
  | 'clock'
  | 'crowd'
  | 'quiet'
  | 'sunrise'
  | 'coin'
  | 'coins'
  | 'gem'
  | 'road'
  | 'gravel'
  | 'signal-off'
  | 'altitude'
  | 'group'
  | 'lock'
  | 'pen'
  | 'plate'
  | 'check'
  | 'home';

const PATHS: Record<GlyphId, string> = {
  hike: 'M3 20 8 11l3 4 3-7 4 6 3 6M14 4a1 1 0 1 0 0 .01',
  walk: 'M12 4a1.2 1.2 0 1 0 0 .01M10 20l2-6-2-3 3-3 2 2 3 1M9 12l-3 2M13 14l3 6',
  viewpoint: 'M2 18h20M4 18 9 9l4 6 3-4 4 7M18 5a2 2 0 1 0 0 .01',
  lake: 'M3 15c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0M8 9c2-3 6-3 8 0',
  drive: 'M3 17c4-6 8-8 18-8M5 17a1.5 1.5 0 1 0 0 .01M11 12l2-2M15 10l2-2',
  wildlife: 'M5 20V11l-2-3 3 1 2-2 2 2 4-1 3 3v9M9 20v-4M15 20v-4M7 8V5M17 8V5',
  geology: 'M3 20h18M6 20l3-9 3 5 2-7 4 11M11 6l1-3 1 3',
  hotspring: 'M4 18c4 2 12 2 16 0M6 18c0-3 12-3 12 0M9 10c-1-2 1-3 0-5M12 11c-1-2 1-3 0-5M15 10c-1-2 1-3 0-5',
  history: 'M4 20h16M6 20V10M10 20V10M14 20V10M18 20V10M3 10l9-6 9 6z',
  food: 'M6 3v8M9 3v8M7.5 11v10M17 3c-3 0-3 7-3 9h3v9',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7',
  stars: 'M12 3l1.5 4 4 1.5-4 1.5L12 14l-1.5-4-4-1.5 4-1.5zM5 15l.8 2 2 .8-2 .8L5 21l-.8-2.4-2-.8 2-.8zM19 16l.6 1.5 1.5.6-1.5.6L19 20l-.6-1.3-1.5-.6 1.5-.6z',
  museum: 'M3 20h18M5 20V9M19 20V9M9 20v-8M15 20v-8M12 20v-8M2 9l10-5 10 5z',
  landmark: 'M12 3v18M8 21h8M9 8h6M7 13h10M12 3l-3 3M12 3l3 3',
  neighbourhood: 'M3 21V10l4-4 4 4v11M11 21V13l4-4 4 4v8M6 13h1M6 17h1M15 15h1M15 18h1',
  market: 'M3 9h18l-2 11H5zM3 9l2-4h14l2 4M9 13v3M15 13v3',
  beach: 'M3 19c3-2 6-2 9 0s6 2 9 0M17 4a5 5 0 0 1 4 6M17 4a5 5 0 0 0-4 6M17 4v11',
  car: 'M4 16v-4l2-5h12l2 5v4M4 16h16M6 16v2M18 16v2M7 13a1 1 0 1 0 0 .01M17 13a1 1 0 1 0 0 .01',
  transit: 'M6 4h12v12H6zM6 9h12M9 19l-1 2M15 19l1 2M9 13a1 1 0 1 0 0 .01M15 13a1 1 0 1 0 0 .01',
  taxi: 'M4 16v-4l2-5h12l2 5v4M4 16h16M9 7V5h6v2M7 13a1 1 0 1 0 0 .01M17 13a1 1 0 1 0 0 .01',
  guide: 'M12 3a2 2 0 1 0 0 .01M12 6v7M8 21l4-8 4 8M5 12h14M5 12v-2M19 12v-2',
  boat: 'M3 16c3 2 15 2 18 0M5 16l1-5h12l1 5M12 4v7M12 4l5 4',
  plane: 'M3 13l8-1 5-8 2 1-3 7 5 3v2l-6-1-2 4H10l1-5-5-1z',
  bed: 'M3 18V8M3 12h18v6M7 12V9h6v3M21 18v-2',
  tent: 'M2 20h20M12 4 3 20M12 4l9 16M12 12l-4 8M12 12l4 8',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M15 9l-2 5-5 2 2-5z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2',
  crowd: 'M8 8a2 2 0 1 0 0 .01M16 8a2 2 0 1 0 0 .01M12 6a2 2 0 1 0 0 .01M4 19c0-4 3-6 4-6s4 2 4 6M12 19c0-4 3-6 4-6s4 2 4 6M9 17c0-3 2-4 3-4s3 1 3 4',
  quiet: 'M5 18V8l6 4-6 6zM14 9c2 1 2 5 0 6M17 6c3 2 3 10 0 12',
  sunrise: 'M3 17h18M6 17a6 6 0 0 1 12 0M12 3v3M4 8l2 2M20 8l-2 2',
  coin: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M9 14c0 1.5 1.5 2 3 2s3-.5 3-2-1.5-2-3-2-3-.5-3-2 1.5-2 3-2 3 .5 3 2M12 6v1M12 17v1',
  coins: 'M8 13a5 3 0 1 0 0 .01M8 13v4a5 3 0 0 0 10 0v-4M8 9a5 3 0 1 0 10 0 5 3 0 0 0-10 0',
  gem: 'M6 8h12l3 4-9 9-9-9zM6 8l6 13M18 8l-6 13M3 12h18',
  road: 'M6 21 9 3M18 21 15 3M12 6v2M12 11v2M12 16v2',
  gravel: 'M6 21 9 3M18 21 15 3M12 7a.5.5 0 1 0 0 .01M11 12a.5.5 0 1 0 0 .01M13 16a.5.5 0 1 0 0 .01M12 20a.5.5 0 1 0 0 .01',
  'signal-off': 'M4 20 20 4M6 11a8 8 0 0 1 4-3M4 8a12 12 0 0 1 9-4M12 20a1 1 0 1 0 0 .01M17 14a8 8 0 0 0-2-2',
  altitude: 'M2 20 8 9l3 4 4-8 7 15M10 5h4M12 3v4',
  group: 'M9 8a3 3 0 1 0 0 .01M17 9a2.5 2.5 0 1 0 0 .01M3 20c0-4 3-7 6-7s6 3 6 7M15 20c0-3 1-5 2-5s4 2 4 5',
  lock: 'M6 11h12v10H6zM9 11V7a3 3 0 0 1 6 0v4M12 15v3',
  pen: 'M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3',
  plate: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10',
  check: 'M5 12l5 5 9-10',
  home: 'M4 11 12 4l8 7M6 10v10h12V10M10 20v-6h4v6',
};

export function Glyph({ id, className, strokeWidth = 1.5 }: { id: GlyphId; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('h-6 w-6 shrink-0', className)} fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[id]} />
    </svg>
  );
}

export const INTEREST_GLYPH: Record<Interest, GlyphId> = {
  hiking: 'hike',
  easy_nature_walks: 'walk',
  scenic_viewpoints: 'viewpoint',
  lakes_and_rivers: 'lake',
  scenic_drives: 'drive',
  wildlife: 'wildlife',
  geology_and_geothermal: 'geology',
  hot_springs: 'hotspring',
  history_and_culture: 'history',
  food_and_towns: 'food',
  photography_golden_hour: 'camera',
  stargazing: 'stars',
  museums_and_galleries: 'museum',
  architecture_and_landmarks: 'landmark',
  neighbourhoods_and_local_life: 'neighbourhood',
  markets_and_street_food: 'market',
  beaches_and_swimming: 'beach',
};

/** One line of context per interest, for the interest card. Generic on purpose: never a claim about a place. */
export const INTEREST_CONTEXT: Record<Interest, string> = {
  hiking: 'Real trails, earned views',
  easy_nature_walks: 'Short, flat, still outside',
  scenic_viewpoints: 'The places you stop the car for',
  lakes_and_rivers: 'Water to sit by or get into',
  scenic_drives: 'Roads that are the point',
  wildlife: 'Animals in their own place',
  geology_and_geothermal: 'Strange ground, steam, craters',
  hot_springs: 'A soak at the end of a day',
  history_and_culture: 'How this place came to be',
  food_and_towns: 'Eating well, small towns',
  photography_golden_hour: 'Light, first and last',
  stargazing: 'Dark skies, late nights',
  museums_and_galleries: 'Indoors, deliberately',
  architecture_and_landmarks: 'The famous silhouettes',
  neighbourhoods_and_local_life: 'Where people actually live',
  markets_and_street_food: 'Eat standing up',
  beaches_and_swimming: 'Sand, surf, salt',
};

/** Warm-to-cool hue per interest for its plate; drawn from the same wheel the board uses. */
export const INTEREST_HUE: Record<Interest, number> = {
  hiking: 150,
  easy_nature_walks: 145,
  scenic_viewpoints: 158,
  lakes_and_rivers: 199,
  scenic_drives: 38,
  wildlife: 96,
  geology_and_geothermal: 22,
  hot_springs: 190,
  history_and_culture: 216,
  food_and_towns: 28,
  photography_golden_hour: 42,
  stargazing: 240,
  museums_and_galleries: 222,
  architecture_and_landmarks: 210,
  neighbourhoods_and_local_life: 228,
  markets_and_street_food: 20,
  beaches_and_swimming: 195,
};
