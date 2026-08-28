import type { Metadata } from 'next';
import Link from 'next/link';
import { countNights, isAbandoned } from '@sidequest/core';
import { ProductChrome } from '@/components/ProductChrome';
import { Panel, buttonClass } from '@/components/ui';
import { providerReadiness } from '@/lib/compiler/readiness';
import { adoptedCompiledRegionId, getLatestJob } from '@/lib/db/compiler-repository';
import { hasItinerary, listTrips } from '@/lib/db/repository';
import { sessionToken } from '@/lib/net/caller';
import { formatDayRange } from '@/lib/format/dates';
import { tripProgress } from '@/lib/format/trip-progress';
import { TripList, type TripListRow } from './TripList';

export const dynamic = 'force-dynamic';

/**
 * Every route in the product shared one title, because the root layout set a
 * default and nothing overrode it — so a browser with six Sidequest tabs open
 * showed six identical ones, and a screen-reader user heard the marketing
 * sentence on arrival at every screen. Each route this slice touches now names
 * itself.
 */
export const metadata: Metadata = {
  title: 'Sidequest — trips built around how you actually travel',
};

/**
 * THE FRONT DOOR.
 *
 * Four things a visitor must be able to get in about one glance (§5): what this
 * does, why it is different from the other thing they could open, what they can
 * do here, and why the output is worth the wait. And one thing a *returning*
 * visitor must be able to do, which this page could not: find their own trips
 * and tell them apart.
 *
 * ## What was here and why it went
 *
 * **Two doors, not three.** "I know where I am going" and "Help me decide" were
 * presented as the whole product. The third intent — somebody who already has a
 * plan and wants it stress-tested — existed as a grey footnote on another page
 * reading "Coming later", which is a promise made where nobody who wants it will
 * look. It is a real door now, and the copy on it says exactly what this build
 * does with an existing plan and what it does not: it rebuilds the days around
 * the places you name and tells you which of them do not fit. It does not
 * critique your plan, and it does not claim to.
 *
 * **A trip list that could not describe a trip.** `slice(0, 8)` by creation
 * date, with a ternary for the label. See `tripProgress` and `TripList` for the
 * two halves of that repair.
 *
 * **An index-statistics banner.** "Destination search covers 109,853 places
 * worldwide, from the overture 2026-07-22.0 release." A catalogue release id and
 * a six-figure count are what §5 means by a fake user count: a big number
 * offered as proof, about a thing nobody asked about, in the vocabulary of the
 * system rather than of the trip. What replaced it is a sentence about whether
 * this deployment can research a new destination *today*, which is the only fact
 * on that banner a traveller could ever act on.
 */

const INTENTS = [
  {
    href: '/trips/new',
    title: 'I know where I am going',
    body: 'Name a town, a region, a park or a country. We work out how much of it your dates can hold.',
    kind: 'primary' as const,
  },
  {
    href: '/decide',
    title: 'Help me decide where to go',
    body: 'Tell us when you are free and what you are after. We rank real places against your dates.',
    kind: 'secondary' as const,
  },
  {
    href: '/trips/new?have=plan',
    title: 'I already have a plan',
    body: 'List the places you have lined up. We build the region around them and say which do not fit.',
    kind: 'secondary' as const,
  },
];

const PROMISES = [
  {
    title: 'It thinks in regions',
    body: 'A town becomes the valley it sits in; a country becomes the two or three parts of it a trip can actually hold. What gets left out is named, with the reason.',
  },
  {
    title: 'It ranks by fit, not by reviews',
    body: 'A quiet viewpoint can outrank the postcard shot if you said crowds ruin a place. Every card explains itself using your own answers.',
  },
  {
    title: 'It tells you what will not work',
    body: 'Closed on your dates, four hours further than it looks, or open only in summer — you find that out here rather than at the gate.',
  },
];

const STEPS: [string, string][] = [
  ['Say where, or say when', 'A destination you know, or dates and preferences and no idea yet.'],
  ['We shape the region', 'Areas, bases, travel times and how much your dates can hold.'],
  ['We check the sources', 'Opening hours, access, seasonal closures and cost, from whoever publishes them.'],
  ['You get a plan', 'Day by day, with what we could not establish said out loud.'],
];

export default async function HomePage() {
  const now = new Date();
  /*
   * Whether a typed destination can be researched at all on this deployment.
   *
   * The one fact worth keeping from the banner this page used to end with. It
   * appears only when the answer is no: "Everything else works" told nobody
   * anything, and the failing case is the one that cost a founder fifteen
   * minutes of questionnaire before the flow admitted it could not build.
   * `readiness.ts` imports nothing, which is what makes asking this free.
   */
  const compileReady = providerReadiness().ready;

  /**
   * WHAT EACH TRIP ACTUALLY IS, FROM FACTS THAT ARE CHEAP TO READ.
   *
   * Three reads per trip and not one of them parses a compiled region: a
   * homepage listing sixty trips must not deserialise sixty artifacts to write
   * sixty labels. The job row already carries the artifact pointer and the
   * heartbeat, and `trips.status` already carries whether anybody answered the
   * questionnaire — `saveProfile` sets it. `tripProgress` decides what the
   * combination means, and is tested without a database.
   */
  /*
   * This browser's trips, not the database's.
   *
   * `listTrips()` took no owner and this heading says "your trips" over the
   * result, which on the live database meant a visitor was shown a hundred and
   * eighty strangers' plans with a Remove button on each. `mint: false` because
   * a page render cannot set a cookie — a first-time visitor has no token, and
   * an empty list is the right answer for somebody who has made nothing.
   */
  const rows: TripListRow[] = listTrips(await sessionToken({ mint: false }))
    .map((trip) => {
      const job = getLatestJob(trip.id);
      const progress = tripProgress({
        status: trip.status,
        jobState: job?.state ?? null,
        jobLive: job ? !isAbandoned(job, now) : false,
        /*
         * The region the *trip* stands on, not the one its last job produced.
         * See `adoptedCompiledRegionId`: an edit clears the first and leaves
         * the second, and reading the job sent an edited trip to a 404.
         */
        hasCompiledRegion: adoptedCompiledRegionId(trip.id) !== null,
        hasItinerary: hasItinerary(trip.id),
      });
      return {
        id: trip.id,
        destination: trip.basics.destinationInput,
        dates: formatDayRange(trip.basics.startDate, trip.basics.endDate),
        nights: countNights(trip.basics.startDate, trip.basics.endDate),
        state: progress.state,
        label: progress.label,
        action: progress.action,
        href: progress.path(trip.id),
        tone: progress.tone,
        rank: progress.rank,
        updatedAt: trip.updatedAt,
      };
    })
    /*
     * By what somebody came back for, then by recency inside that. Sorting by
     * creation date alone is what put the only trip in the database with a
     * finished plan in eighth place, behind seven abandoned drafts of the same
     * destination.
     */
    .sort((a, b) => a.rank - b.rank || b.updatedAt.localeCompare(a.updatedAt))
    .map(({ rank: _rank, updatedAt: _updatedAt, ...row }) => row);

  return (
    <ProductChrome>
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-16">
          <section>
            <p className="eyebrow">Plan anywhere</p>
            <h1 className="mt-4 font-display text-4xl leading-[1.08] text-ink sm:text-5xl">
              The trip you meant to take, and the detour you did not know about.
            </h1>
            <p className="measure mt-6 text-lg leading-relaxed text-ink-muted">
              Answer one set of questions and Sidequest works out what is actually worth your time —
              the famous stops, the quiet ones an hour off the road, what is shut on your dates, and
              what to skip. Ranked by how you travel, not by how many people have reviewed it.
            </p>

            {/*
              THREE DOORS, IN THE TRAVELLER'S WORDS.

              Not "Mode 1 / Mode 2 / Mode 3", and not three identical cards
              either: the first is the one most people want and is the only
              filled control on the page. Each says what it needs *from you*, so
              nobody picks the wrong one and finds out three screens later.
            */}
            <ul className="mt-8 space-y-3">
              {INTENTS.map((intent) => (
                <li key={intent.href}>
                  <Link
                    href={intent.href}
                    className="group flex min-h-11 items-baseline justify-between gap-4 rounded-[var(--radius-card)] border border-rule bg-paper-raised px-4 py-3.5 transition-colors hover:border-pine focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
                  >
                    <span className="min-w-0">
                      <span className="block font-medium text-ink group-hover:text-pine">
                        {intent.title}
                      </span>
                      <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">
                        {intent.body}
                      </span>
                    </span>
                    <span
                      aria-hidden="true"
                      className="shrink-0 self-center text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-pine"
                    >
                      →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            <p className="mt-4 text-sm text-ink-faint">
              No account needed. Nothing is researched until you have seen what we made of it.
            </p>

            {!compileReady ? (
              <Panel className="mt-5 border-amber bg-amber-soft p-4">
                <p className="text-sm leading-relaxed text-ink">
                  <strong className="font-medium">
                    This deployment cannot research a new destination right now.
                  </strong>{' '}
                  Somewhere already researched still plans normally, and everything below still
                  works — but a name typed in fresh will not build until whoever set this up
                  finishes it.
                </p>
              </Panel>
            ) : null}

            {rows.length > 0 ? (
              <p className="mt-5 text-sm">
                <a href="#your-trips" className="text-pine underline underline-offset-4">
                  Or pick up one of your {rows.length} trip{rows.length === 1 ? '' : 's'}
                </a>
              </p>
            ) : null}
          </section>

          <section aria-labelledby="how-heading" className="lg:pt-16">
            <h2 id="how-heading" className="eyebrow">
              How it works
            </h2>
            {/*
              THE ROUTE MOTIF, DRAWN RATHER THAN IMPORTED.

              One continuous line threading the four numbered stops, at the
              weight of a rule and in the same ink — the product's own noun
              stated in the layout instead of in an illustration. §5 lists
              "placeholder illustrations" among the things to avoid, and an SVG
              of a landscape nobody is planning would be exactly that.

              `aria-hidden` and deliberately unanimated: §18 asks for motion
              that reinforces movement through a route, and a decorative line
              that moves on a landing page reinforces nothing.
            */}
            <ol className="relative mt-5 space-y-5">
              <span
                aria-hidden="true"
                className="absolute top-3 bottom-3 left-3.5 w-px bg-rule"
              />
              {STEPS.map(([title, body], index) => (
                <li key={title} className="relative flex gap-4">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-rule bg-paper text-xs font-medium text-ink-faint"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{title}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">
                      {body}
                    </span>
                  </span>
                </li>
              ))}
            </ol>

            {/*
              WHY THE WAIT IS WORTH IT, BESIDE WHAT THE WAIT IS.

              These three used to be a full-width band under everything else,
              which left this column ending halfway down the fold — the "giant
              empty space" §5 lists among the things to avoid — and put the
              product's actual argument below the point most people stop. They
              answer the fourth question the homepage owes a visitor, so they
              belong next to the third.
            */}
            <div className="mt-8 space-y-5 border-t border-rule pt-6">
              {PROMISES.map((item) => (
                <div key={item.title}>
                  <h3 className="font-display text-lg text-ink">{item.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-ink-muted">{item.body}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        {rows.length > 0 ? (
          <section className="mt-16 border-t border-rule pt-12" aria-labelledby="your-trips">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              {/*
                `scroll-mt` because the product header is sticky: without it the
                in-page link from the hero lands with the heading underneath the
                bar, which reads as the anchor having missed.
              */}
              <h2 id="your-trips" className="scroll-mt-24 font-display text-2xl text-ink">
                Your trips
              </h2>
              <Link href="/trips/new" className={buttonClass('secondary', 'sm')}>
                Start another
              </Link>
            </div>
            <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
              Each one says where it actually got to. Opening a trip takes you to the next thing it
              is waiting on — nothing is researched again without you asking.
            </p>
            <div className="mt-5">
              <TripList rows={rows} />
            </div>
          </section>
        ) : null}
      </div>
    </ProductChrome>
  );
}
