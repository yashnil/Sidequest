'use client';

import { useState, useTransition } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { PREFLIGHT_CATEGORY_LABELS, PREPARE_GROUPS, PREPARE_GROUP_LABELS, groupPreflight, type Preflight, type PreflightItem, type PrepareGroup } from '@sidequest/core';
import { setCheckAction } from '@/app/(product)/trips/[id]/itinerary/actions';
import { buttonClass, cx } from '../ui';

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
 *
 * V9.1 §10 — on a phone the lists stack, and the one a traveller scrolls past
 * to reach what is beneath it starts folded there (a count and a "Show"
 * button) and is always open from `lg` up. A tick acknowledges the press in the
 * same render: the box fills, the button is busy, and a screen reader hears
 * "Saving…".
 *
 * V11 §2 — THIS IS NOW PREPARE'S ONE READINESS LIST.
 *
 * A readiness entry used to be rendered three times on the same page — a bucket
 * card here, the full body again in "Before you go", and the full body a third
 * time under "In order", because `buildChecklist` turns every entry into a
 * checklist item as well. Three derived structures over one fact, each
 * restating it instead of indexing it, across about eleven thousand pixels.
 *
 * The duplication was an ownership problem, not a layout problem, so it is
 * fixed by deciding who owns it rather than by hiding two copies. Preflight
 * owns it: of the three it is the one that already knows the entry's state and
 * the traveller's ticks. The other two stopped re-listing entries; this view
 * gained the fourth group and the entry's own identity, links and state, so
 * nothing that was readable before became unreadable.
 *
 * Grouping is a view over the one list (`groupPreflight`), which is why the
 * four groups are derived here rather than stored: a filter may change what a
 * traveller sees without there being a second copy of anything to keep in step.
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

export function PreflightView({ preflight, tripId, bookingsListedBelow = false }: { preflight: Preflight; tripId?: string; /**
   * V11 §3 — set where the page also renders Book first, which lists the same
   * booking needs *with the actions that act on them*. Prepare does, directly
   * beneath this view, so a booking need appeared once here as a row that only
   * pointed at it and again below as a row that could be pressed. The one that
   * can be acted on wins; this list keeps the count in its verdict either way.
   *
   * A prop rather than an assumption: this view cannot see what is under it,
   * and a component that quietly omits data because of what it guesses its
   * neighbour is doing is worse than one that is told.
   */
  bookingsListedBelow?: boolean }) {
  const reduced = useReducedMotion();
  const verdict = VERDICT[preflight.verdict];
  const groups = groupPreflight(
    bookingsListedBelow
      ? {
          ready: preflight.ready.filter((i) => i.category !== 'bookings'),
          attention: preflight.attention.filter((i) => i.category !== 'bookings'),
          later: preflight.later.filter((i) => i.category !== 'bookings'),
        }
      : preflight,
  );
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

      <div className="mt-6 grid gap-6 lg:grid-cols-2" data-testid="readiness-list">
        {PREPARE_GROUPS.map((group) => (
          <Bucket
            key={group}
            id={GROUP_TEST_ID[group]}
            group={group}
            items={groups[group]}
            /* The two a traveller scrolls past on a phone fold there and open from `lg`. */
            collapsible={group === 'closer_to_the_trip' || group === 'ready'}
            {...(tripId ? { tripId } : {})}
          />
        ))}
      </div>
    </section>
  );
}

/*
 * The ids the browser suite already knows, kept pointing at the group that
 * replaced each old bucket so an assertion that meant "what needs doing" still
 * means it. `preflight-later` is the group that genuinely waits.
 */
const GROUP_TEST_ID: Record<PrepareGroup, string> = {
  needs_attention: 'preflight-attention',
  before_you_leave: 'preflight-before-you-leave',
  closer_to_the_trip: 'preflight-later',
  ready: 'preflight-ready',
};

const EMPTY_WORD: Record<PrepareGroup, string> = {
  needs_attention: 'Nothing here.',
  before_you_leave: 'Nothing before you go.',
  closer_to_the_trip: 'Nothing waiting.',
  ready: 'Nothing ticked yet.',
};

function Bucket({ id, group, items, tripId, collapsible = false }: { id: string; group: PrepareGroup; items: readonly PreflightItem[]; tripId?: string; collapsible?: boolean }) {
  const { title, blurb } = PREPARE_GROUP_LABELS[group];
  /* Folded on phones only; `lg:block` on the list keeps it open on a wide screen without a script. */
  const [expanded, setExpanded] = useState(false);
  const folded = collapsible && !expanded && items.length > 0;
  const listId = `${id}-list`;
  return (
    <div data-testid={id} data-count={items.length} {...(collapsible ? { 'data-collapsed': folded ? 'true' : 'false' } : {})}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="type-section text-ink">{title}</h3>
        <span className="type-figure text-sm text-ink-faint">{items.length}</span>
        {collapsible && items.length > 0 ? (
          <button type="button" className={cx(buttonClass('ghost', 'sm'), 'ml-auto lg:hidden')} aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded((v) => !v)} data-testid="preflight-later-toggle">
            {expanded ? 'Hide' : `Show ${items.length}`}
          </button>
        ) : null}
      </div>
      <p className="type-meta">{blurb}</p>
      {items.length === 0 ? (
        <p className="mt-3 type-small text-ink-faint">{EMPTY_WORD[group]}</p>
      ) : (
        <ol id={listId} className={cx('mt-3 divide-y divide-rule rounded-[var(--radius-card)] border border-rule bg-paper-raised', folded && 'hidden lg:block')}>
          {items.map((item) => (
            <PreflightRow key={item.id} item={item} group={group} {...(tripId ? { tripId } : {})} />
          ))}
        </ol>
      )}
    </div>
  );
}

function PreflightRow({ item, group, tripId }: { item: PreflightItem; group: PrepareGroup; tripId?: string }) {
  const [ticked, setTicked] = useState(group === 'ready');
  const [pending, startTransition] = useTransition();
  const tickable = Boolean(tripId && item.checkId);
  return (
    <li
      className="flex items-start gap-3 px-3.5 py-3"
      data-testid="preflight-item"
      data-category={item.category}
      data-bucket={item.bucket}
      data-group={group}
      {...(item.checkId ? { 'data-check': item.checkId } : {})}
      /*
        V11 §2 — a readiness entry is addressable here, because here is the only
        place it is rendered. The kind and state used to live on the "Before you
        go" grid row, which no longer exists; the assertions that named them are
        assertions about real behaviour (a visa entry that needs input must say
        so), so they follow the entry to its one home rather than being dropped.

        They ride on attributes rather than on a second `data-testid`: this is
        one kind of row, and giving some of them a different test id split the
        canonical list in two for anything that addressed it as a whole.
      */
      {...(item.readinessKind ? { 'data-kind': item.readinessKind } : {})}
      {...(item.readinessState ? { 'data-state': item.readinessState } : {})}
    >
      {tickable ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={ticked}
          aria-busy={pending}
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
          <span aria-hidden="true" className={cx('inline-flex h-5 w-5 items-center justify-center rounded-[4px] border text-xs leading-none', ticked ? 'border-pine bg-pine text-paper' : 'border-ink-faint bg-paper')}>
            {ticked ? '✓' : ''}
          </span>
          <span className="sr-only" aria-live="polite">
            {pending ? 'Saving…' : ''}
          </span>
        </button>
      ) : (
        <span aria-hidden="true" className={cx('mt-3 inline-block h-2 w-2 shrink-0 rounded-full', group === 'ready' ? 'bg-pine' : group === 'needs_attention' ? 'bg-amber' : 'bg-ink-faint')} />
      )}
      <span className="min-w-0 flex-1 py-1.5">
        <a href={item.href} className={cx('block text-sm font-medium text-ink underline-offset-4 hover:underline', ticked && group !== 'ready' && 'text-ink-muted line-through')}>
          {item.title}
        </a>
        {/*
          The category is context for the title, so it is dropped when it *is*
          the title — the connectivity entry is called "Staying connected" and
          sits in the category "Staying connected", which printed the same two
          words twice, two lines apart. Saying a thing twice in one row is the
          same fault as saying it twice on one page, at a smaller scale.
        */}
        {(() => {
          const category = PREFLIGHT_CATEGORY_LABELS[item.category];
          const parts = [category.toLowerCase() === item.title.toLowerCase().replace(/\.$/, '') ? null : category, item.sourceName ?? null, item.readAt ?? null].filter(Boolean);
          return parts.length > 0 ? <span className="mt-0.5 block type-meta">{parts.join(' · ')}</span> : null;
        })()}
        {item.detail ? <span className="mt-1 block type-small text-ink-muted">{item.detail}</span> : null}
        {/*
          The official links came with the "Before you go" copy of this entry.
          They are the part a traveller acts on — the government page, the
          airline, the park — so they travel with the entry to its one home
          rather than being the reason to keep a second rendering of it.
        */}
        {item.links && item.links.length > 0 ? (
          <span className="mt-1.5 flex flex-wrap gap-x-3">
            {item.links.map((link) => (
              <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener" className="type-small text-accent underline underline-offset-4">
                {link.name}
              </a>
            ))}
          </span>
        ) : null}
      </span>
    </li>
  );
}
