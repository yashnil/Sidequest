'use client';

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../ui';

/**
 * V6 — THE PLACE DETAIL SHEET.
 *
 * A stop on a plan used to answer three questions in a row — its name, its
 * clock time, one sentence — and hid everything else behind a grey
 * "Why this, and the details" disclosure that pushed the day apart when it was
 * opened. Nine of those on a page is nine accordions and no hierarchy.
 *
 * Pressing a stop (in the Days list or on a map pin) now opens one sheet: the
 * photograph, what the place is, why it is on THIS trip, when it sits in the
 * day, how long, how hard, what the weather does to it, what comes before and
 * after it, its hours and where they came from, and the same controls the row
 * carries. A dialog on a desktop, a bottom sheet on a phone.
 *
 * Deliberately not a router modal: the sheet is a reading surface over the day,
 * not a page. Escape closes it, focus is trapped while it is open and returns
 * to whatever opened it, and the whole thing is `print:hidden` — the packet
 * prints the day, not a stack of overlays.
 */

export interface PlaceSheetFact {
  label: string;
  value: string;
}

export interface PlaceSheetNote {
  /** A short heading; omit for a plain paragraph. */
  title?: string;
  body: string;
  tone?: 'plain' | 'caution' | 'booking';
}

export interface PlaceSheetLink {
  label: string;
  href: string;
}

export interface PlaceSheetDetail {
  id: string;
  name: string;
  /** "Named place", "Area", "Meal" — what kind of thing this is. */
  kindLabel?: string;
  /** How well established this stop is, in traveller words. */
  confidenceLabel?: string;
  /** Why it is on THIS trip, in the fit model's own words. */
  why?: string;
  /** The plan's own sentence, when it says something the fit line does not. */
  planReason?: string;
  /** When, how long, how hard, what the weather does. */
  facts: readonly PlaceSheetFact[];
  /** What comes immediately before and after, in the day's order. */
  route?: { previous?: string; next?: string; arrive?: string };
  /** Short attributes from the board — "quiet find", "sheltered if it rains". */
  facets?: readonly string[];
  /** Hours, access, seasonal and booking notes, in reading order. */
  notes?: readonly PlaceSheetNote[];
  /** Official page, booking page, the source behind the hours. */
  links?: readonly PlaceSheetLink[];
  /** Navigation handoff, when the position is established evidence. */
  navigation?: { google: string; apple: string } | null;
}

interface SheetState {
  open: (detail: PlaceSheetDetail, image: ReactNode, actions: ReactNode) => void;
}

const Ctx = createContext<SheetState | null>(null);

export function usePlaceSheet(): SheetState | null {
  return useContext(Ctx);
}

interface OpenSheet {
  detail: PlaceSheetDetail;
  image: ReactNode;
  actions: ReactNode;
}

export function PlaceSheetProvider({ children }: { children: ReactNode }) {
  const [sheet, setSheet] = useState<OpenSheet | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback((detail: PlaceSheetDetail, image: ReactNode, actions: ReactNode) => {
    opener.current = (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null) ?? null;
    setSheet({ detail, image, actions });
  }, []);
  const close = useCallback(() => {
    setSheet(null);
    // Back to the control that opened it, so a keyboard reader does not land at the top of the document.
    opener.current?.focus?.({ preventScroll: true });
  }, []);
  const value = useMemo<SheetState>(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {sheet ? <Sheet sheet={sheet} onClose={close} /> : null}
    </Ctx.Provider>
  );
}

/** Wraps a stop's name so pressing it opens the sheet. Renders a plain span when there is no provider. */
export function PlaceSheetTrigger({
  detail,
  image = null,
  actions = null,
  className,
  children,
}: {
  detail: PlaceSheetDetail;
  image?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const sheet = usePlaceSheet();
  if (!sheet) return <>{children}</>;
  return (
    <button
      type="button"
      data-testid="stop-open-sheet"
      className={cx('pressable text-left decoration-[var(--color-rule)] underline-offset-[6px] hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine', className)}
      onClick={() => sheet.open(detail, image, actions)}
      aria-haspopup="dialog"
    >
      {children}
    </button>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),select,textarea,input,[tabindex]:not([tabindex="-1"])';

function Sheet({ sheet, onClose }: { sheet: OpenSheet; onClose: () => void }) {
  const { detail, image, actions } = sheet;
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  /*
   * PORTALLED TO THE DOCUMENT, NOT LEFT WHERE IT WAS OPENED.
   *
   * The sheet is opened from a row deep inside the Days view, and that view
   * animates on entry — an `animation` makes a stacking context, so a `z-50`
   * inside it loses to a `z-30` outside it. Measured on a phone: the trip's
   * bottom navigation and the Ask Sidequest button both drew over the open
   * sheet. A dialog belongs to the document, so it is mounted on the body.
   *
   * No mounted guard: this component only ever renders after a press, so the
   * server never reaches it and `document` is always there.
   */

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[data-sheet-initial]')?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.current.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-stretch sm:justify-end print:hidden" data-testid="place-sheet">
      <button type="button" aria-label="Close" tabIndex={-1} className="absolute inset-0 cursor-default bg-ink/35 backdrop-blur-[1px]" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="sheet-enter relative flex max-h-[88vh] w-full flex-col overflow-hidden rounded-t-[var(--radius-plate)] border border-rule bg-paper-raised shadow-[var(--shadow-panel)] sm:max-h-none sm:w-[min(30rem,92vw)] sm:rounded-none sm:rounded-l-[var(--radius-plate)] sm:border-y-0 sm:border-r-0"
      >
        <div className="flex items-start justify-between gap-4 border-b border-rule px-5 pb-3 pt-4 sm:px-6">
          <div className="min-w-0">
            {detail.kindLabel || detail.confidenceLabel ? (
              <p className="label text-ink-faint">{[detail.kindLabel, detail.confidenceLabel].filter(Boolean).join(' · ')}</p>
            ) : null}
            <h2 id={titleId} className="mt-0.5 font-display text-2xl leading-tight text-ink">
              {detail.name}
            </h2>
          </div>
          <button
            type="button"
            data-sheet-initial
            data-testid="place-sheet-close"
            onClick={onClose}
            className="pressable -mr-1 -mt-1 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg text-ink-muted hover:bg-paper-sunk hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine"
            aria-label="Close"
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4 sm:px-6">
          {image ? <div className="mb-4">{image}</div> : null}

          {detail.why ? <p className="type-body text-ink">{detail.why}</p> : null}
          {detail.planReason && detail.planReason !== detail.why ? <p className="mt-2 type-small text-ink-muted">{detail.planReason}</p> : null}

          {detail.facets && detail.facets.length > 0 ? (
            <p className="mt-3 flex flex-wrap gap-x-2 gap-y-1 type-small text-ink-muted" data-testid="place-sheet-facets">
              {detail.facets.slice(0, 4).map((facet, index) => (
                <span key={facet}>
                  {index > 0 ? <span aria-hidden="true" className="mr-2 text-ink-faint">·</span> : null}
                  {facet}
                </span>
              ))}
            </p>
          ) : null}

          {detail.facts.length > 0 ? (
            <dl className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-rule pt-4">
              {detail.facts.map((fact) => (
                <div key={fact.label} className="min-w-0">
                  <dt className="label text-ink-faint">{fact.label}</dt>
                  <dd className="mt-0.5 type-small text-ink">{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}

          {detail.route && (detail.route.previous || detail.route.next || detail.route.arrive) ? (
            <div className="mt-5 rounded-[var(--radius-card)] bg-paper-sunk px-4 py-3" data-testid="place-sheet-route">
              <p className="label text-ink-faint">Where it sits in the day</p>
              <ol className="mt-1.5 space-y-1 type-small text-ink-muted">
                {detail.route.previous ? <li>Before: {detail.route.previous}</li> : null}
                {detail.route.arrive ? <li className="text-ink">{detail.route.arrive}</li> : null}
                {detail.route.next ? <li>After: {detail.route.next}</li> : null}
              </ol>
            </div>
          ) : null}

          {detail.notes && detail.notes.length > 0 ? (
            <div className="mt-5 space-y-2.5">
              {detail.notes.map((note) => (
                <p
                  key={`${note.title ?? ''}${note.body}`}
                  className={cx(
                    'type-small leading-relaxed',
                    note.tone === 'caution' ? 'rounded-[var(--radius-card)] bg-amber-soft p-3 text-ink-muted' : note.tone === 'booking' ? 'rounded-[var(--radius-card)] border border-clay/40 p-3 text-ink-muted' : 'text-ink-muted',
                  )}
                >
                  {note.title ? <span className={cx('font-medium', note.tone === 'booking' ? 'text-clay' : 'text-ink')}>{note.title} </span> : null}
                  {note.body}
                </p>
              ))}
            </div>
          ) : null}

          {detail.links && detail.links.length > 0 ? (
            <p className="mt-5 flex flex-wrap gap-x-4 gap-y-1 type-small">
              {detail.links.map((link) => (
                <a key={link.href} href={link.href} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-4">
                  {link.label}
                </a>
              ))}
            </p>
          ) : null}
        </div>

        {detail.navigation || actions ? (
          <div className="shrink-0 border-t border-rule bg-paper px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:pb-3">
            {detail.navigation ? (
              <p className="flex flex-wrap items-center gap-x-3 type-small text-ink-muted">
                <span className="text-ink-faint">Open in</span>
                <a href={detail.navigation.google} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-4">
                  Google Maps
                </a>
                <a href={detail.navigation.apple} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-4">
                  Apple Maps
                </a>
              </p>
            ) : null}
            {actions ? <div className="mt-2 text-xs">{actions}</div> : null}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
