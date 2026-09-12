import type { TripNodeState, TripStateNode } from '@sidequest/core';
import { Badge } from '../ui';
import { STATE_WORDS } from './HumanWords';

/**
 * V9 §1 — ONE WORD FOR WHERE A DAY STANDS.
 *
 * Read off the state graph (`dayState`), so the Days view, Today and the
 * dashboard cannot describe one day three ways. The open things beneath it
 * (a booking, a decision, something that changed) are named in the title so
 * the badge is a summary and never a mystery.
 */
export function StateBadge({ dayNumber, state, open = [] }: { dayNumber: number; state: TripNodeState; open?: readonly TripStateNode[] }) {
  const word = STATE_WORDS[state];
  const title = open.length > 0 ? open.slice(0, 3).map((node) => node.label).join(' · ') : undefined;
  return (
    <span data-testid={`day-state-${dayNumber}`} data-state={state} className="inline-flex items-center gap-1.5">
      <Badge tone={word.tone} {...(title ? { title } : {})}>
        {word.label}
      </Badge>
      {open.length > 1 ? <span className="type-meta">{open.length} open</span> : null}
    </span>
  );
}
