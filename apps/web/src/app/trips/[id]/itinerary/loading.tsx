export default function ItineraryLoading() {
  return (
    <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8 sm:py-14">
      <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Your trip</p>
      <p className="mt-3 font-display text-3xl text-ink sm:text-5xl" aria-live="polite">
        Building the days…
      </p>
      <p className="mt-3 max-w-md text-ink-muted">
        Grouping what you picked by travel time, ordering each day, and checking it against your
        limits before anything is shown.
      </p>
      <div className="mt-10 space-y-6" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="h-48 animate-pulse rounded-[var(--radius-card)] border border-rule bg-paper-sunk"
          />
        ))}
      </div>
    </div>
  );
}
