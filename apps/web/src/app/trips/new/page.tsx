import { NewTripForm } from './NewTripForm';

export const dynamic = 'force-dynamic';

function isoDate(daysFromNow: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  return date.toISOString().slice(0, 10);
}

export default function NewTripPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16">
      <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">New trip</p>
      <h1 className="mt-3 font-display text-3xl text-ink sm:text-4xl">Start with the basics</h1>
      <p className="mt-3 max-w-xl text-ink-muted">
        Dates and arrival times shape the plan more than people expect — they decide how much of day
        one is real, and which side of the region is reachable.
      </p>
      <NewTripForm defaults={{ startDate: isoDate(30), endDate: isoDate(33) }} />
    </div>
  );
}
