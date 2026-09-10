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
  const [appendix, setAppendix] = useState(printAppendix);
  const labelId = useId();

  /*
   * V6 — `?appendix=1` HAS TO REACH THE PACKET.
   *
   * The band offers "Print with evidence appendix", which links to
   * `?appendix=1`, and nothing on the server ever read that parameter — the
   * page takes `params` only — so the flag arrived here `false` on every
   * request and the link printed exactly the same packet as the button beside
   * it. Read on the client instead: the printed document is produced by the
   * browser, so the browser's own address is the right authority for what it
   * should contain. The server prop still wins whenever it is set.
   */
  useEffect(() => {
    if (printAppendix) return;
    const apply = () => setAppendix(new URLSearchParams(window.location.search).get('appendix') === '1');
    apply();
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, [printAppendix]);

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
    <div id="trip-hub" data-hub-view={view} {...(appendix ? { 'data-print-appendix': 'true' } : {})} className="scroll-mt-[var(--chrome-height)]">
      <nav aria-label="Trip hub" className="sticky top-[var(--chrome-height)] z-20 -mx-5 border-b border-rule bg-paper/95 px-5 backdrop-blur-[2px] print:hidden max-sm:hidden sm:-mx-6 sm:px-6" data-testid="trip-hub-nav">
        <div className="mx-auto flex max-w-[1600px] items-center gap-1 overflow-x-auto" role="tablist" aria-labelledby={labelId}>
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
                  'pressable relative inline-flex min-h-11 shrink-0 items-center gap-2 px-3.5 text-sm font-medium transition-colors duration-[var(--motion-fast)]',
                  active ? 'text-ink after:absolute after:inset-x-3.5 after:bottom-0 after:h-0.5 after:rounded-full after:bg-[var(--color-route)]' : 'text-ink-muted hover:text-ink',
                )}
              >
                {entry.label}
                {badge ? <span className={cx('numeral rounded-full px-1.5 text-[10px] leading-4', active ? 'bg-ink text-paper' : 'bg-paper-sunk text-ink-muted')}>{badge}</span> : null}
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

      {/*
        Phones: four views in a bottom bar, one hand. Overview is not a tab down
        here — it is the trip's own header, reached from the band's title
        (`hub-overview-link`) — so the bar holds the four things a traveller
        does with a plan on the move.
      */}
      <nav aria-label="Trip hub" className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-sm print:hidden sm:hidden" data-testid="trip-hub-bottom-nav">
        <div className="grid grid-cols-4" role="tablist" aria-label="Trip hub views">
          {HUB_VIEWS.filter((entry) => entry.id !== 'overview').map((entry) => {
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
