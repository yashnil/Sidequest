'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type ReactNode } from 'react';
import { LIFECYCLE_LABELS, NEXT_ACTION_KIND_WORD, type TripLifecycle } from '@sidequest/core';
import { DestinationImage, ImageCredit } from '@/components/DestinationImage';
import { TripPlate, hasPlacedShape } from '@/components/collection/TripPlate';
import { ledgerMark, ledgerWords } from '@/components/collection/plate-geometry';
import { countdown, formatCatalogue } from '@/components/collection/stamp-geometry';
import { buttonClass, cx } from '@/components/ui';
import type { DashboardRow } from '@/lib/trips/dashboard';
import { composeCardMeta, type CardTone } from '@/lib/trips/card-metadata';
import { deleteTripAction } from '../actions';
import { archiveTripAction, duplicateTripAction, renameTripAction, setLifecycleAction } from './dashboard-actions';

/**
 * V8 §9 — THE TRIP CARD, SHARED BY THE HOME STRIP AND THE COLLECTION.
 *
 * SURVEY ATLAS, ROUND 2 (2026-10) — one component, four layouts, because a
 * collection is not one cell size:
 *
 * - **`lead`**, **`standard`**, **`wide`** — trips still ahead. A plate on
 *   top (or beside, for `wide`): the trip's own route plotted from persisted
 *   coordinates (`RoutePlate`), or, with nothing placed, a ledger mark made
 *   of what *is* known — letterforms, months, nights, party (`LedgerMark`).
 *   The photograph, when a terms-compliant one is stored, is laid on the
 *   plate as a whole print (`ratio="natural"`, never cropped). Then the
 *   name, the countdown in words, and the ruled lines a traveller reads.
 * - **`index`** — ideas, past and archived trips, as one ruled catalogue row:
 *   number, a thumbnail plate, name, when, where it stands, the act. Cereal's
 *   archive, not a wall of tiles.
 *
 * Every layout carries every test id the suite drives (`trip-card`,
 * `trip-card-title`, `-dates`, `-standing`, `-booking-state`, `-next-action`,
 * `-action`, `-menu`, `trip-rename-input`), so a layout is presentation only.
 *
 * The home strip asks only for a remove button and does its own two-press
 * confirmation in the list; the collection hangs its menu (rename, duplicate,
 * stage, archive, remove) off the card. `controls` says which.
 *
 * ## The card is one link, drawn as an overlay
 *
 * The whole surface is the link — an absolutely positioned anchor with a
 * screen-reader name — and every other control sits above it in the stacking
 * order (`relative`), so the menu, the rename form and the credit are their own
 * targets rather than nested interactive elements.
 */

const LIFECYCLE_TONE: Record<TripLifecycle, CardTone> = {
  idea: 'neutral',
  planning: 'blue',
  ready: 'pine',
  booked: 'pine',
  traveling: 'amber',
  past: 'neutral',
  archived: 'neutral',
};

const TONE_DOT: Record<CardTone, string> = {
  neutral: 'bg-ink-faint',
  pine: 'bg-pine',
  amber: 'bg-amber',
  blue: 'bg-slate-blue',
  clay: 'bg-clay',
};

const TONE_TEXT: Record<CardTone, string> = {
  neutral: 'text-ink-muted',
  pine: 'text-pine',
  amber: 'text-amber',
  blue: 'text-slate-blue',
  clay: 'text-clay',
};

/** A row with the one thing only the server can say without a hydration mismatch. */
export type DashboardCardRow = DashboardRow & { updatedLabel: string };

export type TripCardControls = { kind: 'menu' } | { kind: 'remove'; onRemove: () => void };

export type TripCardVariant = 'lead' | 'standard' | 'wide' | 'index';

const PLATE: Record<Exclude<TripCardVariant, 'index'>, { w: number; h: number }> = {
  lead: { w: 640, h: 340 },
  standard: { w: 480, h: 330 },
  wide: { w: 640, h: 320 },
};

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

export function TripCard({
  row,
  onError,
  controls,
  catalogue,
  variant = 'standard',
  today,
  className,
}: {
  row: DashboardCardRow;
  onError: (message: string | null) => void;
  controls: TripCardControls;
  catalogue?: number;
  variant?: TripCardVariant;
  /** `YYYY-MM-DD` from the server's clock, for the countdown; without it the card states the dates only. */
  today?: string;
  className?: string;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [pending, startTransition] = useTransition();
  const [menuOpen, setMenuOpen] = useState(false);

  const run = (work: () => Promise<{ ok: boolean; error?: string; tripId?: string }>, after?: (result: { ok: boolean; tripId?: string }) => void) => {
    onError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        onError(result.error ?? 'That did not work. Your trips are unchanged.');
        return;
      }
      setMenuOpen(false);
      after?.(result);
      router.refresh();
    });
  };

  const meta = composeCardMeta(row);
  const quiet = row.lifecycle === 'past' || row.lifecycle === 'archived';
  /* The index keeps a plain running number ("03"); "No. 03" read as a catalogue code to a first-time visitor. */
  const number = catalogue ? formatCatalogue(catalogue).replace(/^No\.\s*/, '') : undefined;
  const placed = hasPlacedShape(row.shape);
  const facts = { id: row.id, destination: row.destination, startDate: row.startDate, nights: row.nights, party: row.party, timing: row.timing, lifecycle: row.lifecycle };
  const when = today ? countdown(row, today) : null;

  const titleBlock = renaming ? (
    <form
      className="relative flex min-w-0 flex-1 flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => renameTripAction(row.id, title), () => setRenaming(false));
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} className={cx('min-h-11 min-w-0 flex-1 border-0 border-b border-ink bg-transparent px-0.5 font-display text-xl text-ink', FOCUS)} aria-label="Trip name" data-testid="trip-rename-input" autoFocus />
      <button type="submit" className={buttonClass('primary', 'sm')} disabled={pending} aria-busy={pending}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setRenaming(false)}>
        Cancel
      </button>
    </form>
  ) : (
    <h3
      className={cx(
        'min-w-0 font-display font-[400] text-ink',
        variant === 'lead' || variant === 'wide' ? 'text-[clamp(1.9rem,1.4rem+1.6vw,2.75rem)] leading-[0.98] tracking-[-0.03em]' : variant === 'index' ? 'text-[1.4rem] leading-[1.08] tracking-[-0.015em]' : 'text-[1.65rem] leading-[1.04] tracking-[-0.02em]',
      )}
    >
      <Link href={row.href} className={cx('relative decoration-1 underline-offset-[5px] group-hover:underline', FOCUS)} data-testid="trip-card-title">
        {row.title}
      </Link>
    </h3>
  );

  const dates = (
    <p className="min-w-0 text-sm text-ink" data-testid="trip-card-dates">
      {meta.when.figure ? <span className="type-figure text-[0.8rem]">{meta.when.figure}</span> : <span className="italic text-ink-muted">{meta.when.open}</span>}
      {meta.when.rest.map((part) => (
        <span key={part} className="text-ink-muted">
          {' · '}
          {part}
        </span>
      ))}
    </p>
  );

  const standing = (
    <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm" data-testid="trip-card-standing">
      <span className={cx('inline-flex items-center gap-1.5 font-medium', TONE_TEXT[meta.readiness.tone])}>
        <span aria-hidden="true" className={cx('inline-block h-1.5 w-1.5', TONE_DOT[meta.readiness.tone])} />
        {meta.readiness.label}
      </span>
      <span aria-hidden="true" className="text-ink-faint">·</span>
      {/* V9 §21 — "6 of 8 major items booked" from the engine; V9.1 §10 — a booked state carries a filled mark as well as the colour. */}
      <span className={cx('inline-flex items-center gap-1.5', meta.booking.booked ? 'text-pine' : 'text-ink-muted')} data-testid="trip-card-booking-state" data-booked={meta.booking.booked ? 'true' : 'false'}>
        {meta.booking.booked ? (
          <span aria-hidden="true" className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center bg-pine text-[0.6rem] leading-none text-paper">
            ✓
          </span>
        ) : null}
        {row.bookingState ?? meta.booking.label}
      </span>
    </p>
  );

  /* V9 §21 — the next best action from the engine, the same one the hub leads with. */
  const nextAction =
    row.next && !quiet ? (
      <p className="flex min-w-0 items-start gap-2 text-sm" data-testid="trip-card-next-action" data-kind={row.next.kind}>
        <span className="mt-0.5 inline-flex h-5 shrink-0 items-center border border-ink/30 px-1.5 font-mono text-[0.68rem] font-medium uppercase tracking-[0.1em] text-ink-muted">{NEXT_ACTION_KIND_WORD[row.next.kind]}</span>
        <Link href={row.next.href} className={cx('relative line-clamp-2 min-w-0 text-ink underline-offset-4 hover:underline', FOCUS)} title={`${row.next.title} — ${row.next.why}`}>
          {row.next.title}
        </Link>
      </p>
    ) : null;

  const route =
    meta.route.names.length > 0 ? (
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 type-small text-ink-muted" aria-label="Where you sleep, in order">
        {meta.route.names.map((base, index) => (
          <span key={`${base}-${index}`} className="inline-flex min-w-0 items-center gap-1.5">
            {index > 0 ? <span aria-hidden="true" className="inline-block w-3 shrink-0 border-t border-dotted border-[var(--color-route)]" /> : null}
            <span className="truncate">{base}</span>
          </span>
        ))}
        {meta.route.more > 0 ? <span className="text-ink-faint">+{meta.route.more} more</span> : null}
      </p>
    ) : null;

  const status = (
    <span className={cx('inline-flex items-center gap-1.5', TONE_TEXT[LIFECYCLE_TONE[row.lifecycle]])} title={row.lifecycleBasis === 'override' ? 'You set this stage' : 'Sidequest read this from the trip'}>
      <span aria-hidden="true" className={cx('inline-block h-1.5 w-1.5', TONE_DOT[LIFECYCLE_TONE[row.lifecycle]])} />
      {LIFECYCLE_LABELS[row.lifecycle]}
    </span>
  );

  const menu =
    controls.kind === 'remove' ? (
      <button type="button" onClick={controls.onRemove} className={cx(buttonClass('ghost', 'sm'), 'relative text-ink-muted hover:text-clay')} aria-label={`Remove the ${row.title} trip`}>
        Remove
      </button>
    ) : (
      <CardMenu row={row} pending={pending} open={menuOpen} setOpen={setMenuOpen} onRename={() => setRenaming(true)} run={run} />
    );

  const overlay = <Link href={row.href} className="absolute inset-0 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-[-2px]" aria-label={`Open ${row.title}`} />;

  /* ─────────────────────────── THE INDEX ROW ─────────────────────────── */
  if (variant === 'index') {
    return (
      <li
        className={cx(
          'group relative grid min-w-0 grid-cols-[3.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 py-4 transition-colors duration-[var(--motion-fast)] hover:bg-paper-sunk/45 focus-within:bg-paper-sunk/45 sm:grid-cols-[4.5rem_minmax(0,1fr)] md:grid-cols-[3.25rem_4.5rem_minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1.15fr)_12.5rem] md:items-center md:gap-x-5 md:py-3.5',
          menuOpen ? 'z-20' : '',
          className,
        )}
        data-testid="trip-card"
        data-lifecycle={row.lifecycle}
        data-variant="index"
      >
        <span aria-hidden="true" className="coordbar hidden pl-1 text-ink-faint md:block">
          {number ?? ''}
        </span>
        <div className="relative row-span-4 self-start transition-transform duration-[var(--motion-base)] group-hover:-translate-y-0.5 motion-reduce:group-hover:translate-y-0 md:row-span-1 md:self-center">
          <TripPlate shape={row.shape} facts={facts} width={72} height={72} detail="mini" className="block h-auto w-full bg-paper-raised" />
        </div>
        {overlay}
        <div className="min-w-0">
          <p className="coordbar text-ink-faint md:hidden">
            {LIFECYCLE_LABELS[row.lifecycle]}
          </p>
          {titleBlock}
          {row.title !== row.destination ? <p className="mt-0.5 type-small text-ink-muted">{row.destination}</p> : null}
          {route ? <div className="mt-1">{route}</div> : null}
        </div>
        <div className="min-w-0">
          {dates}
          {meta.when.note ? <p className="mt-0.5 type-meta">{meta.when.note}</p> : null}
        </div>
        <div className="grid min-w-0 gap-1">
          {standing}
          {nextAction}
        </div>
        <div className="relative flex min-w-0 flex-wrap items-center gap-1 md:justify-end">
          <Link href={row.href} className={cx('relative inline-flex min-h-11 items-center gap-1.5 px-1 text-sm font-semibold text-ink underline decoration-ink/25 underline-offset-[5px] hover:decoration-ink', FOCUS)} data-testid="trip-card-action">
            {row.nextAction}
            <span aria-hidden="true" className="transition-transform duration-[var(--motion-fast)] group-hover:translate-x-0.5">
              →
            </span>
          </Link>
          {menu}
        </div>
      </li>
    );
  }

  /* ─────────────────────────── THE FEATURE ENTRY ─────────────────────────── */
  const plate = PLATE[variant];
  const big = variant === 'lead' || variant === 'wide';
  const countdownLine =
    when?.kind === 'until' ? (
      big ? (
        <span className="flex items-end gap-2.5">
          <span className="numeral-giant text-[clamp(3.25rem,2.4rem+2.4vw,4.75rem)] leading-[0.8] text-ink">{when.days}</span>
          <span className="coordbar mb-1 text-ink-muted">{when.days === 1 ? 'day to go' : 'days to go'}</span>
        </span>
      ) : (
        <span className="coordbar text-ink-muted">{when.days === 1 ? 'Tomorrow' : `In ${when.days} days`}</span>
      )
    ) : when?.kind === 'during' ? (
      <span className="coordbar text-amber">
        Day {when.day} of {when.of}
      </span>
    ) : null;

  /* Say what the line joins, in plain words: where you sleep in order, or the day's stops in order. */
  const plateCaption = placed ? (row.shape!.bases.length > 1 ? 'Where you sleep, in order' : 'Your stops, in order') : ledgerWords(ledgerMark(facts));
  const plateCount = placed ? mappedWords(row.shape!.bases.length, row.shape!.stops.length) : 'Not on the map yet';

  return (
    <li
      className={cx(
        'sheet group relative flex min-w-0 flex-col transition-[box-shadow,transform] duration-[var(--motion-base)] hover:-translate-y-0.5 hover:shadow-[0_22px_40px_-30px_rgb(13_26_31/0.55)] focus-within:shadow-[0_22px_40px_-30px_rgb(13_26_31/0.55)] motion-reduce:hover:translate-y-0',
        variant === 'wide' ? 'lg:grid lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]' : '',
        menuOpen ? 'z-20' : '',
        className,
      )}
      data-testid="trip-card"
      data-lifecycle={row.lifecycle}
      data-variant={variant}
    >
      {/* THE PLATE: the trip's own shape, or its ledger mark; the photograph as a whole print laid on it. */}
      <div className={cx('relative min-w-0 overflow-hidden bg-paper-raised', variant === 'wide' ? 'border-b border-ink/10 lg:border-r lg:border-b-0' : 'border-b border-ink/10')}>
        <div className="flex min-w-0 items-center justify-between gap-3 px-4 pt-3">
          <span className="coordbar">{status}</span>
          <span className="coordbar text-ink-faint">{plateCount}</span>
        </div>
        <TripPlate
          shape={row.shape}
          facts={facts}
          width={plate.w}
          height={plate.h}
          className={cx('block h-auto w-full', big ? '' : '[&_.plate-label]:opacity-0 [&_.plate-label]:transition-opacity group-hover:[&_.plate-label]:opacity-100 group-focus-within:[&_.plate-label]:opacity-100')}
        />
        {row.image ? (
          <div className={cx('print-frame absolute right-4 bottom-9 rotate-[1.5deg] transition-transform duration-[var(--motion-base)] group-hover:rotate-0 motion-reduce:group-hover:rotate-[1.5deg]', big ? 'w-[30%] max-w-[13rem]' : 'w-[36%] max-w-[10rem]')}>
            <DestinationImage image={row.image} fallback={row.fallback} ratio="natural" credit="none" className="[&>div]:rounded-none" />
            <p className="px-0.5 pt-1.5 pb-2 font-mono text-[9px] uppercase tracking-[0.1em] text-[#5f625c]">{row.destination}</p>
          </div>
        ) : null}
        <p className="coordbar flex min-w-0 flex-wrap gap-x-3 gap-y-1 px-4 pb-3 whitespace-normal text-ink-faint">
          <span>{plateCaption}</span>
          {placed && (row.shape!.bases.length > 1 || row.shape!.stops.length > 1) ? (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block w-5 border-t-2 border-dotted border-[var(--color-route)]" /> lines show order, not roads
            </span>
          ) : null}
        </p>
      </div>

      {overlay}

      <div className={cx('flex min-w-0 flex-1 flex-col px-4 pt-4 pb-4 sm:px-5', big ? 'sm:pt-5' : '')}>
        <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            {titleBlock}
            {row.title !== row.destination ? <p className="mt-1 type-small text-ink-muted">{row.destination}</p> : null}
          </div>
          {countdownLine ? <div className="shrink-0">{countdownLine}</div> : null}
        </div>

        {/* The ruled lines: when and who; where it stands; the next act; where you sleep. */}
        <div className="ruled mt-3 min-w-0 border-t border-ink/15 [&>*]:py-2">
          <div className="min-w-0">
            {dates}
            {meta.when.note ? <p className="mt-0.5 type-meta">{meta.when.note}</p> : null}
          </div>
          {standing}
          {nextAction}
          {route}
        </div>

        <div className={cx('relative flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-ink/15 pt-3', variant === 'wide' ? 'mt-4' : 'mt-auto')}>
          <Link href={row.href} className={buttonClass(quiet ? 'secondary' : 'primary', 'sm')} data-testid="trip-card-action">
            {row.nextAction}
          </Link>
          {menu}
        </div>

        <div className="relative mt-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="coordbar text-ink-faint">{row.updatedLabel}</p>
          {row.image ? <ImageCredit image={row.image} as="p" className="mt-0 min-w-0 truncate" /> : null}
        </div>
      </div>
    </li>
  );
}

/**
 * The card's menu on its own, for a surface that shows a trip without being
 * its card — the collection's cover. Everything but Rename, which edits the
 * card's title in place and so belongs to the card.
 */
export function TripQuickMenu({ row, onError, tone = 'paper' }: { row: DashboardCardRow; onError: (message: string | null) => void; tone?: 'paper' | 'night' }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const run = (work: () => Promise<{ ok: boolean; error?: string; tripId?: string }>, after?: (result: { ok: boolean; tripId?: string }) => void) => {
    onError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        onError(result.error ?? 'That did not work. Your trips are unchanged.');
        return;
      }
      setOpen(false);
      after?.(result);
      router.refresh();
    });
  };
  return (
    <div className={tone === 'night' ? '[&>div>button:first-child]:text-[var(--color-atlas-ink)] [&>div>button:first-child]:hover:bg-white/10' : undefined}>
      <CardMenu row={row} pending={pending} open={open} setOpen={setOpen} run={run} />
    </div>
  );
}

function CardMenu({
  row,
  pending,
  open,
  setOpen,
  onRename,
  run,
}: {
  row: DashboardCardRow;
  pending: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  onRename?: () => void;
  run: (work: () => Promise<{ ok: boolean; error?: string; tripId?: string }>, after?: (result: { ok: boolean; tripId?: string }) => void) => void;
}) {
  const router = useRouter();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const close = (restoreFocus = false) => {
    setOpen(false);
    setConfirmRemove(false);
    if (restoreFocus) menuButton.current?.focus();
  };
  return (
    <div
      className="relative"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <button
        ref={menuButton}
        type="button"
        className={cx(buttonClass('ghost', 'sm'), 'min-w-11 px-2')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More for ${row.title}`}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="trip-card-menu"
      >
        <MoreGlyph />
      </button>
      {open ? (
        <div role="menu" aria-busy={pending} className="slide-down sheet absolute right-0 z-30 mt-1 w-60 p-1.5 shadow-[var(--shadow-float)]" data-testid="trip-card-menu-open">
          {onRename ? (
            <MenuButton
              onClick={() => {
                onRename();
                close();
              }}
            >
              Rename
            </MenuButton>
          ) : null}
          <MenuButton
            onClick={() =>
              run(
                () => duplicateTripAction(row.id),
                (r) => {
                  if (r.tripId) router.push(`/trips/${r.tripId}/questionnaire`);
                },
              )
            }
          >
            Duplicate
          </MenuButton>
          {row.lifecycle !== 'past' && row.lifecycle !== 'traveling' && row.lifecycle !== 'archived' ? <MenuButton onClick={() => run(() => setLifecycleAction(row.id, 'booked'))}>Mark as booked</MenuButton> : null}
          {row.lifecycleBasis === 'override' ? <MenuButton onClick={() => run(() => setLifecycleAction(row.id, null))}>Let Sidequest set the stage</MenuButton> : null}
          <MenuButton onClick={() => run(() => archiveTripAction(row.id, row.lifecycle !== 'archived'))}>{row.lifecycle === 'archived' ? 'Restore' : 'Archive'}</MenuButton>
          {confirmRemove ? (
            <div className="px-2.5 py-2 text-sm text-ink">
              Remove for good?
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={cx(buttonClass('secondary', 'sm'), 'border-clay text-clay')} disabled={pending} onClick={() => run(() => deleteTripAction(row.id))} data-testid="trip-card-remove-confirm">
                  Remove
                </button>
                <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setConfirmRemove(false)}>
                  Keep it
                </button>
              </div>
            </div>
          ) : (
            <MenuButton onClick={() => setConfirmRemove(true)}>Remove</MenuButton>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** "6 stops mapped", "2 places to stay · 9 stops" — what the plate draws, counted in words. */
export function mappedWords(bases: number, stops: number): string {
  const parts: string[] = [];
  if (bases > 1) parts.push(`${bases} places to stay`);
  if (stops > 0) parts.push(`${stops} ${stops === 1 ? 'stop' : 'stops'}`);
  return parts.length > 0 ? `${parts.join(' · ')} mapped` : 'On the map';
}

function MoreGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function MenuButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex min-h-11 w-full items-center rounded-[var(--radius-control)] px-2.5 text-left text-sm text-ink hover:bg-paper-sunk focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-[-2px]"
    >
      {children}
    </button>
  );
}
