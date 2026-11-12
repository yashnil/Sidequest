'use client';

import type { JourneyLeg } from '@/lib/journey/model';
import { fitMercator } from '../map-projection';
import { MODE_COLOUR, type JourneyPin } from './JourneyMap';
import { lineKindOf } from './journey-key';
import { clusterMarkers, dayColour } from '../map-clusters';
import { clearOfPinned } from '../map-cluster-layer';

/**
 * THE JOURNEY WITHOUT A BASEMAP — never a blank frame.
 *
 * The explorer's fallback was one line of text ("Drawing the journey…") on a
 * night ground, and it stayed that way whenever WebGL was missing or the style
 * never arrived: a map-shaped hole. This draws the same pins and legs the map
 * would, at their real positions, projected in Web Mercator onto a plain night
 * ground with no coastline, road or border — because none has been read — and
 * says so. Lines keep their evidence: a routed leg solid along its geometry, a
 * straight connection thin and broken.
 */
export function JourneyFallback({ pins, legs, status, cluster = false }: { pins: readonly JourneyPin[]; legs: readonly JourneyLeg[]; status: 'loading' | 'failed'; cluster?: boolean }) {
  const width = 1000;
  const height = 640;
  const shown = pins.filter((pin) => Number.isFinite(pin.lat) && Number.isFinite(pin.lng));
  const focus = shown.filter((pin) => !pin.dim);
  const viewport = fitMercator({ points: focus.length > 0 ? focus : shown, width, height, insets: { top: 150, right: 90, bottom: 190, left: 90 }, minSpanKm: 2.5 });
  const at = (lng: number, lat: number) => viewport.project({ lat, lng });
  /* The same grouping rule as the live map: on the whole trip, overlapping stops are one disc with a count, ringed by their days. */
  const grouped = cluster
    ? clusterMarkers(
        shown.filter((pin) => pin.kind === 'stop' || pin.kind === 'meal').map((pin) => ({ ...at(pin.lng, pin.lat), id: pin.id, lat: pin.lat, lng: pin.lng, label: pin.label, dayNumber: pin.dayNumber })),
        { radius: 40 },
      ).clusters
    : [];
  const beds = shown.filter((pin) => pin.kind === 'base' || pin.kind === 'gateway').map((pin) => at(pin.lng, pin.lat));
  const hidden = new Set(grouped.flatMap((g) => g.members.map((m) => m.id)));
  /* Beds last, so a base is never under a stop or a cluster. */
  const ordered = [...shown.filter((pin) => !hidden.has(pin.id) && pin.kind !== 'base' && pin.kind !== 'gateway'), ...shown.filter((pin) => pin.kind === 'base' || pin.kind === 'gateway')];
  return (
    <div className="absolute inset-0" data-testid="journey-fallback" data-status={status}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice" className="h-full w-full" role="img" aria-label={`${shown.length} places drawn at their real positions, without a basemap.`}>
        <rect width={width} height={height} fill="#0d1a1f" />
        <g opacity={0.18} stroke="#3a5359" strokeWidth={1}>
          {Array.from({ length: 17 }, (_, i) => (
            <line key={`v${i}`} x1={i * 64} y1={0} x2={i * 64} y2={height} />
          ))}
          {Array.from({ length: 11 }, (_, i) => (
            <line key={`h${i}`} x1={0} y1={i * 64} x2={width} y2={i * 64} />
          ))}
        </g>
        {legs
          .filter((leg) => leg.coords.length >= 2)
          .map((leg) => {
            const kind = lineKindOf(leg);
            const points = (kind === 'routed' ? leg.coords : [leg.coords[0]!, leg.coords[leg.coords.length - 1]!]).map(([lng, lat]) => at(lng, lat));
            const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
            const dim = (leg as JourneyLeg & { dim?: boolean }).dim === true;
            return (
              <path
                key={leg.id}
                d={d}
                fill="none"
                stroke={MODE_COLOUR[leg.mode]}
                strokeWidth={kind === 'routed' ? 3.5 : 1.6}
                strokeDasharray={kind === 'routed' ? undefined : kind === 'straight_unknown' ? '0.5 5' : kind === 'arc' ? '8 6' : '6 5'}
                strokeLinecap="round"
                opacity={dim ? 0.25 : kind === 'routed' ? 1 : 0.85}
                data-line-kind={kind}
              />
            );
          })}
        {grouped.map((group) => {
          const [ox, oy] = clearOfPinned(group, beds, 30);
          const g = { ...group, x: group.x + ox, y: group.y + oy };
          const total = g.members.length;
          const counts = [...new Set(g.members.map((m) => m.dayNumber ?? 0))].map((day) => ({ day, n: g.members.filter((m) => (m.dayNumber ?? 0) === day).length }));
          const ring = 2 * Math.PI * 14;
          const arcs = counts.reduce<{ day: number; len: number; off: number }[]>((out, c) => [...out, { day: c.day, len: (c.n / total) * ring, off: -out.reduce((sum, a) => sum + a.len, 0) }], []);
          return (
            <g key={g.key} data-cluster={total}>
              <circle cx={g.x} cy={g.y} r={18} fill="#0d1a1f" />
              {arcs.map((a) => (
                <circle key={a.day} cx={g.x} cy={g.y} r={14} fill="none" stroke={a.day ? dayColour(a.day) : '#a3b1b1'} strokeWidth={5} strokeDasharray={`${a.len.toFixed(2)} ${ring.toFixed(2)}`} strokeDashoffset={a.off.toFixed(2)} transform={`rotate(-90 ${g.x} ${g.y})`} />
              ))}
              <text x={g.x} y={g.y + 4} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fontWeight={600} fill="#f1ebdf">
                {total}
              </text>
            </g>
          );
        })}
        {ordered.map((pin) => {
          const p = at(pin.lng, pin.lat);
          const base = pin.kind === 'base' || pin.kind === 'gateway';
          const fill = pin.kind === 'context' ? '#a3b1b1' : base ? '#f1ebdf' : pin.kind === 'meal' ? '#7fd1e0' : (pin.colour ?? '#ff5a1f');
          const r = pin.kind === 'context' ? 4 : 11;
          return (
            <g key={pin.id} opacity={pin.dim ? 0.4 : 1}>
              {base ? <rect x={p.x - 11} y={p.y - 11} width={22} height={22} rx={3} fill={fill} stroke="#0d1a1f" strokeWidth={1.5} /> : <circle cx={p.x} cy={p.y} r={r} fill={fill} stroke="#0d1a1f" strokeWidth={1.5} />}
              {pin.kind !== 'context' && pin.mark ? (
                <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={11} fontFamily="var(--font-mono)" fontWeight={600} fill="#0d1a1f">
                  {pin.mark}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <p className="pointer-events-none absolute inset-x-4 bottom-[7.5rem] mx-auto max-w-[36ch] text-center text-xs text-bone/70" role="status">
        {status === 'loading' ? 'Loading the map — the places are already at their real positions.' : 'The map could not load here. The places are drawn at their real positions, with no basemap beneath them.'}
      </p>
    </div>
  );
}
