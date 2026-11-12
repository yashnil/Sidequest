'use client';

import { useEffect } from 'react';

/**
 * The browser-print fallback: when no PDF renderer is configured, the export
 * opens the dedicated print layout with `?print=1` and this opens the dialog
 * once fonts and photographs are ready, so the first page is never set in a
 * fallback face with empty frames.
 */
export function GuideAutoPrint() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('print') !== '1') return;
    let cancelled = false;
    const images = Array.from(document.images).map((image) => (image.complete ? Promise.resolve() : image.decode().catch(() => undefined)));
    void Promise.all([document.fonts.ready, ...images]).then(() => {
      if (!cancelled) window.setTimeout(() => window.print(), 150);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
