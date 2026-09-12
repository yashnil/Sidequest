'use client';

import { useState, useTransition } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { PREFLIGHT_CATEGORY_LABELS, type Preflight, type PreflightItem } from '@sidequest/core';
import { setCheckAction } from '@/app/(product)/trips/[id]/itinerary/actions';
import { cx } from '../ui';

/**
 * V9 §7 — "AM I READY TO ACTUALLY TAKE THIS TRIP?"
 *
 * One verdict, how far away the trip is, and three lists: what is ready,
 * what needs attention before departure, what can wait. Every item links to
 * the thing it is about; an item with a `checkId` carries a tick the traveller
 * can press (a `trip_checks(list='preflight')` row — the only thing this view
 * writes, and only on the owner's copy).
 *
 * The verdict settles with one short scale on mount and nothing else moves.
 * The `prepare-top` id stays on the header so the earlier "three things that
 * matter" specs keep landing on the thing that replaced it.
 */
const VERDICT: Record<Preflight['verdict'], { tone: string; dot: string }> = {
  ready: { tone: 'border-pine/40 bg-pine-soft/50', dot: 'bg-pine' },
  nearly: { tone: 'border-amber/40 bg-amber-soft/40', dot: 'bg-amber' },
  not_yet: { tone: 'border-clay/40 bg-clay-soft/40', dot: 'bg-clay' },
};

function awayWord(days: number): string {
  if (days < 0) return 'Under way';
  if (days === 0) return 'Today';
  if (days === 1) return '1 day away';
  return `${days} days away`;
}

export function PreflightView({ preflight, tripId }: { preflight: Preflight; tripId?: string }) {
  const reduced = useReducedMotion();
  const verdict = VERDICT[preflight.verdict];
  return (
    <section aria-labelledby="preflight-heading" data-testid="preflight" data-verdict={preflight.verdict}>
      <motion.div
        className={cx('card-raised border p-5', verdict.tone)}
        data-testid="prepare-top"
        initial={reduced ? false : { opacity: 0, scale: 0.985 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: reduced ? 0 : 0.26, ease: [0.2, 0.7, 0.2, 1] }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="eyebrow">Ready to go?</p>
          <p className="type-figure text-sm text-ink-muted" data-testid="preflight-days">
            {awayWord(preflight.daysUntilTrip)}
          </p>
        </div>
        <h2 id="preflight-heading" className="mt-1 flex items-center gap-2.5 font-display text-2xl leading-tight text-ink" data-testid="preflight-verdict" data-verdict={preflight.verdict}>
          <span aria-hidden="true" className={cx('inline-block h-2.5 w-2.5 shrink-0 rounded-full', verdict.dot)} />
          {preflight.headline}
        </h2>
        <p className="mt-1.5 type-small text-ink-muted">
          {preflight.verdict === 'ready' ? 'Everything the trip depends on is arranged or ticked.' : preflight.verdict === 'nearly' ? 'A few things before you go, none of them big.' : 'Some of these the plan cannot do without.'}
        </p>
      </motion.div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Bucket id="preflight-attention" title="Needs attention" blurb="Before you leave." items={preflight.attention} bucket="attention" {...(tripId ? { tripId } : {})} />
        <Bucket id="preflight-ready" title="Ready" blurb="Done or confirmed." items={preflight.ready} bucket="ready" {...(tripId ? { tripId } : {})} />
        <Bucket id="preflight-later" title="Can wait" blurb="Nearer the date." items={preflight.later} bucket="later" {...(tripId ? { tripId } : {})} />
      </div>
    </section>
  );
}

function Bucket({ id, title, blurb, items, bucket, tripId }: { id: string; title: string; blurb: string; items: readonly PreflightItem[]; bucket: PreflightItem['bucket']; tripId?: string }) {
  return (
    <div data-testid={id} data-count={items.length}>
      <div className="flex items-baseline gap-2">
        <h3 className="type-section text-ink">{title}</h3>
        <span className="type-figure text-sm text-ink-faint">{items.length}</span>
      </div>
      <p className="type-meta">{blurb}</p>
      {items.length === 0 ? (
        <p className="mt-3 type-small text-ink-faint">{bucket === 'attention' ? 'Nothing here.' : bucket === 'ready' ? 'Nothing ticked yet.' : 'Nothing waiting.'}</p>
      ) : (
        <ol className="mt-3 divide-y divide-rule rounded-[var(--radius-card)] border border-rule bg-paper-raised">
          {items.map((item) => (
            <PreflightRow key={item.id} item={item} bucket={bucket} {...(tripId ? { tripId } : {})} />
          ))}
        </ol>
      )}
    </div>
  );
}

function PreflightRow({ item, bucket, tripId }: { item: PreflightItem; bucket: PreflightItem['bucket']; tripId?: string }) {
  const [ticked, setTicked] = useState(bucket === 'ready');
  const [pending, startTransition] = useTransition();
  const tickable = Boolean(tripId && item.checkId);
  return (
    <li className="flex items-start gap-3 px-3.5 py-3" data-testid="preflight-item" data-category={item.category} data-bucket={bucket} {...(item.checkId ? { 'data-check': item.checkId } : {})}>
      {tickable ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={ticked}
          aria-label={`${ticked ? 'Untick' : 'Tick'} ${item.title}`}
          data-testid="preflight-tick"
          disabled={pending}
          onClick={() => {
            const next = !ticked;
            setTicked(next);
            startTransition(async () => {
              const result = await setCheckAction(tripId!, 'preflight', item.checkId!, next);
              if (!result.ok) setTicked(!next);
            });
          }}
          className={cx('mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine', pending && 'opacity-60')}
        >
          <span aria-hidden="true" className={cx('inline-flex h-5 w-5 items-center justify-center rounded-[4px] border text-[0.7rem] leading-none', ticked ? 'border-pine bg-pine text-paper' : 'border-ink-faint bg-paper')}>
            {ticked ? '✓' : ''}
          </span>
        </button>
      ) : (
        <span aria-hidden="true" className={cx('mt-3 inline-block h-2 w-2 shrink-0 rounded-full', bucket === 'ready' ? 'bg-pine' : bucket === 'attention' ? 'bg-amber' : 'bg-ink-faint')} />
      )}
      <span className="min-w-0 flex-1 py-1.5">
        <a href={item.href} className={cx('block text-sm font-medium text-ink underline-offset-4 hover:underline', ticked && bucket !== 'ready' && 'text-ink-muted line-through')}>
          {item.title}
        </a>
        <span className="mt-0.5 block type-meta">
          {PREFLIGHT_CATEGORY_LABELS[item.category]}
          {item.sourceName ? ` · ${item.sourceName}` : ''}
          {item.readAt ? ` · ${item.readAt}` : ''}
        </span>
        {item.detail ? <span className="mt-1 block type-small text-ink-muted">{item.detail}</span> : null}
      </span>
    </li>
  );
}
