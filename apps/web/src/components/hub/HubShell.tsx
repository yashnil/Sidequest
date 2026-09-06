'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';
import { cx } from '../ui';

/**
 * PRODUCTION UI V1 — THE TRIP HUB'S FIVE PLACES TO LOOK.
 *
 *   Overview · Days · Map · Plan · Prepare
 *
 * One eight-thousand-pixel page became five views under one segmented nav.
 * Every view is server-rendered and present in the document (so a print, a
 * search or a screen reader's outline sees the whole trip); the nav decides
 * which one is displayed. The address bar keeps the view (`#days`), so a
 * link into a plan lands on the right tab and Back works. On phones the same
 * nav sits at the bottom, thumb-reachable, with Overview folded into Days.
 *
 * Deliberately not a tab library: five anchors, one attribute, no dependency.
 */
export const HUB_VIEWS = [
  { id: 'overview', label: 'Overview', short: 'Trip' },
  { id: 'days', label: 'Days', short: 'Days' },
  { id: 'map', label: 'Map', short: 'Map' },
  { id: 'plan', label: 'Plan', short: 'Plan' },
  { id: 'prepare', label: 'Prepare', short: 'Prepare' },
] as const;
export type HubViewId = (typeof HUB_VIEWS)[number]['id'];

/** Legacy anchors (`#book-first`, `#day-3`, `#verify`) still land on the view that holds them. */
const LEGACY_ANCHORS: Record<string, HubViewId> = {
  itinerary: 'days',
  stays: 'plan',
  'getting-around': 'plan',
  food: 'plan',
  budget: 'plan',
  bookings: 'plan',
  'book-first': 'prepare',
  'before-you-go': 'prepare',
  pack: 'prepare',
  backups: 'prepare',
  verify: 'prepare',
  considered: 'prepare',
};

export function viewForHash(hash: string): { view: HubViewId; anchor: string | null } {
  const raw = hash.replace(/^#/, '');
  if (!raw) return { view: 'overview', anchor: null };
  if ((HUB_VIEWS as readonly { id: string }[]).some((v) => v.id === raw)) return { view: raw as HubViewId, anchor: null };
  if (/^day-\d+$/.test(raw)) return { view: 'days', anchor: raw };
  const legacy = LEGACY_ANCHORS[raw];
  if (legacy) return { view: legacy, anchor: raw };
  return { view: 'overview', anchor: raw };
}

export function HubShell({
  views,
  badges = {},
  printAppendix = false,
  initialView = 'overview',
}: {
  views: Record<HubViewId, ReactNode>;
  /** Small counts beside a label — open Book-first items on Prepare, days on Days. */
  badges?: Partial<Record<HubViewId, number>>;
  /** `?appendix=1`: the evidence appendix prints too. */
  printAppendix?: boolean;
  initialView?: HubViewId;
}) {
  const [view, setView] = useState<HubViewId>(initialView);
  const labelId = useId();

  useEffect(() => {
    const apply = () => {
      const { view: next, anchor } = viewForHash(window.location.hash);
      setView(next);
      if (anchor) {
        // Let the view display first, then land on the anchor inside it.
        requestAnimationFrame(() => document.getElementById(anchor)?.scrollIntoView({ block: 'start' }));
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, []);

  function select(next: HubViewId) {
    setView(next);
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    window.history.replaceState(null, '', url);
    // The view changes in place; the traveller keeps their scroll position at the top of the hub.
    document.getElementById('trip-hub')?.scrollIntoView({ block: 'start' });
  }

  return (
    <div id="trip-hub" data-hub-view={view} {...(printAppendix ? { 'data-print-appendix': 'true' } : {})} className="scroll-mt-[var(--chrome-height)]">
      <nav aria-label="Trip hub" className="sticky top-[var(--chrome-height)] z-20 -mx-5 border-b border-rule bg-paper/92 px-5 backdrop-blur-sm print:hidden max-sm:hidden sm:-mx-8 sm:px-8" data-testid="trip-hub-nav">
        <div className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto py-1.5" role="tablist" aria-labelledby={labelId}>
          <span id={labelId} className="sr-only">
            Trip hub views
          </span>
          {HUB_VIEWS.map((entry) => {
            const active = entry.id === view;
            const badge = badges[entry.id];
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`hub-tab-${entry.id}`}
                aria-selected={active}
                aria-controls={`hub-view-${entry.id}`}
                data-testid={`hub-link-${entry.id}`}
                onClick={() => select(entry.id)}
                className={cx(
                  'relative inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors duration-[var(--motion-fast)]',
                  active ? 'bg-ink text-paper' : 'text-ink-muted hover:bg-paper-sunk hover:text-ink',
                )}
              >
                {entry.label}
                {badge ? <span className={cx('numeral rounded-full px-1.5 text-[10px] leading-4', active ? 'bg-paper/20 text-paper' : 'bg-accent text-paper')}>{badge}</span> : null}
              </button>
            );
          })}
        </div>
      </nav>

      {HUB_VIEWS.map((entry) => (
        <section
          key={entry.id}
          id={`hub-view-${entry.id}`}
          role="tabpanel"
          aria-labelledby={`hub-tab-${entry.id}`}
          data-view={entry.id}
          data-active={entry.id === view ? 'true' : 'false'}
          className={cx('hub-view', entry.id === view && 'enter')}
        >
          {views[entry.id]}
        </section>
      ))}

      {/* Phones: the same five views as a bottom bar, one hand. */}
      <nav aria-label="Trip hub" className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm print:hidden sm:hidden" data-testid="trip-hub-bottom-nav">
        <div className="grid grid-cols-5" role="tablist" aria-label="Trip hub views">
          {HUB_VIEWS.map((entry) => {
            const active = entry.id === view;
            const badge = badges[entry.id];
            return (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`hub-view-${entry.id}`}
                data-testid={`hub-bottom-${entry.id}`}
                onClick={() => select(entry.id)}
                className={cx('relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium', active ? 'text-ink' : 'text-ink-faint')}
              >
                <span aria-hidden="true" className={cx('h-1 w-6 rounded-full transition-colors duration-[var(--motion-fast)]', active ? 'bg-accent' : 'bg-transparent')} />
                {entry.short}
                {badge ? <span className="numeral absolute right-3 top-2 rounded-full bg-accent px-1.5 text-[10px] leading-4 text-paper">{badge}</span> : null}
              </button>
            );
          })}
        </div>
      </nav>
      {/* Room for the bottom bar. */}
      <div aria-hidden="true" className="h-16 sm:hidden print:hidden" />
    </div>
  );
}
