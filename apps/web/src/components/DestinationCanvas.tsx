'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DestinationMap, type DestinationGeometry } from './interview/DestinationMap';
import { CANVAS_S, timing } from './interview/choreography';
import type { MapBasemap } from './map-adapter';
import { cx } from './ui';

/**
 * EXPERIENCE V2 — THE NEW-TRIP CANVAS.
 *
 * Before a destination is chosen the canvas is the world: a quiet graticule on
 * the atlas ground, no place named, nothing invented. The moment a suggestion
 * is picked, the same frame becomes the destination's own map, framed at its
 * extent. The feeling is "I have started going somewhere", not a form.
 *
 * V8 — the four states hand over to each other with motion rather than by
 * replacement: the typed name settles onto the graticule, the placing note
 * breathes while a lookup runs, and the map crossfades in over the graticule
 * (≤ 420 ms, none under reduced motion) instead of swapping. `data-state`
 * stays the truth the browser suite reads (`destination-placing.spec.ts`).
 */
export function DestinationCanvas({
  geometry,
  tiles = null,
  className,
  destinationText = '',
  placing = false,
  attempted = false,
  scope = null,
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
  /** The scope in human words ("A whole country"), shown only once the place is framed and only when there are words for it. */
  scope?: string | null;
}) {
  const reduced = useReducedMotion();
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
  /* The graticule is one surface across `world`, `named` and `placing`; only the map is a different one. */
  const surface = geometry ? 'map' : 'graticule';
  const fade = timing(CANVAS_S, reduced);
  return (
    <div className={cx('relative min-w-0 overflow-hidden rounded-[var(--radius-plate)] border border-white/10 bg-[var(--color-atlas-raised)]', className)} data-testid="destination-canvas" data-state={state}>
      <AnimatePresence initial={false} mode="sync">
        {surface === 'map' && geometry ? (
          <motion.div key="map" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, position: 'absolute', inset: 0 }} transition={fade} className="destination-canvas-map p-3">
            {scope ? (
              <p className="type-meta mb-2 px-1" style={{ color: 'var(--color-atlas-muted)' }} data-testid="destination-canvas-scope">
                {scope}
              </p>
            ) : null}
            <DestinationMap geometry={geometry} tiles={tiles} shape="stay_put" />
          </motion.div>
        ) : (
          <motion.div key="graticule" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, position: 'absolute', inset: 0 }} transition={fade}>
            {typed ? <NamedGraticule name={typed} placing={placing} attempted={attempted} reduced={reduced} /> : <WorldGraticule />}
          </motion.div>
        )}
      </AnimatePresence>
      <style>{`
        .destination-canvas-map :where(p, figcaption, button, span) { color: var(--color-atlas-muted); }
        .destination-canvas-map :where(button) { border-color: rgb(255 255 255 / 0.15); background: transparent; }
      `}</style>
    </div>
  );
}

const WIDTH = 640;
const HEIGHT = 400;

/** The equirectangular grid both graticules share: denser near the equator, the way an atlas endpaper reads. */
function gridPath(): string {
  const lines: string[] = [];
  for (let lng = -180; lng <= 180; lng += 30) {
    const x = ((lng + 180) / 360) * WIDTH;
    lines.push(`M${x.toFixed(1)} 0 V${HEIGHT}`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * HEIGHT;
    lines.push(`M0 ${y.toFixed(1)} H${WIDTH}`);
  }
  return lines.join(' ');
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
function NamedGraticule({ name, placing, attempted, reduced }: { name: string; placing: boolean; attempted: boolean; reduced: boolean | null }) {
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label={`${name}, not yet placed on the map`}>
        <rect width={WIDTH} height={HEIGHT} fill="var(--color-atlas-raised)" />
        <path d={gridPath()} fill="none" stroke="rgb(255 255 255 / 0.08)" strokeWidth="1" />
        {/* The name settles in once, when words first appear; it does not re-enter on every keystroke. */}
        <motion.g initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={timing(CANVAS_S * 0.6, reduced)}>
          <text x={WIDTH / 2} y={HEIGHT / 2 - 6} textAnchor="middle" fontSize="30" fill="var(--color-atlas-ink, #f5f2ea)" fontFamily="var(--font-display)">
            {name}
          </text>
          <path d={`M${WIDTH / 2 - 60} ${HEIGHT / 2 + 18} H${WIDTH / 2 + 60}`} stroke="rgb(255 255 255 / 0.28)" strokeWidth="1" />
        </motion.g>
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

/** The world as a graticule, before anything has been said. */
function WorldGraticule() {
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="h-auto w-full" role="img" aria-label="World grid">
      <rect width={WIDTH} height={HEIGHT} fill="var(--color-atlas-raised)" />
      <path d={gridPath()} fill="none" stroke="rgb(255 255 255 / 0.12)" strokeWidth="1" />
      <ellipse cx={WIDTH / 2} cy={HEIGHT / 2} rx={WIDTH * 0.42} ry={HEIGHT * 0.44} fill="none" stroke="rgb(255 255 255 / 0.18)" strokeWidth="1" />
      <path d={`M${WIDTH / 2} 0 V${HEIGHT}`} stroke="rgb(255 255 255 / 0.22)" strokeWidth="1" />
      <path d={`M0 ${HEIGHT / 2} H${WIDTH}`} stroke="rgb(255 255 255 / 0.22)" strokeWidth="1" />
      <text x={WIDTH / 2} y={HEIGHT - 14} textAnchor="middle" fontSize="13" fill="var(--color-atlas-muted)" fontFamily="var(--font-sans)" letterSpacing="1.5">
        ANYWHERE
      </text>
    </svg>
  );
}
