import type { GuideMap, GuideMapPoint } from '@/lib/guide/model';

/**
 * A PRINTED MAP THAT DRAWS ONLY WHAT THE PLAN KNOWS.
 *
 * Web Mercator fitted to the trip's own points, north up, with a scale bar and
 * a graticule. There is no basemap: tile services' terms forbid baking their
 * imagery into a document, and inventing coastlines or roads would draw a
 * place we have not measured. What is drawn is real — the stops and bases at
 * their resolved coordinates, measured legs along the router's own geometry,
 * everything else as a dashed straight line that says it is not a road.
 */

const LINE: Record<string, { dash?: string; width: number; opacity: number }> = {
  measured: { width: 1.6, opacity: 0.95 },
  trail: { width: 1.4, opacity: 0.9, dash: '1.2 2.2' },
  rail: { width: 1.4, opacity: 0.9, dash: '5 2' },
  boat: { width: 1.2, opacity: 0.85, dash: '2.5 2.5' },
  flight: { width: 1, opacity: 0.7, dash: '6 3' },
  estimated: { width: 1.1, opacity: 0.7, dash: '3 2.2' },
  unmeasured: { width: 1, opacity: 0.55, dash: '1.5 2.5' },
};

const toMerc = (lat: number, lng: number) => {
  const clamped = Math.max(-85, Math.min(85, lat));
  return { x: (lng * Math.PI) / 180, y: Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360)) };
};

function niceKm(target: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(Math.max(target, 0.001))));
  for (const step of [5, 2, 1]) if (step * exp <= target) return step * exp;
  return exp;
}

export function GuideMapSvg({
  map,
  width,
  height,
  label,
  lang,
  showNames = false,
}: {
  map: GuideMap;
  width: number;
  height: number;
  label: string;
  lang?: string;
  /** Write base names beside their pins, where they fit. */
  showNames?: boolean;
}) {
  const all = [...map.points.map((p) => ({ lat: p.lat, lng: p.lng })), ...map.lines.flatMap((line) => line.points)];
  const merc = all.map((p) => toMerc(p.lat, p.lng));
  let minX = Math.min(...merc.map((p) => p.x));
  let maxX = Math.max(...merc.map((p) => p.x));
  let minY = Math.min(...merc.map((p) => p.y));
  let maxY = Math.max(...merc.map((p) => p.y));
  const midLat = (Math.min(...all.map((p) => p.lat)) + Math.max(...all.map((p) => p.lat))) / 2;
  const cos = Math.cos((midLat * Math.PI) / 180);
  // Never zoom closer than about 3 km across: one point must not fill the page like a creek.
  const minSpan = 3 / (6371 * Math.max(cos, 0.2));
  if (maxX - minX < minSpan) {
    const c = (maxX + minX) / 2;
    minX = c - minSpan / 2;
    maxX = c + minSpan / 2;
  }
  if (maxY - minY < minSpan) {
    const c = (maxY + minY) / 2;
    minY = c - minSpan / 2;
    maxY = c + minSpan / 2;
  }
  const pad = 26;
  const scale = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxY - minY));
  const offX = (width - (maxX - minX) * scale) / 2;
  const offY = (height - (maxY - minY) * scale) / 2;
  const project = (lat: number, lng: number) => {
    const m = toMerc(lat, lng);
    return { x: offX + (m.x - minX) * scale, y: offY + (maxY - m.y) * scale };
  };
  const fmt = (n: number) => n.toFixed(1);

  /* Scale bar: kilometres per SVG unit at the map's middle latitude. */
  const kmPerUnit = (6371 * cos) / scale;
  const barKm = niceKm(kmPerUnit * width * 0.22);
  const barLen = barKm / kmPerUnit;

  /* Graticule at a round step that gives three to six lines. */
  const lngSpan = ((maxX - minX) * 180) / Math.PI;
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20].find((s) => lngSpan / s <= 6) ?? 30;
  const west = (minX * 180) / Math.PI;
  const east = (maxX * 180) / Math.PI;
  const south = (2 * Math.atan(Math.exp(minY)) - Math.PI / 2) * (180 / Math.PI);
  const north = (2 * Math.atan(Math.exp(maxY)) - Math.PI / 2) * (180 / Math.PI);
  const meridians: number[] = [];
  for (let v = Math.ceil(west / step) * step; v <= east; v += step) meridians.push(v);
  const parallels: number[] = [];
  for (let v = Math.ceil(south / step) * step; v <= north; v += step) parallels.push(v);

  const stops = map.points.filter((p) => p.kind === 'stop');
  const bases = map.points.filter((p) => p.kind === 'base');
  /*
   * Names go beside bases only, and only where they fit: right of the pin,
   * else left, else not at all (the list beside the map names every base).
   */
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const nameFor = (point: GuideMapPoint, x: number, y: number, r: number): { x: number; anchor: 'start' | 'end' } | null => {
    if (!showNames || point.kind !== 'base') return null;
    const w = [...point.name].reduce((sum, ch) => sum + (/[^\u0020-\u024f]/.test(ch) ? 7.6 : 4.1), 0);
    for (const side of ['right', 'left'] as const) {
      const x0 = side === 'right' ? x + r + 2 : x - r - 2 - w;
      const box = { x0, x1: x0 + w, y0: y - 5, y1: y + 4 };
      if (box.x0 < 2 || box.x1 > width - 2) continue;
      if (placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
      placed.push(box);
      return side === 'right' ? { x: x + r + 3, anchor: 'start' } : { x: x - r - 3, anchor: 'end' };
    }
    return null;
  };
  const pin = (point: GuideMapPoint, index: number) => {
    const { x, y } = project(point.lat, point.lng);
    const r = point.label.length > 1 ? 6.4 : 5.6;
    const name = nameFor(point, x, y, r);
    return (
      <g key={`${point.kind}-${index}`}>
        <circle cx={fmt(x)} cy={fmt(y)} r={r} fill={point.kind === 'base' ? 'var(--g-ink)' : 'var(--g-flare)'} stroke="#fff" strokeWidth={1.2} />
        <text x={fmt(x)} y={fmt(y + 2.3)} textAnchor="middle" fontSize={6.6} fontWeight={700} fill="#fff" fontFamily="var(--g-mono)">
          {point.label}
        </text>
        {name ? (
          <text x={fmt(name.x)} y={fmt(y + 2.6)} textAnchor={name.anchor} fontSize={7.6} fontWeight={600} fill="var(--g-ink)" fontFamily="var(--g-sans)" paintOrder="stroke" stroke="#fff" strokeWidth={2.4} strokeLinejoin="round" {...(lang && /[^\u0020-\u024f]/.test(point.name) ? { lang } : {})}>
            {point.name}
          </text>
        ) : null}
      </g>
    );
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} className="guide-map">
      <rect x={0.5} y={0.5} width={width - 1} height={height - 1} fill="var(--g-paper-tint)" stroke="var(--g-rule)" />
      <g stroke="var(--g-rule)" strokeWidth={0.5}>
        {meridians.map((v) => {
          const x = project(0, v).x;
          return <line key={`m${v}`} x1={fmt(x)} x2={fmt(x)} y1={1} y2={height - 1} />;
        })}
        {parallels.map((v) => {
          const y = project(v, 0).y;
          return <line key={`p${v}`} y1={fmt(y)} y2={fmt(y)} x1={1} x2={width - 1} />;
        })}
      </g>
      <g fill="none" stroke="var(--g-flare)" strokeLinecap="round" strokeLinejoin="round">
        {map.lines.map((line, index) => {
          const look = LINE[line.style] ?? LINE.unmeasured!;
          const d = line.points.map((p, i) => {
            const { x, y } = project(p.lat, p.lng);
            return `${i === 0 ? 'M' : 'L'}${fmt(x)} ${fmt(y)}`;
          });
          return <path key={index} d={d.join('')} strokeWidth={look.width} opacity={look.opacity} {...(look.dash ? { strokeDasharray: look.dash } : {})} {...(line.style === 'unmeasured' || line.style === 'estimated' ? { stroke: 'var(--g-ink-muted)' } : {})} />;
        })}
      </g>
      {stops.map((point, index) => pin(point, index))}
      {bases.map((point, index) => pin(point, index + stops.length))}
      <g transform={`translate(${pad - 10} ${height - 14})`} fontFamily="var(--g-mono)" fontSize={6.4} fill="var(--g-ink)">
        <rect x={0} y={-3} width={fmt(barLen)} height={3} fill="var(--g-ink)" />
        <rect x={fmt(barLen / 2)} y={-3} width={fmt(barLen / 2)} height={3} fill="#fff" stroke="var(--g-ink)" strokeWidth={0.5} />
        <text x={fmt(barLen + 4)} y={0}>
          {barKm >= 1 ? `${barKm} km` : `${Math.round(barKm * 1000)} m`}
        </text>
      </g>
      <g transform={`translate(${width - 16} 18)`} fontFamily="var(--g-mono)" fontSize={7} fill="var(--g-ink)" textAnchor="middle">
        <path d="M0 -9 L4 3 L0 0 L-4 3 Z" fill="var(--g-ink)" />
        <text y={12}>N</text>
      </g>
    </svg>
  );
}
