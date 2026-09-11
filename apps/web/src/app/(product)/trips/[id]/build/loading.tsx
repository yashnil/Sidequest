/**
 * The generation screen's ground, before the run row has been read. The same
 * dark atlas as the screen itself, laid out the way the screen will be — the
 * words on the left, the map's frame on the right — so arriving here from the
 * review is one continuous surface rather than a flash of paper.
 */
export default function BuildLoading() {
  return (
    <div className="atlas atlas-live min-h-[calc(100dvh-var(--chrome-height))] px-5 py-6 sm:px-8 sm:py-8" data-loading="true">
      <div className="mx-auto grid max-w-6xl gap-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:gap-12">
        <div className="min-w-0">
          <p className="type-small atlas-muted">Building your trip</p>
          <p className="display-xl mt-2 text-[var(--color-atlas-ink)]" aria-live="polite">
            Finding where the build had got to…
          </p>
          <p className="mt-3 type-small atlas-muted">Your answers are saved either way.</p>
        </div>
        <div aria-hidden="true" className="rounded-[var(--radius-plate)] border border-white/10 bg-[var(--color-atlas-raised)] p-3">
          <div className="aspect-[7/5] rounded-[var(--radius-card)] bg-white/[0.04]" />
        </div>
      </div>
    </div>
  );
}
