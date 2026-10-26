import { cx } from '../ui';
import { ledgerMark, scaleBar, type LedgerFacts } from './plate-geometry';
import { baseLine, projectShape, type ShapeInput } from './stamp-geometry';

/**
 * A TRIP'S PLATE — the picture a catalogue entry carries.
 *
 * Two kinds, chosen by what the plan actually persisted:
 *
 * - **`RoutePlate`** — the trip's own coordinates on the survey grid: bases as
 *   numbered squares in sleeping order joined by a dotted line (order, not a
 *   road — the maps' "not measured" stroke), placed stops as dots, the real
 *   a plain scale bar (straight-line distance; the caption says lines are not roads). No basemap, so it
 *   cannot pretend to be a map it is not.
 * - **`LedgerMark`** — for a trip with nothing placed. The name's letterforms,
 *   the months its days fall in (dotted while the dates are open), one tick a
 *   night, one square a person, the frame dashed for an idea and faded once it
 *   is over. Honest about the absence: it says "not on the map yet".
 *
 * Both are pictures of facts the entry also states in words, so both are
 * hidden from assistive technology.
 */

export type PlateDetail = 'full' | 'mini';

export function hasPlacedShape(shape: ShapeInput | undefined): boolean {
  return Boolean(shape && shape.bases.length + shape.stops.length > 0);
}

export function TripPlate({ shape, facts, width, height, detail = 'full', className }: { shape: ShapeInput | undefined; facts: LedgerFacts; width: number; height: number; detail?: PlateDetail; className?: string }) {
  return hasPlacedShape(shape) ? <RoutePlate shape={shape!} width={width} height={height} detail={detail} className={className} /> : <LedgerMark facts={facts} width={width} height={height} detail={detail} className={className} />;
}

export function RoutePlate({ shape, width: W, height: H, detail = 'full', className }: { shape: ShapeInput; width: number; height: number; detail?: PlateDetail; className?: string }) {
  const mini = detail === 'mini';
  const pad = Math.round(Math.min(W, H) * (mini ? 0.16 : 0.17));
  const projected = projectShape(shape, { width: W, height: H, pad });
  const line = baseLine(projected.bases);
  const bar = mini ? null : scaleBar(projected.pxPerDegree, W * 0.24);
  /* Stops in day order, faintly, only when there are no bases to carry the shape. */
  const stopLine = line.length < 2 && projected.stops.length > 1;
  const labelled = !mini && shape.bases.length > 0 && shape.bases.length <= 6;
  const cell = mini ? W / 3 : 48;
  const svg = (
    <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} className={mini ? className : 'block h-auto w-full'} data-plate={mini ? 'route' : undefined} preserveAspectRatio="xMidYMid meet">
      <g stroke="var(--color-ink)" strokeOpacity={mini ? 0.08 : 0.07}>
        {Array.from({ length: Math.floor(W / cell) }, (_, i) => (
          <line key={`v${i}`} x1={round((i + 1) * cell)} y1={0} x2={round((i + 1) * cell)} y2={H} />
        ))}
        {Array.from({ length: Math.floor(H / cell) }, (_, i) => (
          <line key={`h${i}`} x1={0} y1={round((i + 1) * cell)} x2={W} y2={round((i + 1) * cell)} />
        ))}
      </g>
      {stopLine ? <polyline points={projected.stops.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--color-ink)" strokeOpacity={0.35} strokeWidth={mini ? 1 : 1.3} strokeDasharray={mini ? '0.1 3' : '0.1 5'} strokeLinecap="round" strokeLinejoin="round" /> : null}
      {line.length > 1 ? <polyline points={line.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--color-route)" strokeWidth={mini ? 1.6 : 2.2} strokeDasharray={mini ? '0.1 3.2' : '0.1 6'} strokeLinecap="round" strokeLinejoin="round" /> : null}
      <g fill="var(--color-route)" stroke="var(--color-paper-raised)" strokeWidth={mini ? 0.6 : 1.4}>
        {projected.stops.map((s, i) => (
          <circle key={`s${i}`} cx={s.x} cy={s.y} r={mini ? 1.7 : 4.2} />
        ))}
      </g>
      {projected.bases.map((b) => {
        const r = mini ? 3.2 : 10;
        return (
          <g key={`b${b.index}`}>
            <rect x={b.x - r} y={b.y - r} width={r * 2} height={r * 2} fill="var(--color-paper-raised)" stroke="var(--color-ink)" strokeWidth={mini ? 1.2 : 1.5} />
            {mini ? null : (
              <text x={b.x} y={b.y + 3.6} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={10} fill="var(--color-ink)">
                {String(b.index + 1).padStart(2, '0')}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
  if (mini) return svg;
  return (
    <div className={cx('@container relative', className)} data-plate="route">
      {svg}
      {/* Words over the drawing are HTML, so they stay legible at a phone's width instead of shrinking with the viewBox. */}
      {labelled
        ? projected.bases.map((b, i) => {
            /* A repeated base (back to the first town) is labelled once. */
            if (projected.bases.findIndex((o) => Math.abs(o.x - b.x) < 0.5 && Math.abs(o.y - b.y) < 0.5) !== i) return null;
            const right = b.x > W * 0.6;
            return (
              <span
                key={`l${b.index}`}
                aria-hidden="true"
                className="plate-label pointer-events-none absolute max-w-[40%] -translate-y-1/2 truncate font-mono text-[10px] tracking-[0.08em] text-ink uppercase [text-shadow:0_0_3px_var(--color-paper-raised),0_0_3px_var(--color-paper-raised)]"
                style={{ top: pct(b.y, H), ...(right ? { right: `calc(${pct(W - b.x, W)} + 14px)` } : { left: `calc(${pct(b.x, W)} + 14px)` }) }}
              >
                {b.name}
              </span>
            );
          })
        : null}
      {bar ? (
        <span aria-hidden="true" className="absolute right-3 bottom-1 flex flex-col items-end gap-1">
          <span className="block h-1.5 border-x border-b border-ink/70" style={{ width: `${((bar.units / W) * 100).toFixed(2)}cqw` }} />
          <span className="coordbar text-ink-faint">{bar.label}</span>
        </span>
      ) : null}
    </div>
  );
}

const MONTH_INITIALS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/** Three wavy lines and a ring: a postal cancellation, for a trip that is over. A status, not a place. */
function Cancellation({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 120 60" className={className} fill="none" stroke="var(--color-ink)" strokeOpacity={0.4} strokeWidth={1.4}>
      {[14, 26, 38].map((y) => (
        <path key={y} d={`M2 ${y} q 9 -7 18 0 t 18 0 t 18 0 t 18 0 t 18 0 t 18 0`} />
      ))}
    </svg>
  );
}

export function LedgerMark({ facts, width: W, height: H, detail = 'full', className }: { facts: LedgerFacts; width: number; height: number; detail?: PlateDetail; className?: string }) {
  const mark = ledgerMark(facts);
  const accent = mark.frame === 'faded' ? 'var(--color-ink-muted)' : mark.frame === 'dashed' ? 'var(--color-slate-blue)' : 'var(--color-route)';
  const two = mark.letters.length > 1;
  const people = mark.adults + mark.children;
  const nights = mark.nights.drawn + mark.nights.more;

  if (detail === 'mini') {
    /* The index's thumbnail: months along the top, the letters, a tick a night and a square a person along the foot. */
    const ink = 'var(--color-ink)';
    const cellW = (W - 10) / 12;
    const ticks = Math.min(mark.nights.drawn, 12);
    const tickGap = 3;
    return (
      <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} className={className} data-plate="ledger" opacity={mark.frame === 'faded' ? 0.85 : 1}>
        <rect x={0.75} y={0.75} width={W - 1.5} height={H - 1.5} fill="none" stroke={ink} strokeOpacity={0.5} strokeWidth={1} strokeDasharray={mark.frame === 'dashed' ? '3 2.4' : undefined} />
        {mark.datesOpen ? (
          <line x1={5} y1={8} x2={W - 5} y2={8} stroke={ink} strokeOpacity={0.5} strokeWidth={1.2} strokeDasharray="0.1 3" strokeLinecap="round" />
        ) : (
          mark.months.map((on, i) => <rect key={i} x={round(5 + i * cellW + 0.4)} y={5.5} width={round(cellW - 0.8)} height={5} fill={on ? accent : ink} fillOpacity={on ? 1 : 0.12} />)
        )}
        <text x={W / 2} y={H * 0.66} textAnchor="middle" fontFamily="var(--font-display)" fontStyle="italic" fontWeight={340} fontSize={two ? H * 0.4 : H * 0.5} letterSpacing={two ? -1 : 0} fill={ink}>
          {mark.letters}
        </text>
        <g stroke={accent} strokeWidth={1.3}>
          {Array.from({ length: ticks }, (_, i) => (
            <line key={i} x1={round(6 + i * tickGap)} y1={H - 13} x2={round(6 + i * tickGap)} y2={H - 6} />
          ))}
        </g>
        <g fill={ink} fillOpacity={0.75} stroke={ink} strokeWidth={0.8}>
          {Array.from({ length: Math.min(people, 6) }, (_, i) => {
            const child = i >= mark.adults;
            const s = child ? 3.4 : 4.4;
            return <rect key={i} x={round(W - 6 - (Math.min(people, 6) - i) * 6 + (4.4 - s) / 2)} y={round(H - 10.5 + (4.4 - s) / 2)} width={s} height={s} fill={child ? 'none' : ink} />;
          })}
        </g>
        {mark.frame === 'faded' ? (
          <g fill="none" stroke={ink} strokeOpacity={0.35} strokeWidth={1}>
            {[18, 23, 28].map((y) => (
              <path key={y} d={`M${W * 0.46} ${y} q 4 -3 8 0 t 8 0 t 8 0 t 8 0`} />
            ))}
          </g>
        ) : null}
      </svg>
    );
  }

  return (
    <div className={cx('@container relative overflow-hidden', className)} style={{ aspectRatio: `${W} / ${H}` }} data-plate="ledger" aria-hidden="true">
      <div className="survey absolute inset-0 [--survey-cell:48px]" />
      <div className={cx('absolute inset-3 border', mark.frame === 'dashed' ? 'border-dashed border-slate-blue/60' : 'border-ink/25')} />
      {/* The calendar strip: the months the days fall in — or the open question, said as such. */}
      <div className="absolute top-6 left-6 flex min-w-0 items-center gap-3">
        <span className="grid w-[min(15rem,52cqw)] grid-cols-12 gap-px">
          {mark.months.map((on, i) => (
            <span
              key={i}
              className={cx('grid h-5 place-items-center font-mono text-[9px] leading-none', on ? 'text-paper-raised' : mark.datesOpen ? 'border border-dashed border-ink/25 text-ink-faint' : 'bg-ink/[0.06] text-ink-faint')}
              style={on ? { background: accent } : undefined}
            >
              {MONTH_INITIALS[i]}
            </span>
          ))}
        </span>
        <span className="coordbar text-ink-muted">{mark.datesOpen ? 'Dates open' : mark.year}</span>
      </div>
      {/* The name's letterforms, set large and cut by the foot of the plate like a cover line. */}
      <span
        className={cx('absolute bottom-0 left-5 translate-y-[0.2em] font-display leading-[0.8] font-[300] text-ink italic', mark.frame === 'faded' ? 'opacity-70' : '')}
        style={{ fontSize: two ? '40cqw' : '46cqw', letterSpacing: two ? '-0.05em' : '0' }}
      >
        {mark.letters}
      </span>
      {mark.frame === 'faded' ? <Cancellation className="absolute top-[22%] right-[8%] w-[34cqw] -rotate-6" /> : null}
      {/* Who and how long: a square a person, a tick a night. */}
      <div className="absolute right-6 bottom-6 flex flex-col items-end gap-2">
        {people > 0 ? (
          <span className="flex flex-col items-end gap-1">
            <span className="flex gap-1">
              {Array.from({ length: Math.min(people, 12) }, (_, i) => (
                <span key={i} className={cx('block border border-ink', i >= mark.adults ? 'mt-0.5 h-2 w-2' : 'h-2.5 w-2.5 bg-ink/80')} />
              ))}
            </span>
            <span className="coordbar text-ink-muted">
              {mark.adults > 0 ? `${mark.adults} adult${mark.adults === 1 ? '' : 's'}` : ''}
              {mark.children > 0 ? ` · ${mark.children} child${mark.children === 1 ? '' : 'ren'}` : ''}
            </span>
          </span>
        ) : null}
        {nights > 0 ? (
          <span className="flex flex-col items-end gap-1">
            <span className="flex gap-[4px]">
              {Array.from({ length: mark.nights.drawn }, (_, i) => (
                <span key={i} className="block h-4 w-[1.5px]" style={{ background: accent }} />
              ))}
            </span>
            <span className="coordbar text-ink-muted">
              {nights} night{nights === 1 ? '' : 's'}
            </span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function pct(v: number, of: number): string {
  return `${((v / of) * 100).toFixed(2)}%`;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
