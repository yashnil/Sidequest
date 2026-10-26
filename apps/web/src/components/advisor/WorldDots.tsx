import { LAND_BITS, LAND_COLS, LAND_NORTH, LAND_ROWS, LAND_STEP } from './world-dots';

/**
 * THE ADVISOR'S WORLD, DRAWN FROM REAL COORDINATES ONLY.
 *
 * A dotted equirectangular world (Natural Earth land, rasterised in
 * `world-dots.ts`), every catalog destination as a faint point at its own
 * centre, and the places currently leading as numbered flare specimens. It is
 * how the interview shows a shortlist forming — and how the shortlist shows
 * where its answers sit relative to each other — without a tile server, a map
 * library or a single invented position.
 *
 * Pure SVG and server-renderable. Points transition on `r` and opacity so a
 * re-rank reads as the map changing its mind rather than as a redraw.
 */
export interface WorldPoint {
  id: string;
  lat: number;
  lng: number;
  label?: string;
}

let cells: { x: number; y: number }[] | null = null;
function landCells(): { x: number; y: number }[] {
  if (cells) return cells;
  const bytes = typeof atob === 'function' ? Uint8Array.from(atob(LAND_BITS), (c) => c.charCodeAt(0)) : Uint8Array.from(Buffer.from(LAND_BITS, 'base64'));
  const out: { x: number; y: number }[] = [];
  for (let index = 0; index < LAND_COLS * LAND_ROWS; index += 1) {
    if (bytes[index >> 3]! & (0x80 >> (index & 7))) {
      out.push({ x: (index % LAND_COLS) * LAND_STEP + LAND_STEP / 2, y: Math.floor(index / LAND_COLS) * LAND_STEP + LAND_STEP / 2 });
    }
  }
  cells = out;
  return out;
}

const WIDTH = 360;
const HEIGHT = LAND_ROWS * LAND_STEP;

function project(lat: number, lng: number): { x: number; y: number } {
  return { x: lng + 180, y: Math.min(HEIGHT, Math.max(0, LAND_NORTH - lat)) };
}

export function WorldDots({
  points,
  highlighted,
  tone = 'paper',
  className,
  label,
}: {
  points: readonly WorldPoint[];
  /** Ids in rank order; the first gets "1". */
  highlighted: readonly string[];
  tone?: 'paper' | 'night';
  className?: string;
  label: string;
}) {
  const land = tone === 'night' ? 'rgb(241 235 223 / 0.16)' : 'color-mix(in srgb, var(--color-ink) 16%, transparent)';
  const faint = tone === 'night' ? 'rgb(241 235 223 / 0.45)' : 'color-mix(in srgb, var(--color-ink) 38%, transparent)';
  const ink = tone === 'night' ? 'var(--color-bone)' : 'var(--color-ink)';
  const lit = new Map(highlighted.map((id, index) => [id, index]));
  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label} className={className} preserveAspectRatio="xMidYMid meet">
      <g fill={land}>
        {landCells().map((cell) => (
          <circle key={`${cell.x}-${cell.y}`} cx={cell.x} cy={cell.y} r={0.62} />
        ))}
      </g>
      <g>
        {points.map((point) => {
          const { x, y } = project(point.lat, point.lng);
          const rank = lit.get(point.id);
          const on = rank !== undefined;
          return (
            <circle
              key={point.id}
              cx={x}
              cy={y}
              r={on ? 2.6 : 0.9}
              fill={on ? 'var(--color-flare)' : faint}
              opacity={on ? 1 : 0.8}
              style={{ transition: 'r 420ms var(--ease-out, ease), opacity 420ms ease, fill 420ms ease' }}
            />
          );
        })}
      </g>
      <g fontFamily="var(--font-mono)" fontSize={5.2} fontWeight={600}>
        {highlighted.map((id, index) => {
          const point = points.find((candidate) => candidate.id === id);
          if (!point) return null;
          const { x, y } = project(point.lat, point.lng);
          return (
            <g key={id}>
              <circle cx={x} cy={y} r={5.2} fill="none" stroke={ink} strokeWidth={0.5} opacity={0.6} />
              <text x={x + 6.5} y={y + 1.8} fill={ink}>
                {index + 1}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
