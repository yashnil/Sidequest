/**
 * The screen while the server is producing this page.
 *
 * Present so a slow render is a stated state rather than a blank tab. Route
 * segments without one fall back to the nearest ancestor's, which for these was
 * nothing at all — so a traveller pressing Continue on a slow connection saw the
 * previous screen sit there, unresponsive, with no way to tell whether their
 * press had registered.
 *
 * Deliberately says what is being done rather than only that something is. The
 * skeleton is `aria-hidden`; the sentence above it is the live region, because a
 * screen-reader user needs the claim, not the shimmer.
 */
export default function EditTripLoading() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14" data-loading="true">
      <p className="text-xs uppercase tracking-[0.2em] text-ink-faint">Change this trip</p>
      <p className="mt-3 font-display text-3xl leading-tight text-ink" aria-live="polite">
        Bringing up what you told us…
      </p>
      <p className="mt-3 max-w-md text-ink-muted">Your trip stays exactly as it is until you save a change.</p>
      <div className="mt-10 space-y-3" aria-hidden="true">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-16 animate-pulse rounded-[var(--radius-card)] border border-rule bg-paper-sunk"
          />
        ))}
      </div>
    </div>
  );
}
