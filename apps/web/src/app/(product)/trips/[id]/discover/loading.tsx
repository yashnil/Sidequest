export default function DiscoverLoading() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
      <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Discovery board</p>
      <p className="mt-3 font-display text-3xl text-ink sm:text-5xl" aria-live="polite">
        Reading the region…
      </p>
      <p className="mt-3 max-w-md text-ink-muted">
        Expanding your destination into a travel region, checking what is open on your dates, and
        scoring every candidate against your answers.
      </p>
      <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            className="h-64 animate-pulse rounded-[var(--radius-card)] border border-rule bg-paper-sunk"
          />
        ))}
      </div>
    </div>
  );
}
