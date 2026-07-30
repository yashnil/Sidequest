import Link from 'next/link';
import { EASTERN_SIERRA_PLACES } from '@sidequest/core';
import { buttonClass, Panel, PlacePlate } from '@/components/ui';
import { listTrips } from '@/lib/db/repository';

export const dynamic = 'force-dynamic';

const SHOWCASE = ['mono-lake-south-tufa', 'obsidian-dome', 'convict-lake'];

export default function HomePage() {
  const trips = listTrips();
  const showcase = SHOWCASE.map((id) =>
    EASTERN_SIERRA_PLACES.find((place) => place.id === id),
  ).filter((place) => place !== undefined);

  return (
    <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-24">
      <section className="max-w-2xl">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">
          Mammoth Lakes · Eastern Sierra
        </p>
        <h1 className="mt-4 font-display text-4xl leading-[1.1] text-ink sm:text-6xl">
          You typed a town. The trip is the whole region.
        </h1>
        <p className="mt-6 text-lg leading-relaxed text-ink-muted">
          Answer one questionnaire and Sidequest works out what is actually worth your time — the
          famous stops, the quiet ones an hour up the 395, what is closed on your dates, and what to
          skip. Ranked by how you travel, not by how many people have reviewed it.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link href="/trips/new" className={buttonClass('primary')}>
            Plan a Mammoth Lakes trip
          </Link>
          <span className="text-sm text-ink-faint">Takes about three minutes</span>
        </div>
      </section>

      <section className="mt-16 grid gap-4 sm:grid-cols-3">
        {showcase.map((place) => (
          <Panel key={place.id} as="article" className="overflow-hidden">
            <PlacePlate placeId={place.id} category={place.category} className="h-32" />
            <div className="p-4">
              <h2 className="font-display text-lg text-ink">{place.name}</h2>
              <p className="mt-1 text-sm leading-relaxed text-ink-muted">
                {place.shortDescription}
              </p>
            </div>
          </Panel>
        ))}
      </section>

      <section className="mt-16 grid gap-8 border-t border-rule pt-10 sm:grid-cols-3">
        {[
          {
            title: 'It thinks in regions',
            body: 'Mammoth Lakes becomes June Lake Loop, Mono Lake, Convict Lake, Hot Creek and Minaret Vista — each with an honest verdict on whether the drive is worth it for you.',
          },
          {
            title: 'It ranks by fit',
            body: 'A quiet obsidian dome can outrank the postcard shot if you said crowds ruin a place. Every card explains itself using your own answers.',
          },
          {
            title: 'It tells you what will not work',
            body: 'Reds Meadow is shut most of the year and shuttle-only in summer. If your dates do not work, you find out here, not at the gate.',
          },
        ].map((item) => (
          <div key={item.title}>
            <h3 className="font-display text-lg text-ink">{item.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">{item.body}</p>
          </div>
        ))}
      </section>

      {trips.length > 0 ? (
        <section className="mt-16 border-t border-rule pt-10">
          <h2 className="font-display text-xl text-ink">Your trips</h2>
          <ul className="mt-4 divide-y divide-rule">
            {trips.slice(0, 6).map((trip) => (
              <li key={trip.id}>
                <Link
                  href={
                    trip.status === 'draft'
                      ? `/trips/${trip.id}/questionnaire`
                      : `/trips/${trip.id}/discover`
                  }
                  className="flex flex-wrap items-baseline justify-between gap-2 py-3 hover:text-pine"
                >
                  <span className="font-medium">{trip.basics.destinationInput}</span>
                  <span className="text-sm text-ink-muted">
                    {trip.basics.startDate} → {trip.basics.endDate} ·{' '}
                    {trip.status === 'draft' ? 'Questionnaire not finished' : 'Discovery board ready'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
