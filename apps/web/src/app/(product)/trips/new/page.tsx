import type { Metadata } from 'next';
import { TripComposer } from '@/components/TripComposer';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Start a trip — Sidequest',
};

function isoDate(daysFromNow: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

/**
 * TWO WAYS IN, ONE COMPOSER.
 *
 * The third intent on the homepage — "I already have a plan" — arrives here with
 * `?have=plan`. It is the same form, framed for somebody who is not starting
 * from nothing, with the list of places they already have promoted from the last
 * question to the second one.
 *
 * ## Why this is the honest shape of Mode 3 in this build
 *
 * Sidequest cannot critique an itinerary. There is no engine that reads a plan
 * and argues with it, and pretending otherwise would be the worst thing on the
 * homepage. What it *can* do, today, is take the places somebody names, resolve
 * them against real map data, build the region around them, and report which of
 * them it could not find, could not reach, or could not fit — which is most of
 * what a person wants when they ask "is this plan any good?".
 *
 * So the copy promises exactly that and no more. The previous state of this
 * intent was a grey line at the bottom of this page reading "Coming later:
 * paste an itinerary you already have and we will stress-test it" — a promise
 * made where nobody who wanted it would look, for a thing that does not exist.
 */
export default async function NewTripPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const improving = params.have === 'plan';

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="eyebrow">{improving ? 'A plan you already have' : 'New trip'}</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {improving
          ? 'Tell us what you have, and we will build around it'
          : 'Let us work out what your trip should be'}
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">
        {improving
          ? 'List the places your plan already has. We will find them on the map, work out how far apart they really are, lay the days out around them — and tell you plainly which of them do not fit the time you have.'
          : 'A few questions, each of which changes what we go and look for. Nothing is researched until you have seen what we made of it.'}
      </p>

      <div className="mt-10">
        <TripComposer
          defaults={{ startDate: isoDate(30), endDate: isoDate(36) }}
          intent={improving ? 'has_plan' : 'new'}
        />
      </div>
    </div>
  );
}
