'use client';

import { useEffect, useState, useTransition } from 'react';
import { ErrorNote, buttonClass, cx } from '../ui';
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
 */
export function ReviewTimingCard({ tripId, onAccepted }: { tripId: string; onAccepted: (window: { startDate: string; endDate: string }) => void }) {
  const [result, setResult] = useState<TripTimingResult | null>(null);
  const [shown, setShown] = useState(0);
  const [accepted, setAccepted] = useState<TimingWindowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    startTransition(async () => {
      const outcome = await recommendTripTimingAction(tripId).catch(() => ({ ok: false as const, note: 'We could not compare the months just now.' }));
      if (!cancelled) setResult(outcome);
    });
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  const windows: TimingWindowView[] = result?.ok ? [result.pick, ...result.alternatives] : [];
  const current = windows[shown] ?? null;

  return (
    <section className="rise mt-10 max-w-2xl" aria-live="polite" data-testid="review-timing">
      <h3 className="font-display text-xl text-ink">When to go</h3>
      {accepted ? (
        <div className="mt-3 rounded-[var(--radius-panel)] border border-pine/40 bg-pine-soft p-5" data-testid="review-timing-accepted">
          <p className="label text-pine-strong">Your dates</p>
          <p className="mt-1.5 font-display text-3xl leading-none text-ink">{accepted.label}</p>
          <p className="numeral mt-2 text-sm text-ink-muted">
            {accepted.startDate} → {accepted.endDate}
          </p>
          <p className="mt-3 text-sm text-ink-muted">Locked to you. Sidequest builds to these dates and will not move them.</p>
        </div>
      ) : pending && !result ? (
        <p className="breathing mt-3 type-body text-ink-muted">Comparing the months on climate records, your interests and the busy weeks…</p>
      ) : result?.ok && current ? (
        <div className="mt-3 overflow-hidden rounded-[var(--radius-panel)] border border-accent/40 bg-accent-soft" data-testid="timing-pick">
          <div className="p-5 sm:p-6">
            <p className="label text-accent-strong">{shown === 0 ? 'Sidequest’s pick' : 'Another window'}</p>
            <p className="mt-1.5 font-display text-4xl leading-none text-ink">{current.label}</p>
            <p className="numeral mt-2 text-sm text-ink-muted">
              {current.startDate} → {current.endDate}
            </p>
            <p className="mt-3 text-sm text-ink-muted" data-testid="review-timing-basis">
              Scored on {result.basis}.
            </p>
            {current.reasons.length > 0 ? (
              <ul className="mt-4 space-y-2 text-sm leading-relaxed text-ink">
                {current.reasons.map((reason) => (
                  <li key={reason} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
                    <span className="min-w-0">{reason}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {current.tradeoffs.length > 0 ? (
              <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">
                {current.tradeoffs.map((tradeoff) => (
                  <li key={tradeoff} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full border border-accent" />
                    <span className="min-w-0">{tradeoff}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {result.unknowns.length > 0 ? (
              <details className="mt-4 text-sm text-ink-muted">
                <summary className="cursor-pointer">What this does not know</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {result.unknowns.map((unknown) => (
                    <li key={unknown}>{unknown}</li>
                  ))}
                  <li>
                    {result.attribution} · normals from {result.sampleYears}.
                  </li>
                </ul>
              </details>
            ) : null}
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className={buttonClass('primary')}
                disabled={pending}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const outcome = await acceptTripTimingAction(tripId, { ...current });
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
              <span className="text-sm text-ink-faint">Or build without choosing, and Sidequest picks the window with the plan.</span>
            </div>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
          </div>
        </div>
      ) : result && !result.ok ? (
        <p className={cx('mt-3 flex gap-3 rounded-[var(--radius-card)] border border-rule bg-paper-raised p-4 type-body text-ink-muted')} data-testid="timing-deferred">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" />
          <span className="min-w-0">{result.note}</span>
        </p>
      ) : null}
    </section>
  );
}
