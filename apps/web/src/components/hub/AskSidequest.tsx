'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { DeltaLine, DraftDelta } from '@sidequest/core';
import { buttonClass, cx, FOCUS_RING } from '../ui';
import { groupByDay, suggestionsFor } from './ask-diff';
import { ChangesCard } from './ChangesCard';
import { ASK_OPEN_EVENT } from './HubShell';

/**
 * ASK SIDEQUEST — THE CONVERSATIONAL ENTRY POINT.
 *
 * PRODUCTION LOCK V5 §43. A sheet rather than a page, and a sheet rather than a
 * chat window: the traveller is looking at their trip and wants to change the
 * thing in front of them, so the trip must stay on screen. A side sheet on the
 * desktop and a bottom sheet on a phone, both the same component and the same
 * markup — the difference is a media query, not two implementations.
 *
 * Three things it deliberately does not do:
 *
 * - **It is not a chatbot.** There is no persona, no typing indicator and no
 *   open-ended conversation. One request, one answer, and the answer is a change
 *   to the trip or a sentence about it.
 * - **It never shows graph terminology** (§44). "Blast radius", "checkpoint",
 *   "interrupt", "patch" and "thread" appear nowhere a traveller can read. What
 *   they see is what changed, what stayed, and what is being rechecked.
 * - **It does not let a second request race the first** (§48). The composer is
 *   disabled while a change is in flight, and the server refuses one anyway.
 *
 * V8 — THE PANEL IS AN ASSISTANT WORKSPACE WITH FOUR VISIBLE STATES.
 *
 * An answer is a quiet card. A proposal is a raised accent card that says what
 * would change and what is kept, with Apply and Cancel. Working is a breathing
 * row under the log. Applied is a pine card with a prominent Undo. The
 * proposal → applied step morphs in place (the card's colour settles and the
 * result card rises under it) rather than replacing the panel.
 *
 * THE TRIGGER LIVES WHERE IT CANNOT COVER THE PLAN. The hub's own chrome
 * renders the one element carrying `ask-sidequest-open` (`HubShell`'s
 * `AskTrigger`, in the nav row on `sm+` and the bottom bar on a phone) from
 * the first server paint, and raises a DOM event this sheet opens on — so
 * nothing ever floats over a headline or a card (the V8 audit's P0). On a
 * wide screen a floating button appears only once the band has scrolled out
 * of view; it carries its own id so the tests' single trigger stays single.
 * A page with no hub trigger gets a floating fallback after mount.
 */

export interface RefinementSummary {
  changed: readonly string[];
  kept: readonly string[];
  rechecking: readonly string[];
  refused: readonly string[];
}

export interface RefinementReply {
  ok: boolean;
  error?: string;
  question?: { question: string; options: string[]; because?: string };
  runId?: string;
  summary?: RefinementSummary;
  answer?: string;
  version?: number;
  /**
   * V6 §30 — WHICH OF THE THREE THINGS THIS REPLY IS.
   *
   * `answer` is a sentence about the trip and nothing moved. `proposal` is a
   * change Sidequest is offering to make, with its scope and its days, and
   * nothing has landed yet. `applied` is a change that has landed and can be
   * undone. Optional because a reply from before the field existed carries
   * none, and the shape of the reply still decides how it renders.
   */
  mode?: 'answer' | 'proposal' | 'applied';
  /** The preview behind a proposal: what it would touch, and what it would do. */
  proposal?: { scope: string; changes: readonly string[]; days: readonly number[]; delta?: DraftDelta };
  /** V9 §4 — after Apply, the measured delta between the previous version's metrics and the new. */
  delta?: readonly DeltaLine[];
}

export interface AskSidequestProps {
  tripId: string;
  /** Whether there is a plan to change yet. A trip with no draft gets an explanation, not a disabled box with no reason. */
  ready: boolean;
  canUndo: boolean;
  /** The trip's own day count, for the example prompts. Optional: without it the examples name no day. */
  dayCount?: number;
  /** The trip's base names in order, for the example prompts. Optional: without them the examples name no place. */
  baseNames?: readonly string[];
  onAsk(input: { tripId: string; request: string; idempotencyKey: string; structural?: boolean }): Promise<RefinementReply>;
  onAnswer(input: { tripId: string; runId: string; answer: string }): Promise<RefinementReply>;
  onUndo(input: { tripId: string }): Promise<RefinementReply>;
}

type Exchange =
  | { kind: 'request'; text: string }
  | { kind: 'answer'; text: string }
  | { kind: 'question'; text: string; because?: string; options: string[]; runId: string }
  | { kind: 'proposal'; text: string; scope: string; changes: readonly string[]; days: readonly number[]; options: string[]; runId: string; answered?: string; delta?: DraftDelta }
  | { kind: 'result'; summary: RefinementSummary; undoable: boolean; delta?: readonly DeltaLine[] }
  | { kind: 'error'; text: string };

/* The one breakpoint the sheet and the trigger placement both turn on: Tailwind's `sm`. */
const WIDE_QUERY = '(min-width: 640px)';
const subscribeWide = (onChange: () => void) => {
  const media = window.matchMedia(WIDE_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};
const readWide = () => window.matchMedia(WIDE_QUERY).matches;
const readWideOnServer = () => false;

/* "Has this component hydrated?" — the sanctioned probe, as `PrintButton` argues. */
const subscribeNever = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function AskSidequest(props: AskSidequestProps) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [bandGone, setBandGone] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLButtonElement>(null);
  /* The hub's trigger, found once mounted; the fallback renders only when there is none. */
  const [hubTrigger, setHubTrigger] = useState<HTMLElement | null>(null);
  /*
   * Whether the page has no hub trigger at all, decided after the tree has
   * committed — never during render, where the document may still be the
   * previous page's (a client navigation from the board found no trigger and
   * drew a floating fallback beside the hub's own).
   */
  const [needsFallback, setNeedsFallback] = useState(false);
  /* Whatever opened the sheet — the trigger, the floating button — gets focus back when it closes. */
  const openerRef = useRef<HTMLElement | null>(null);
  /*
   * V9 §3 — a request handed in with the open event (an alternative chip, a
   * freshness proposal, "Change today"). Held until the sheet is open and the
   * composer is free, then sent as if typed; never sent twice.
   */
  const [queued, setQueued] = useState<{ text: string; send: boolean; structural?: boolean } | null>(null);
  const reduced = useReducedMotion();
  const mounted = useSyncExternalStore(subscribeNever, onClient, onServer);
  const wide = useSyncExternalStore(subscribeWide, readWide, readWideOnServer);
  /*
   * §59 — the idempotency key, minted purely.
   *
   * A stable id for this panel plus a counter, rather than a clock and a random
   * number: a counter dedupes a *retried identical request* reliably where a
   * timestamp does not. The session id is minted in an effect, because
   * `crypto.randomUUID()` is impure and a component body must not be, and it is
   * new each time the panel mounts — a `useId()` would replay the first-ever
   * request's stored result on every reload.
   */
  const sessionRef = useRef('');
  useEffect(() => {
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID().slice(0, 12);
  }, []);
  const submissionCount = useRef(0);

  const close = useCallback(() => {
    setOpen(false);
    const opener = openerRef.current ?? hubTrigger ?? fallbackRef.current;
    opener?.focus?.({ preventScroll: true });
  }, [hubTrigger]);

  const openSheet = useCallback(
    (from?: HTMLElement | null) => {
      openerRef.current = from ?? hubTrigger ?? (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null) ?? fallbackRef.current;
      setOpen(true);
    },
    [hubTrigger],
  );

  /* The hub's trigger raises an event rather than holding this sheet's state; the sheet keeps its `aria-expanded` true. */
  useEffect(() => {
    if (!mounted) return;
    const trigger = document.querySelector<HTMLElement>('[data-testid="ask-sidequest-open"]');
    // Deferred so the effect never sets state synchronously during a render pass.
    const handle = window.setTimeout(() => {
      setHubTrigger(trigger);
      setNeedsFallback(trigger === null);
    }, 0);
    const onOpen = (event: Event) => {
      openSheet(document.querySelector<HTMLElement>('[data-testid="ask-sidequest-open"]'));
      const detail = (event as CustomEvent<{ request?: unknown; send?: unknown; structural?: unknown } | undefined>).detail;
      const request = detail?.request;
      /*
       * The default is to pre-fill the composer and wait for the traveller's
       * own press (a freshness proposal, a split suggestion, "Change today");
       * only a dispatcher that says `send: true` — the decision cards'
       * controlled alternatives, which are complete requests — is sent as is.
       */
      if (typeof request === 'string' && request.trim().length > 0) setQueued({ text: request.trimStart().slice(0, 600), send: detail?.send === true, structural: detail?.structural === true });
    };
    window.addEventListener(ASK_OPEN_EVENT, onOpen);
    return () => {
      window.clearTimeout(handle);
      window.removeEventListener(ASK_OPEN_EVENT, onOpen);
    };
  }, [mounted, openSheet]);
  useEffect(() => {
    hubTrigger?.setAttribute('aria-expanded', String(open));
  }, [hubTrigger, open]);

  /* Escape closes the sheet, which is what every sheet on the web does — and focus goes home. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [exchanges, reduced]);

  /* On a wide screen the floating button appears only once the band has scrolled away. */
  useEffect(() => {
    if (!mounted || !wide || typeof IntersectionObserver === 'undefined') return;
    const band = document.querySelector('[data-testid="atlas-band"]');
    if (!band) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) setBandGone(!entry.isIntersecting);
    });
    observer.observe(band);
    return () => observer.disconnect();
  }, [mounted, wide]);

  const record = (reply: RefinementReply) => {
    if (!reply.ok && reply.error) return setExchanges((previous) => [...previous, { kind: 'error', text: reply.error! }]);
    /*
     * A proposal is not a clarifying question. The traveller is being shown a
     * change before it lands — its scope, the days it touches and what it would
     * do — and the two buttons are a decision, not an answer.
     */
    if (reply.mode === 'proposal' && reply.proposal && reply.question && reply.runId) {
      const proposal = reply.proposal;
      return setExchanges((previous) => [
        ...previous,
        { kind: 'proposal', text: reply.question!.question, scope: proposal.scope, changes: proposal.changes, days: proposal.days, options: reply.question!.options, runId: reply.runId!, ...(proposal.delta ? { delta: proposal.delta } : {}) },
      ]);
    }
    if (reply.question && reply.runId) return setExchanges((previous) => [...previous, { kind: 'question', text: reply.question!.question, ...(reply.question!.because ? { because: reply.question!.because } : {}), options: reply.question!.options, runId: reply.runId! }]);
    if (reply.answer) return setExchanges((previous) => [...previous, { kind: 'answer', text: reply.answer! }]);
    if (reply.summary) return setExchanges((previous) => [...previous, { kind: 'result', summary: reply.summary!, undoable: reply.mode === 'applied', ...(reply.delta && reply.delta.length > 0 ? { delta: reply.delta } : {}) }]);
    setExchanges((previous) => [...previous, { kind: 'error', text: 'Nothing changed.' }]);
  };

  const send = (text: string, structural = false) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy) return;
    setExchanges((previous) => [...previous, { kind: 'request', text: trimmed }]);
    setRequest('');
    setBusy(true);
    /* One key per logical submission; a retry of the same submission reuses it. */
    submissionCount.current += 1;
    const idempotencyKey = `${sessionRef.current || 'pending'}-${submissionCount.current}`;
    startTransition(async () => {
      try {
        record(await props.onAsk({ tripId: props.tripId, request: trimmed, idempotencyKey, ...(structural ? { structural: true } : {}) }));
      } finally {
        setBusy(false);
      }
    });
  };

  const answer = (runId: string, choice: string) => {
    if (busy) return;
    /*
     * V6 — a proposal answered is settled. Its buttons go, so a second press
     * (a double tap, a walker in a loop) cannot send "Apply" to a run that has
     * already applied and be told the question is no longer open.
     */
    setExchanges((previous) => [...previous.map((entry) => (entry.kind === 'proposal' && entry.runId === runId ? { ...entry, answered: choice } : entry)), { kind: 'request', text: choice }]);
    setBusy(true);
    startTransition(async () => {
      try {
        record(await props.onAnswer({ tripId: props.tripId, runId, answer: choice }));
      } finally {
        setBusy(false);
      }
    });
  };

  const undo = () => {
    if (busy) return;
    setBusy(true);
    startTransition(async () => {
      try {
        record(await props.onUndo({ tripId: props.tripId }));
      } finally {
        setBusy(false);
      }
    });
  };

  const working = busy || pending;
  /* A proposal waits on a decision exactly as a question waits on an answer: the composer stays shut until one of the two buttons is pressed. */
  const lastPrompt = [...exchanges].reverse().find((entry) => entry.kind === 'question' || entry.kind === 'proposal');
  const awaiting = lastPrompt !== undefined && exchanges.indexOf(lastPrompt) === exchanges.length - 1;
  const suggestions = suggestionsFor({ ...(props.dayCount ? { dayCount: props.dayCount } : {}), ...(props.baseNames ? { baseNames: props.baseNames } : {}) });

  /* The queued request goes the moment the sheet is open and nothing is in flight or waiting on an answer. */
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    if (!queued || !open || working || awaiting) return;
    const { text, send: shouldSend, structural } = queued;
    // Deferred so the effect never sets state synchronously during a render pass.
    const handle = window.setTimeout(() => {
      setQueued(null);
      if (!props.ready) return;
      if (shouldSend) sendRef.current(text.trim(), structural === true);
      else {
        setRequest(text);
        inputRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(handle);
  }, [queued, open, working, awaiting, props.ready]);

  /* Only a page with no hub trigger at all gets one of its own, and only after mount, so nothing floats on first paint. */
  const fallback = mounted && needsFallback && hubTrigger === null;

  const sheetMotion = wide ? { initial: { x: '100%' }, animate: { x: 0 }, exit: { x: '100%' } } : { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } };
  const sheetTransition = reduced ? { duration: 0 } : { duration: 0.32, ease: [0.2, 0.7, 0.2, 1] as const };
  const rise = reduced ? {} : { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.26, ease: [0.2, 0.7, 0.2, 1] as const } };

  return (
    <>
      {fallback ? (
        <button
          type="button"
          ref={fallbackRef}
          data-testid="ask-sidequest-open"
          onClick={(event) => openSheet(event.currentTarget)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Ask Sidequest"
          className={cx(buttonClass('primary'), 'fixed bottom-20 right-4 z-30 rounded-full shadow-[var(--shadow-float)] print:hidden sm:bottom-6 sm:right-6')}
        >
          <SparkGlyph className="h-4 w-4" />
          <span>Ask Sidequest</span>
        </button>
      ) : null}

      <AnimatePresence>
        {wide && bandGone && !open ? (
          <motion.button
            key="ask-float"
            type="button"
            data-testid="ask-sidequest-float"
            aria-label="Ask Sidequest"
            onClick={(event) => openSheet(event.currentTarget)}
            className={cx(buttonClass('primary'), 'fixed bottom-6 right-6 z-30 rounded-full shadow-[var(--shadow-float)] print:hidden')}
            initial={reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12 }}
            transition={{ duration: reduced ? 0 : 0.2 }}
          >
            <SparkGlyph className="h-4 w-4" />
            Ask Sidequest
          </motion.button>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {open ? (
          <div className="fixed inset-0 z-40 print:hidden" role="presentation">
            <motion.button
              type="button"
              aria-label="Close"
              className="absolute inset-0 bg-ink/35 backdrop-blur-[1px]"
              onClick={close}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? 0 : 0.2 }}
            />
            <motion.aside
              role="dialog"
              aria-modal="true"
              aria-label="Ask Sidequest"
              data-testid="ask-sidequest-sheet"
              className={cx(
                'absolute flex flex-col bg-paper shadow-[var(--shadow-float)]',
                /* Bottom sheet on a phone, side sheet from the small breakpoint up. */
                'inset-x-0 bottom-0 max-h-[88vh] rounded-t-[var(--radius-plate)] border-t border-rule',
                'sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[min(28rem,92vw)] sm:max-h-none sm:rounded-none sm:rounded-l-[var(--radius-plate)] sm:border-t-0 sm:border-l',
              )}
              {...sheetMotion}
              transition={sheetTransition}
            >
              <header className="flex items-start justify-between gap-3 border-b border-rule px-5 pb-4 pt-5 sm:px-6">
                <div className="min-w-0">
                  <p className="eyebrow text-accent-strong">Your plan, on request</p>
                  <h2 className="mt-1 font-display text-2xl leading-tight text-ink">Ask Sidequest</h2>
                  <p className="mt-1.5 type-small text-ink-muted">Tell it what to change. It keeps everything you did not mention.</p>
                </div>
                <button
                  type="button"
                  onClick={close}
                  className={cx('pressable -mr-2 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg text-ink-muted hover:bg-paper-sunk hover:text-ink', FOCUS_RING, 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine')}
                  aria-label="Close Ask Sidequest"
                >
                  <span aria-hidden="true">✕</span>
                </button>
              </header>

              <div ref={logRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
                {!props.ready ? (
                  <p className="type-body text-ink-muted">Build the trip first. Once there is a plan, Sidequest can change it for you.</p>
                ) : exchanges.length === 0 ? (
                  <div>
                    <p className="type-small text-ink-muted">Things people ask, on a trip like this one:</p>
                    <ul className="mt-3 flex flex-col gap-2">
                      {suggestions.map((suggestion) => (
                        <li key={suggestion}>
                          <button
                            type="button"
                            onClick={() => send(suggestion)}
                            disabled={working}
                            className={cx('card lift pressable flex min-h-11 w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm text-ink disabled:opacity-50', FOCUS_RING, 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine')}
                          >
                            <span>{suggestion}</span>
                            <span aria-hidden="true" className="text-ink-faint">
                              →
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <ol className="flex flex-col gap-4">
                    {exchanges.map((entry, index) => (
                      <motion.li key={index} layout={!reduced} {...rise} className="text-sm leading-relaxed">
                        {entry.kind === 'request' ? (
                          <p className="ml-10 rounded-[var(--radius-card)] rounded-br-sm bg-paper-sunk px-4 py-2.5 text-ink">{entry.text}</p>
                        ) : entry.kind === 'answer' ? (
                          <div className="card mr-6 px-4 py-3" data-testid="ask-sidequest-answer">
                            <p className="eyebrow">Answer</p>
                            <p className="mt-1 type-body text-ink">{entry.text}</p>
                          </div>
                        ) : entry.kind === 'error' ? (
                          <p data-testid="ask-sidequest-error" className="mr-6 rounded-[var(--radius-card)] border border-clay/50 bg-clay-soft/50 px-4 py-3 text-ink">
                            {entry.text}
                          </p>
                        ) : entry.kind === 'proposal' ? (
                          <ProposalCard entry={entry} working={working} reduced={Boolean(reduced)} onAnswer={answer} />
                        ) : entry.kind === 'question' ? (
                          <div data-testid="ask-sidequest-question" className="card mr-6 px-4 py-3">
                            <p className="eyebrow">One question first</p>
                            <p className="mt-1 type-body text-ink">{entry.text}</p>
                            {entry.because ? <p className="mt-1 type-small text-ink-muted">{entry.because}</p> : null}
                            <div className="mt-3 flex flex-col gap-2">
                              {entry.options.map((option) => (
                                <button key={option} type="button" onClick={() => answer(entry.runId, option)} disabled={working} className={cx(buttonClass('secondary', 'sm'), 'justify-start text-left')}>
                                  {option}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <ResultCard entry={entry} working={working} onUndo={undo} />
                        )}
                      </motion.li>
                    ))}
                  </ol>
                )}
                <AnimatePresence>
                  {working ? (
                    <motion.div key="working" className="mt-4 flex items-center gap-3 text-sm text-ink-muted" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.16 }} aria-live="polite">
                      <span aria-hidden="true" className="breathing inline-flex gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                      </span>
                      <span data-testid="ask-sidequest-working">Working on it…</span>
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <form
                className="border-t border-rule bg-paper-raised px-5 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 sm:px-6"
                onSubmit={(event) => {
                  event.preventDefault();
                  send(request);
                }}
              >
                <label htmlFor="ask-sidequest-input" className="sr-only">
                  What would you like changed?
                </label>
                <textarea
                  id="ask-sidequest-input"
                  ref={inputRef}
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      send(request);
                    }
                  }}
                  rows={2}
                  maxLength={600}
                  disabled={!props.ready || working || awaiting}
                  placeholder={awaiting ? 'Answer the question above first' : props.dayCount ? `Make day ${Math.min(props.dayCount, 2)} easier…` : 'Make a day easier…'}
                  className="w-full resize-none rounded-[var(--radius-card)] border border-rule bg-paper px-3.5 py-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine disabled:opacity-50"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  {props.canUndo ? (
                    <button type="button" onClick={undo} disabled={working} className={buttonClass('ghost', 'sm')} data-testid="ask-sidequest-undo">
                      Undo last change
                    </button>
                  ) : (
                    <span />
                  )}
                  <button type="submit" disabled={!props.ready || working || awaiting || request.trim().length === 0} className={buttonClass('primary')}>
                    Send
                  </button>
                </div>
              </form>
            </motion.aside>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

function ProposalCard({ entry, working, reduced, onAnswer }: { entry: Extract<Exchange, { kind: 'proposal' }>; working: boolean; reduced: boolean; onAnswer: (runId: string, choice: string) => void }) {
  const applyWord = applyOption(entry.options);
  const cancelWord = cancelOption(entry.options);
  const applied = entry.answered !== undefined && entry.answered === applyWord;
  const cancelled = entry.answered !== undefined && !applied;
  return (
    <motion.div
      layout={!reduced}
      data-testid="ask-proposal"
      data-state={applied ? 'applied' : cancelled ? 'cancelled' : 'open'}
      className={cx(
        'mr-6 rounded-[var(--radius-card)] border px-4 py-4 transition-[background-color,border-color,box-shadow] duration-[var(--motion-page)]',
        applied ? 'border-pine/50 bg-pine-soft/40' : cancelled ? 'border-rule bg-paper-sunk/60' : 'border-accent/60 bg-accent-soft/50 shadow-[var(--shadow-raised)]',
      )}
    >
      <p className={cx('eyebrow', applied ? 'text-pine' : cancelled ? 'text-ink-faint' : 'text-accent-strong')}>{applied ? 'Applied' : cancelled ? 'Cancelled' : 'Proposed change'}</p>
      <h3 className="mt-1 font-display text-xl leading-snug text-ink">{proposalHeading(entry.days, entry.text)}</h3>
      <p className="mt-1 type-small text-ink-muted">{entry.scope}</p>
      {/* V9 §4 — the deterministic delta, from the drafts themselves. No provider has run yet, so nothing here is a measured minute. */}
      {entry.delta ? <ChangesCard lines={entry.delta.lines} headline={entry.delta.headline} eyebrow="What this would change" testId="proposal-delta" className="mt-3" /> : null}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <ChangeGroups title="Would change" lines={entry.changes} />
        <div>
          <p className="text-sm font-semibold text-ink">Kept</p>
          <p className="mt-1 type-small text-ink-muted">Everything you did not mention stays as it is.</p>
        </div>
      </div>
      {entry.answered ? (
        <p className={cx('mt-3 text-sm font-medium', applied ? 'text-pine' : 'text-ink-muted')} data-testid="ask-proposal-answered">
          {applied ? 'Applied.' : 'Cancelled — nothing moved.'}
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" data-testid="ask-proposal-apply" onClick={() => onAnswer(entry.runId, applyWord)} disabled={working} className={buttonClass('accent', 'sm')}>
            {applyWord}
          </button>
          <button type="button" data-testid="ask-proposal-cancel" onClick={() => onAnswer(entry.runId, cancelWord)} disabled={working} className={buttonClass('secondary', 'sm')}>
            {cancelWord}
          </button>
        </div>
      )}
    </motion.div>
  );
}

function ResultCard({ entry, working, onUndo }: { entry: Extract<Exchange, { kind: 'result' }>; working: boolean; onUndo: () => void }) {
  return (
    /*
     * §44 — changed, kept, rechecking. Three headings a traveller can act on,
     * and no vocabulary from the graph that produced them.
     */
    <div data-testid="ask-sidequest-result" className={cx('mr-6 rounded-[var(--radius-card)] border px-4 py-4', entry.undoable ? 'border-pine/50 bg-pine-soft/40' : 'card')}>
      <p className={cx('eyebrow', entry.undoable ? 'text-pine' : '')}>{entry.undoable ? 'Applied to your plan' : 'Done'}</p>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <ChangeGroups title="Changed" lines={entry.summary.changed} />
        <ChangeGroups title="Kept" lines={entry.summary.kept} />
      </div>
      <ChangeGroups title="Rechecking" lines={entry.summary.rechecking} muted className="mt-3" />
      {entry.summary.refused.length > 0 ? <ChangeGroups title="Not changed" lines={entry.summary.refused} muted className="mt-3" /> : null}
      {/* V9 §4 — the measured delta, from the structural metrics of the version before and the version after. */}
      {entry.delta ? <ChangesCard lines={entry.delta} eyebrow="Measured" testId="applied-delta" className="mt-3" /> : null}
      {entry.undoable ? (
        <p className="mt-4">
          <button type="button" onClick={onUndo} disabled={working} className={buttonClass('secondary', 'md')} data-testid="ask-sidequest-undo-applied">
            Undo this change
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Change days 4–6?" — the days the proposal touches, as a range a person reads.
 *
 * Falls back to the model's own question when the proposal names no day, which
 * is the honest rendering of a change whose scope is the whole trip.
 */
function proposalHeading(days: readonly number[], fallback: string): string {
  if (days.length === 0) return fallback;
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const contiguous = sorted.every((day, index) => index === 0 || day === sorted[index - 1]! + 1);
  if (sorted.length === 1) return `Change day ${sorted[0]}?`;
  return contiguous ? `Change days ${sorted[0]}–${sorted[sorted.length - 1]}?` : `Change days ${sorted.join(', ')}?`;
}

/* The run's own option words, so the button sends exactly what the server expects. */
function applyOption(options: readonly string[]): string {
  return options.find((option) => /^(apply|yes|go ahead|do it)/i.test(option)) ?? options[0] ?? 'Apply';
}

function cancelOption(options: readonly string[]): string {
  return options.find((option) => /^(cancel|no|leave|keep)/i.test(option)) ?? options[options.length - 1] ?? 'Cancel';
}

/** "Day 3 — fewer stops, the big walk kept": the lines grouped under the day they name. */
function ChangeGroups({ title, lines, muted = false, className }: { title: string; lines: readonly string[]; muted?: boolean; className?: string }) {
  if (lines.length === 0) return null;
  const groups = groupByDay(lines.slice(0, 8));
  return (
    <div className={className}>
      <p className={cx('text-sm font-semibold', muted ? 'text-ink-faint' : 'text-ink')}>{title}</p>
      <ul className={cx('mt-1 flex flex-col gap-1.5 type-small', muted ? 'text-ink-faint' : 'text-ink-muted')}>
        {groups.map((group) => (
          <li key={group.day ?? 'trip'}>
            {group.day !== null ? <span className="type-figure text-ink">Day {group.day} — </span> : null}
            {group.lines.join(', ')}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A small four-point spark: the one mark the trigger carries, so it reads as "ask" at bar size. */
function SparkGlyph({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className={cx('shrink-0', className)} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM5 17l.7 1.8 1.8.7-1.8.7L5 22l-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}
