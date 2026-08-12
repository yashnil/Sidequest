import type { ReactNode } from 'react';
import { cx } from './ui';

/**
 * ONE DOOR FOR EVERYTHING THAT IS NOT A PLACE.
 *
 * The discovery board grew four separate customer-facing quality frameworks,
 * each with its own panel, each stacked in front of the cards: a research
 * readiness verdict, a board integrity reading, a per-card trust disclosure and
 * a reconciliation account. On a live Tokyo board they occupied the first nine
 * hundred pixels of a desktop screen and the first fourteen hundred of a phone,
 * and between them they said the same thing three times in three vocabularies.
 *
 * §33 says the fix for parallel frameworks is to keep the best-written one and
 * delete the rest, and §10.1 says secondary evidence goes behind progressive
 * disclosure. This is that disclosure: one `<details>`, at the *foot* of the
 * board, holding the trip's context and everything about how the board was
 * assembled. The board integrity reading stays outside it, because it is the one
 * of the four that answers a question a traveller actually asked — "is this
 * enough to plan a trip from?" — and it now answers it in three lines.
 *
 * Closed by default and rendered server-side, so nothing about it depends on
 * JavaScript: `<details>` works with scripting off, keeps its content in the
 * document for find-in-page, and is announced correctly by every screen reader
 * without a line of ARIA.
 */
export function BoardBackstage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <details
      className={cx('rounded-[var(--radius-card)] border border-rule bg-paper-raised', className)}
      data-testid="board-backstage"
    >
      <summary
        className="min-h-11 cursor-pointer px-4 py-3 text-sm font-medium text-ink-muted hover:text-ink"
        data-testid="board-backstage-toggle"
      >
        How we put this board together
      </summary>
      <div className="space-y-6 border-t border-rule p-4 sm:p-5">{children}</div>
    </details>
  );
}
