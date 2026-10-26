import { projectShape } from '../collection/stamp-geometry';
import type { AtlasTour } from './atlas-tours';

/**
 * THE DESIGNED STILL — what the hero shows before the globe, and instead of it.
 *
 * An Active Theory lesson: a browser without WebGL (or a visitor who asked to
 * save data) should get a composed image, not an empty box. This is the
 * current example's real towns plotted on the night survey grid with a local
 * equirectangular projection, joined by a dotted line because the line is a
 * sketch of an order, not a road — the same "not measured" stroke the maps
 * use. The caption beside it says "Example shape". Server-renderable, no
 * script, a few hundred bytes of SVG.
 */
const W = 800;
const H = 560;

export function ExampleStill({ tour }: { tour: AtlasTour }) {
  const shape = projectShape({ center: null, bases: tour.stops.map((s) => ({ name: s.name, lat: s.lat, lng: s.lng })), stops: [] }, { width: W, height: H, pad: 130 });
  const points = shape.bases;
  return (
    <div className="survey-night absolute inset-0 [--survey-cell:96px]">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="absolute inset-0 h-full w-full">
        {points.length > 1 ? (
          <polyline key={tour.id} points={points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--color-flare)" strokeWidth={2.4} strokeDasharray="0.1 9" strokeLinecap="round" strokeLinejoin="round" className="fade-up" />
        ) : null}
        {points.map((p, i) => (
          <g key={`${tour.id}-${p.name}`} className="fade-up" style={{ ['--d' as string]: `${120 + i * 110}ms` }}>
            <circle cx={p.x} cy={p.y} r={14} fill="var(--color-flare)" fillOpacity={0.14} />
            <circle cx={p.x} cy={p.y} r={5} fill="var(--color-flare)" stroke="var(--color-night)" strokeWidth={1.5} />
            <text x={p.x} y={p.y + 34} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={16} letterSpacing={2.2} fill="var(--color-bone)" fillOpacity={0.82}>
              {p.name.toUpperCase()}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
