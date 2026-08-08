'use client';

import { NEUTRAL_COPY } from '@/lib/benchmark/vocabulary';
import { LABS_COPY } from '@/components/benchmark/copy';
import { Panel, buttonClass } from '@/components/ui';

/**
 * ONE ERROR SURFACE FOR THE WHOLE COMPARISON.
 *
 * Deliberately identical whatever went wrong, and that is not laziness about
 * error messages — it is the point. A boundary that said "the second plan could
 * not be built" or that carried a stack frame naming a module would tell the
 * reviewer which of the two arms failed, and therefore which panel is which, at
 * the exact moment they are least suspicious of the screen. A per-system error
 * string is the easiest leak in this whole design and this file is where it
 * would have gone.
 *
 * The `error` object is not read for the same reason. Its `message` and `digest`
 * are produced by whichever code threw, and neither has been through the neutral
 * vocabulary.
 */
export default function BenchmarkError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-2xl px-3 py-10 sm:px-8">
      <Panel className="p-5">
        <h1 className="font-display text-2xl text-ink">{NEUTRAL_COPY.errorTitle}</h1>
        <p className="measure mt-3 text-sm leading-relaxed text-ink-muted">
          {NEUTRAL_COPY.errorBody}
        </p>
        <button
          type="button"
          onClick={reset}
          className={`${buttonClass('secondary')} mt-5 motion-reduce:transition-none`}
        >
          {LABS_COPY.errorRetry}
        </button>
      </Panel>
    </div>
  );
}
