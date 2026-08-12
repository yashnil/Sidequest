/**
 * The screen while "help me decide" is being produced.
 *
 * Present for the same reason `trips/new` has one: a route segment without a
 * loading file inherits its nearest ancestor's, and for this half of the
 * product that was nothing at all — so a slow render left the previous page on
 * screen, unresponsive, with no way to tell whether the press had registered.
 *
 * The sentence is the live region and the skeleton is `aria-hidden`, because a
 * screen-reader user needs the claim rather than the shimmer.
 */
export default function DecideLoading() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8 sm:py-16" data-loading="true">
      <p className="eyebrow">Where should I go</p>
      <p className="mt-3 font-display text-3xl leading-tight text-ink" aria-live="polite">
        Getting ready…
      </p>
      <p className="measure mt-3 text-ink-muted">
        Four questions, and nothing is bought to answer them.
      </p>
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
