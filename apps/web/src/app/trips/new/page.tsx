import { TripComposer } from '@/components/TripComposer';

export const dynamic = 'force-dynamic';

function isoDate(daysFromNow: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

export default function NewTripPage() {
  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="eyebrow">New trip</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        Let us work out what your trip should be
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">
        A few questions, each of which changes what we go and look for. Nothing is researched until
        you have seen what we made of it.
      </p>

      <div className="mt-10">
        <TripComposer defaults={{ startDate: isoDate(30), endDate: isoDate(36) }} />
      </div>

      {/*
        Plan critique, demoted.

        It used to be a full-width card in the primary mode picker reading "NOT
        BUILT YET", which spent a third of the first impression on something the
        product cannot do. It is a footnote now, and it becomes a mode when it
        exists.
      */}
      <p className="mt-14 border-t border-rule pt-6 text-sm text-ink-faint">
        Coming later: paste an itinerary you already have and we will stress-test it.
      </p>
    </div>
  );
}
