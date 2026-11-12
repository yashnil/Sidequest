import Link from 'next/link';
import { AtlasGlobe } from '../landing/AtlasGlobe';
import { DestinationLine } from '../landing/DestinationLine';
import type { DashboardCardRow } from '@/app/(product)/trips/TripCard';
import { StageCover } from './StageCover';
import { YourAtlas, type AtlasTrip } from './YourAtlas';
import { collectionLine } from './stage-model';

/**
 * THE TRIPS HOME'S STAGE — the front page's night, continued past sign-in.
 *
 * 2026-11 visual continuity. Signing in used to drop somebody from a full-bleed
 * night hero with a living globe onto a pale page with a boxed panel and three
 * numbered instructions. The stage is the same ground as the landing hero
 * (`.night-stage`, the chrome continuing it through `data-chrome-tone`), set
 * in the same type, and it changes with what somebody has:
 *
 * - **Nothing yet** — the landing hero's composition with a greeting: the
 *   globe flying through example shapes behind the words (the same lazily
 *   started `AtlasGlobe`, which declines to a designed still), the destination
 *   as a typed line, and the two other doors. No instructions; the globe and
 *   the plates below show what Sidequest makes.
 * - **Some trips** — a greeting with one line of figures, a place to start the
 *   next one, every trip on the world as a mark (`YourAtlas`), and the trip
 *   about to happen as the cover, inside the same night.
 *
 * Server-rendered; only the globe and the cover's menu are client code.
 */
export function DashboardStage({
  name,
  rows,
  atlas,
  cover,
  coverCatalogue,
  nextInDays,
  today,
  globe,
  signedIn,
}: {
  name: string | null;
  rows: readonly DashboardCardRow[];
  atlas: readonly AtlasTrip[];
  cover: DashboardCardRow | null;
  coverCatalogue: number;
  nextInDays: number | null;
  today: string;
  globe: boolean;
  signedIn: boolean;
}) {
  if (rows.length === 0) {
    return (
      <section className="night-stage" aria-labelledby="stage-heading" data-chrome-tone="night" data-testid="dashboard-empty">
        <div className="relative flex flex-col lg:block lg:min-h-[max(40rem,calc(88svh-var(--chrome-height)))]">
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[2] hidden bg-[linear-gradient(90deg,rgb(8_20_26/0.94)_0%,rgb(8_20_26/0.7)_36%,transparent_64%)] lg:block" />
          <div className="pointer-events-none relative z-[4] mx-auto w-full max-w-7xl px-5 pt-10 pb-8 sm:px-8 sm:pt-16 lg:pt-24 lg:pb-36">
            <div className="pointer-events-auto max-w-[38rem]">
              <p className="sheet-label rise-in text-[var(--color-glacier)]">{name ? `Welcome, ${name}` : 'Welcome to Sidequest'}</p>
              <h1 id="stage-heading" className="mt-5 font-display text-[clamp(3.25rem,2rem+6vw,7.5rem)] leading-[0.9] font-[380] tracking-[-0.045em] text-[var(--color-atlas-ink)]">
                <span className="mask-rise">
                  <span style={{ ['--d' as string]: '60ms' }}>Where</span>
                </span>{' '}
                <span className="mask-rise pr-[0.12em] pb-[0.1em]">
                  <span style={{ ['--d' as string]: '200ms' }}>
                    <em className="font-[300] text-[var(--color-flare)]">first?</em>
                  </span>
                </span>
              </h1>
              <p className="rise-in mt-5 max-w-[27rem] text-base leading-relaxed text-[var(--color-atlas-muted)] sm:text-lg" style={{ ['--d' as string]: '60ms' }}>
                A town, a park, a whole country. Name it and the trip starts here.
              </p>
              <div className="rise-in" style={{ ['--d' as string]: '120ms' }}>
                <DestinationLine id="dashboard-destination" className="mt-8" />
              </div>
              <ul className="rise-in mt-5 flex flex-wrap gap-x-6 gap-y-1 text-sm" style={{ ['--d' as string]: '180ms' }} aria-label="Other ways to start">
                <li>
                  <Link href="/decide" className="inline-flex min-h-11 items-center gap-2 font-semibold text-[var(--color-atlas-ink)] underline decoration-white/25 underline-offset-[6px] hover:decoration-[var(--color-flare)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2" data-testid="dashboard-decide">
                    Help me choose where
                  </Link>
                </li>
                <li>
                  <Link href="/trips/new?have=plan" className="inline-flex min-h-11 items-center gap-2 text-[var(--color-atlas-muted)] underline decoration-white/15 underline-offset-[6px] hover:text-[var(--color-atlas-ink)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2">
                    I already have a plan
                  </Link>
                </li>
              </ul>
              {!signedIn ? <p className="rise-in mt-6 text-sm text-[var(--color-atlas-muted)]">Trips you make here stay on this browser until you sign in.</p> : null}
            </div>
          </div>
          <div className="relative h-[30rem] sm:h-[34rem] lg:absolute lg:inset-0 lg:h-auto">
            <AtlasGlobe enabled={globe} eager={false} />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="night-stage" aria-labelledby="stage-heading" data-chrome-tone="night" data-testid="dashboard-stage">
      <div className="mx-auto w-full max-w-7xl px-5 pt-10 pb-4 sm:px-8 sm:pt-14">
        <div className="grid min-w-0 items-end gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="min-w-0">
            <p className="sheet-label rise-in text-[var(--color-glacier)]">{collectionLine(rows, nextInDays)}</p>
            <h1 id="stage-heading" className="mt-4 font-display text-[clamp(2.9rem,1.9rem+4.2vw,5.75rem)] leading-[0.92] font-[340] tracking-[-0.04em] text-[var(--color-atlas-ink)]">
              <span className="mask-rise">
                <span style={{ ['--d' as string]: '60ms' }}>{name ? 'Welcome back,' : 'Welcome'}</span>
              </span>{' '}
              {/* Two set lines, as the front page sets its own: a line count that depends on which font has loaded moved everything under it (a 0.12 layout shift). */}
              <br />
              <span className="mask-rise pr-[0.12em] pb-[0.1em]">
                <span style={{ ['--d' as string]: '180ms' }}>
                  <em className="font-[300] text-[var(--color-flare)]">{name ? `${name}.` : 'back.'}</em>
                </span>
              </span>
            </h1>
            <div className="rise-in" style={{ ['--d' as string]: '140ms' }}>
              <DestinationLine id="dashboard-destination" label="Where next?" placeholder="Somewhere new" size="compact" className="mt-8" />
            </div>
            <p className="rise-in mt-4 text-sm text-[var(--color-atlas-muted)]" style={{ ['--d' as string]: '200ms' }}>
              Not sure?{' '}
              <Link href="/decide" className="font-semibold text-[var(--color-atlas-ink)] underline decoration-white/25 underline-offset-[5px] hover:decoration-[var(--color-flare)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2" data-testid="dashboard-decide">
                Help me choose
              </Link>
            </p>
          </div>
          {atlas.length > 0 ? <YourAtlas trips={atlas} /> : null}
        </div>
        {cover ? <StageCover row={cover} catalogue={coverCatalogue} today={today} /> : <div className="h-8" />}
      </div>
    </section>
  );
}
