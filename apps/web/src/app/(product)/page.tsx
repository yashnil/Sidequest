import type { Metadata } from 'next';
import Link from 'next/link';
import { ProductChrome } from '@/components/ProductChrome';
import { buttonClass } from '@/components/ui';
import { chromeAccount } from '@/lib/auth/chrome';
import { isCompositionModelConfigured, isFixtureComposer } from '@/lib/providers/switches';
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

const INTENTS = [
  {
    href: '/trips/new',
    title: 'I know where I am going',
    body: 'Name a town, a region, a park or a country. We work out how much of it your dates can hold.',
    glyph: 'pin',
  },
  {
    href: '/decide',
    title: 'Help me decide where to go',
    body: 'Tell us when you are free and what you are after. We rank real places against your dates.',
    glyph: 'compass',
  },
  {
    href: '/trips/new?have=plan',
    title: 'I already have a plan',
    body: 'List the places you have lined up. We build the region around them and say which do not fit.',
    glyph: 'list',
  },
] as const;

/** Example prompts. Places, not itineraries: nothing here claims a route exists for them. */
const PROMPTS = ['Kenya and Tanzania', 'Ten days in Japan', 'Iceland ring road', 'Chongqing and the Yangtze'];

/** Six short items, not six sections: what the trip already accounts for when it arrives. */
const PROOF: [string, string][] = [
  ['Route', 'Bases, and the order you sleep in them.'],
  ['Logistics', 'Travel timed where it can be, and said where it cannot.'],
  ['Timing', 'What your dates open, close and crowd.'],
  ['Reality', 'Every named place checked against the map.'],
  ['Travelling as a group', 'One person’s hard rule is the group’s.'],
  ['Preparation', 'What to book, pack and keep a fallback for.'],
];

export default async function HomePage() {
  const now = new Date();
  /* Planning needs a composer, never the research stack: that is optional, behind "Explore experiences first". */
  const compileReady = isFixtureComposer() || isCompositionModelConfigured();

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

            <div className="mt-7 flex flex-wrap items-center gap-2" aria-label="Try a destination">
              <span className="type-small text-ink-faint">Try</span>
              {PROMPTS.map((prompt) => (
                <Link
                  key={prompt}
                  href={`/trips/new?destination=${encodeURIComponent(prompt)}`}
                  className="pressable lift inline-flex min-h-11 items-center rounded-full border border-rule bg-paper-raised px-4 text-sm font-medium text-ink shadow-[var(--shadow-card)] hover:border-ink-faint focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                  data-testid="home-prompt"
                >
                  {prompt}
                </Link>
              ))}
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Link href="/trips/new" className={buttonClass('accent', 'lg')} data-testid="home-new-trip">
                New trip
              </Link>
              <p className="type-small text-ink-muted">No account needed. Nothing is researched until you have seen what we made of it.</p>
            </div>

            {!compileReady ? (
              <p className="card mt-6 border-amber bg-amber-soft p-4 text-sm leading-relaxed text-ink">
                <strong className="font-semibold">This deployment cannot compose a new trip right now.</strong> Trips you have
                already built still open normally.
              </p>
            ) : null}
          </div>

          <LivingAtlas />
        </section>

        {/*
          THREE DOORS, IN THE TRAVELLER'S WORDS.

          Not "Mode 1 / Mode 2 / Mode 3", and not three bordered rows: cards with
          depth that lift under the pointer. Each says what it needs *from you*.
        */}
        <section className="mt-14 sm:mt-16" aria-labelledby="doors-heading">
          <h2 id="doors-heading" className="sr-only">
            Three ways to start
          </h2>
          <ul className="grid gap-4 sm:grid-cols-3">
            {INTENTS.map((intent) => (
              <li key={intent.href} className="min-w-0">
                <Link
                  href={intent.href}
                  className="card lift pressable group flex h-full min-w-0 flex-col gap-3 rounded-[var(--radius-panel)] p-5 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                >
                  <span aria-hidden="true" className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-paper-sunk text-ink">
                    <DoorGlyph kind={intent.glyph} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-display text-[1.375rem] leading-tight text-ink group-hover:text-pine">{intent.title}</span>
                    <span className="mt-1.5 block type-small text-ink-muted">{intent.body}</span>
                  </span>
                  <span aria-hidden="true" className="text-lg text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-pine">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {/* WHAT SIDEQUEST ADDS — six words, one line each, no sections. */}
        <section className="mt-14 rule-top pt-8 sm:mt-16" aria-labelledby="proof-heading">
          <h2 id="proof-heading" className="type-small font-semibold text-ink-muted">
            Already accounted for when the plan arrives
          </h2>
          <ul className="mt-5 grid grid-cols-2 gap-x-6 gap-y-6 sm:grid-cols-3 lg:grid-cols-6">
            {PROOF.map(([word, line]) => (
              <li key={word} className="min-w-0">
                <p className="font-display text-xl leading-tight text-ink">{word}</p>
                <p className="mt-1 type-small text-ink-muted">{line}</p>
              </li>
            ))}
          </ul>
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
      <div className="absolute inset-x-0 bottom-0 flex items-end justify-between p-5 sm:p-6">
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
