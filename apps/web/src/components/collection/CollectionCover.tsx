import Link from 'next/link';
import { LIFECYCLE_LABELS, NEXT_ACTION_KIND_WORD } from '@sidequest/core';
import { DestinationImage, ImageCredit } from '../DestinationImage';
import { TripQuickMenu, type DashboardCardRow } from '@/app/(product)/trips/TripCard';
import { TripStamp } from './TripStamp';
import { baseLine, countdown, countdownWords, formatCatalogue, projectShape } from './stamp-geometry';

/**
 * THE COVER — the trip somebody is about to live, set like an issue cover.
 *
 * Its name in display type, the countdown as a figure, its one next act, and
 * the shape of the trip plotted from its own persisted coordinates on the
 * night survey sheet: bases as numbered squares in sleeping order joined by a
 * dotted line (order, not a road), stops as dots. No coordinates in the
 * corners: they read as noise to anybody who is not a surveyor. No basemap, so nothing here can pretend to be a map it is not.
 * The photograph, when a terms-compliant one is stored, is a print laid on
 * the sheet, whole and credited.
 *
 * Not a `trip-card`, and the same trip is *not* repeated in the catalogue
 * below — it appeared twice, which read as a duplicate. The cover carries the
 * card's menu instead (`TripQuickMenu`), so no action is lost.
 */
const W = 560;
const H = 380;

export function CollectionCover({ row, catalogue, today, onError }: { row: DashboardCardRow; catalogue: number; today: string; onError: (message: string | null) => void }) {
  const projected = projectShape(row.shape ?? { center: null, bases: [], stops: [] }, { width: W, height: H, pad: 56 });
  const line = baseLine(projected.bases);
  const drawn = projected.bases.length + projected.stops.length > 0;
  const c = countdown(row, today);
  const words = countdownWords(c);
  const figure = c.kind === 'until' ? String(c.days) : c.kind === 'during' ? String(c.day).padStart(2, '0') : null;
  const number = formatCatalogue(catalogue);
  /* Numbered specimens while they can be read; past two dozen the stops are a scatter of dots. */
  const numbered = projected.stops.length <= 24;

  return (
    <section className="survey-night relative isolate mt-8 overflow-hidden text-[var(--color-atlas-ink)]" aria-labelledby="collection-cover-title" data-testid="collection-cover">
      <div className="grid min-w-0 gap-8 px-5 py-7 sm:px-8 sm:py-9 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-10">
        <div className="relative z-[1] flex min-w-0 flex-col">
          <p className="sheet-label text-[var(--color-glacier)]">
            Up next <span className="opacity-60">·</span> {LIFECYCLE_LABELS[row.lifecycle]}
          </p>
          <h2 id="collection-cover-title" className="mt-5 font-display text-[clamp(2.6rem,1.6rem+3.6vw,5rem)] leading-[0.95] font-[340] tracking-[-0.035em]">
            <span className="mask-rise">
              <span style={{ ['--d' as string]: '80ms' }}>{row.title}</span>
            </span>
          </h2>
          {row.title !== row.destination ? <p className="mt-2 text-[var(--color-atlas-muted)]">{row.destination}</p> : null}

          {figure ? (
            <div className="fade-up mt-7 flex min-w-0 items-end gap-4" style={{ ['--d' as string]: '260ms' }}>
              <span className="numeral-giant text-[clamp(4.5rem,3rem+5vw,7.5rem)] text-[var(--color-flare)]">{figure}</span>
              <span className="coordbar mb-2 grid gap-1 text-[var(--color-atlas-muted)]">
                <span className="text-[var(--color-atlas-ink)]">{c.kind === 'until' ? (c.days === 1 ? 'day to go' : 'days to go') : `day of ${c.kind === 'during' ? c.of : ''}`}</span>
                <span>{row.dates}</span>
              </span>
            </div>
          ) : (
            <p className="coordbar mt-6 text-[var(--color-atlas-muted)]">{words ?? row.dates}</p>
          )}

          <div className="ruled-night mt-7 min-w-0 border-t border-white/15 text-sm [&>*]:py-2.5">
            <p className="text-[var(--color-atlas-muted)]">
              {row.nights} night{row.nights === 1 ? '' : 's'} · {row.party}
              {row.bases.length > 1 ? ` · ${row.bases.length} places to stay` : ''}
            </p>
            {row.next ? (
              <p className="flex min-w-0 items-start gap-2.5">
                <span className="mt-0.5 inline-flex h-5 shrink-0 items-center border border-white/30 px-1.5 font-mono text-[0.68rem] uppercase tracking-[0.1em] text-[var(--color-atlas-muted)]">{NEXT_ACTION_KIND_WORD[row.next.kind]}</span>
                <Link href={row.next.href} className="min-w-0 underline decoration-white/25 underline-offset-4 hover:decoration-[var(--color-flare)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2">
                  {row.next.title}
                </Link>
              </p>
            ) : null}
          </div>
          <div className="mt-6 flex min-w-0 flex-wrap items-center gap-3 lg:mt-auto lg:pt-6">
            <Link href={row.href} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--color-bone)] px-5 text-sm font-semibold text-[var(--color-night)] transition-transform duration-[var(--motion-fast)] hover:scale-[1.02] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2" data-testid="collection-cover-open">
              {row.nextAction}
              <span aria-hidden="true">→</span>
            </Link>
            <TripQuickMenu row={row} onError={onError} tone="night" />
          </div>
        </div>

        <figure className="relative m-0 min-w-0" aria-label={drawn ? `The shape of ${row.title}: ${row.bases.length} base${row.bases.length === 1 ? '' : 's'} and ${projected.stops.length} placed stop${projected.stops.length === 1 ? '' : 's'}` : `${row.title} has no places on the map yet`}>
          <div className="relative border border-white/15">
            {drawn ? (
              <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden="true">
                <g stroke="rgb(241 235 223 / 0.07)">
                  {Array.from({ length: 7 }, (_, i) => (
                    <line key={`v${i}`} x1={(W / 7) * i} y1={0} x2={(W / 7) * i} y2={H} />
                  ))}
                  {Array.from({ length: 5 }, (_, i) => (
                    <line key={`h${i}`} x1={0} y1={(H / 5) * i} x2={W} y2={(H / 5) * i} />
                  ))}
                </g>
                {/* Without base coordinates the stops carry the shape: joined faintly in day order — an order, not a road. */}
                {line.length < 2 && projected.stops.length > 1 ? (
                  <polyline points={projected.stops.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--color-bone)" strokeOpacity={0.35} strokeWidth={1.4} strokeDasharray="0.1 6" strokeLinecap="round" strokeLinejoin="round" className="fade-up" style={{ ['--d' as string]: '420ms' }} />
                ) : null}
                {line.length > 1 ? (
                  <polyline points={line.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="var(--color-flare)" strokeOpacity={0.9} strokeWidth={2} strokeDasharray="0.1 7" strokeLinecap="round" strokeLinejoin="round" className="fade-up" style={{ ['--d' as string]: '420ms' }} />
                ) : null}
                {projected.stops.map((s, i) =>
                  numbered ? (
                    <g key={`s${i}`} className="fade-up" style={{ ['--d' as string]: `${300 + i * 45}ms` }}>
                      <circle cx={s.x} cy={s.y} r={10} fill="var(--color-flare)" stroke="var(--color-night)" strokeWidth={1.5} />
                      <text x={s.x} y={s.y + 3.3} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={9} fill="var(--color-night)">
                        {String(i + 1).padStart(2, '0')}
                      </text>
                    </g>
                  ) : (
                    <circle key={`s${i}`} cx={s.x} cy={s.y} r={3.6} fill="var(--color-flare)" fillOpacity={0.8} className="fade-up" style={{ ['--d' as string]: `${300 + Math.min(i, 30) * 28}ms` }} />
                  ),
                )}
                {projected.bases.map((b) => (
                  <g key={`b${b.index}`} className="fade-up" style={{ ['--d' as string]: `${500 + b.index * 90}ms` }}>
                    <rect x={b.x - 11} y={b.y - 11} width={22} height={22} fill="var(--color-bone)" stroke="var(--color-night)" strokeWidth={1.5} />
                    <text x={b.x} y={b.y + 3.6} textAnchor="middle" fontFamily="var(--font-mono)" fontSize={10} fill="var(--color-night)">
                      {String(b.index + 1).padStart(2, '0')}
                    </text>
                    {row.shape && row.shape.bases.length <= 6 ? (
                      <text x={b.x > W * 0.62 ? b.x - 16 : b.x + 16} y={b.y + 4} textAnchor={b.x > W * 0.62 ? 'end' : 'start'} fontFamily="var(--font-mono)" fontSize={11} letterSpacing={1.2} fill="var(--color-bone)" fillOpacity={0.85}>
                        {b.name.toUpperCase()}
                      </text>
                    ) : null}
                  </g>
                ))}
              </svg>
            ) : (
              <div className="grid aspect-[56/38] place-items-center">
                <TripStamp id={row.id} name={row.destination} dates={row.timing === 'open' ? 'Dates open' : row.dates} shape={row.shape} catalogue={number} size={220} tone="bone" />
              </div>
            )}
            {row.image ? (
              <div className="print-frame absolute -bottom-3 left-3 w-[34%] max-w-[12rem] rotate-[-2deg] max-sm:hidden">
                <DestinationImage image={row.image} fallback={row.fallback} ratio="natural" credit="none" className="[&>div]:rounded-none" />
                <p className="px-0.5 pt-1.5 pb-2 font-mono text-[9px] uppercase tracking-[0.1em] text-[#5f625c]">{row.destination}</p>
              </div>
            ) : null}
          </div>
          <figcaption className="coordbar mt-2.5 flex min-w-0 flex-wrap justify-between gap-x-4 gap-y-1 whitespace-normal text-[var(--color-atlas-muted)]">
            <span>{!drawn ? 'No places on the map yet' : projected.bases.length > 1 ? 'Where you sleep, in order' : 'Your stops, in order'}</span>
            {line.length > 1 || projected.stops.length > 1 ? (
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="inline-block w-6 border-t-2 border-dotted border-[var(--color-flare)]" /> lines show order, not roads
              </span>
            ) : null}
            {row.image ? <ImageCredit image={row.image} as="span" className="mt-0 min-w-0 normal-case tracking-normal" /> : null}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
