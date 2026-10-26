import { baseLine, idHash, projectShape, stampTilt, type ShapeInput } from './stamp-geometry';

/**
 * A TRIP'S STAMP — the passport page for one journey.
 *
 * A seal drawn from the trip itself: its name and dates set round the ring in
 * mono, and inside the disc the bases in sleeping order (squares joined by a
 * dotted line, because the order you sleep in is not a road and the maps
 * draw "not measured" dotted) with the placed stops as dots. Deterministic —
 * tilt and serial come from the trip id — and never a fake map: with no
 * coordinates the disc stays empty and its inner ring is dotted.
 *
 * Decorative to assistive technology: the entry around it says everything the
 * stamp does in words.
 */
export function TripStamp({
  id,
  name,
  dates,
  shape,
  catalogue,
  size = 168,
  tone = 'ink',
  className,
}: {
  id: string;
  name: string;
  dates: string;
  shape: ShapeInput | undefined;
  catalogue?: string;
  size?: number;
  /** `ink` on paper; `rust` and `slate` are the two stamp inks for trips still ahead; `bone` on the night ground; `faded` for past and archived trips. */
  tone?: 'ink' | 'rust' | 'slate' | 'bone' | 'faded';
  className?: string;
}) {
  const R = 100;
  const ringR = 80;
  const discR = 64;
  const projected = projectShape(shape ?? { center: null, bases: [], stops: [] }, { width: discR * 1.36, height: discR * 1.36, pad: 6 });
  const offset = R - (discR * 1.36) / 2;
  const line = baseLine(projected.bases);
  const drawn = projected.bases.length + projected.stops.length > 0;
  const title = name.toUpperCase();
  const when = (dates || 'Dates open').toUpperCase();
  /* Name over the top arc, dates under the bottom arc, both reading left to right — the way a cancellation stamp is cut. */
  const nameSize = Math.min(14, Math.max(7, (Math.PI * 80 * 0.78) / (Math.max(1, title.length) * 0.68)));
  const dateSize = Math.min(10.5, Math.max(6, (Math.PI * 88 * 0.7) / (Math.max(1, when.length) * 0.68)));
  const serial = (idHash(id) % 0xffff).toString(16).toUpperCase().padStart(4, '0');
  const ink = tone === 'bone' ? 'var(--color-bone)' : tone === 'rust' ? 'var(--color-route)' : tone === 'slate' ? 'var(--color-slate-blue)' : 'var(--color-ink)';
  const route = tone === 'bone' ? 'var(--color-flare)' : tone === 'rust' ? 'var(--color-ink)' : 'var(--color-route)';
  const pathId = `stamp-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 200"
      width={size}
      height={size}
      className={className}
      style={{ transform: `rotate(${stampTilt(id)}deg)`, opacity: tone === 'faded' ? 0.7 : 1 }}
      data-stamp={drawn ? 'drawn' : 'empty'}
    >
      <defs>
        <path id={`${pathId}-top`} d={`M ${R - ringR} ${R} A ${ringR} ${ringR} 0 0 1 ${R + ringR} ${R}`} />
        <path id={`${pathId}-bottom`} d={`M ${R - 86} ${R} A 86 86 0 0 0 ${R + 86} ${R}`} />
      </defs>
      <g fill="none" stroke={ink}>
        <circle cx={R} cy={R} r={95} strokeWidth={2.2} strokeOpacity={0.9} />
        <circle cx={R} cy={R} r={90.5} strokeWidth={0.7} strokeOpacity={0.7} />
        <circle cx={R} cy={R} r={discR + 2} strokeWidth={0.9} strokeOpacity={0.75} strokeDasharray={drawn ? undefined : '1.2 3.2'} strokeLinecap="round" />
      </g>
      <text fill={ink} fillOpacity={0.92} fontFamily="var(--font-mono)" fontSize={nameSize} fontWeight={600} letterSpacing={nameSize * 0.14}>
        <textPath href={`#${pathId}-top`} startOffset="50%" textAnchor="middle">
          {title}
        </textPath>
      </text>
      <text fill={ink} fillOpacity={0.8} fontFamily="var(--font-mono)" fontSize={dateSize} letterSpacing={dateSize * 0.12}>
        <textPath href={`#${pathId}-bottom`} startOffset="50%" textAnchor="middle">
          {when}
        </textPath>
      </text>
      <g fill={ink} fillOpacity={0.8}>
        <circle cx={R - ringR - 4} cy={R} r={1.6} />
        <circle cx={R + ringR + 4} cy={R} r={1.6} />
      </g>
      <g transform={`translate(${offset} ${offset})`}>
        {line.length > 1 ? <polyline points={line.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={route} strokeWidth={1.6} strokeDasharray="0.1 3.4" strokeLinecap="round" strokeLinejoin="round" /> : null}
        {projected.stops.map((s, i) => (
          <circle key={`s${i}`} cx={s.x} cy={s.y} r={1.7} fill={route} fillOpacity={0.85} />
        ))}
        {projected.bases.map((b) => (
          <rect key={`b${b.index}`} x={b.x - 3.2} y={b.y - 3.2} width={6.4} height={6.4} fill={tone === 'bone' ? 'var(--color-night)' : 'var(--color-paper-raised)'} stroke={ink} strokeWidth={1.3} />
        ))}
        {!drawn && projected.center ? (
          <g stroke={ink} strokeOpacity={0.6} strokeWidth={0.9}>
            <line x1={projected.center.x - 7} y1={projected.center.y} x2={projected.center.x + 7} y2={projected.center.y} />
            <line x1={projected.center.x} y1={projected.center.y - 7} x2={projected.center.x} y2={projected.center.y + 7} />
          </g>
        ) : null}
      </g>
      <text x={R} y={R + discR - 17} textAnchor="middle" fill={ink} fillOpacity={0.7} fontFamily="var(--font-mono)" fontSize={7} letterSpacing={1.1}>
        {catalogue ? `${catalogue.toUpperCase()} · ${serial}` : `SQ · ${serial}`}
      </text>
    </svg>
  );
}
