import Link from 'next/link';
import { ATLAS_TOURS } from '../landing/atlas-tours';
import { plateRoute, smoothPath } from './stage-model';

const W = 320;
const H = 210;

/**
 * SHAPES TO START FROM — the front page's example journeys, as plates.
 *
 * Each plate is a cut of the night survey sheet with one example's real towns
 * plotted at their real positions and a sketched line through them, which
 * traces itself in full flare when the plate is hovered or focused. It is
 * labelled an example every time, the line is an order and never a road, and
 * pressing it opens the first question with the words filled in — exactly as
 * if they had been typed. No photograph is borrowed to make a place look like
 * somewhere it is not.
 */
export function ExampleShapes() {
  return (
    <section className="mx-auto max-w-7xl px-5 pt-14 pb-4 sm:px-8 sm:pt-20" aria-labelledby="example-shapes" data-testid="dashboard-examples">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-6 gap-y-2 border-b-[1.5px] border-ink pb-3">
        <h2 id="example-shapes" className="font-display text-[clamp(1.9rem,1.5rem+1.4vw,2.6rem)] leading-tight font-[360] tracking-[-0.025em] text-ink">
          Shapes worth <em className="font-[300]">the detour</em>
        </h2>
        <p className="coordbar !whitespace-normal text-ink-muted">Example shapes · press one to start from it</p>
      </div>
      <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {ATLAS_TOURS.map((tour, index) => {
          const points = plateRoute(tour.stops, { width: W, height: H, pad: 34 });
          const d = smoothPath(points);
          /* Labels sit on the side of their point away from the shape's middle, so the line never runs through a name. */
          const cy = points.reduce((sum, p) => sum + p.y, 0) / Math.max(points.length, 1);
          return (
            <li key={tour.id} className="fade-up min-w-0" style={{ ['--d' as string]: `${80 + index * 80}ms` }}>
              <Link
                href={`/trips/new?destination=${encodeURIComponent(tour.prompt)}`}
                className="group block h-full overflow-hidden rounded-[var(--radius-panel)] bg-[var(--color-night)] text-[var(--color-atlas-ink)] transition-transform duration-[var(--motion-base)] ease-[var(--ease-out)] hover:-translate-y-1 focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-pine"
                data-testid="dashboard-example"
              >
                <div className="topo relative [--topo-opacity:0.1] [--topo-size:640px_430px]" style={{ color: 'var(--color-bone)' }}>
                  <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" aria-hidden="true">
                    <path d={d} fill="none" stroke="var(--color-flare)" strokeOpacity={0.38} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
                    <path d={d} pathLength={1} fill="none" stroke="var(--color-flare)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" className="route-trace" />
                    {points.map((p, i) => (
                      <g key={tour.stops[i]!.name}>
                        <circle cx={p.x} cy={p.y} r={i === 0 ? 5 : 3.6} fill={i === 0 ? 'var(--color-bone)' : 'var(--color-flare)'} stroke="var(--color-night)" strokeWidth={1.5} />
                        {i === 0 || i === points.length - 1 ? (
                          <text x={Math.min(W - 6, Math.max(6, p.x))} y={p.y < cy ? p.y - 10 : p.y + 17} textAnchor={p.x < 60 ? 'start' : p.x > W - 60 ? 'end' : 'middle'} fontFamily="var(--font-mono)" fontSize={9} letterSpacing={1.1} fill="rgb(241 235 223 / 0.78)">
                            {tour.stops[i]!.name.toUpperCase()}
                          </text>
                        ) : null}
                      </g>
                    ))}
                  </svg>
                  <span className="coordbar absolute top-3 left-3.5 text-[var(--color-glacier)]">Example · {String(index + 1).padStart(2, '0')}</span>
                </div>
                <div className="border-t border-white/10 px-4 pt-3.5 pb-4">
                  <p className="flex items-baseline justify-between gap-3">
                    <span className="font-display text-xl leading-tight">{tour.prompt}</span>
                    <span className="coordbar shrink-0 text-[var(--color-atlas-muted)]">{tour.days} days</span>
                  </p>
                  <p className="mt-1.5 text-sm leading-snug text-[var(--color-atlas-muted)]">{tour.note}</p>
                  <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[var(--color-atlas-ink)] underline decoration-white/25 underline-offset-[5px] group-hover:decoration-[var(--color-flare)]">
                    Start from this <span aria-hidden="true" className="transition-transform duration-[var(--motion-fast)] group-hover:translate-x-0.5">→</span>
                  </p>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
