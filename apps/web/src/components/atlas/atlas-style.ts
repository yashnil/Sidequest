/**
 * THE SURVEY ATLAS — Sidequest's own cartography for every map inside a trip.
 *
 * The trip maps used OpenFreeMap's stock "positron" style: a grey street map
 * drawn for somebody else's product, under a landing page that is a lit night
 * globe. One visual language now runs from the globe to the last day of a plan,
 * in two grounds:
 *
 * - `survey` — the paper the plan is printed on: bone land, glacier water,
 *   sage parks, white streets, terrain as a faint relief. The figure's marks
 *   (ink pins, the flare route) are the loudest thing on it.
 * - `night` — the globe's ground, for the stage screens (the scan, the board's
 *   map, the journey): night land, deep water, streets as a quiet lattice.
 *
 * Sources and terms are the globe's own (see `landing/night-style.ts`):
 * OpenFreeMap vector tiles (OpenStreetMap, OpenMapTiles; keyless, commercial
 * use allowed, attribution required) and AWS Terrain Tiles (open data). Plain
 * data, no imports, so a unit test can say exactly what it asks the network for.
 */
export type AtlasGround = 'survey' | 'night';

/** The style identifiers a basemap source may name instead of a remote style URL. */
export const ATLAS_STYLE_IDS = { survey: 'sidequest:survey', night: 'sidequest:night' } as const;

export const ATLAS_ATTRIBUTION = '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap · terrain: AWS Terrain Tiles';

interface Palette {
  land: string;
  relief: [string, string];
  water: string;
  waterLine: string;
  park: string;
  wood: string;
  building: string;
  minor: string;
  major: string;
  majorCase: string;
  rail: string;
  label: string;
  labelStrong: string;
  halo: string;
  boundary: string;
}

export const ATLAS_PALETTES: Record<AtlasGround, Palette> = {
  survey: {
    land: '#ece5d6',
    relief: ['#b7a88d', '#fbf8f1'],
    water: '#bcd3d6',
    waterLine: '#9fbcc1',
    park: '#d9dcc3',
    wood: '#d0d5ba',
    building: '#e0d6c3',
    minor: '#f8f4ec',
    major: '#ffffff',
    majorCase: '#d3c6ad',
    rail: '#a99b84',
    label: '#6a6152',
    labelStrong: '#2c2a25',
    halo: '#ece5d6',
    boundary: '#b4a68e',
  },
  night: {
    land: '#16303a',
    relief: ['#06100f', '#3e5f64'],
    water: '#0a161b',
    waterLine: '#0e2128',
    park: '#1b3837',
    wood: '#1a3534',
    building: '#1d3842',
    minor: '#22414b',
    major: '#2f5561',
    majorCase: '#16303a',
    rail: '#3d6570',
    label: '#8fa6a6',
    labelStrong: '#d9dfd8',
    halo: '#0d1a1f',
    boundary: '#3a5359',
  },
};

const MINOR = ['minor', 'service', 'tertiary', 'track'];
const MAJOR = ['primary', 'secondary', 'trunk', 'motorway'];

export function atlasStyle(ground: AtlasGround, options: { terrain?: boolean } = {}): Record<string, unknown> {
  const c = ATLAS_PALETTES[ground];
  const name = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name']];
  const style: Record<string, unknown> = {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 12,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': c.land } },
      {
        id: 'relief',
        type: 'hillshade',
        source: 'dem',
        paint: {
          'hillshade-shadow-color': c.relief[0],
          'hillshade-highlight-color': c.relief[1],
          'hillshade-accent-color': c.relief[0],
          'hillshade-exaggeration': ground === 'night' ? 0.5 : 0.32,
        },
      },
      { id: 'landcover-wood', type: 'fill', source: 'openmaptiles', 'source-layer': 'landcover', filter: ['==', ['get', 'class'], 'wood'], paint: { 'fill-color': c.wood, 'fill-opacity': 0.55 } },
      { id: 'park', type: 'fill', source: 'openmaptiles', 'source-layer': 'park', paint: { 'fill-color': c.park, 'fill-opacity': 0.7 } },
      { id: 'landuse-green', type: 'fill', source: 'openmaptiles', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['cemetery', 'grass', 'pitch', 'playground']]], paint: { 'fill-color': c.park, 'fill-opacity': 0.5 } },
      { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water', paint: { 'fill-color': c.water } },
      { id: 'waterway', type: 'line', source: 'openmaptiles', 'source-layer': 'waterway', paint: { 'line-color': c.waterLine, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 14, 1.6] } },
      { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': c.building, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0, 14.5, 0.9] } },
      { id: 'road-minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 11, filter: ['in', ['get', 'class'], ['literal', MINOR]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.minor, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 1.6, 17, 6] } },
      { id: 'road-path', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', minzoom: 13, filter: ['==', ['get', 'class'], 'path'], paint: { 'line-color': c.majorCase, 'line-width': 0.8, 'line-dasharray': [2, 2] } },
      { id: 'road-major-case', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', MAJOR]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.majorCase, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 3, 16, 9] } },
      { id: 'road-major', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', MAJOR]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.major, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.3, 12, 1.8, 16, 7] } },
      { id: 'rail', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': c.rail, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 15, 1.4], 'line-dasharray': [4, 2] } },
      { id: 'boundary-country', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary', filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]], paint: { 'line-color': c.boundary, 'line-width': 1, 'line-dasharray': [3, 2] } },
      {
        id: 'water-name-line',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water_name',
        filter: ['==', ['geometry-type'], 'LineString'],
        layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 11, 'text-letter-spacing': 0.1, 'symbol-placement': 'line' },
        paint: { 'text-color': ground === 'night' ? '#5d8590' : '#6c8e94', 'text-halo-color': c.water, 'text-halo-width': 1 },
      },
      {
        id: 'water-name-point',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'water_name',
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { 'text-field': name, 'text-font': ['Noto Sans Italic'], 'text-size': 11, 'text-letter-spacing': 0.1 },
        paint: { 'text-color': ground === 'night' ? '#5d8590' : '#6c8e94', 'text-halo-color': c.water, 'text-halo-width': 1 },
      },
      {
        id: 'place-minor',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 11,
        filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'quarter', 'village', 'hamlet']]],
        layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'text-transform': 'uppercase', 'text-letter-spacing': 0.18, 'text-max-width': 8 },
        paint: { 'text-color': c.label, 'text-opacity': 0.8, 'text-halo-color': c.halo, 'text-halo-width': 1.2 },
      },
      {
        id: 'place-town',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]],
        /* A town name may take another side of its point when a pin holds the first. */
        layout: { 'text-field': name, 'text-font': ['Noto Sans Bold'], 'text-size': ['match', ['get', 'class'], 'city', 13, 11], 'text-transform': 'uppercase', 'text-letter-spacing': 0.16, 'text-max-width': 8, 'text-variable-anchor': ['center', 'top', 'bottom', 'left', 'right'], 'text-radial-offset': 0.9 },
        paint: { 'text-color': c.labelStrong, 'text-halo-color': c.halo, 'text-halo-width': 1.4 },
      },
      {
        id: 'place-country',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        maxzoom: 6,
        filter: ['==', ['get', 'class'], 'country'],
        layout: { 'text-field': name, 'text-font': ['Noto Sans Regular'], 'text-size': 12, 'text-transform': 'uppercase', 'text-letter-spacing': 0.3 },
        paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.2 },
      },
    ],
  };
  if (options.terrain) style.terrain = { source: 'dem', exaggeration: 1.4 };
  return style;
}

/** A basemap source's style, resolved: Sidequest's own ground for an `sidequest:` id, the remote URL otherwise. */
export function resolveAtlasStyle(styleUrl: string): string | Record<string, unknown> {
  if (styleUrl === ATLAS_STYLE_IDS.survey) return atlasStyle('survey');
  if (styleUrl === ATLAS_STYLE_IDS.night) return atlasStyle('night');
  return styleUrl;
}
