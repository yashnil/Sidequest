import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { Panel } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The wait, said once, for both.
 *
 * Two placeholder blocks of the same size rather than one per state, because a
 * skeleton that reflected how far along each arm was would announce the faster
 * one before the screen it belongs to had even rendered. `breathing` is the
 * product's own live-surface utility and honours reduced motion through the
 * global media query.
 */
export default function RunLoading() {
  return (
    <div className="mx-auto max-w-4xl px-3 py-8 sm:px-8 sm:py-12">
      <p className="eyebrow">{NEUTRAL_COPY.eyebrow}</p>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink sm:text-4xl">
        {NEUTRAL_COPY.loadingTitle}
      </h1>
      <p className="measure mt-3 leading-relaxed text-ink-muted">{NEUTRAL_COPY.loadingBody}</p>

      <div className="mt-8 grid gap-3" aria-hidden="true">
        {[0, 1].map((slot) => (
          <Panel key={slot} className="breathing h-24 p-4">
            {null}
          </Panel>
        ))}
      </div>
    </div>
  );
}
