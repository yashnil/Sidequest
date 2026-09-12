'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ErrorNote, buttonClass, cx } from '../ui';
import { Glyph } from './glyphs';
import { CROSSFADE_S, timing } from './choreography';
import { acceptTripTimingAction, recommendTripTimingAction, type TripTimingResult } from '@/app/(product)/trips/[id]/questionnaire/timing-actions';
import type { TimingWindowView } from '@/app/(product)/trips/new/timing-actions';

/**
 * V7 §7 — BEST_TIME V4: THE WINDOW, CHOSEN AT THE READY BOUNDARY.
 *
 * Shown on the review only while the timing question is open (the traveller
 * asked Sidequest to choose and has not accepted a window). The pick is scored
 * from the whole profile — interests, crowd tolerance, the busy weeks compiled
 * for the destination — and every reason is a sentence about that evidence.
 * "Use this timing" is durable: the trip row is dated and locked to the
 * traveller in one statement, and the composition can never overwrite it.
 * Building without pressing it is allowed; then the composition chooses, and
 * the plan says so.
 *
 * V8 — a card in the review's brief grid rather than a strip under it. Its
 * three states (comparing → pick → locked) cross-fade in place (≤ 260 ms, none
 * under reduced motion); the accepted window is set in pine, the product's
 * colour for something locked. The test ids the browser suite reads
 * (`review-timing`, `timing-pick`, `timing-accept`, `review-timing-accepted`,
 * `review-timing-basis`, `timing-deferred`) stay where they were.
 */
export function ReviewTimingCard({
  tripId,
  onAccepted,
  initialAccepted = null,
  className,
}: {
  tripId: string;
  onAccepted: (window: { startDate: string; endDate: string }) => void;
  /** V8 — the window already accepted on the row, so a reload shows the dates the traveller chose rather than asking again. */
  initialAccepted?: TimingWindowView | null;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [result, setResult] = useState<TripTimingResult | null>(null);
  const [shown, setShown] = useState(0);
  const [accepted, setAccepted] = useState<TimingWindowView | null>(initialAccepted);
  const [error, setError] = useState<string | null>(null);
  /*
   * V8 — plain async state, not a React transition. The recommendation load
   * and the acceptance used to share one `useTransition`, whose pending flag
   * disabled "Use this timing"; a transition that stayed pending (a suspended
   * subtree inside the crossfade) left the button disabled with the pick on
   * screen. Neither call needs transition semantics: they are one request
   * each, and their own flags say exactly what is in flight.
   */
  const [comparing, setComparing] = useState(!initialAccepted);
  const [accepting, setAccepting] = useState(false);
  const pending = accepting;

  useEffect(() => {
    if (initialAccepted) return;
    let cancelled = false;
    /* `comparing` starts true for exactly this case, so nothing is set here before the request answers. */
    recommendTripTimingAction(tripId)
      .catch(() => ({ ok: false as const, note: 'We could not compare the months just now.' }))
      .then((outcome) => {
        if (cancelled) return;
        setResult(outcome);
        setComparing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId, initialAccepted]);

  const windows: TimingWindowView[] = result?.ok ? [result.pick, ...result.alternatives] : [];
  const current = windows[shown] ?? null;
  const state = accepted ? 'accepted' : comparing && !result ? 'comparing' : result?.ok && current ? 'pick' : result && !result.ok ? 'deferred' : 'idle';
  const fade = timing(CROSSFADE_S, reduced);

  return (
    <section className={cx('card min-w-0 p-5', accepted ? 'border-pine/40' : '', className)} aria-live="polite" data-testid="review-timing">
      <h3 className="flex items-center gap-2 font-display text-lg leading-tight text-ink">
        <Glyph id={accepted ? 'lock' : 'sunrise'} className={cx('h-5 w-5', accepted ? 'text-pine' : 'text-accent')} />
        When to go
      </h3>
      <AnimatePresence initial={false} mode="wait">
        {state === 'accepted' && accepted ? (
          <motion.div key="accepted" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} className="mt-3 rounded-[var(--radius-card)] bg-pine-soft p-4" data-testid="review-timing-accepted">
            <p className="label text-pine-strong">Your dates · locked</p>
            <p className="mt-1.5 font-display text-3xl leading-none text-ink">{accepted.label}</p>
            <p className="type-figure mt-2 text-sm text-ink-muted">
              {accepted.startDate} → {accepted.endDate}
            </p>
            <p className="type-small mt-3 text-ink-muted">Locked to you. Sidequest builds to these dates and will not move them.</p>
          </motion.div>
        ) : state === 'comparing' ? (
          <motion.p key="comparing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} className="breathing mt-3 type-body text-ink-muted">
            Comparing the months on climate records, your interests and the busy weeks…
          </motion.p>
        ) : state === 'pick' && result?.ok && current ? (
          <motion.div key={`pick-${shown}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} className="mt-3 rounded-[var(--radius-card)] bg-accent-soft p-4 sm:p-5" data-testid="timing-pick">
            <p className="label text-accent-strong">{shown === 0 ? 'Sidequest’s pick' : 'Another window'}</p>
            <p className="mt-1.5 font-display text-4xl leading-none text-ink">{current.label}</p>
            <p className="type-figure mt-2 text-sm text-ink-muted">
              {current.startDate} → {current.endDate}
            </p>
            <p className="type-small mt-3 text-ink-muted" data-testid="review-timing-basis">
              Scored on {result.basis}.
            </p>
            <div className="mt-4 grid gap-x-8 gap-y-3 lg:grid-cols-2">
              {current.reasons.length > 0 ? (
                <ul className="space-y-2 text-sm leading-relaxed text-ink">
                  {current.reasons.map((reason) => (
                    <li key={reason} className="flex gap-2.5">
                      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                      <span className="min-w-0">{reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {current.tradeoffs.length > 0 ? (
                <ul className="space-y-2 text-sm leading-relaxed text-ink-muted">
                  {current.tradeoffs.map((tradeoff) => (
                    <li key={tradeoff} className="flex gap-2.5">
                      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-accent" />
                      <span className="min-w-0">{tradeoff}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {result.unknowns.length > 0 ? (
              <details className="mt-4 text-sm text-ink-muted">
                <summary className="inline-flex min-h-9 cursor-pointer items-center underline underline-offset-4">What this does not know</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {result.unknowns.map((unknown) => (
                    <li key={unknown} {...(unknown === result.regionalNote ? { 'data-testid': 'review-timing-regional-note' } : {})}>
                      {unknown}
                    </li>
                  ))}
                  <li>
                    {result.attribution} · normals from {result.sampleYears}.
                  </li>
                </ul>
              </details>
            ) : null}
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={buttonClass('accent')}
                disabled={pending}
                onClick={() => {
                  setError(null);
                  setAccepting(true);
                  void acceptTripTimingAction(tripId, { ...current })
                    .catch(() => ({ ok: false as const, error: 'We could not reach Sidequest just then. Your answers are saved — try once more.' }))
                    .then((outcome) => {
                      setAccepting(false);
                      if (!outcome.ok) {
                        setError(outcome.error);
                        return;
                      }
                      setAccepted(current);
                      onAccepted({ startDate: outcome.startDate, endDate: outcome.endDate });
                    });
                }}
                data-testid="timing-accept"
              >
                Use this timing
              </button>
              {windows.length > 1 ? (
                <button type="button" className={buttonClass('ghost')} onClick={() => setShown((shown + 1) % windows.length)} data-testid="timing-another">
                  Show another window
                </button>
              ) : null}
              <span className="type-small text-ink-faint">Or build without choosing, and Sidequest picks the window with the plan.</span>
            </div>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
          </motion.div>
        ) : state === 'deferred' && result && !result.ok ? (
          <motion.p key="deferred" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade} className="mt-3 flex gap-3 type-body text-ink-muted" data-testid="timing-deferred">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" />
            <span className="min-w-0">{result.note}</span>
          </motion.p>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
