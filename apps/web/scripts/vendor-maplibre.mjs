#!/usr/bin/env node
/**
 * COPY MAPLIBRE OUT OF `node_modules` AND INTO `public/`, UNBUNDLED.
 *
 * MVP V3, P0-2, second half. Repairing the collapsed container made the basemap
 * the right size and still drew nothing, because a second, independent failure
 * was underneath it:
 *
 *   MapLibre renders tiles in a Web Worker, and it locates that worker with
 *   `new Worker(new URL('./maplibre-gl-worker.mjs', import.meta.url), {type:'module'})`.
 *   Put the library through a bundler and `import.meta.url` is a chunk URL, so
 *   the sibling path no longer names the worker. The bundler *does* emit the
 *   worker (`.next/static/media/maplibre-gl-worker.<hash>.mjs`) but nothing
 *   points at it. The result is a worker that starts, receives nothing, requests
 *   no tile, and reports no error: the map renders frame after frame of empty
 *   canvas, `map.loaded()` never becomes true, and the page looks exactly like a
 *   map whose tile host is down.
 *
 *   Measured, both in dev and against a production build: 4 requests to
 *   OpenFreeMap (style, sprite JSON, sprite image, TileJSON) and **zero** tile
 *   requests. The identical style, in the identical browser, loaded from an
 *   unbundled copy on the same origin: tiles requested, `load loaded=true`.
 *
 * So MapLibre is served as what it is — a self-contained ES module with a
 * sibling worker — from this app's own `public/` directory. `import.meta.url` is
 * then the real file URL, the worker resolves next to it, and the whole thing is
 * same-origin, key-free and already covered by the existing CSP (`script-src
 * 'self'`, `worker-src 'self'`).
 *
 * Two further things this buys, neither of them the reason for it:
 *   - ~800 kB of map renderer leaves the application bundle entirely; it is
 *     fetched only by a page that actually draws a map.
 *   - The version on disk is the version in `package.json`, checked by
 *     `map-vendor.test.ts`, so a dependency bump that forgets to re-vendor fails
 *     the suite rather than the browser.
 *
 * Run automatically by `predev` and `prebuild`. The output is generated, not
 * authored, and is git-ignored.
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const repoRoot = join(webRoot, '..', '..');

/** Every file the browser needs. The worker and the shared module are siblings by contract. */
export const VENDORED_FILES = [
  'maplibre-gl.mjs',
  'maplibre-gl-shared.mjs',
  'maplibre-gl-worker.mjs',
  'maplibre-gl.css',
];

export const VENDOR_DIR = join(webRoot, 'public', 'vendor', 'maplibre');
/** The URL the app loads it from. One string, shared with the component through `map-vendor.ts`. */
export const VENDOR_PUBLIC_PATH = '/vendor/maplibre';

function packageDir() {
  for (const candidate of [join(webRoot, 'node_modules', 'maplibre-gl'), join(repoRoot, 'node_modules', 'maplibre-gl')]) {
    try {
      readFileSync(join(candidate, 'package.json'), 'utf8');
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error('maplibre-gl is not installed; run npm install first.');
}

export function vendorMaplibre({ quiet = false } = {}) {
  const source = packageDir();
  const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version;
  rmSync(VENDOR_DIR, { recursive: true, force: true });
  mkdirSync(VENDOR_DIR, { recursive: true });
  for (const file of VENDORED_FILES) {
    copyFileSync(join(source, 'dist', file), join(VENDOR_DIR, file));
  }
  writeFileSync(join(VENDOR_DIR, 'version.json'), `${JSON.stringify({ version, files: VENDORED_FILES }, null, 2)}\n`);
  if (!quiet) console.log(`vendored maplibre-gl ${version} → public${VENDOR_PUBLIC_PATH}`);
  return version;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  vendorMaplibre();
}
