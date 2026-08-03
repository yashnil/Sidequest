import type { PreflightPortfolio } from '@sidequest/core';

/**
 * WHAT THE TRIP LOOKS LIKE ON THE GROUND, WITHOUT A MAP PLATFORM.
 *
 * A traveller who has typed a country and been told "we found four areas" has no
 * way to check that against what they pictured. This draws it: the proposed
 * bases, the route between them, and the areas we are *not* including — which is
 * the half a list of names hides.
 *
 * It is deliberately **not a map**. No tiles, no basemap, no coastline, no
 * dependency. Every mark is a coordinate that came from an indexed source
 * record, projected linearly into the viewbox. There is no geography here that
 * we did not read from data, which is what makes it safe to show at a stage
 * where nothing has been verified.
 *
 * The projection is equirectangular with a cosine correction on longitude, which
 * is wrong for a continent and right for the few hundred kilometres a trip
 * covers. Saying so here rather than pretending otherwise: this is a diagram of
 * relative position, not a chart anybody should navigate by.
 */

const WIDTH = 320;
const HEIGHT = 210;
/** Room for a label above the topmost mark, and for one below the bottom one. */
const PADDING = 34;

export function ScopePreview({
  portfolio,
  title,
}: {
  portfolio: PreflightPortfolio;
  title: string;
}) {
  const points = [
    ...portfolio.route.map((cluster) => ({ ...cluster, included: true })),
    ...portfolio.excluded.map((entry) => ({ ...entry.cluster, included: false })),
  ];
  if (points.length === 0) return null;

  const lats = points.map((point) => point.center.lat);
  const lngs = points.map((point) => point.center.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  /*
   * A degenerate extent is the single-cluster case, and dividing by it would
   * put every mark at NaN. A small span centres the one point instead.
   */
  const latSpan = Math.max(maxLat - minLat, 0.05);
  const midLat = (minLat + maxLat) / 2;
  const lngScale = Math.max(0.15, Math.cos((midLat * Math.PI) / 180));
  const lngSpan = Math.max((maxLng - minLng) * lngScale, 0.05);
  const span = Math.max(latSpan, lngSpan);

  function project(point: { lat: number; lng: number }): { x: number; y: number } {
    const x =
      PADDING +
      (((point.lng - (minLng + maxLng) / 2) * lngScale) / span + 0.5) * (WIDTH - PADDING * 2);
    // SVG y grows downwards; latitude grows northwards.
    const y = PADDING + (0.5 - (point.lat - midLat) / span) * (HEIGHT - PADDING * 2);
    return { x, y };
  }

  const route = portfolio.route.map((cluster) => ({ cluster, at: project(cluster.center) }));
  const excluded = portfolio.excluded.map((entry) => ({
    cluster: entry.cluster,
    at: project(entry.cluster.center),
  }));

  return (
    <figure className="m-0" data-testid="scope-preview">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-label={`${title}: ${portfolio.route.length} proposed base${portfolio.route.length === 1 ? '' : 's'}${
          excluded.length > 0 ? ` and ${excluded.length} area${excluded.length === 1 ? '' : 's'} left out` : ''
        }`}
      >
        {/* The route between bases, drawn first so the marks sit on top. */}
        {route.length > 1 ? (
          <polyline
            points={route.map((entry) => `${entry.at.x},${entry.at.y}`).join(' ')}
            fill="none"
            stroke="var(--color-pine)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            strokeLinejoin="round"
          />
        ) : null}

        {excluded.map((entry) => (
          <g key={entry.cluster.id}>
            <circle
              cx={entry.at.x}
              cy={entry.at.y}
              r={3}
              fill="none"
              stroke="var(--color-ink-faint)"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          </g>
        ))}

        {route.map((entry, index) => {
          /*
           * Labels alternate above and below the mark.
           *
           * Two bases forty kilometres apart project to points a few pixels
           * apart, and a live capture showed "Bishkek" and "Tokmok" printed over
           * each other — which is worse than no label, because it reads as one
           * corrupted word. Alternating is not a general solution to label
           * collision; it is the cheap one that fixes the case that actually
           * occurs, which is two or three marks in a cluster.
           */
          const above = index % 2 === 0;
          return (
            <g key={entry.cluster.id}>
              <circle
                cx={entry.at.x}
                cy={entry.at.y}
                r={index === 0 ? 5.5 : 4.5}
                fill="var(--color-pine)"
                opacity={index === 0 ? 1 : 0.75}
              />
              <text
                x={entry.at.x}
                y={entry.at.y + (above ? -9 : 16)}
                textAnchor="middle"
                fontSize={9}
                fill="var(--color-ink)"
                stroke="var(--color-paper-raised)"
                strokeWidth={2.5}
                paintOrder="stroke"
              >
                {entry.cluster.name}
              </text>
            </g>
          );
        })}
      </svg>

      <figcaption className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-pine" /> Proposed base
        </span>
        {excluded.length > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full border border-dashed border-ink-faint"
            />{' '}
            Left out
          </span>
        ) : null}
        <span>Relative positions from source coordinates. Not a map.</span>
      </figcaption>
    </figure>
  );
}
