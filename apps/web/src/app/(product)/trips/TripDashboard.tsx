'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { LIFECYCLE_LABELS, type TripLifecycle } from '@sidequest/core';
import { atlasButtonClass } from '@/components/hub/AtlasBand';
import { ErrorNote } from '@/components/ui';
import { TripCard, type DashboardCardRow } from './TripCard';

export type { DashboardCardRow } from './TripCard';

/**
 * THE DASHBOARD — A PERSONAL TRAVEL LIBRARY.
 *
 * V6 §25, V8 §9. Trips grouped by where each is in its life — up next,
 * booked, planning, ideas, past, archived — as the shared `TripCard`: picture
 * or atlas route sketch, the dates as a figure, who is going, where the plan
 * stands, what is booked, the base route, one obvious action. The controls a
 * list needs — search, sort, filter — live in the address bar so a reload
 * keeps them; the per-card actions are server actions behind the card's menu.
 *
 * No database aesthetic: no table, no id column, no status enum on screen.
 */

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
      <div className="mt-10 overflow-hidden rounded-[var(--radius-plate)] shadow-[var(--shadow-raised)]" data-testid="dashboard-empty">
        <div className="atlas atlas-live relative px-6 py-14 text-center sm:px-10 sm:py-20">
          {/* A route with nowhere on it yet: three hollow marks and a line that draws itself in. Decorative, and a claim about nothing. */}
          <svg aria-hidden="true" viewBox="0 0 400 120" className="mx-auto mb-6 h-20 w-full max-w-sm opacity-90" fill="none">
            <path d="M40 84 C 110 40, 170 96, 230 52 S 330 30, 360 44" pathLength={1} className="route-draw" stroke="var(--color-route-bright)" strokeOpacity={0.7} strokeWidth={2} strokeLinecap="round" />
            <circle cx="40" cy="84" r="6" stroke="var(--color-route-bright)" strokeWidth={2} fill="var(--color-atlas)" />
            <circle cx="230" cy="52" r="6" stroke="var(--color-route-bright)" strokeWidth={2} fill="var(--color-atlas)" />
            <circle cx="360" cy="44" r="6" stroke="var(--color-route-bright)" strokeWidth={2} fill="var(--color-atlas)" />
          </svg>
          <p className="display-lg text-[var(--color-atlas-ink)]">Nowhere yet.</p>
          <p className="mx-auto mt-3 max-w-md type-body atlas-muted">
            Start with a place — a town, a park, a whole country. Sidequest asks the rest one
            question at a time and builds the trip around your answers.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-2.5">
            <Link href="/trips/new" className={atlasButtonClass('primary')}>
              Plan a trip
            </Link>
            <Link href="/decide" className={atlasButtonClass('ghost')}>
              Help me decide where
            </Link>
          </div>
          {!signedIn ? <p className="mt-7 type-small atlas-muted">Trips you make here stay on this browser until you sign in.</p> : null}
        </div>
      </div>
    );
  }

  const controlPill = 'min-h-11 rounded-full border border-rule bg-paper-raised px-3.5 text-sm text-ink shadow-[var(--shadow-card)] focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

  return (
    <div className="mt-8">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5" data-testid="dashboard-controls">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-rule bg-paper-raised px-4 shadow-[var(--shadow-card)] focus-within:border-ink-faint sm:max-w-sm">
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
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rule-top pt-4">
              <h2 id={`dashboard-${section.id}`} className="type-section text-ink">
                {section.title}
              </h2>
              <span className="type-figure text-sm text-ink-faint">{inSection.length}</span>
              {SECTION_NOTE[section.id] ? <span className="type-small text-ink-muted">{SECTION_NOTE[section.id]}</span> : null}
            </div>
            <ul className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {inSection.map((row) => (
                <TripCard key={row.id} row={row} onError={setError} controls={{ kind: 'menu' }} />
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
