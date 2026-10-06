import type { Metadata } from 'next';
import Link from 'next/link';
import { ProductChrome } from '@/components/ProductChrome';
import { buttonClass } from '@/components/ui';
import { chromeAccount } from '@/lib/auth/chrome';
import { buildPreflight } from '@/lib/planning/build-preflight';
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
 * A returning visitor is not a first-time visitor: their trips lead, as the
 * same rich cards the dashboard shows, and "All your trips" goes to the
 * dashboard — which is where the lifecycle sections, search and sort live.
 *
 * ## What used to be here and why it went
 *
 * A four-step "How it works" box and three promise paragraphs. Both were
 * true and both were prose about the product where the visitor wanted to see
 * the product: the atlas shows the shape of what is built, the proof strip
 * says the six things it accounts for in six words each, and the doors say
 * what each needs *from you* so nobody picks the wrong one and finds out
 * three screens later.
 */

/**
 * V11 §B1 — TWO JOBS, NOT THREE DOORS.
 *
 * There were three, weighted equally, below the fold and below a hero whose own
 * call to action was a fourth thing ("New trip") that did not correspond to any
 * of them. A first-time visitor's question is one of exactly two, and the page
 * has about five seconds to show that it answers both.
 *
 * The third door — "I already have a plan" — is not a third job. It is the first
 * job with a list already in hand, and it goes to the same screen. It stays
 * reachable as a line under the two, which is the correct weight for something
 * a minority of visitors want and none of them scan for.
 */
const JOBS = [
  {
    href: '/trips/new',
    title: 'I know where I want to go',
    body: 'Name a town, a region, a park or a country. We work out how much of it your dates can hold.',
    glyph: 'pin',
  },
  {
    href: '/decide',
    title: 'Help me choose',
    body: 'Tell us when you are free and what you are after. We rank real places against your dates.',
    glyph: 'compass',
  },
] as const;

/** Example prompts. Places, not itineraries: nothing here claims a route exists for them. */
const PROMPTS = ['Kenya and Tanzania', 'Ten days in Japan', 'Iceland ring road'];

/**
 * V11 §B1 — FOUR SENTENCES, IN ORDER, ABOUT WHAT HAPPENS.
 *
 * Six unrelated nouns is a feature list, and a feature list is what a visitor
 * skips. These four are the product's actual sequence — it learns, it designs,
 * it checks, it holds the trip together — so reading them in order is reading
 * what Sidequest does. No word here names a model, a provider or a technology,
 * because none of that is what the traveller is buying.
 */
const PROOF: [string, string][] = [
  ['It learns how you travel', 'One adaptive interview, not a form. A hard rule for one person is a hard rule for the group.'],
  ['It designs the route', 'Where you sleep, in what order, and which days are worth the detour.'],
  ['It checks whether it works', 'Every place found on the map, every journey timed where it can be — and said plainly where it cannot.'],
  ['It keeps the trip together', 'What to book, what to pack, what is shut on your dates, and a fallback for the day it rains.'],
];

export default async function HomePage() {
  const now = new Date();
  /*
   * Planning needs a composer, never the research stack: that is optional,
   * behind "Explore experiences first". V1 convergence — asked of the one
   * preflight every build door asks (composer, production fixture guard, a
   * rejected key, the day's shared allowance), so this sentence and the Build
   * button can never disagree.
   */
  const preflight = buildPreflight(null);
  const compileReady = preflight.ok;

  /*
   * This browser's trips, not the database's. `mint: false` because a page
   * render cannot set a cookie — a first-time visitor has no token, and an
   * empty list is the right answer for somebody who has made nothing.
   *
   * By what somebody came back for, then by recency inside that. Sorting by
   * creation date alone is what put the only trip in the database with a
   * finished plan in eighth place, behind seven abandoned drafts.
   */
  const rows: DashboardCardRow[] = dashboardRowsFor({ userId: await currentUserId(), ownerToken: await sessionToken({ mint: false }) }, now)
    .sort((a, b) => a.progressRank - b.progressRank || b.updatedAt.localeCompare(a.updatedAt))
    .map((row) => ({ ...row, updatedLabel: lastTouched(row.updatedAt, now) }));

  return (
    <ProductChrome account={await chromeAccount()}>
      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        {rows.length > 0 ? (
          <section className="mb-14 sm:mb-16" aria-labelledby="your-trips">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <h2 id="your-trips" className="type-title text-ink">
                Pick up where you left off
              </h2>
              <Link href="/trips" className={buttonClass('ghost', 'sm')} data-testid="home-all-trips">
                All your trips
                <span aria-hidden="true">→</span>
              </Link>
            </div>
            <div className="mt-5">
              <TripList rows={rows} />
            </div>
          </section>
        ) : null}

        <section className="grid gap-10 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-center lg:gap-16" aria-labelledby="home-heading">
          <div className="min-w-0">
            <p className="eyebrow">Plan anywhere</p>
            <h1 id="home-heading" className="display-hero mt-4 text-ink">
              The trip you meant to take, and the detour you did not know about.
            </h1>
            <p className="measure mt-6 type-body text-lg text-ink-muted">
              Tell Sidequest how you actually travel. You get a trip built around you and checked
              against the real world — the famous stops, the quiet ones an hour off the road, what is
              shut on your dates, and what to skip.
            </p>

            {/*
              THE TWO JOBS, IN THE HERO, WHERE THE QUESTION IS ASKED.

              They used to be three cards a scroll below a button called "New
              trip" — which is a fourth thing, in our words, corresponding to
              neither question a visitor arrives with.
            */}
            <ul className="mt-8 grid gap-3 sm:grid-cols-2" aria-label="Two ways to start">
              {JOBS.map((job, index) => (
                <li key={job.href} className="min-w-0">
                  <Link
                    href={job.href}
                    className="card lift pressable group flex h-full min-w-0 flex-col gap-2.5 rounded-[var(--radius-panel)] p-5 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                    data-testid={index === 0 ? 'home-new-trip' : 'home-decide'}
                  >
                    <span aria-hidden="true" className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-paper-sunk text-ink">
                      <DoorGlyph kind={job.glyph} />
                    </span>
                    <span className="block font-display text-[1.375rem] leading-tight text-ink group-hover:text-pine">{job.title}</span>
                    <span className="block type-small text-ink-muted">{job.body}</span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2" aria-label="Try a destination">
              <span className="type-small text-ink-faint">Or start from</span>
              {PROMPTS.map((prompt) => (
                <Link
                  key={prompt}
                  href={`/trips/new?destination=${encodeURIComponent(prompt)}`}
                  className="inline-flex min-h-11 items-center text-sm text-ink underline decoration-rule underline-offset-4 hover:text-pine focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                  data-testid="home-prompt"
                >
                  {prompt}
                </Link>
              ))}
            </div>

            <p className="mt-5 type-small text-ink-muted">
              No account needed. Nothing is researched until you have seen what we made of it.{' '}
              <Link href="/trips/new?have=plan" className="underline underline-offset-4 hover:text-pine">
                Already have a plan? Paste it and we will build the region around it.
              </Link>
            </p>

            {!compileReady ? (
              <p className="card mt-6 border-amber bg-amber-soft p-4 text-sm leading-relaxed text-ink">
                <strong className="font-semibold">{preflight.ok ? '' : preflight.failure.heading}</strong> {preflight.ok ? '' : preflight.failure.message}
              </p>
            ) : null}
          </div>

          <LivingAtlas />
        </section>

        {/* WHAT HAPPENS, IN ORDER — four sentences, no sections, no technology. */}
        <section className="mt-14 rule-top pt-8 sm:mt-16" aria-labelledby="proof-heading">
          <h2 id="proof-heading" className="type-small font-semibold text-ink-muted">
            What Sidequest does with that
          </h2>
          <ol className="mt-5 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
            {PROOF.map(([word, line]) => (
              <li key={word} className="min-w-0">
                <p className="font-display text-xl leading-tight text-ink">{word}</p>
                <p className="mt-1.5 type-small text-ink-muted">{line}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </ProductChrome>
  );
}

/**
 * THE LIVING ATLAS.
 *
 * The dark atlas ground with a route drawing itself in and three hollow base
 * marks that settle as the line reaches them. CSS only, on a server component:
 * `route-draw` for the line, a local keyframe for the marks, and both held
 * still under reduced motion. Decorative and `aria-hidden`; the coastline is
 * an invented contour and the marks sit on no coordinates, so nothing here is
 * a claim about a real place.
 */
function LivingAtlas() {
  return (
    <div aria-hidden="true" className="atlas atlas-live relative aspect-[5/4] w-full overflow-hidden rounded-[var(--radius-plate)] shadow-[var(--shadow-raised)] sm:aspect-[4/3]">
      <svg viewBox="0 0 400 300" className="absolute inset-0 h-full w-full" fill="none">
        {/* An invented shoreline: two soft contours in the atlas ink, quieter than the grid. */}
        <path d="M-10 190 C 60 150, 120 210, 190 170 S 320 120, 420 160" stroke="rgb(255 255 255 / 0.08)" strokeWidth={22} strokeLinecap="round" />
        <path d="M-10 215 C 70 180, 140 240, 220 200 S 330 150, 420 190" stroke="rgb(255 255 255 / 0.05)" strokeWidth={34} strokeLinecap="round" />
        {/* The route, drawing itself once. */}
        <path d="M64 216 C 110 160, 160 200, 208 136 S 296 84, 336 100" pathLength={1} className="route-draw" stroke="var(--color-route-bright)" strokeWidth={2.2} strokeLinecap="round" strokeOpacity={0.85} />
        {/* Three bases, settling in as the line reaches them. */}
        <g className="home-atlas-mark" style={{ animationDelay: '150ms' }}>
          <circle cx="64" cy="216" r="7" stroke="var(--color-route-bright)" strokeWidth={2} fill="var(--color-atlas)" />
        </g>
        <g className="home-atlas-mark" style={{ animationDelay: '800ms' }}>
          <circle cx="208" cy="136" r="7" stroke="var(--color-route-bright)" strokeWidth={2} fill="var(--color-atlas)" />
        </g>
        <g className="home-atlas-mark" style={{ animationDelay: '1450ms' }}>
          <circle cx="336" cy="100" r="16" stroke="var(--color-route-bright)" strokeWidth={1} strokeOpacity={0.35} className="breathing" />
          <circle cx="336" cy="100" r="7" stroke="var(--color-route-bright)" strokeWidth={2} fill="var(--color-atlas)" />
        </g>
      </svg>
      {/*
        Stacked below `sm`. Side by side at 360 px the two lines ran into each
        other — "Where you sleep, in" / "order." wrapping under "Then the days
        between." — which is two sentences colliding rather than one caption.
      */}
      <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <p className="font-display text-xl leading-tight text-[var(--color-atlas-ink)] sm:text-2xl">Where you sleep, in order.</p>
        <p className="type-small atlas-muted">Then the days between.</p>
      </div>
      <style>{`
        .home-atlas-mark {
          transform-box: fill-box;
          transform-origin: center;
          animation: home-atlas-settle var(--motion-page) var(--ease-spring) both;
        }
        @keyframes home-atlas-settle {
          from { opacity: 0; transform: scale(0.4); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-reduced-motion: reduce) {
          .home-atlas-mark { animation: none; }
        }
      `}</style>
    </div>
  );
}

function DoorGlyph({ kind }: { kind: 'pin' | 'compass' | 'list' }) {
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  if (kind === 'pin') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" {...stroke}>
        <path d="M12 21s6-5.6 6-11a6 6 0 1 0-12 0c0 5.4 6 11 6 11Z" />
        <circle cx="12" cy="10" r="2.2" />
      </svg>
    );
  }
  if (kind === 'compass') {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" {...stroke}>
        <circle cx="12" cy="12" r="9" />
        <path d="m15.5 8.5-2 5-5 2 2-5Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" {...stroke}>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </svg>
  );
}
