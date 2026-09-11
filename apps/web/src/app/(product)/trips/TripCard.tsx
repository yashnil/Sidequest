'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition, type ReactNode } from 'react';
import { LIFECYCLE_LABELS, type TripLifecycle } from '@sidequest/core';
import { DestinationImage, ImageCredit } from '@/components/DestinationImage';
import { Badge, buttonClass, cx } from '@/components/ui';
import type { DashboardRow } from '@/lib/trips/dashboard';
import { composeCardMeta, type CardTone } from '@/lib/trips/card-metadata';
import { deleteTripAction } from '../actions';
import { archiveTripAction, duplicateTripAction, renameTripAction, setLifecycleAction } from './dashboard-actions';

/**
 * V8 §9 — THE TRIP CARD, SHARED BY THE HOME STRIP AND THE DASHBOARD.
 *
 * A card that looks like a trip somebody wants to reopen: a picture where a
 * terms-compliant one exists, the atlas ground carrying the base route sketch
 * where none does — never a wave gradient standing in for a photograph — the
 * destination set in the display face, the dates as a figure, who is going,
 * where the plan stands and what is booked, the base route in order, one
 * obvious action, and depth under the pointer.
 *
 * Two homes, one component, so the same trip is never described two ways: the
 * dashboard hangs its menu (rename, duplicate, stage, archive, remove) off the
 * card; the home strip asks only for a remove button and does its own two-press
 * confirmation in the list. `controls` says which.
 *
 * ## What the picture may and may not do
 *
 * `crop={false}` with `ratio="natural"`: share-alike files must not be adapted,
 * and a crop is an adaptation — `DestinationImage` enforces that in its prop
 * types. The credit is rendered at the card's foot, reachable, because a
 * licence obligation is discharged only where the picture is shown.
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

export function TripCard({ row, onError, controls }: { row: DashboardCardRow; onError: (message: string | null) => void; controls: TripCardControls }) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, startTransition] = useTransition();
  const menuButton = useRef<HTMLButtonElement>(null);

  const run = (work: () => Promise<{ ok: boolean; error?: string; tripId?: string }>, after?: (result: { ok: boolean; tripId?: string }) => void) => {
    onError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        onError(result.error ?? 'That did not work. Your trips are unchanged.');
        return;
      }
      closeMenu();
      after?.(result);
      router.refresh();
    });
  };

  function closeMenu(restoreFocus = false) {
    setMenu(false);
    setConfirmRemove(false);
    if (restoreFocus) menuButton.current?.focus();
  }

  const meta = composeCardMeta(row);
  const quiet = row.lifecycle === 'past' || row.lifecycle === 'archived';

  return (
    <li
      className={cx('card lift group relative flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-panel)]', quiet && 'opacity-90 hover:opacity-100')}
      data-testid="trip-card"
      data-lifecycle={row.lifecycle}
    >
      {/* The picture, whole and uncropped, or the atlas ground with the route sketched on it. */}
      <div className="relative">
        {row.image ? (
          <DestinationImage image={row.image} fallback={row.fallback} ratio="natural" credit="none" className="rounded-none" />
        ) : (
          <TripAtlasPlate bases={row.bases} />
        )}
      </div>

      <Link href={row.href} className="absolute inset-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-[-2px]" aria-label={`Open ${row.title}`} />

      <div className="flex min-w-0 flex-1 flex-col gap-2.5 px-4 pt-4 pb-4 sm:px-5">
        <div className="relative flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          {renaming ? (
            <form
              className="flex min-w-0 flex-1 flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => renameTripAction(row.id, title), () => setRenaming(false));
              }}
            >
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-control)] border border-rule bg-paper px-2.5 text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2" aria-label="Trip name" data-testid="trip-rename-input" autoFocus />
              <button type="submit" className={buttonClass('primary', 'sm')} disabled={pending}>
                Save
              </button>
              <button type="button" className={buttonClass('ghost', 'sm')} onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <h3 className="min-w-0 font-display text-[1.375rem] leading-[1.15] text-ink">
              <Link href={row.href} className="hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2" data-testid="trip-card-title">
                {row.title}
              </Link>
            </h3>
          )}
          <Badge tone={LIFECYCLE_TONE[row.lifecycle]} title={row.lifecycleBasis === 'override' ? 'You set this stage' : 'Sidequest read this from the trip'}>
            {LIFECYCLE_LABELS[row.lifecycle]}
          </Badge>
        </div>

        {row.title !== row.destination ? <p className="-mt-1 type-small text-ink-muted">{row.destination}</p> : null}

        {/* Line one: when, and who. */}
        <p className="text-sm text-ink" data-testid="trip-card-dates">
          {meta.when.figure ? <span className="type-figure">{meta.when.figure}</span> : <span className="italic text-ink-muted">{meta.when.open}</span>}
          {meta.when.rest.map((part) => (
            <span key={part} className="text-ink-muted">
              {' · '}
              {part}
            </span>
          ))}
        </p>
        {meta.when.note ? <p className="-mt-1.5 type-meta">{meta.when.note}</p> : null}

        {/* Line two: where the plan stands, then what is booked. */}
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm" data-testid="trip-card-standing">
          <span className={cx('inline-flex items-center gap-1.5 font-medium', TONE_TEXT[meta.readiness.tone])}>
            <span aria-hidden="true" className={cx('inline-block h-1.5 w-1.5 rounded-full', TONE_DOT[meta.readiness.tone])} />
            {meta.readiness.label}
          </span>
          <span aria-hidden="true" className="text-ink-faint">·</span>
          <span className={meta.booking.booked ? 'text-pine' : 'text-ink-muted'}>{meta.booking.label}</span>
        </p>

        {meta.route.names.length > 0 ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 type-small text-ink-muted" aria-label="Where you sleep, in order">
            {meta.route.names.map((base, index) => (
              <span key={`${base}-${index}`} className="inline-flex min-w-0 items-center gap-1.5">
                {index > 0 ? <span aria-hidden="true" className="inline-block h-0.5 w-3 shrink-0 rounded-full bg-[var(--color-map-route)]" /> : null}
                <span className="truncate">{base}</span>
              </span>
            ))}
            {meta.route.more > 0 ? <span className="text-ink-faint">+{meta.route.more} more</span> : null}
          </p>
        ) : null}

        <div className="relative mt-auto flex min-w-0 flex-wrap items-center justify-between gap-2 pt-2">
          <Link href={row.href} className={buttonClass(quiet ? 'secondary' : 'primary', 'sm')} data-testid="trip-card-action">
            {row.nextAction}
          </Link>
          {controls.kind === 'remove' ? (
            <button
              type="button"
              onClick={controls.onRemove}
              className={cx(buttonClass('ghost', 'sm'), 'text-ink-muted hover:text-clay')}
              aria-label={`Remove the ${row.title} trip`}
            >
              Remove
            </button>
          ) : (
            <div
              className="relative"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && menu) {
                  event.stopPropagation();
                  closeMenu(true);
                }
              }}
            >
              <button
                ref={menuButton}
                type="button"
                className={cx(buttonClass('ghost', 'sm'), 'min-w-11 px-2')}
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-label={`More for ${row.title}`}
                onClick={() => (menu ? closeMenu() : setMenu(true))}
                data-testid="trip-card-menu"
              >
                <MoreGlyph />
              </button>
              {menu ? (
                <div role="menu" className="slide-down absolute right-0 z-30 mt-1 w-60 rounded-[var(--radius-panel)] border border-rule bg-paper-raised p-1.5 shadow-[var(--shadow-float)]" data-testid="trip-card-menu-open">
                  <MenuButton onClick={() => { setRenaming(true); closeMenu(); }}>Rename</MenuButton>
                  <MenuButton onClick={() => run(() => duplicateTripAction(row.id), (r) => { if (r.tripId) router.push(`/trips/${r.tripId}/questionnaire`); })}>Duplicate</MenuButton>
                  {row.lifecycle !== 'past' && row.lifecycle !== 'traveling' && row.lifecycle !== 'archived' ? (
                    <MenuButton onClick={() => run(() => setLifecycleAction(row.id, 'booked'))}>Mark as booked</MenuButton>
                  ) : null}
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
          )}
        </div>

        <div className="relative flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="type-meta">{row.updatedLabel}</p>
          {row.image ? <ImageCredit image={row.image} as="p" className="mt-0 min-w-0 truncate" /> : null}
        </div>
      </div>
    </li>
  );
}

/**
 * THE ATLAS GROUND WHERE THERE IS NO PHOTOGRAPH.
 *
 * Not a placeholder: the same deep cartographic surface every trip opens on,
 * carrying the one thing this card knows about the shape of the trip — the
 * bases in order, as hollow marks joined by a line that draws itself in. A
 * trip with no plan yet gets a quiet plate with a single mark. Nothing here
 * is positioned by coordinates, so nothing here is a claim about a place.
 */
function TripAtlasPlate({ bases }: { bases: readonly string[] }) {
  const count = Math.min(4, bases.length);
  const stops = count === 0 ? [{ x: 50, y: 30 }] : Array.from({ length: count }, (_, index) => ({ x: count === 1 ? 50 : 16 + (index * 68) / (count - 1), y: 26 + (index % 2 === 0 ? 6 : -6) + (count === 1 ? 4 : 0) }));
  const path = stops.length > 1 ? stops.map((stop, index) => (index === 0 ? `M${stop.x} ${stop.y}` : `L${stop.x} ${stop.y}`)).join(' ') : null;
  return (
    <div aria-hidden="true" className="atlas relative aspect-[16/9] w-full overflow-hidden">
      <svg viewBox="0 0 100 56" className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
        {path ? <path d={path} pathLength={1} className="route-draw" fill="none" stroke="var(--color-route-bright)" strokeOpacity={0.75} strokeWidth={0.7} strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {stops.map((stop, index) => (
        <span
          key={index}
          className={cx('absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2', count === 0 ? 'border-[var(--color-atlas-muted)] bg-transparent' : 'border-[var(--color-route-bright)] bg-[var(--color-atlas)]')}
          style={{ left: `${stop.x}%`, top: `${(stop.y / 56) * 100}%` }}
        />
      ))}
    </div>
  );
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
