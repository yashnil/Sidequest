import type { Metadata } from 'next';
import Link from 'next/link';
import { ProductChrome } from '@/components/ProductChrome';
import { buttonClass } from '@/components/ui';
import { AtlasGlobe } from '@/components/landing/AtlasGlobe';
import { HomeReveal } from '@/components/landing/HomeMotion';
import { HowSheet } from '@/components/landing/HowSheet';
import { resolveVectorBasemap } from '@/components/map-adapter';
import { chromeAccount } from '@/lib/auth/chrome';
import { buildFailure } from '@/lib/planning/build-failure';
import { scanPreflight } from '@/lib/discovery-scan/preflight';
import { currentUserId } from '@/lib/auth/session';
import { sessionToken } from '@/lib/net/caller';
import { dashboardRowsFor, lastTouched } from '@/lib/trips/dashboard';
import type { DashboardCardRow } from './trips/TripCard';
import { TripList } from './TripList';

export const dynamic = 'force-dynamic';

/**
 * Every route in the product shared one title, because the root layout set a
 * default and nothing overrode it — so a browser with six Sidequest tabs open
 * showed six identical ones. Each route names itself.
 */
export const metadata: Metadata = {
  title: 'Sidequest — trips built around how you actually travel',
};

/**
 * THE FRONT DOOR.
 *
 * V8 §8. A signed-out visitor understands within seconds: tell Sidequest how
 * you actually travel, get a trip built around you, checked against the real
 * world. One editorial headline, a living atlas beside it (a route drawing
 * itself and three base marks settling in — a claim about no real place),
 * four example destinations that open the composer already filled in, one
 * filled action, three doors as cards with depth, and six short words for what
 * Sidequest adds. Not a twelve-section landing page.
 *
 * A returning visitor still lands on the hero — it is what the site opens to
 * for everyone — and their trips follow directly under it, as the same rich
 * cards the dashboard shows; "All your trips" goes to the dashboard, which is
 * where the lifecycle sections, search and sort live.
 *
 * ## What used to be here and why it went
 *
 * A four-step "How it works" box and three promise paragraphs. Both were
 * true and both were prose about the product where the visitor wanted to see
 * the product: the atlas shows the shape of what is built, the proof strip
 * says the six things it accounts for in six words each, and the doors say
 * what each needs *from you* so nobody picks the wrong one and finds out
 * three screens later.
 *
 * ## Survey Atlas (2026-10)
 *
 * The globe stays the stage and the chrome around it became an instrument: a
 * live coordinate bar, the example journeys as a numbered index on the right
 * edge, the headline rising line by line, and the destination as a typed line
 * on a hairline. Below the fold, the four-step route and the three promises
 * gave way to one ruled sheet (`HowSheet`) that shows the product's own
 * fragments — a question, a board row, a day — and the confidence legend
 * drawn as the maps draw it.
 */




export default async function HomePage() {
  const now = new Date();
  /*
   * Can a new trip be planned here at all? The normal door is scan → board →
   * planner, which needs no model when the open-data fallback is available,
   * so the front page warns only when *that* path is refused — never merely
   * because the model-composed fallback is down. Asked of the same preflight
   * the scan button reads, so the two cannot disagree.
   */
  const scan = scanPreflight();
  const preflight = scan.ok ? ({ ok: true } as const) : ({ ok: false, failure: buildFailure(scan.cause) } as const);
  const globe = resolveVectorBasemap(process.env) !== null;

  /*
   * This browser's trips, not the database's — by what somebody came back
   * for, then by recency. `mint: false`: a page render cannot set a cookie.
   */
  const rows: DashboardCardRow[] = dashboardRowsFor({ userId: await currentUserId(), ownerToken: await sessionToken({ mint: false }) }, now)
    .sort((a, b) => a.progressRank - b.progressRank || b.updatedAt.localeCompare(a.updatedAt))
    .map((row) => ({ ...row, updatedLabel: lastTouched(row.updatedAt, now) }));

  return (
    /* The hero is always the first thing on the page, so the header continues its night. */
    <ProductChrome account={await chromeAccount()} tone="night">
      {/*
        THE HERO — the night sheet, full bleed. The globe is an enhancement
        over a designed still (the example's towns on the survey grid) that is
        complete on its own; the words and the destination field are
        server-rendered and never wait for WebGL.
      */}
      <section aria-labelledby="home-heading" className="survey-night relative isolate overflow-hidden" data-testid="home-hero">
        <div className="relative flex flex-col lg:block lg:min-h-[max(44rem,calc(100svh-var(--chrome-height)))]">
          {/* A readable side for the words on a wide screen, without a box: the ground deepens under them. */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[2] hidden bg-[linear-gradient(90deg,rgb(8_20_26/0.94)_0%,rgb(8_20_26/0.72)_34%,transparent_62%)] lg:block" />
          <div className="pointer-events-none relative z-[4] mx-auto w-full max-w-7xl px-5 pt-9 pb-6 sm:px-8 sm:pt-16 lg:pt-24 lg:pb-40">
            <div className="pointer-events-auto max-w-[38rem]">
              <p className="sheet-label fade-up text-[var(--color-glacier)]">Trip planning that fits how you travel</p>
              <h1 id="home-heading" className="mt-5 font-display text-[clamp(3.5rem,2rem+7vw,8.25rem)] leading-[0.88] font-[380] tracking-[-0.045em] text-[var(--color-atlas-ink)]">
                <span className="mask-rise">
                  <span style={{ ['--d' as string]: '60ms' }}>Take the</span>
                </span>
                <br />
                <span className="mask-rise pr-[0.12em] pb-[0.1em]">
                  <span style={{ ['--d' as string]: '200ms' }}>
                    <em className="font-[300] text-[var(--color-flare)]">detour.</em>
                  </span>
                </span>
              </h1>
              <p className="fade-up mt-5 max-w-[27rem] text-base leading-relaxed sm:mt-6 sm:text-lg text-[var(--color-atlas-muted)]" style={{ ['--d' as string]: '420ms' }}>
                Name a place. Sidequest finds the famous stops and the quiet ones, routes the days, and checks them before you see them.
              </p>
              <div className="fade-up" style={{ ['--d' as string]: '540ms' }}>
                <HomeDestinationForm />
              </div>
              <ul className="fade-up mt-5 flex flex-wrap gap-x-6 gap-y-1 text-sm" style={{ ['--d' as string]: '640ms' }} aria-label="Two ways to start">
                <li>
                  <Link href="/trips/new" className="inline-flex min-h-11 items-center gap-2 font-semibold text-[var(--color-atlas-ink)] underline decoration-white/25 underline-offset-[6px] hover:decoration-[var(--color-flare)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2" data-testid="home-new-trip">
                    I know where I want to go
                  </Link>
                </li>
                <li>
                  <Link href="/decide" className="inline-flex min-h-11 items-center gap-2 font-semibold text-[var(--color-atlas-ink)] underline decoration-white/25 underline-offset-[6px] hover:decoration-[var(--color-flare)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2" data-testid="home-decide">
                    Help me choose
                  </Link>
                </li>
                <li>
                  <Link href="/trips/new?have=plan" className="inline-flex min-h-11 items-center gap-2 text-[var(--color-atlas-muted)] underline decoration-white/15 underline-offset-[6px] hover:text-[var(--color-atlas-ink)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2">
                    I already have a plan
                  </Link>
                </li>
              </ul>
              {!preflight.ok ? (
                <p className="mt-6 max-w-[30rem] border-l-2 border-[var(--color-flare)] pl-4 text-sm leading-relaxed text-[var(--color-atlas-ink)]" data-testid="home-preflight">
                  <strong className="font-semibold">{preflight.failure.heading}</strong> {preflight.failure.message}
                </p>
              ) : null}
            </div>
          </div>
          {/* The globe: behind the words on a wide screen, its own panel under them on a phone. */}
          <div className="relative h-[34rem] sm:h-[36rem] lg:absolute lg:inset-0 lg:h-auto">
            <AtlasGlobe enabled={globe} />
          </div>
        </div>
      </section>

      {rows.length > 0 ? (
        <section className="mx-auto max-w-7xl px-5 pt-12 pb-12 sm:px-8" aria-labelledby="your-trips">
          <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 border-b-[1.5px] border-ink pb-3">
            <div className="min-w-0">
              <p className="sheet-label text-ink-muted">Your journeys · {String(rows.length).padStart(2, '0')}</p>
              <h2 id="your-trips" className="mt-2 font-display text-[clamp(1.9rem,1.5rem+1.4vw,2.6rem)] leading-tight font-[360] tracking-[-0.025em] text-ink">
                Pick up where you left off
              </h2>
            </div>
            <Link href="/trips" className={buttonClass('ghost', 'sm')} data-testid="home-all-trips">
              All your trips
              <span aria-hidden="true">→</span>
            </Link>
          </div>
          <div className="mt-6">
            <TripList rows={rows} />
          </div>
        </section>
      ) : null}

      <HowSheet />

      <section className="survey-night relative isolate overflow-hidden" aria-labelledby="cta-heading">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 py-20 sm:px-8 lg:flex-row lg:items-end lg:justify-between">
          <HomeReveal>
            <p className="sheet-label text-[var(--color-glacier)]">Your turn</p>
            <h2 id="cta-heading" className="mt-4 max-w-2xl font-display text-[clamp(2.4rem,1.6rem+3vw,4.5rem)] leading-[0.95] font-[340] tracking-[-0.035em] text-[var(--color-atlas-ink)]">
              Where are you <em className="font-[300]">thinking</em> of going?
            </h2>
          </HomeReveal>
          <div className="w-full max-w-md">
            <HomeDestinationForm compact />
          </div>
        </div>
      </section>
    </ProductChrome>
  );
}

/**
 * The destination field, in the hero and again at the foot of the page. A
 * plain GET form into the setup flow's own prefill (`?destination=`), so it
 * works before hydration and with JavaScript off.
 *
 * Set as a typed line on a hairline — the way the survey sheet asks a
 * question — with the one flare action at its end.
 */
function HomeDestinationForm({ compact = false }: { compact?: boolean }) {
  const id = compact ? 'home-destination-foot' : 'home-destination';
  return (
    <form action="/trips/new" method="get" className={`group ${compact ? '' : 'mt-9'} w-full max-w-[34rem]`} role="search" aria-label="Start a trip">
      <label htmlFor={id} className="sheet-label text-[var(--color-atlas-muted)]">
        Where to?
      </label>
      <div className="mt-1 flex min-w-0 items-end gap-3 border-b border-white/30 pb-2 transition-colors duration-[var(--motion-fast)] focus-within:border-[var(--color-flare)] hover:border-white/55">
        <input
          id={id}
          name="destination"
          type="text"
          autoComplete="off"
          placeholder="Dolomites in July"
          className="min-h-12 min-w-0 flex-1 bg-transparent font-display text-[1.65rem] leading-tight text-[var(--color-atlas-ink)] italic caret-[var(--color-flare)] placeholder:text-[var(--color-atlas-muted)]/70 focus:outline-none sm:text-[1.9rem]"
          data-testid={id}
        />
        <button type="submit" className="inline-flex min-h-12 shrink-0 items-center gap-2 rounded-full bg-[var(--color-flare)] px-5 text-sm font-semibold text-[var(--color-night)] transition-transform duration-[var(--motion-fast)] hover:scale-[1.02] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2">
          Start
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </form>
  );
}
