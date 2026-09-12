'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { buttonClass, cx } from '@/components/ui';
import { confirmLearnedAction, dismissLearnedAction, restoreLearnedAction } from './actions';

/**
 * V9 §18 — "SIDEQUEST NOTICED": leanings, each with a sentence and two answers.
 *
 * Every row is one feature Sidequest has watched the account lean towards or
 * away from — medium or high confidence only, phrased as a leaning, never a
 * rule. Dismiss says "that is not me" and the leaning never reaches a brief
 * again; Restore takes it back. A dismissed row stays on the page, greyed,
 * so the traveller can see what has been forgotten rather than wondering.
 */
export interface LearnedRow {
  feature: string;
  /** The sentence the brief would read, from `learnedHints`. */
  sentence: string;
  band: 'medium' | 'high';
  weight: number;
  dismissed: boolean;
}

export function LearnedPreferences({ rows }: { rows: LearnedRow[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());

  const run = (work: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? 'That did not save. Nothing was changed.');
        return;
      }
      after?.();
      router.refresh();
    });
  };

  if (rows.length === 0) {
    return <p className="mt-4 type-body text-ink-muted">Nothing yet. Leanings appear here after a few trips, and only ever as leanings.</p>;
  }

  return (
    <div className="mt-4">
      {error ? (
        <p role="alert" className="mb-3 type-small text-clay">
          {error}
        </p>
      ) : null}
      <ul className="grid gap-3">
        {rows.map((row) => (
          <li key={row.feature} className={cx('card flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-[var(--radius-card)] px-4 py-3.5', row.dismissed && 'opacity-70')} data-testid="learned-preference" data-feature={row.feature} data-band={row.band} data-dismissed={row.dismissed ? 'true' : 'false'}>
            <span className="min-w-0 flex-1">
              <span className="block type-small text-ink">{row.dismissed ? <span className="text-ink-muted">Forgotten: </span> : null}{row.sentence}</span>
              <span className="type-meta mt-0.5 block">{row.dismissed ? 'Sidequest no longer plans around this.' : `${row.band === 'high' ? 'Fairly sure' : 'Noticed'} · a leaning, never a rule`}</span>
            </span>
            <span className="flex shrink-0 flex-wrap items-center gap-1.5">
              {row.dismissed ? (
                <button type="button" className={buttonClass('secondary', 'sm')} disabled={pending} data-testid="learned-restore" onClick={() => run(() => restoreLearnedAction(row.feature))}>
                  Restore
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className={buttonClass('ghost', 'sm')}
                    disabled={pending || confirmed.has(row.feature)}
                    aria-pressed={confirmed.has(row.feature)}
                    data-testid="learned-confirm"
                    onClick={() => run(() => confirmLearnedAction(row.feature), () => setConfirmed((c) => new Set(c).add(row.feature)))}
                  >
                    {confirmed.has(row.feature) ? 'Noted' : 'That’s right'}
                  </button>
                  <button type="button" className={buttonClass('ghost', 'sm')} disabled={pending} data-testid="learned-dismiss" onClick={() => run(() => dismissLearnedAction(row.feature))}>
                    Dismiss
                  </button>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
