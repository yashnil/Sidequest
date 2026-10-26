/**
 * THE NIGHT ATLAS STYLE — the landing globe's own MapLibre style.
 *
 * Built rather than borrowed: OpenFreeMap's stock styles are made to be read
 * at street level, and on a globe at zoom 2 they are a grey ball. This one is
 * drawn for the first screen of a travel product — night water, land a step
 * lighter, AWS Terrain Tiles as shaded relief and as real 3D terrain under
 * the pitched camera, from orbit down into
 * a region. Few layers on purpose: it paints in one frame on a phone.
 *
 * Sources and their terms:
 * - OpenFreeMap vector planet (`tiles.openfreemap.org`):
 *   free, keyless, commercial use allowed; © OpenStreetMap contributors,
 *   OpenMapTiles.
 * - AWS Terrain Tiles (`s3.amazonaws.com/elevation-tiles-prod`, Terrarium
 *   encoding): open data; attribution per the Joerd sources list, carried in
 *   `NIGHT_ATTRIBUTION` and shown under the globe.
 *
 * Plain data, no imports: a unit test can assert what it asks the network for.
 */
export const NIGHT_ATTRIBUTION = '© OpenStreetMap contributors · OpenMapTiles · OpenFreeMap · terrain: AWS Terrain Tiles (USGS, SRTM, GMTED, ETOPO1 and others)';

export const NIGHT = {
  sea: '#0a161b',
  land: '#16303a',
  landHigh: '#1a3139',
  boundary: '#3a5359',
  label: '#cfd6cf',
  labelHalo: '#0a161b',
  water: '#0d1f26',
} as const;

export function nightAtlasStyle(options: { terrain?: boolean } = {}): Record<string, unknown> {
  const style: Record<string, unknown> = {
    version: 8,
    projection: { type: 'globe' },
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sky: {
      'sky-color': '#0d1a1f',
      'horizon-color': '#1d3a44',
      'fog-color': '#0d1a1f',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.8,
      'fog-ground-blend': 0.4,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.6, 9, 0],
    },
    sources: {
      openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: {
        type: 'raster-dem',
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        encoding: 'terrarium',
        tileSize: 256,
        maxzoom: 11,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': NIGHT.sea } },
      /*
       * Land and sea come from the elevation tiles, not from the vector water
       * layer: the terrain tiles are small and arrive first, so a coast is
       * right on the first frame instead of the whole globe reading as land
       * until a slow water tile lands. Higher ground is a step lighter.
       */
      {
        id: 'relief',
        type: 'color-relief',
        source: 'dem',
        paint: {
          'color-relief-color': ['interpolate', ['linear'], ['elevation'], -10000, '#060f13', -200, NIGHT.sea, -1, NIGHT.sea, 0, NIGHT.land, 800, '#1b3742', 2200, '#24444d', 4500, '#3a5c63'],
        },
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          'hillshade-shadow-color': '#040a0d',
          'hillshade-highlight-color': '#4d6e74',
          'hillshade-accent-color': '#0b171c',
          'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 0, 0.6, 5, 0.45, 9, 0.55],
        },
      },
      {
        id: 'water',
        type: 'fill',
        source: 'openmaptiles',
        'source-layer': 'water',
        paint: { 'fill-color': NIGHT.sea, 'fill-opacity': 0.88 },
      },
      {
        id: 'boundary-country',
        type: 'line',
        source: 'openmaptiles',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': NIGHT.boundary, 'line-width': ['interpolate', ['linear'], ['zoom'], 1, 0.4, 6, 1], 'line-opacity': 0.7 },
      },
      {
        id: 'place-country',
        type: 'symbol',
        source: 'openmaptiles',
        'source-layer': 'place',
        minzoom: 2,
        maxzoom: 4.6,
        filter: ['==', ['get', 'class'], 'country'],
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 5, 13],
          'text-transform': 'uppercase',
          'text-letter-spacing': 0.18,
          'text-max-width': 8,
        },
        paint: { 'text-color': NIGHT.label, 'text-opacity': 0.5, 'text-halo-color': NIGHT.labelHalo, 'text-halo-width': 1.2 },
      },
    ],
  };
  /* Only for a pitched camera (the landing globe): the same elevation tiles as a 3D mesh. One source for relief and mesh, so a region costs one set of elevation tiles, not two. */
  if (options.terrain) style.terrain = { source: 'dem', exaggeration: 1.6 };
  return style;
}
