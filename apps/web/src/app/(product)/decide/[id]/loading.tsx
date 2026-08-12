/**
 * The screen while a stored decision session is being read back.
 *
 * The ranking itself has its own state inside `ShortlistView`; this is the
 * shorter window before that — a refresh, a back button, a shared link — and
 * without it the browser sat on the previous page with nothing to say.
 */
export default function DecideSessionLoading() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16" data-loading="true">
      <p className="eyebrow">Where should I go</p>
      <p className="mt-3 font-display text-3xl leading-tight text-ink" aria-live="polite">
        Reading your answers…
      </p>
      <div className="mt-10 space-y-3" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="h-24 animate-pulse rounded-[var(--radius-card)] border border-rule bg-paper-sunk"
          />
        ))}
      </div>
    </div>
  );
}
