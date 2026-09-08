/**
 * WHERE THE MAP RENDERER IS SERVED FROM, AND THE ONE RULE ABOUT LOADING IT.
 *
 * MapLibre is not bundled. It is copied into `public/vendor/maplibre` by
 * `scripts/vendor-maplibre.mjs` and loaded from there at runtime, because
 * bundling it silently breaks its worker — see that script's header for the
 * measurement. This module holds the paths so the component, the copy script
 * and the test that keeps them honest all read one value.
 *
 * Import-free on purpose: nothing here touches the DOM, the network or
 * `process.env`, so it can be asserted in a plain unit test.
 */

export const MAPLIBRE_VENDOR_PATH = '/vendor/maplibre';
export const MAPLIBRE_MODULE_URL = `${MAPLIBRE_VENDOR_PATH}/maplibre-gl.mjs`;
export const MAPLIBRE_STYLESHEET_URL = `${MAPLIBRE_VENDOR_PATH}/maplibre-gl.css`;
/** The worker MapLibre resolves next to its own module URL. Named here only so a test can check it was copied. */
export const MAPLIBRE_WORKER_URL = `${MAPLIBRE_VENDOR_PATH}/maplibre-gl-worker.mjs`;

/** The renderer's stylesheet, added once per document. Idempotent, and safe to call before the module loads. */
export function ensureMaplibreStylesheet(doc: Document): void {
  const id = 'maplibre-gl-css';
  if (doc.getElementById(id)) return;
  const link = doc.createElement('link');
  link.id = id;
  link.rel = 'stylesheet';
  link.href = MAPLIBRE_STYLESHEET_URL;
  doc.head.appendChild(link);
}
