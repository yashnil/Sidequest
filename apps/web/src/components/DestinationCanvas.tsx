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
export function DestinationCanvas({
  geometry,
  tiles = null,
  className,
  destinationText = '',
  placing = false,
  attempted = false,
}: {
  geometry: DestinationGeometry | null;
  tiles?: MapBasemap | null;
  className?: string;
  /** What the traveller has typed. Present and unplaced is a different state from nothing typed. */
  destinationText?: string;
  /** A lookup is in flight for the typed text. */
  placing?: boolean;
  /** A lookup has been made and did not place it. Before that there is nothing to explain. */
  attempted?: boolean;
}) {
  const typed = destinationText.trim();
  /*
   * FOUR STATES, AND "ANYWHERE" IS ONLY THE FIRST OF THEM.
   *
   * STAGING PARITY §6. The canvas had two states — framed, or the empty world
   * captioned ANYWHERE — and every destination a fresh deployment could not place
   * got the second one. A traveller who has typed "Japan" and is looking at the
   * word ANYWHERE is being told the product did not hear them.
   *
   * So the empty world keeps its caption for the case it was written for, which is
   * an empty field, and the two cases in between get their own honest treatment: a
   * quiet frame with the name in it while the lookup runs, and the same frame with
   * the name kept when the lookup found nothing. Neither pretends to be a map, and
   * neither throws away the only thing known for certain — what the traveller
   * said.
   */
  const state = geometry ? 'framed' : typed ? (placing ? 'placing' : 'named') : 'world';
  return (
    <div className={cx('relative min-w-0 overflow-hidden rounded-[var(--radius-plate)] border border-white/10 bg-[var(--color-atlas-raised)]', className)} data-testid="destination-canvas" data-state={state}>
      {geometry ? (
        <div className="destination-canvas-map p-3">
          <DestinationMap geometry={geometry} tiles={tiles} shape="stay_put" />
        </div>
      ) : typed ? (
        <NamedGraticule name={typed} placing={placing} attempted={attempted} />
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

/**
 * The destination named on the atlas ground, while it is being placed or after it could not be.
 *
 * The same graticule as the world, without the ellipse that reads as "somewhere
 * unspecified", and with the traveller's own words as the label. The line
 * underneath is the whole difference between the two cases and is the only place
 * either is explained: nothing about providers, nothing about an index, and no
 * suggestion that the trip cannot go ahead — because it can, and does.
 */
function NamedGraticule({ name, placing, attempted }: { name: string; placing: boolean; attempted: boolean }) {
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
    <figure className="m-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={`${name}, not yet placed on the map`}>
        <rect width={width} height={height} fill="var(--color-atlas-raised)" />
        <path d={lines.join(' ')} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="1" />
        <text x={width / 2} y={height / 2 - 6} textAnchor="middle" fontSize="30" fill="var(--color-atlas-ink, #f5f2ea)" fontFamily="var(--font-display)">
          {name}
        </text>
        <path d={`M${width / 2 - 60} ${height / 2 + 18} H${width / 2 + 60}`} stroke="rgb(255 255 255 / 0.28)" strokeWidth="1" />
      </svg>
      {/*
        Nothing is said until something has been tried.

        The caption used to appear the moment a letter was typed, promising to
        place the destination "as the plan comes together" while the traveller was
        still spelling it — an apology for a lookup that had not happened yet and
        which, one press later, usually succeeds. Silence is the honest state
        while they are still typing.
      */}
      {placing || attempted ? (
        <figcaption className={cx('px-4 pb-4 text-center type-small', placing ? 'breathing' : '')} style={{ color: 'var(--color-atlas-muted)' }} data-testid="destination-canvas-note">
          {placing ? 'Placing this on the map…' : 'Sidequest will place this as the plan comes together.'}
        </figcaption>
      ) : (
        <figcaption className="px-4 pb-4 text-center type-small" style={{ color: 'transparent' }} aria-hidden="true">
          &nbsp;
        </figcaption>
      )}
    </figure>
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
