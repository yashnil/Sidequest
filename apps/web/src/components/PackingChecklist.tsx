'use client';

import { useState } from 'react';
import { cx, FOCUS_RING, OVERLAY_INPUT } from './ui';

/**
 * A packing list you can tick. Ticks live in this tab only — nothing here is
 * persisted, and the list says so rather than implying a saved state it does
 * not have.
 */
export function PackingChecklist({ items }: { items: readonly string[] }) {
  const [done, setDone] = useState<Set<string>>(() => new Set());
  if (items.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1.5" data-testid="packing-checklist">
      {items.map((item) => {
        const checked = done.has(item);
        return (
          <li key={item}>
            <label className={cx('relative flex min-h-9 cursor-pointer items-start gap-2.5 rounded-md px-1 text-sm', FOCUS_RING, checked ? 'text-ink-faint line-through' : 'text-ink')}>
              <input
                type="checkbox"
                className={OVERLAY_INPUT}
                checked={checked}
                onChange={(event) =>
                  setDone((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(item);
                    else next.delete(item);
                    return next;
                  })
                }
              />
              <span aria-hidden="true" className={cx('mt-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px]', checked ? 'border-pine bg-pine text-paper' : 'border-rule bg-paper')}>
                {checked ? '✓' : ''}
              </span>
              <span>{item}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
