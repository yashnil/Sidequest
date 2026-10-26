'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { LIFECYCLE_LABELS, type TripLifecycle } from '@sidequest/core';
import { ErrorNote, buttonClass, cx } from '../ui';
import { TripCard, type DashboardCardRow } from '@/app/(product)/trips/TripCard';
import { CollectionCover } from './CollectionCover';
import { catalogueNumbers, coverTrip } from './stamp-geometry';

/**
 * THE COLLECTION — every journey as a catalogue entry, the next one as a cover.
 *
 * SURVEY ATLAS (2026-10). Replaces `TripDashboard`'s grid of tiles with a
 * personal collection: the trip somebody is about to live opens the page as a
 * cover (`CollectionCover`), and every trip — including that one, so nothing
 * is only reachable from the cover — follows as a numbered entry with its own
 * stamp, grouped by where it is in its life. Catalogue numbers are the order
 * the trips are taken in over the whole collection, so a number never moves
 * when somebody searches.
 *
 * Behaviour is `TripDashboard`'s, unchanged: search, sort and filter live in
 * the address bar so a reload keeps them; every per-trip action is the card's
 * menu. The controls are set as one typeset line — a ruled search field and
 * two selects that read as words — rather than three pills.
 */

const SECTION_NOTE: Record<string, string> = {
  traveling: 'Under way right now. Today is one press away.',
  upcoming: 'Under way right now.',
  booked: 'A bed or a way there is arranged. Now get ready.',
  planning: 'Planned day by day. Still yours to change.',
  ideas: 'Somewhere you were thinking about.',
  past: 'Been and gone.',
  archived: 'Out of the way, not deleted.',
};

/** Places to start from on an empty page. Words only: each opens the first question with the field filled. */
const EMPTY_EXAMPLES = ['Lisbon', 'Japan', 'The Dolomites', 'Iceland', 'Scottish Highlands'] as const;

const EMPTY_STEPS = [
  { title: 'Tell it about the trip', body: 'Where, when, who — then a short interview about how you like to travel.' },
  { title: 'Pick what sounds good', body: 'A board of classics and hidden gems near where you are going. Tick, skip, or let it choose.' },
  { title: 'Get days that work', body: 'Stops in a sensible order, meals and breaks in, travel times checked, ready to take with you.' },
] as const;

/** Trips still ahead get the editorial entries; ideas and what is over go in the ruled index. */
const AHEAD = new Set(['traveling', 'upcoming', 'booked', 'planning']);

/**
 * Mixed sizes, Cereal's rhythm: pairs alternate seven-and-five columns, and a
 * trip left alone at the end of a section (or alone in it) is laid wide —
 * plate beside words — instead of leaving a hole in the grid.
 */
export function featureLayout(index: number, count: number): { variant: 'lead' | 'standard' | 'wide'; className: string } {
  if (count === 1 || (count % 2 === 1 && index === count - 1)) return { variant: 'wide', className: 'sm:col-span-2 lg:col-span-12' };
  const pair = Math.floor(index / 2);
  const first = index % 2 === 0;
  const lead = first === (pair % 2 === 0);
  return lead ? { variant: 'lead', className: 'lg:col-span-7' } : { variant: 'standard', className: 'lg:col-span-5' };
}

interface Section {
  id: string;
  title: string;
  lifecycles: readonly TripLifecycle[];
}

const SELECT =
  'min-h-11 cursor-pointer appearance-none border-0 border-b border-ink/40 bg-transparent py-0 pr-6 pl-0.5 font-display text-base italic text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

function Chevron() {
  return (
    <svg aria-hidden="true" viewBox="0 0 9 6" className="pointer-events-none absolute right-1 bottom-[1.15rem] h-1.5 w-2.5 text-ink-muted" fill="none" stroke="currentColor">
      <path d="M.5.5 4.5 5 8.5.5" />
    </svg>
  );
}

export function CollectionDashboard({
  rows,
  sections,
  query,
  sort,
  filter,
  signedIn,
  today,
}: {
  rows: DashboardCardRow[];
  sections: readonly Section[];
  query: string;
  sort: 'date' | 'changed';
  filter: string;
  signedIn: boolean;
  /** `YYYY-MM-DD` from the server's own clock, so the countdown cannot disagree on hydration. */
  today: string;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(query);
  const [error, setError] = useState<string | null>(null);
  const numbers = useMemo(() => catalogueNumbers(rows), [rows]);
  const cover = useMemo(() => (rows.length >= 2 ? coverTrip(rows, today) : null), [rows, today]);

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
      <div className="survey-night relative mt-10 overflow-hidden px-6 py-12 sm:px-12 sm:py-16" data-testid="dashboard-empty">
        <div className="relative grid min-w-0 items-center gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <div className="min-w-0">
            <p className="sheet-label text-[var(--color-glacier)]">Your first trip</p>
            <p className="mt-3 font-display text-[clamp(2.4rem,1.6rem+2.8vw,4rem)] leading-[0.95] font-[340] tracking-[-0.03em] text-[var(--color-atlas-ink)]">Nowhere yet.</p>
            <p className="mt-4 max-w-md type-body text-[var(--color-atlas-muted)]">Name a place — a town, a park, a whole country — and Sidequest asks a few questions, finds what is worth it, and plans the days.</p>
            {/*
              A real starting move, not a pointer to one: the words typed here
              are carried to the first question (`?destination=`), where they
              are placed exactly as if typed there. A plain GET form, so it
              works before the page has hydrated.
            */}
            <form action="/trips/new" method="get" className="mt-7 flex max-w-lg min-w-0 items-center gap-2 rounded-full border border-white/20 bg-white/[0.04] p-1.5 pl-5 focus-within:border-[var(--color-glacier)]" data-testid="dashboard-empty-start">
              <label htmlFor="empty-destination" className="sr-only">
                Where to?
              </label>
              <input id="empty-destination" name="destination" required minLength={2} autoComplete="off" placeholder="Where to?" className="min-h-11 min-w-0 flex-1 bg-transparent font-display text-xl text-[var(--color-atlas-ink)] outline-none placeholder:text-[var(--color-atlas-muted)]" />
              <button type="submit" className={buttonClass('accent', 'md')}>
                Start
                <span aria-hidden="true">→</span>
              </button>
            </form>
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Or start from an example">
              {EMPTY_EXAMPLES.map((example) => (
                <li key={example}>
                  <Link href={`/trips/new?destination=${encodeURIComponent(example)}`} className="inline-flex min-h-9 items-center rounded-full border border-white/15 px-3.5 text-sm text-[var(--color-atlas-muted)] transition-colors hover:border-white/40 hover:text-[var(--color-atlas-ink)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2">
                    {example}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-8 text-sm text-[var(--color-atlas-muted)]">
              No destination in mind?{' '}
              <Link href="/decide" className="text-[var(--color-atlas-ink)] underline decoration-white/30 underline-offset-4 hover:decoration-[var(--color-flare)] focus-visible:outline-2 focus-visible:outline-[var(--color-glacier)] focus-visible:outline-offset-2">
                Help me decide where
              </Link>
              {!signedIn ? <span className="block pt-1.5 opacity-80">Trips you make here stay on this browser until you sign in.</span> : null}
            </p>
          </div>
          {/* How it goes, in three moves — the shape of the product before anybody has used it. Decorative numbers, real steps. */}
          <ol className="grid min-w-0 gap-px overflow-hidden border border-white/12 bg-white/10" aria-label="How Sidequest plans a trip">
            {EMPTY_STEPS.map((step, index) => (
              <li key={step.title} className="fade-up flex min-w-0 items-start gap-4 bg-[var(--color-night)] p-5" style={{ ['--d' as string]: `${120 + index * 90}ms` }}>
                <span aria-hidden="true" className="font-display text-3xl leading-none text-[var(--color-flare)]">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block font-display text-lg leading-tight text-[var(--color-atlas-ink)]">{step.title}</span>
                  <span className="mt-1 block text-sm leading-snug text-[var(--color-atlas-muted)]">{step.body}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-6">
      {cover ? <CollectionCover row={cover} catalogue={numbers.get(cover.id) ?? 1} today={today} onError={setError} /> : null}

      {/* The controls as one typeset line: Find [ ] · sorted by [trip date] · showing [everything]. Two trips need no search. */}
      <div className={cx('mt-10', rows.length < 3 ? 'hidden' : '')} data-few={rows.length < 3 ? 'true' : undefined}>
      <div className="flex min-w-0 flex-wrap items-end gap-x-8 gap-y-3 border-b border-ink/15 pb-3" data-testid="dashboard-controls">
        <label className="flex min-w-0 flex-1 basis-full items-end gap-3 sm:basis-auto sm:max-w-sm">
          <span className="sheet-label shrink-0 pb-3 text-ink-muted">Find</span>
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
            placeholder="a place, a base, a name"
            aria-label="Search your trips"
            className="min-h-11 w-full min-w-0 border-0 border-b border-ink/40 bg-transparent px-0.5 font-display text-base text-ink outline-none placeholder:italic placeholder:text-ink-faint hover:border-ink focus-visible:border-ink focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
            data-testid="dashboard-search"
          />
        </label>
        <label className="flex items-end gap-2.5">
          <span className="sheet-label pb-3 text-ink-muted">Sorted by</span>
          <span className="relative">
          <select value={sort} onChange={(e) => setParam('sort', e.target.value)} aria-label="Sort your trips" className={SELECT} data-testid="dashboard-sort">
            <option value="date">trip date</option>
            <option value="changed">recently changed</option>
          </select>
          <Chevron />
          </span>
        </label>
        <label className="flex items-end gap-2.5">
          <span className="sheet-label pb-3 text-ink-muted">Showing</span>
          <span className="relative">
          <select value={filter} onChange={(e) => setParam('status', e.target.value)} aria-label="Show only one stage" className={SELECT} data-testid="dashboard-filter">
            <option value="all">everything</option>
            {(Object.keys(LIFECYCLE_LABELS) as TripLifecycle[]).map((lifecycle) => (
              <option key={lifecycle} value={lifecycle}>
                {LIFECYCLE_LABELS[lifecycle].toLowerCase()}
              </option>
            ))}
          </select>
          <Chevron />
          </span>
        </label>
        <span className="coordbar pb-3 text-ink-faint sm:ml-auto">
          {visible.length === rows.length ? `${rows.length} trip${rows.length === 1 ? '' : 's'}` : `${visible.length} of ${rows.length}`}
        </span>
      </div>
      </div>
      {error ? (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}

      {sections
        .map((section) => ({ section, inSection: visible.filter((row) => section.lifecycles.includes(row.lifecycle) && row.id !== cover?.id) }))
        .filter(({ inSection }) => inSection.length > 0)
        .map(({ section, inSection }) => {
        return (
          <section key={section.id} className="mt-12" aria-labelledby={`dashboard-${section.id}`} data-testid={`dashboard-section-${section.id}`}>
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-4 gap-y-1 border-t-[1.5px] border-ink pt-3">
              <h2 id={`dashboard-${section.id}`} className="flex items-baseline gap-2.5 font-display text-[1.75rem] leading-tight font-[400] tracking-[-0.02em] text-ink">
                {section.title}
                <span className="inline-flex h-6 min-w-6 translate-y-[-0.2em] items-center justify-center rounded-full bg-ink/[0.07] px-2 font-mono text-xs tracking-normal text-ink-muted">
                  {inSection.length}
                  <span className="sr-only">{inSection.length === 1 ? ' trip' : ' trips'}</span>
                </span>
              </h2>
              {SECTION_NOTE[section.id] ? <span className="col-span-2 type-small text-ink-muted sm:col-span-1 sm:text-right">{SECTION_NOTE[section.id]}</span> : null}
            </div>
            {AHEAD.has(section.id) ? (
              <ul className="mt-6 grid gap-x-6 gap-y-8 sm:grid-cols-2 lg:grid-cols-12">
                {inSection.map((row, i) => {
                  const layout = featureLayout(i, inSection.length);
                  return <TripCard key={row.id} row={row} onError={setError} controls={{ kind: 'menu' }} catalogue={numbers.get(row.id)} today={today} variant={layout.variant} className={layout.className} />;
                })}
              </ul>
            ) : (
              <>
                <div aria-hidden="true" className="coordbar mt-5 hidden grid-cols-[3.25rem_4.5rem_minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,1.15fr)_12.5rem] gap-x-5 pb-2 text-ink-faint md:grid">
                  <span className="pl-1">#</span>
                  <span />
                  <span>Trip</span>
                  <span>When · who</span>
                  <span>Status</span>
                  <span />
                </div>
                <ul className="mt-3 divide-y divide-ink/15 border-y border-ink/15 md:mt-0">
                  {inSection.map((row) => (
                    <TripCard key={row.id} row={row} onError={setError} controls={{ kind: 'menu' }} catalogue={numbers.get(row.id)} today={today} variant="index" />
                  ))}
                </ul>
              </>
            )}
          </section>
        );
        })}
      {visible.length === 0 ? (
        <p className="mt-12 type-body text-ink-muted">
          Nothing matches that.{' '}
          <button
            type="button"
            className="min-h-11 text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2"
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
