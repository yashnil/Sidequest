import { LAND_BITS, LAND_COLS, LAND_NORTH, LAND_ROWS, LAND_STEP } from './world-dots';

/**
 * THE ADVISOR'S WORLD, DRAWN FROM REAL COORDINATES ONLY.
 *
 * A dotted equirectangular world (Natural Earth land, rasterised in
 * `world-dots.ts`), a thinned sample of real destination centres as faint
 * points, and the places currently leading as numbered flare specimens. It is
 * how the interview shows a shortlist forming — and how the shortlist shows
 * where its answers sit relative to each other — without a tile server, a map
 * library or a single invented position.
 *
 * The atlas holds tens of thousands of destinations, so the faint points are a
 * sample the server thins (`world-sample.ts`) and hands over as one string of
 * path data: three elements draw the whole sheet however many dots it carries.
 * The leaders are not looked up in that sample — most of them are not in it —
 * so each is drawn from its own latitude and longitude.
 *
 * Pure SVG and server-renderable.
 */
export interface WorldMark {
  id: string;
  lat: number;
  lng: number;
}

const WIDTH = 360;
const HEIGHT = LAND_ROWS * LAND_STEP;
/*
 * A dot is a hair-length stroke with round caps. Not zero-length: a degenerate
 * subpath is the one case engines have disagreed about, and a hundredth of a
 * degree is invisible.
 */
const DOT = 'h.01';

function project(lat: number, lng: number): { x: number; y: number } {
  return { x: Math.min(WIDTH, Math.max(0, lng + 180)), y: Math.min(HEIGHT, Math.max(0, LAND_NORTH - lat)) };
}

const tenth = (value: number): string => String(Math.round(value * 10) / 10);

/**
 * Path data for a set of destination centres: one dot per distinct position at
 * a tenth of a degree, which is finer than the sheet can show. Built on the
 * server so the browser receives a string rather than a list of places.
 */
export function worldDotsPath(points: readonly { lat: number; lng: number }[]): string {
  const seen = new Set<string>();
  let d = '';
  for (const point of points) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) continue;
    const { x, y } = project(point.lat, point.lng);
    const at = `${tenth(x)} ${tenth(y)}`;
    if (seen.has(at)) continue;
    seen.add(at);
    d += `M${at}${DOT}`;
  }
  return d;
}

/**
 * The land mask as horizontal runs. Each run is one stroked line whose dash
 * pattern (a hair of ink every `LAND_STEP`) leaves a dot per cell, so a
 * continent costs a few hundred short commands rather than thousands of
 * elements.
 */
let land: string | null = null;
function landPath(): string {
  if (land !== null) return land;
  const bytes = typeof atob === 'function' ? Uint8Array.from(atob(LAND_BITS), (c) => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(LAND_BITS, 'base64'));
  const filled = (index: number): boolean => Boolean(bytes[index >> 3]! & (0x80 >> (index & 7)));
  let d = '';
  for (let row = 0; row < LAND_ROWS; row += 1) {
    const y = row * LAND_STEP + LAND_STEP / 2;
    let col = 0;
    while (col < LAND_COLS) {
      if (!filled(row * LAND_COLS + col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < LAND_COLS && filled(row * LAND_COLS + col)) col += 1;
      d += `M${start * LAND_STEP + LAND_STEP / 2} ${y}h${(col - start - 1) * LAND_STEP + 0.01}`;
    }
  }
  land = d;
  return d;
}

export function WorldDots({
  dots = '',
  highlighted,
  tone = 'paper',
  className,
  label,
}: {
  /** Path data from `worldDotsPath`: the faint sample of destination centres. Empty draws land and marks only. */
  dots?: string;
  /** The places to mark, in rank order; the first gets "1". Each is drawn at its own coordinates. */
  highlighted: readonly WorldMark[];
  tone?: 'paper' | 'night';
  className?: string;
  label: string;
}) {
  const landInk = tone === 'night' ? 'rgb(241 235 223 / 0.16)' : 'color-mix(in srgb, var(--color-ink) 16%, transparent)';
  const faint = tone === 'night' ? 'rgb(241 235 223 / 0.36)' : 'color-mix(in srgb, var(--color-ink) 30%, transparent)';
  const ink = tone === 'night' ? 'var(--color-bone)' : 'var(--color-ink)';
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label} className={className} preserveAspectRatio="xMidYMid meet">
      {/* A newly leading place fades in; the global reduced-motion rule flattens it. */}
      <style>{'@keyframes world-mark-in{from{opacity:0}to{opacity:1}}.world-mark{animation:world-mark-in 420ms ease-out both}'}</style>
      <path d={landPath()} fill="none" stroke={landInk} strokeWidth={1.24} strokeLinecap="round" strokeDasharray={`0.01 ${LAND_STEP - 0.01}`} />
      {dots ? <path d={dots} fill="none" stroke={faint} strokeWidth={1.5} strokeLinecap="round" /> : null}
      <g fontFamily="var(--font-mono)" fontSize={5.2} fontWeight={600}>
        {highlighted.map((mark, index) => {
          const { x, y } = project(mark.lat, mark.lng);
          return (
            <g key={mark.id} className="world-mark">
              <circle cx={x} cy={y} r={2.6} fill="var(--color-flare)" />
              <circle cx={x} cy={y} r={5.2} fill="none" stroke={ink} strokeWidth={0.5} opacity={0.6} />
              {highlighted.length > 1 ? (
                <text x={x > WIDTH - 14 ? x - 10.5 : x + 6.5} y={y + 1.8} fill={ink}>
                  {index + 1}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
