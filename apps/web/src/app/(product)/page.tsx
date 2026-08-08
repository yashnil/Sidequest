import Link from 'next/link';
import { ProductChrome } from '@/components/ProductChrome';
import { buttonClass, Panel } from '@/components/ui';
import { destinationIndexRelease } from '@/lib/db/destination-index-repository';
import { listTrips } from '@/lib/db/repository';

export const dynamic = 'force-dynamic';

/**
 * THE FRONT DOOR, WHICH NO LONGER ADVERTISES ONE TOWN.
 *
 * What was here: an eyebrow reading "Mammoth Lakes · Eastern Sierra", a call to
 * action reading "Plan a Mammoth Lakes trip", and three cards imported from the
 * authored fixture. All of it accurate about what the product could do a phase
 * ago, and all of it wrong about what it does now.
 *
 * The claims below are ones the engine can actually keep for anywhere, and the
 * page says how much of the world it holds rather than implying all of it: the
 * index release line is read from the database, so an unbuilt index says so
 * instead of pretending.
 */

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

export default function HomePage() {
  const trips = listTrips();
  const release = destinationIndexRelease();

  return (
    <ProductChrome>
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-8 sm:py-20">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
          <section>
            <p className="eyebrow">Plan anywhere</p>
            <h1 className="mt-4 font-display text-4xl leading-[1.08] text-ink sm:text-5xl lg:text-6xl">
              You name a place — or tell us when you are free.
            </h1>
            <p className="measure mt-6 text-lg leading-relaxed text-ink-muted">
              Answer one set of questions and Sidequest works out what is actually worth your time —
              the famous stops, the quiet ones an hour off the road, what is shut on your dates, and
              what to skip. Ranked by how you travel, not by how many people have reviewed it.
            </p>
            {/*
              Two doors, side by side.

              The second one has existed in the schema since Phase 7 and had no
              code path behind it, so a traveller with two free weeks and no idea
              had nowhere to start and nothing on screen said so. Presenting them
              as equals is the honest description of the product now that both
              work — and the copy names what each one needs from you, so nobody
              picks the wrong one and finds out three screens later.
            */}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/trips/new" className={buttonClass('primary')}>
                I know where I am going
              </Link>
              <Link href="/decide" className={buttonClass('secondary')}>
                Help me decide
              </Link>
            </div>
            <p className="mt-3 text-sm text-ink-faint">
              No account needed. Nothing is researched until you have seen what we made of it.
            </p>
          </section>

          <section aria-labelledby="how-heading" className="lg:pt-14">
            <h2 id="how-heading" className="sr-only">
              How it works
            </h2>
            <ol className="space-y-5">
              {[
                ['Say where, or say when', 'A destination you know, or dates and preferences and no idea yet.'],
                ['We shape the region', 'Areas, bases, travel times and how much your dates can hold.'],
                ['We check the sources', 'Opening hours, access, seasonal closures and cost, from whoever publishes them.'],
                ['You get a plan', 'Day by day, with what we could not establish said out loud.'],
              ].map(([title, body], index) => (
                <li key={title} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-rule text-xs font-medium text-ink-faint"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-ink">{title}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">{body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <section className="mt-16 grid gap-6 border-t border-rule pt-12 sm:grid-cols-3">
          {PROMISES.map((item) => (
            <div key={item.title}>
              <h3 className="font-display text-lg text-ink">{item.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-muted">{item.body}</p>
            </div>
          ))}
        </section>

        {trips.length > 0 ? (
          <section className="mt-14 border-t border-rule pt-10" aria-labelledby="trips-heading">
            <h2 id="trips-heading" className="font-display text-xl text-ink">
              Your trips
            </h2>
            <ul className="mt-4 divide-y divide-rule">
              {trips.slice(0, 8).map((trip) => (
                <li key={trip.id}>
                  <Link
                    href={
                      trip.status === 'draft'
                        ? `/trips/${trip.id}/plan`
                        : `/trips/${trip.id}/discover`
                    }
                    className="flex flex-wrap items-baseline justify-between gap-2 py-3 hover:text-pine"
                  >
                    <span className="font-medium">{trip.basics.destinationInput}</span>
                    <span className="text-sm text-ink-muted">
                      {trip.basics.startDate} → {trip.basics.endDate} ·{' '}
                      {trip.status === 'draft' ? 'Not finished' : 'Discovery board ready'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <Panel className="mt-14 p-5" as="aside">
          <p className="text-sm leading-relaxed text-ink-muted">
            {release ? (
              <>
                Destination search covers{' '}
                <strong className="font-medium text-ink">
                  {release.entryCount.toLocaleString('en-GB')} places
                </strong>{' '}
                worldwide, from the {release.catalog} {release.releaseId} release. Anything outside it
                can still be typed in full and looked up.
              </>
            ) : (
              <>
                Destination search is not built on this deployment yet, so typing a destination will be
                looked up rather than suggested. Everything else works.
              </>
            )}
          </p>
        </Panel>
      </div>
    </ProductChrome>
  );
}
