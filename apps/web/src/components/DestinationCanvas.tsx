'use client';

import { DestinationMap, type DestinationGeometry } from './interview/DestinationMap';
import type { MapBasemap } from './map-adapter';
import { cx } from './ui';

/**
 * EXPERIENCE V2 — THE NEW-TRIP CANVAS.
 *
 * Before a destination is chosen the canvas is the world: a quiet graticule on
 * the atlas ground, no place named, nothing invented. The moment a suggestion
 * is picked, the same frame becomes the destination's own map, framed at its
 * extent. The feeling is "I have started going somewhere", not a form.
 */
export function DestinationCanvas({ geometry, tiles = null, className }: { geometry: DestinationGeometry | null; tiles?: MapBasemap | null; className?: string }) {
  return (
    <div className={cx('relative min-w-0 overflow-hidden rounded-[var(--radius-plate)] border border-white/10 bg-[var(--color-atlas-raised)]', className)} data-testid="destination-canvas" data-state={geometry ? 'framed' : 'world'}>
      {geometry ? (
        <div className="destination-canvas-map p-3">
          <DestinationMap geometry={geometry} tiles={tiles} shape="stay_put" />
        </div>
      ) : (
        <WorldGraticule />
      )}
      <style>{`
        .destination-canvas-map :where(p, figcaption, button, span) { color: var(--color-atlas-muted); }
        .destination-canvas-map :where(button) { border-color: rgb(255 255 255 / 0.15); background: transparent; }
      `}</style>
    </div>
  );
}

/** The world as a graticule: an equirectangular grid with the graticule denser near the equator, the way an atlas endpaper reads. */
function WorldGraticule() {
  const width = 640;
  const height = 400;
  const lines: string[] = [];
  for (let lng = -180; lng <= 180; lng += 30) {
    const x = ((lng + 180) / 360) * width;
    lines.push(`M${x.toFixed(1)} 0 V${height}`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * height;
    lines.push(`M0 ${y.toFixed(1)} H${width}`);
  }
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="World grid">
      <rect width={width} height={height} fill="var(--color-atlas-raised)" />
      <path d={lines.join(' ')} fill="none" stroke="rgb(255 255 255 / 0.12)" strokeWidth="1" />
      <ellipse cx={width / 2} cy={height / 2} rx={width * 0.42} ry={height * 0.44} fill="none" stroke="rgb(255 255 255 / 0.18)" strokeWidth="1" />
      <path d={`M${width / 2} 0 V${height}`} stroke="rgb(255 255 255 / 0.22)" strokeWidth="1" />
      <path d={`M0 ${height / 2} H${width}`} stroke="rgb(255 255 255 / 0.22)" strokeWidth="1" />
      <text x={width / 2} y={height - 14} textAnchor="middle" fontSize="11" fill="var(--color-atlas-muted)" fontFamily="var(--font-sans)" letterSpacing="1.5">
        ANYWHERE
      </text>
    </svg>
  );
}
