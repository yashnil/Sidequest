'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { cx } from '../ui';

/**
 * PRODUCTION UI V1 — THE TRIP HUB'S PLACES TO LOOK.
 *
 *   Trip · Days · Map · Plan · Book · Prepare
 *
 * V9 — Book is its own view: the needs with their actions, what is booked,
 * the import centre and the ledger. The bottom bar on a phone holds Days ·
 * Book · Prepare · Map. Every earlier id keeps its testid.
 *
 * One eight-thousand-pixel page became five views under one segmented nav.
 * Every view is server-rendered and present in the document (so a print, a
 * search or a screen reader's outline sees the whole trip); the nav decides
 * which one is displayed. The address bar keeps the view (`#days`), so a
 * link into a plan lands on the right tab and Back works. On phones the same
 * nav sits at the bottom, thumb-reachable, with Overview folded into Days.
 *
 * Deliberately not a tab library: five anchors, one attribute, no dependency.
 *
 * V8 — the active tab's underline slides between tabs (`layoutId`), and the
 * shell offers two slots for Ask Sidequest's trigger — right of the tabs on
 * `sm+`, a fifth cell in the bottom bar on a phone — so the trigger sits in
 * the chrome rather than floating over the plan.
 */
export const HUB_VIEWS = [
  { id: 'overview', label: 'Trip', short: 'Trip' },
  { id: 'days', label: 'Days', short: 'Days' },
  { id: 'map', label: 'Map', short: 'Map' },
  { id: 'plan', label: 'Plan', short: 'Plan' },
  { id: 'book', label: 'Book', short: 'Book' },
  { id: 'prepare', label: 'Prepare', short: 'Prepare' },
] as const;
export type HubViewId = (typeof HUB_VIEWS)[number]['id'];

/**
 * V9 — the phone bar holds the four things a traveller does with a plan on
 * the move, in the order they do them: Days · Book · Prepare · Map. Trip is
 * the band's own title link, Plan is reached from the others.
 */
export const HUB_BOTTOM_VIEWS: readonly HubViewId[] = ['days', 'book', 'prepare', 'map'];

/** Legacy anchors (`#book-first`, `#day-3`, `#verify`) still land on the view that holds them. */
const LEGACY_ANCHORS: Record<string, HubViewId> = {
  itinerary: 'days',
  stays: 'plan',
  'getting-around': 'plan',
  food: 'plan',
  budget: 'plan',
  /* V9 — everything about arranging the trip lives on Book. */
  bookings: 'book',
  'book-first': 'book',
  booked: 'book',
  import: 'book',
  ledger: 'book',
  'next-action': 'overview',
  decisions: 'overview',
  preflight: 'prepare',
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
  askSlot = false,
}: {
  views: Record<HubViewId, ReactNode>;
  /** Small counts beside a label — open required needs on Book, attention items on Prepare, days on Days. */
  badges?: Partial<Record<HubViewId, number>>;
  /** `?appendix=1`: the evidence appendix prints too. */
  printAppendix?: boolean;
  initialView?: HubViewId;
  /** Whether Ask Sidequest is on this page, so the chrome reserves the two trigger slots. Never on the shared copy. */
  askSlot?: boolean;
}) {
  const [view, setView] = useState<HubViewId>(initialView);
  const [appendix, setAppendix] = useState(printAppendix);
  const labelId = useId();
  const reduced = useReducedMotion();

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

  /*
   * V9 §11 — `?print=1` FROM THE TRIP PACK OPENS THE PRINT DIALOG.
   *
   * The Pack's "PDF" is the browser's own print of this page. Once, after
   * hydration, and after `PrintExpand` has had a frame to open the packet's
   * disclosures on `beforeprint`. Never on a re-render, never on the shared
   * copy's own address (the Pack is owner-only, and so is the link).
   */
  const printedRef = useRef(false);
  useEffect(() => {
    if (printedRef.current) return;
    if (new URLSearchParams(window.location.search).get('print') !== '1') return;
    printedRef.current = true;
    const handle = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(handle);
  }, []);

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

  const indicatorTransition = reduced ? { duration: 0 } : { type: 'spring' as const, stiffness: 520, damping: 42, mass: 0.6 };

  return (
    <div id="trip-hub" data-hub-view={view} {...(appendix ? { 'data-print-appendix': 'true' } : {})} className="scroll-mt-[var(--chrome-height)]">
      {/*
        On a phone the row is not `display: none` — that would take the Ask
        trigger inside it out of the render tree, and the trigger is the one
        element that must stay single (the suite locates it by id) while being
        fixed over the bottom bar. The row collapses to zero height instead and
        only the tab list is hidden; the fixed trigger is out of flow anyway.
      */}
      <nav aria-label="Trip hub" className="sticky top-[var(--chrome-height)] z-20 -mx-5 border-b border-rule bg-paper/95 px-5 backdrop-blur-[2px] print:hidden max-sm:z-40 max-sm:h-0 max-sm:overflow-visible max-sm:border-0 max-sm:bg-transparent max-sm:px-0 max-sm:backdrop-blur-none sm:-mx-6 sm:px-6" data-testid="trip-hub-nav">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3">
          <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto max-sm:hidden" role="tablist" aria-labelledby={labelId}>
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
                    'pressable relative inline-flex min-h-12 shrink-0 items-center gap-2 px-3.5 text-sm font-semibold transition-colors duration-[var(--motion-fast)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-pine',
                    active ? 'text-ink' : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {entry.label}
                  {badge ? <span className={cx('type-figure rounded-full px-1.5 text-xs leading-5', active ? 'bg-ink text-paper' : 'bg-paper-sunk text-ink-muted')}>{badge}</span> : null}
                  {active ? <motion.span layoutId="hub-tab-indicator" aria-hidden="true" className="absolute inset-x-3.5 bottom-0 h-0.5 rounded-full bg-[var(--color-route)]" transition={indicatorTransition} /> : null}
                </button>
              );
            })}
          </div>
          {askSlot ? <AskTrigger /> : null}
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
        Phones: four views in a bottom bar, one hand (`HUB_BOTTOM_VIEWS`).
        Overview is not a tab down here — it is the trip's own header, reached
        from the band's title (`hub-overview-link`) — and Plan is reached from
        the others; the bar holds Days · Book · Prepare · Map, plus Ask
        Sidequest as a fifth cell when the page has it.
      */}
      <nav aria-label="Trip hub" className="fixed inset-x-0 bottom-0 z-30 border-t border-rule bg-paper/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-6px_24px_-16px_rgb(23_24_26/0.35)] backdrop-blur-sm print:hidden sm:hidden" data-testid="trip-hub-bottom-nav">
        <div className={cx('grid', askSlot ? 'grid-cols-5' : 'grid-cols-4')}>
          <div className="col-span-4 grid grid-cols-4" role="tablist" aria-label="Trip hub views">
            {HUB_BOTTOM_VIEWS.map((id) => HUB_VIEWS.find((entry) => entry.id === id)!).map((entry) => {
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
                  className={cx('pressable relative flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-pine', active ? 'text-ink' : 'text-ink-faint')}
                >
                  <span aria-hidden="true" className={cx('h-1 w-6 rounded-full transition-colors duration-[var(--motion-fast)]', active ? 'bg-accent' : 'bg-transparent')} />
                  {entry.short}
                  {badge ? <span className="type-figure absolute right-3 top-2 rounded-full bg-accent px-1.5 text-xs leading-5 text-paper">{badge}</span> : null}
                </button>
              );
            })}
          </div>
          {/* The fifth cell is held for the trigger, which sits over it (see `AskTrigger`). */}
          {askSlot ? <div aria-hidden="true" className="pointer-events-none border-l border-rule" /> : null}
        </div>
      </nav>
      {/* Room for the bottom bar. */}
      <div aria-hidden="true" className="h-16 sm:hidden print:hidden" />
    </div>
  );
}

/** The DOM event the hub's trigger raises; `AskSidequest` opens on it. */
export const ASK_OPEN_EVENT = 'sidequest:ask-open';

/**
 * V8 — ONE TRIGGER, IN THE CHROME, FROM THE FIRST PAINT.
 *
 * Ask Sidequest is mounted after the hub (it is a sheet over the whole page),
 * so the trigger used to be portalled into the nav after hydration — and for
 * the first paint it floated over whatever card sat bottom-right. The hub
 * renders it itself now, server-side, and raises a DOM event that the sheet
 * listens for. One element: in the nav row from `sm`, and on a phone fixed
 * over the bottom bar's reserved fifth cell — so the tests' single
 * `ask-sidequest-open` stays single and is visible at every width.
 */
function AskTrigger() {
  return (
    <button
      type="button"
      data-testid="ask-sidequest-open"
      aria-haspopup="dialog"
      aria-label="Ask Sidequest"
      onClick={() => window.dispatchEvent(new CustomEvent(ASK_OPEN_EVENT))}
      className={cx(
        'pressable print:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine',
        /* `sm+`: a pill right of the tabs. */
        'sm:inline-flex sm:min-h-11 sm:shrink-0 sm:items-center sm:gap-2 sm:rounded-full sm:border sm:border-rule sm:bg-paper-raised sm:px-3 sm:text-xs sm:font-semibold sm:text-ink sm:shadow-[var(--shadow-card)] sm:hover:border-ink-faint sm:hover:shadow-[var(--shadow-raised)] sm:focus-visible:outline-offset-2',
        /* Phones: the bottom bar's fifth cell, in the bar's own style. */
        'max-sm:fixed max-sm:bottom-0 max-sm:right-0 max-sm:z-40 max-sm:flex max-sm:min-h-14 max-sm:w-1/5 max-sm:flex-col max-sm:items-center max-sm:justify-center max-sm:gap-0.5 max-sm:pb-[env(safe-area-inset-bottom)] max-sm:text-xs max-sm:font-medium max-sm:text-ink max-sm:focus-visible:outline-offset-[-2px]',
      )}
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 max-sm:h-5 max-sm:w-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM5 17l.7 1.8 1.8.7-1.8.7L5 22l-.7-1.8-1.8-.7 1.8-.7z" />
      </svg>
      <span className="sm:hidden">Ask</span>
      <span className="max-sm:hidden">Ask Sidequest</span>
    </button>
  );
}
