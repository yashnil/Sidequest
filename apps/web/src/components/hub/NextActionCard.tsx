'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { NEXT_ACTION_KIND_WORD, type NextAction, type NextActions, type TripPhase } from '@sidequest/core';
import { cx } from '../ui';

/**
 * V9 §2 — WHAT TO DO NOW, AT THE TOP OF THE TRIP.
 *
 * One to three actions from the deterministic ranking, each with the kind of
 * act it is (Decide · Book · Check · Prepare · Re-check · Now), what it is,
 * why it matters and a real date when one exists. Urgency is never invented
 * here: a booking with no deadline reads as a booking with no deadline. The
 * "N more" link goes to the view that lists the rest.
 *
 * Client only for the motion: an action that is settled leaves the list, and
 * the one beneath it rises into its place (`AnimatePresence`, off under
 * reduced motion). Nothing here blocks an action or runs perpetually.
 */
const PHASE_WORD: Record<TripPhase, { eyebrow: string; blurb: string }> = {
  plan: { eyebrow: 'Planning', blurb: 'What the plan still needs from you.' },
  book: { eyebrow: 'Booking', blurb: 'What to arrange, most consequential first.' },
  prepare: { eyebrow: 'Getting ready', blurb: 'What to settle before you go.' },
  travel: { eyebrow: 'Under way', blurb: 'Today first; the rest can wait.' },
  past: { eyebrow: 'Been and gone', blurb: 'Nothing left to do on this trip.' },
};

const KIND_CLASS: Record<NextAction['kind'], string> = {
  decide: 'bg-clay text-paper',
  book: 'bg-accent text-paper',
  verify: 'bg-amber text-paper',
  prepare: 'bg-ink text-paper',
  recheck: 'bg-slate-blue text-paper',
  travel: 'bg-pine text-paper',
};

function dueWord(due: string | undefined): string | null {
  if (!due) return null;
  const then = Date.parse(`${due}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  return `by ${new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(then))}`;
}

export function NextActionCard({ nextActions, moreHref }: { nextActions: NextActions; moreHref?: string }) {
  const reduced = useReducedMotion();
  const phase = PHASE_WORD[nextActions.phase];
  const { actions, remaining } = nextActions;
  const more = moreHref ?? (nextActions.phase === 'book' ? '#book' : '#prepare');
  return (
    <section className="card-raised p-5" aria-labelledby="next-action-heading" data-testid="next-action-card" data-phase={nextActions.phase}>
      <p className="eyebrow text-accent-strong" data-testid="next-action-phase">
        {phase.eyebrow}
      </p>
      <h2 id="next-action-heading" className="mt-1 type-section text-ink">
        {actions.length === 0 ? (nextActions.phase === 'past' ? 'Nothing left to do' : 'Nothing needs you right now') : actions.length === 1 ? 'The one thing to do next' : `The ${actions.length === 2 ? 'two' : 'three'} things to do next`}
      </h2>
      <p className="mt-1 type-small text-ink-muted">{actions.length === 0 && nextActions.phase !== 'past' ? 'Everything the trip depends on is settled or waiting on nobody.' : phase.blurb}</p>
      <ol className="mt-4 grid gap-2.5">
        <AnimatePresence initial={false}>
          {actions.map((action) => (
            <motion.li
              key={action.id}
              layout={!reduced}
              initial={reduced ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: reduced ? 0 : 0.26, ease: [0.2, 0.7, 0.2, 1] }}
            >
              <a
                href={action.href}
                data-testid="next-action"
                data-kind={action.kind}
                className="card lift pressable group flex items-start gap-3.5 px-4 py-3.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
              >
                {/* V9.1 §10 — the kind of act is operational text, so it sits on the 13 px floor rather than the 12 px eyebrow. */}
                <span className={cx('mt-0.5 inline-flex h-6 shrink-0 items-center rounded-sm px-1.5 text-xs font-semibold uppercase tracking-[0.08em]', KIND_CLASS[action.kind])}>{NEXT_ACTION_KIND_WORD[action.kind]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-lg leading-snug text-ink group-hover:underline group-hover:underline-offset-4">{action.title}</span>
                  <span className="mt-0.5 block type-small text-ink-muted">{action.why}</span>
                  {dueWord(action.due) ? <span className="mt-1 block type-meta text-amber">{dueWord(action.due)}</span> : null}
                </span>
                <span aria-hidden="true" className="mt-1 text-ink-faint">
                  →
                </span>
              </a>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
      {remaining > 0 ? (
        <a href={more} className="mt-2 inline-flex min-h-11 items-center type-small text-accent-strong underline underline-offset-4" data-testid="next-action-more">
          {remaining} more
        </a>
      ) : null}
    </section>
  );
}
