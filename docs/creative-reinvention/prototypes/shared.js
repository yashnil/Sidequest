/* Shared helpers for the concept prototypes. Plain browser JS; data comes from data.js (window.DATA). */
window.ATLAS = {
  night: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 12 },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#16303a' } },
      { id: 'hill', type: 'hillshade', source: 'dem', paint: { 'hillshade-shadow-color': '#06100f', 'hillshade-highlight-color': '#3e5f64', 'hillshade-exaggeration': 0.5 } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': '#1d3b3a', 'fill-opacity': 0.6 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#0a161b' } },
      { id: 'bld', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': '#1e3a44', 'fill-opacity': 0.7 } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]], minzoom: 12, paint: { 'line-color': '#284853', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.4, 16, 2] } },
      { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'trunk', 'motorway']]], paint: { 'line-color': '#335a66', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 16, 3] } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': '#3d6570', 'line-width': 0.8, 'line-dasharray': [3, 2] } },
      { id: 'place', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'neighbourhood']]], layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': ['match', ['get', 'class'], 'city', 13, 'town', 12, 10], 'text-transform': 'uppercase', 'text-letter-spacing': 0.2 }, paint: { 'text-color': '#8fa6a6', 'text-halo-color': '#0d1a1f', 'text-halo-width': 1.2 } },
    ],
  },
  bone: {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' }, dem: { type: 'raster-dem', tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'], encoding: 'terrarium', tileSize: 256, maxzoom: 12 } },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#efe8da' } },
      { id: 'hill', type: 'hillshade', source: 'dem', paint: { 'hillshade-shadow-color': '#b9ab92', 'hillshade-highlight-color': '#fbf8f1', 'hillshade-exaggeration': 0.35 } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': '#d9dcc4', 'fill-opacity': 0.8 } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': '#bcd6da' } },
      { id: 'bld', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': '#e2d8c5' } },
      { id: 'road-minor', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]], minzoom: 12, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 3] } },
      { id: 'road-major', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'trunk', 'motorway']]], paint: { 'line-color': '#d6c7ab', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 16, 4] } },
      { id: 'place', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['city', 'town', 'suburb', 'neighbourhood']]], layout: { 'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']], 'text-font': ['Noto Sans Regular'], 'text-size': ['match', ['get', 'class'], 'city', 13, 'town', 12, 10], 'text-transform': 'uppercase', 'text-letter-spacing': 0.2 }, paint: { 'text-color': '#6f6556', 'text-halo-color': '#efe8da', 'text-halo-width': 1.4 } },
    ],
  },
};

window.bounds = function bounds(points) {
  const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
};

window.makeMap = function makeMap(el, style, points, opts = {}) {
  const map = new maplibregl.Map({ container: el, style, attributionControl: false, interactive: opts.interactive ?? true, fadeDuration: 0 });
  if (points.length) map.fitBounds(bounds(points), { padding: opts.padding ?? 80, duration: 0, maxZoom: opts.maxZoom ?? 14 });
  return map;
};
