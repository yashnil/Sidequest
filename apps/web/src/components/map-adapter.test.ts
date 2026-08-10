import { describe, expect, it } from 'vitest';
import {
  MAP_TILES_ATTRIBUTION_ENV,
  MAP_TILES_ENV,
  resolveMapTileSource,
  tilesForViewport,
  type MapTileSource,
} from './map-adapter';
import { fitMercator } from './map-projection';

/**
 * THE SEAM IS TESTED SO THAT IT IS A SEAM RATHER THAN A COMMENT.
 *
 * "We preserved a map-adapter path" is only true if switching it on would work.
 * The default — every build in existence — is `null`, and the first block below
 * is about the ways a half-configured basemap must refuse rather than degrade.
 */

const INSETS = { top: 20, right: 20, bottom: 20, left: 20 };

const SOURCE: MapTileSource = {
  urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png',
  attribution: 'Example',
  tileSize: 256,
  maxZoom: 19,
};

describe('the basemap switch', () => {
  it('is off, which is what every build produces', () => {
    expect(resolveMapTileSource({})).toBeNull();
  });

  it('refuses a tile source that carries no attribution', () => {
    expect(
      resolveMapTileSource({ [MAP_TILES_ENV]: 'https://tiles.example/{z}/{x}/{y}.png' }),
    ).toBeNull();
  });

  it('refuses a template that is not a template', () => {
    for (const template of [
      'https://tiles.example/tile.png',
      'https://tiles.example/{z}/{x}.png',
      'http://tiles.example/{z}/{x}/{y}.png',
    ]) {
      expect(
        resolveMapTileSource({
          [MAP_TILES_ENV]: template,
          [MAP_TILES_ATTRIBUTION_ENV]: 'Example',
        }),
        template,
      ).toBeNull();
    }
  });

  it('resolves a complete configuration, with defaults for the rest', () => {
    expect(
      resolveMapTileSource({
        [MAP_TILES_ENV]: ' https://tiles.example/{z}/{x}/{y}.png ',
        [MAP_TILES_ATTRIBUTION_ENV]: ' © Example ',
      }),
    ).toEqual({
      urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png',
      attribution: '© Example',
      tileSize: 256,
      maxZoom: 19,
    });
  });

  it('reads nothing from the ambient environment', () => {
    // The property render purity depends on: the resolver is a function of its
    // argument, so nothing is read while a component is being produced.
    process.env[MAP_TILES_ENV] = 'https://tiles.example/{z}/{x}/{y}.png';
    process.env[MAP_TILES_ATTRIBUTION_ENV] = 'Example';
    try {
      expect(resolveMapTileSource({})).toBeNull();
    } finally {
      delete process.env[MAP_TILES_ENV];
      delete process.env[MAP_TILES_ATTRIBUTION_ENV];
    }
  });
});

describe('tiles for a fitted viewport', () => {
  const viewport = fitMercator({
    points: [
      { lat: 41.1, lng: 28.9 },
      { lat: 36.9, lng: 30.7 },
    ],
    width: 320,
    height: 250,
    insets: INSETS,
    minSpanKm: 8,
  });

  it('covers the frame', () => {
    const tiles = tilesForViewport({ viewport, source: SOURCE });
    expect(tiles.length).toBeGreaterThan(0);

    const left = Math.min(...tiles.map((tile) => tile.left));
    const top = Math.min(...tiles.map((tile) => tile.top));
    const right = Math.max(...tiles.map((tile) => tile.left + tile.size));
    const bottom = Math.max(...tiles.map((tile) => tile.top + tile.size));
    expect(left).toBeLessThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(viewport.width);
    expect(bottom).toBeGreaterThanOrEqual(viewport.height);
  });

  it('lands a tile where the coordinate it depicts is drawn', () => {
    const tiles = tilesForViewport({ viewport, source: SOURCE });
    const point = { lat: 39.0, lng: 29.8 };
    const at = viewport.project(point);
    const covering = tiles.filter(
      (tile) =>
        at.x >= tile.left &&
        at.x <= tile.left + tile.size &&
        at.y >= tile.top &&
        at.y <= tile.top + tile.size,
    );
    /*
     * The property that makes a basemap trustworthy rather than decorative: the
     * tile under a mark is the tile for that mark's own coordinate. Computed
     * here from the slippy-map formula independently of the module.
     */
    const zoom = covering[0]!.z;
    const count = 2 ** zoom;
    const expectedX = Math.floor(((point.lng + 180) / 360) * count);
    const phi = (point.lat * Math.PI) / 180;
    const expectedY = Math.floor(
      (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * count,
    );
    expect(covering.some((tile) => tile.x === expectedX && tile.y === expectedY)).toBe(true);
  });

  it('never magnifies a tile past its native resolution', () => {
    const tiles = tilesForViewport({ viewport, source: SOURCE });
    for (const tile of tiles) expect(tile.size).toBeLessThanOrEqual(SOURCE.tileSize + 1e-9);
  });

  it('fills the template', () => {
    const [tile] = tilesForViewport({ viewport, source: SOURCE });
    expect(tile!.href).toBe(`https://tiles.example/${tile!.z}/${tile!.x}/${tile!.y}.png`);
  });

  it('honours the provider ceiling rather than asking for a zoom it does not serve', () => {
    const tight = fitMercator({
      points: [{ lat: 51.5, lng: -0.12 }],
      width: 320,
      height: 250,
      insets: INSETS,
      minSpanKm: 0.2,
    });
    const tiles = tilesForViewport({ viewport: tight, source: { ...SOURCE, maxZoom: 8 } });
    for (const tile of tiles) expect(tile.z).toBe(8);
  });

  it('caps the number of images a misconfiguration can emit', () => {
    const tiles = tilesForViewport({ viewport, source: SOURCE, maxTiles: 3 });
    expect(tiles).toHaveLength(3);
  });

  it('wraps longitude rather than requesting a tile off the edge of the world', () => {
    const acrossTheAntimeridian = fitMercator({
      points: [
        { lat: -16.5, lng: 179.5 },
        { lat: -17.5, lng: -179.5 },
      ],
      width: 320,
      height: 250,
      insets: INSETS,
      minSpanKm: 8,
    });
    const tiles = tilesForViewport({ viewport: acrossTheAntimeridian, source: SOURCE });
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(2 ** tile.z);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(2 ** tile.z);
    }
  });
});
