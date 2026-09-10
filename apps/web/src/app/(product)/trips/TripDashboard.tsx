'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { LIFECYCLE_LABELS, type TripLifecycle } from '@sidequest/core';
import { DestinationImage } from '@/components/DestinationImage';
import { Badge, ErrorNote, buttonClass, cx } from '@/components/ui';
import type { DashboardRow } from '@/lib/trips/dashboard';
import { deleteTripAction } from '../actions';
import { archiveTripAction, duplicateTripAction, renameTripAction, setLifecycleAction } from './dashboard-actions';

/**
 * THE DASHBOARD — TRIP CARDS GROUPED BY WHERE EACH TRIP IS IN ITS LIFE.
 *
 * V6 §25. A card shows the destination picture, the name, the dates (or the
 * fact that timing is still open), who is going, the route, what is booked,
 * the stage, and the one action that carries on from here. The controls a
 * list needs — search, sort, filter — are in the address bar so a reload
 * keeps them; the per-card actions (rename, duplicate, archive, remove, set
 * a stage) are server actions behind a small menu.
 *
 * No database aesthetic: no table, no id column, no status enum on screen.
 *
 * ## What the picture may and may not do
 *
 * `crop={false}` with `ratio="natural"` throughout. Share-alike files must not
 * be adapted, and a crop is an adaptation — `DestinationImage` enforces that in
 * its prop types, and the natural ratio is what lets a card show the whole file
 * without letterbox bands. It also means the pictures in a row are not all the
 * same height, which is what an editorial grid looks like rather than a defect.
 *
 * ## The card is one link, drawn as an overlay
 *
 * A card whose only target is its title is a card most people press and nothing
 * happens. The whole surface is the link — an absolutely positioned anchor with
 * a screen-reader name — and every *other* control on the card sits above it in
 * the stacking order, so the menu and the rename form are still their own
 * targets rather than nested interactive elements.
 */

const LIFECYCLE_TONE: Record<TripLifecycle, 'neutral' | 'pine' | 'amber' | 'blue' | 'clay'> = {
  idea: 'neutral',
  planning: 'blue',
  ready: 'pine',
  booked: 'pine',
  traveling: 'amber',
  past: 'neutral',
  archived: 'neutral',
};

/** What each section is for, said once at the top of it rather than on every card. */
const SECTION_NOTE: Record<string, string> = {
  upcoming: 'Under way right now.',
  booked: 'A bed or a way there is paid for.',
  planning: 'Days exist. Still yours to change.',
  ideas: 'Somewhere you were thinking about.',
  past: 'Been and gone.',
  archived: 'Out of the way, not deleted.',
};

interface Section {
  id: string;
  title: string;
  lifecycles: readonly TripLifecycle[];
}

/** A row with the one thing only the server can say without a hydration mismatch. */
export type DashboardCardRow = DashboardRow & { updatedLabel: string };

export function TripDashboard({
  rows,
  sections,
  query,
  sort,
  filter,
  signedIn,
}: {
  rows: DashboardCardRow[];
  sections: readonly Section[];
  query: string;
  sort: 'date' | 'changed';
  filter: string;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(query);
  const [error, setError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = rows.filter((row) => (needle ? `${row.title} ${row.destination} ${row.bases.join(' ')}`.toLowerCase().includes(needle) : true)).filter((row) => (filter === 'all' ? true : row.lifecycle === filter));
    return [...filtered].sort((a, b) => (sort === 'changed' ? b.updatedAt.localeCompare(a.updatedAt) : a.startDate.localeCompare(b.startDate)));
  }, [rows, search, filter, sort]);

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(window.location.search);
    if (value && value !== 'all' && value !== 'date') params.set(key, value);
    else params.delete(key);
    router.replace(`/trips${params.toString() ? `?${params.toString()}` : ''}`);
  };

  if (rows.length === 0) {
    return (
      <div className="mt-10 overflow-hidden rounded-[var(--radius-plate)] border border-rule" data-testid="dashboard-empty">
        <div className="atlas px-6 py-14 text-center sm:px-10 sm:py-20">
          <p className="display-lg" style={{ color: 'var(--color-atlas-ink)' }}>
            Nowhere yet.
          </p>
          <p className="mx-auto mt-3 max-w-md type-body" style={{ color: 'var(--color-atlas-muted)' }}>
            Start with a place — a town, a park, a whole country. Sidequest asks the rest one
            question at a time and builds the trip around your answers.
          </p>
          {/*
            Drawn for the dark ground rather than borrowed from `buttonClass`.
            The product's primary button is ink on paper — near-black type on a
            near-black surface here — and `.atlas-actions` only restyles real
            `<button>` elements, so these two links would have come out invisible
            and nobody would have seen it in a light-mode screenshot.
          */}
          <div className="mt-8 flex flex-wrap justify-center gap-2.5">
            <Link
              href="/trips/new"
              className="pressable inline-flex min-h-12 items-center rounded-full bg-[var(--color-route-bright)] px-6 text-sm font-medium text-[var(--color-atlas)] hover:brightness-105 focus-visible:outline-2 focus-visible:outline-[var(--color-route-bright)] focus-visible:outline-offset-2"
            >
              Plan a trip
            </Link>
            <Link
              href="/decide"
              className="pressable inline-flex min-h-12 items-center rounded-full border border-white/25 px-6 text-sm font-medium text-[var(--color-atlas-ink)] hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-[var(--color-route-bright)] focus-visible:outline-offset-2"
            >
              Help me decide where
            </Link>
          </div>
          {!signedIn ? (
            <p className="mt-7 type-small" style={{ color: 'var(--color-atlas-muted)' }}>
              Trips you make here stay on this browser until you sign in.
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  const controlPill = 'min-h-11 rounded-full border border-rule bg-paper-raised px-3.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

  return (
    <div className="mt-8">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5" data-testid="dashboard-controls">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-rule bg-paper-raised px-4 sm:max-w-sm">
          <span aria-hidden="true" className="text-ink-faint">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="11" cy="11" r="6.5" />
              <path d="m16 16 4 4" />
            </svg>
          </span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => setParam('q', search)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                setParam('q', search);
              }
            }}
            placeholder="Search your trips"
            aria-label="Search your trips"
            className="min-h-11 w-full bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
            data-testid="dashboard-search"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="sr-only sm:not-sr-only">Sort</span>
          <select value={sort} onChange={(e) => setParam('sort', e.target.value)} aria-label="Sort your trips" className={controlPill} data-testid="dashboard-sort">
            <option value="date">by trip date</option>
            <option value="changed">recently changed</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="sr-only sm:not-sr-only">Show</span>
          <select value={filter} onChange={(e) => setParam('status', e.target.value)} aria-label="Show only one stage" className={controlPill} data-testid="dashboard-filter">
            <option value="all">everything</option>
            {(Object.keys(LIFECYCLE_LABELS) as TripLifecycle[]).map((lifecycle) => (
              <option key={lifecycle} value={lifecycle}>
                {LIFECYCLE_LABELS[lifecycle].toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error ? (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      {sections.map((section) => {
        const inSection = visible.filter((row) => section.lifecycles.includes(row.lifecycle));
        if (inSection.length === 0) return null;
        return (
          <section key={section.id} className="mt-12" aria-labelledby={`dashboard-${section.id}`} data-testid={`dashboard-section-${section.id}`}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rule-top pt-3">
              <h2 id={`dashboard-${section.id}`} className="type-section text-ink">
                {section.title}
              </h2>
              <span className="numeral text-sm text-ink-faint">{inSection.length}</span>
              {SECTION_NOTE[section.id] ? <span className="type-small text-ink-muted">{SECTION_NOTE[section.id]}</span> : null}
            </div>
            <ul className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {inSection.map((row) => (
                <TripCard key={row.id} row={row} onError={setError} />
              ))}
            </ul>
          </section>
        );
      })}
      {visible.length === 0 ? (
        <p className="mt-12 type-body text-ink-muted">
          Nothing matches that.{' '}
          <button
            type="button"
            className="text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
            onClick={() => {
              setSearch('');
              setParam('q', '');
            }}
          >
            Show everything
          </button>
        </p>
      ) : null}
    </div>
  );
}

function TripCard({ row, onError }: { row: DashboardCardRow; onError: (message: string | null) => void }) {
  const router = useRouter();
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(row.title);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = (work: () => Promise<{ ok: boolean; error?: string; tripId?: string }>, after?: (result: { ok: boolean; tripId?: string }) => void) => {
    onError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        onError(result.error ?? 'That did not work. Your trips are unchanged.');
        return;
      }
      setMenu(false);
      after?.(result);
      router.refresh();
    });
  };

  const timingLine = row.timing === 'open' ? 'Timing still open' : row.dates;
  const timingNote = row.timing === 'chosen' ? 'dates chosen for you' : null;
  const quiet = row.lifecycle === 'past' || row.lifecycle === 'archived';

  return (
    <li
      className={cx(
        'group relative flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-panel)] border border-rule bg-paper-raised shadow-[var(--shadow-card)] transition-colors',
        quiet ? 'opacity-90 hover:opacity-100' : 'hover:border-ink-faint',
      )}
      data-testid="trip-card"
      data-lifecycle={row.lifecycle}
    >
      {/* The picture, whole and uncropped: see the note at the top of the file. */}
      <div className="relative bg-paper-sunk">
        <DestinationImage image={row.image} fallback={row.fallback} ratio="natural" credit="none" className="rounded-none" />
      </div>

      {/*
        One link over the whole card. Everything interactive below carries
        `relative`, which lifts it above this without a z-index arms race.
      */}
      <Link href={row.href} className="absolute inset-0 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-[-2px]">
        <span className="sr-only">
          {row.title}: {row.nextAction}
        </span>
      </Link>

      <div className="flex min-w-0 flex-1 flex-col gap-2 px-4 pt-3.5 pb-4">
        <div className="relative flex min-w-0 flex-wrap items-start justify-between gap-x-2 gap-y-1.5">
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
            <h3 className="min-w-0 font-display text-xl leading-tight text-ink">
              <Link href={row.href} className="hover:underline hover:underline-offset-4 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2" data-testid="trip-card-title">
                {row.title}
              </Link>
            </h3>
          )}
          <Badge tone={LIFECYCLE_TONE[row.lifecycle]} title={row.lifecycleBasis === 'override' ? 'You set this stage' : 'Sidequest read this from the trip'}>
            {LIFECYCLE_LABELS[row.lifecycle]}
          </Badge>
        </div>

        {row.title !== row.destination ? <p className="type-small text-ink-muted">{row.destination}</p> : null}

        <p className="text-sm text-ink" data-testid="trip-card-dates">
          <span className={row.timing === 'open' ? 'text-ink-muted italic' : undefined}>{timingLine}</span>
          {row.nights > 0 ? <span className="text-ink-muted"> · {row.nights} nights</span> : null}
          <span className="text-ink-muted"> · {row.party}</span>
        </p>

        {timingNote ? <p className="type-small text-ink-faint">{timingNote}</p> : null}

        {row.bases.length > 0 ? (
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 type-small text-ink-muted">
            {row.bases.slice(0, 4).map((base, index) => (
              <span key={`${base}-${index}`} className="inline-flex items-center gap-1.5">
                {index > 0 ? (
                  <span aria-hidden="true" className="inline-block h-px w-3" style={{ background: 'var(--color-map-route)' }} />
                ) : null}
                {base}
              </span>
            ))}
            {row.bases.length > 4 ? <span className="text-ink-faint">+{row.bases.length - 4} more</span> : null}
          </p>
        ) : null}

        <p className="flex min-w-0 flex-wrap items-center gap-x-2 type-small">
          <span className={row.bookedCount > 0 ? 'text-pine' : 'text-ink-faint'}>
            <span aria-hidden="true" className={cx('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', row.bookedCount > 0 ? 'bg-pine' : 'bg-rule')} />
            {row.bookedCount > 0 ? `${row.bookedCount} booked` : 'Nothing booked yet'}
          </span>
          {row.feasibilitySummary ? <span className="text-ink-muted">{row.feasibilitySummary}</span> : null}
        </p>

        <div className="relative mt-auto flex min-w-0 flex-wrap items-center justify-between gap-2 pt-3">
          <Link href={row.href} className={buttonClass(quiet ? 'secondary' : 'primary', 'sm')} data-testid="trip-card-action">
            {row.nextAction}
          </Link>
          <div className="relative">
            <button
              type="button"
              className={cx(buttonClass('ghost', 'sm'), 'min-w-11')}
              aria-haspopup="menu"
              aria-expanded={menu}
              aria-label={`More for ${row.title}`}
              onClick={() => setMenu((m) => !m)}
              data-testid="trip-card-menu"
            >
              <span aria-hidden="true">•••</span>
            </button>
            {menu ? (
              <div role="menu" className="absolute right-0 z-30 mt-1 w-56 rounded-[var(--radius-panel)] border border-rule bg-paper-raised p-1.5 shadow-[var(--shadow-card)]" data-testid="trip-card-menu-open">
                <MenuButton onClick={() => { setRenaming(true); setMenu(false); }}>Rename</MenuButton>
                <MenuButton onClick={() => run(() => duplicateTripAction(row.id), (r) => { if (r.tripId) router.push(`/trips/${r.tripId}/questionnaire`); })}>Duplicate</MenuButton>
                {row.lifecycle !== 'past' && row.lifecycle !== 'traveling' && row.lifecycle !== 'archived' ? (
                  <MenuButton onClick={() => run(() => setLifecycleAction(row.id, 'booked'))}>Mark as booked</MenuButton>
                ) : null}
                {row.lifecycleBasis === 'override' ? <MenuButton onClick={() => run(() => setLifecycleAction(row.id, null))}>Let Sidequest set the stage</MenuButton> : null}
                <MenuButton onClick={() => run(() => archiveTripAction(row.id, row.lifecycle !== 'archived'))}>{row.lifecycle === 'archived' ? 'Restore' : 'Archive'}</MenuButton>
                {confirmRemove ? (
                  <div className="px-2 py-2 text-sm text-ink">
                    Remove for good?
                    <div className="mt-1.5 flex flex-wrap gap-2">
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
        </div>

        <p className="type-meta">{row.updatedLabel}</p>
      </div>
    </li>
  );
}

function MenuButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
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
