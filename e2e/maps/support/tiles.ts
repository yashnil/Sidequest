import { deflateSync } from 'node:zlib';
import type { BrowserContext, Page } from '@playwright/test';

/**
 * A CONTROLLED TILE SOURCE FOR THE INTERACTIVE-MAP SUITE.
 *
 * The production map code runs unchanged — the real Survey Atlas style, the
 * real MapLibre, the real markers, lines and camera — but every request to the
 * tile hosts is answered here, so the suite is reproducible offline and never
 * leans on a volunteer service:
 *
 * - OpenFreeMap's TileJSON is answered with a valid TileJSON;
 * - every vector tile is an empty tile (a valid zero-feature protobuf), so the
 *   map draws its background and our own layers only;
 * - glyph ranges are empty (no basemap labels in tests);
 * - elevation tiles are a SYNTHETIC terrarium field generated here — smooth
 *   hills of a few hundred metres — so the 3D path has real elevation to read.
 *   It exists only in this test harness and is never served by the app.
 *
 * `failTiles` turns the source off to exercise the fallback, and `requests`
 * records what the page asked for so a test can prove nothing escaped.
 */
export interface TileOptions {
  /** Answer the TileJSON with a 500, so the style fails before the map loads. */
  failStyle?: boolean;
  /** Answer every elevation tile with a 404 (no terrain). */
  noElevation?: boolean;
}

export async function routeTiles(target: Page | BrowserContext, options: TileOptions = {}): Promise<{ requests: string[] }> {
  const requests: string[] = [];
  await target.route('https://tiles.openfreemap.org/**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (/\/planet\/?$/.test(url) || url.endsWith('/planet')) {
      if (options.failStyle) return route.fulfill({ status: 500, body: 'tile service down' });
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ tilejson: '3.0.0', tiles: ['https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf'], minzoom: 0, maxzoom: 14, vector_layers: [] }),
      });
    }
    if (url.includes('/fonts/')) return route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) });
    return route.fulfill({ status: 200, contentType: 'application/x-protobuf', body: Buffer.alloc(0) });
  });
  await target.route('https://s3.amazonaws.com/elevation-tiles-prod/**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    if (options.noElevation) return route.fulfill({ status: 404, body: '' });
    const match = /terrarium\/(\d+)\/(\d+)\/(\d+)\.png/.exec(url);
    const [z, x, y] = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
    return route.fulfill({ status: 200, contentType: 'image/png', body: terrariumTile(z, x, y) });
  });
  return { requests };
}

/** A 256×256 terrarium PNG of smooth synthetic hills, continuous across tile edges. */
function terrariumTile(z: number, x: number, y: number): Buffer {
  const size = 256;
  const scale = 2 ** (14 - z);
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (size * 4 + 1)] = 0;
    for (let col = 0; col < size; col += 1) {
      const gx = (x * size + col) * scale;
      const gy = (y * size + row) * scale;
      const metres = 600 + 420 * Math.sin(gx / 9000) * Math.cos(gy / 7000) + 180 * Math.sin(gx / 2300 + gy / 3100);
      const value = metres + 32768;
      const offset = row * (size * 4 + 1) + 1 + col * 4;
      raw[offset] = Math.floor(value / 256);
      raw[offset + 1] = Math.floor(value % 256);
      raw[offset + 2] = Math.floor((value % 1) * 256);
      raw[offset + 3] = 255;
    }
  }
  return png(size, size, raw);
}

function png(width: number, height: number, raw: Buffer): Buffer {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return crc ^ 0xffffffff;
}

/** Wait until a map frame reports itself drawn. */
export async function waitForMap(page: Page, testId: string, timeout = 30_000): Promise<void> {
  await page.waitForFunction((id) => document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-map-health') === 'ready', testId, { timeout });
}
