import { fitMercator, MAX_MERCATOR_LATITUDE, type MapViewport } from './map-projection';

/**
 * THE ESCAPE CLAUSE FROM §20, KEPT OPEN AND KEPT SHUT.
 *
 * §20 says that if a full interactive map cannot be responsibly implemented this
 * pass, improve the visualization and **preserve an explicit map-adapter path
 * rather than inventing a fake map**. This is that path.
 *
 * Why no basemap ships today, stated rather than implied:
 *
 *   1. **A basemap is somebody's tile service, on somebody's terms.** Every
 *      hosted raster endpoint worth using — including the free-tier ones — comes
 *      with a rate policy, an attribution requirement and a clause about
 *      automated traffic, and none of those has been agreed to for this project.
 *      Wiring a URL in and finding out later is exactly the failure mode
 *      `.claude-private/BLOCKER-google-terms.md` was written about.
 *   2. **Google Places content may not be drawn on a non-Google map** (Maps
 *      Service Specific Terms §14.2, and §3.2.3(e) of the platform terms). The
 *      marks on this figure come from the open-licensed destination index rather
 *      than from Places, so they are not caught by that clause — but the clause
 *      is the reason a tile layer can never be switched on blind. Whoever
 *      configures one has to know which provider every mark on top of it came
 *      from.
 *   3. **§25's seven questions do not currently clear a maps library.** MapLibre
 *      GL is ~200 kB gzipped of runtime to draw at most a dozen marks, it cannot
 *      be exercised offline in this suite, and without a tile source it renders
 *      an empty canvas — so it would answer "what existing failure does this
 *      eliminate" with "none, until somebody signs a terms document".
 *
 * So: a typed interface, a resolver that is a pure function of an environment
 * record, and tile arithmetic that is unit-tested. The default is `null`, which
 * is what every build produces, and `null` means the honest data-driven figure
 * is what renders — not a degraded version of a map that is not there.
 *
 * RENDER PURITY. Nothing in this module reads `process.env` and nothing in it
 * opens a socket. `resolveMapTileSource` takes the environment as an argument,
 * so the one place that reads the real environment is a caller that has decided
 * to — see `apps/web/src/lib/render-purity.architecture.test.ts` for why that
 * distinction is enforced rather than trusted. The tiles themselves are fetched
 * by the browser as `<image href>` after the page is on screen, which is the
 * same boundary `DestinationCombobox` already sits on.
 */

export interface MapTileSource {
  /**
   * A raster tile URL template with `{z}`, `{x}` and `{y}` placeholders.
   *
   * Raster rather than vector deliberately: a raster tile is an `<image>` inside
   * the SVG that already exists, so switching one on adds no runtime dependency
   * at all. A vector basemap would need a renderer, which is the dependency
   * decision this seam exists to defer.
   */
  urlTemplate: string;
  /**
   * The attribution the provider's terms require, rendered with the figure.
   *
   * Required rather than optional, and the resolver refuses a source without
   * one. Every tile provider worth naming demands attribution, and an
   * unattributed basemap is a licence breach that looks like a nice picture.
   */
  attribution: string;
  /** Edge length of one tile in pixels. 256 unless the provider says otherwise. */
  tileSize: number;
  /** The deepest zoom the provider serves. */
  maxZoom: number;
}

/**
 * The environment switch, in one place so the name cannot drift.
 *
 * `SIDEQUEST_MAP_TILES` holds the template; `SIDEQUEST_MAP_TILES_ATTRIBUTION`
 * holds the credit line. Both are required, because a half-configured basemap is
 * worse than none.
 */
export const MAP_TILES_ENV = 'SIDEQUEST_MAP_TILES';
export const MAP_TILES_ATTRIBUTION_ENV = 'SIDEQUEST_MAP_TILES_ATTRIBUTION';

export interface TileEnvironment {
  [key: string]: string | undefined;
}

/**
 * The configured basemap, or `null` — which is every build today.
 *
 * Deliberately strict. A template that is missing a placeholder, is not HTTPS,
 * or arrives without attribution resolves to `null` rather than to a broken or
 * unlawful layer: the figure below it is complete on its own, so refusing costs
 * the traveller nothing and shipping a misconfiguration costs them a picture
 * they cannot trust.
 */
export function resolveMapTileSource(env: TileEnvironment): MapTileSource | null {
  const template = env[MAP_TILES_ENV]?.trim();
  const attribution = env[MAP_TILES_ATTRIBUTION_ENV]?.trim();
  if (!template || !attribution) return null;
  if (!/^https:\/\//i.test(template)) return null;
  for (const placeholder of ['{z}', '{x}', '{y}']) {
    if (!template.includes(placeholder)) return null;
  }

  const tileSize = Number(env.SIDEQUEST_MAP_TILE_SIZE ?? 256);
  const maxZoom = Number(env.SIDEQUEST_MAP_MAX_ZOOM ?? 19);
  return {
    urlTemplate: template,
    attribution,
    tileSize: Number.isInteger(tileSize) && tileSize > 0 ? tileSize : 256,
    maxZoom: Number.isInteger(maxZoom) && maxZoom > 0 ? maxZoom : 19,
  };
}

export interface PlacedTile {
  z: number;
  x: number;
  y: number;
  href: string;
  /** Where the tile sits in the SVG's own coordinate space. */
  left: number;
  top: number;
  size: number;
}

/**
 * The tiles covering a fitted viewport, placed in the figure's own coordinates.
 *
 * This is the part that has to be right for the seam to be real, and it is the
 * part that is arithmetic rather than judgement — so it is written and tested
 * now, while the terms question is still open, instead of being left as a
 * comment saying somebody could add a map here.
 *
 * The zoom is the shallowest whose tiles are never magnified. The viewport's
 * scale is pixels per world unit and a tile at zoom z covers `1 / 2^z` world
 * units, so a tile is drawn at `scale / 2^z` pixels; requiring that to stay at
 * or below the provider's native tile size gives `z ≥ log2(scale / tileSize)`.
 * Rounding that up rather than down means a tile is shown slightly reduced
 * rather than blown up — a basemap that is soft under the marks is a basemap
 * asserting more precision than it has.
 */
export function tilesForViewport(input: {
  viewport: MapViewport;
  source: MapTileSource;
  /** A hard cap, so a misconfigured zoom cannot emit thousands of images. */
  maxTiles?: number;
}): PlacedTile[] {
  const { viewport, source } = input;
  const maxTiles = input.maxTiles ?? 64;

  const ideal = Math.log2(Math.max(1, viewport.scale) / source.tileSize);
  const zoom = Math.max(0, Math.min(source.maxZoom, Math.ceil(ideal)));
  const count = 2 ** zoom;
  /* One tile's edge, in the figure's coordinates rather than the provider's. */
  const size = viewport.scale / count;

  /*
   * The figure-space position of world (0, 0) — the top-left of the whole
   * Mercator square, which is 180°W at the northern truncation. Every tile is
   * placed from this one anchor rather than from a per-tile projection, so a
   * tile's index and its position cannot round differently from each other.
   */
  const origin = viewport.project({ lat: MAX_MERCATOR_LATITUDE, lng: -180 });
  const worldLeft = (0 - origin.x) / viewport.scale;
  const worldRight = (viewport.width - origin.x) / viewport.scale;
  const worldTop = (0 - origin.y) / viewport.scale;
  const worldBottom = (viewport.height - origin.y) / viewport.scale;

  const firstX = Math.floor(worldLeft * count);
  const lastX = Math.floor(worldRight * count);
  const firstY = Math.floor(worldTop * count);
  const lastY = Math.floor(worldBottom * count);

  const tiles: PlacedTile[] = [];
  for (let y = firstY; y <= lastY; y += 1) {
    for (let x = firstX; x <= lastX; x += 1) {
      if (tiles.length >= maxTiles) return tiles;
      if (y < 0 || y >= count) continue;
      // Longitude wraps; latitude does not.
      const wrapped = ((x % count) + count) % count;
      tiles.push({
        z: zoom,
        x: wrapped,
        y,
        href: source.urlTemplate
          .replace('{z}', String(zoom))
          .replace('{x}', String(wrapped))
          .replace('{y}', String(y)),
        left: origin.x + (x * viewport.scale) / count,
        top: origin.y + (y * viewport.scale) / count,
        size,
      });
    }
  }
  return tiles;
}

/**
 * Re-exported so a caller wiring a basemap has one import rather than two, and
 * so the adapter and the figure provably share a projection: a tile layer under
 * marks produced by a *different* fit would be a map that is wrong in a way
 * nobody could see.
 */
export { fitMercator };
