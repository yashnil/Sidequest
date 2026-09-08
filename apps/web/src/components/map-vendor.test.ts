import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAPLIBRE_MODULE_URL, MAPLIBRE_STYLESHEET_URL, MAPLIBRE_WORKER_URL, MAPLIBRE_VENDOR_PATH } from './map-vendor';
import { VENDORED_FILES, VENDOR_DIR, VENDOR_PUBLIC_PATH } from '../../scripts/vendor-maplibre.mjs';

/**
 * THE MAP RENDERER MUST BE ON DISK, UNBUNDLED, AT THE VERSION THIS APP INSTALLED.
 *
 * MVP V3, P0-2. Bundling MapLibre breaks its worker silently: the map renders an
 * empty canvas, requests no tile and raises no error. The fix is to serve it as a
 * plain module from `public/`, and the failure mode of *that* fix is somebody
 * bumping the dependency without re-running the copy — which would leave the
 * browser on an old renderer with no sign of it anywhere. Hence this file.
 */

const packageVersion = () => {
  for (const candidate of [
    join(__dirname, '..', '..', 'node_modules', 'maplibre-gl', 'package.json'),
    join(__dirname, '..', '..', '..', '..', 'node_modules', 'maplibre-gl', 'package.json'),
  ]) {
    if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8')).version as string;
  }
  throw new Error('maplibre-gl is not installed');
};

describe('the vendored map renderer', () => {
  it('the component and the copy script agree on one public path', () => {
    expect(MAPLIBRE_VENDOR_PATH).toBe(VENDOR_PUBLIC_PATH);
    expect(MAPLIBRE_MODULE_URL).toBe(`${VENDOR_PUBLIC_PATH}/maplibre-gl.mjs`);
    expect(MAPLIBRE_STYLESHEET_URL).toBe(`${VENDOR_PUBLIC_PATH}/maplibre-gl.css`);
    expect(MAPLIBRE_WORKER_URL).toBe(`${VENDOR_PUBLIC_PATH}/maplibre-gl-worker.mjs`);
  });

  it('every file the browser needs has been copied', () => {
    for (const file of VENDORED_FILES) {
      const path = join(VENDOR_DIR, file);
      expect(existsSync(path), `${file} has not been vendored — run npm run vendor:maplibre`).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(1000);
    }
  });

  it('the worker sits beside the module, which is how MapLibre finds it', () => {
    // Not a stylistic preference: `new Worker(new URL('./maplibre-gl-worker.mjs', import.meta.url))`
    // is how the library resolves it, so the two must be siblings on the served origin.
    expect(MAPLIBRE_WORKER_URL.replace(/\/[^/]+$/, '')).toBe(MAPLIBRE_MODULE_URL.replace(/\/[^/]+$/, ''));
  });

  it('is the version this app installed', () => {
    const stamped = JSON.parse(readFileSync(join(VENDOR_DIR, 'version.json'), 'utf8')) as { version: string };
    expect(stamped.version, 'the vendored renderer is stale — run npm run vendor:maplibre').toBe(packageVersion());
  });
});
