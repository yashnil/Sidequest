'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { buttonClass, cx, FOCUS_RING } from '../ui';

/**
 * ASK SIDEQUEST — THE CONVERSATIONAL ENTRY POINT.
 *
 * PRODUCTION LOCK V5 §43. A sheet rather than a page, and a sheet rather than a
 * chat window: the traveller is looking at their trip and wants to change the
 * thing in front of them, so the trip must stay on screen. A side sheet on the
 * desktop and a bottom sheet on a phone, both the same component and the same
 * markup — the difference is two Tailwind breakpoints, not two implementations.
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
 * The suggestions are contextual and phrased as things a person would actually
 * say, because a blank box next to a finished trip is a hard prompt to answer.
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
}

export interface AskSidequestProps {
  tripId: string;
  /** Whether there is a plan to change yet. A trip with no draft gets an explanation, not a disabled box with no reason. */
  ready: boolean;
  canUndo: boolean;
  onAsk(input: { tripId: string; request: string; idempotencyKey: string }): Promise<RefinementReply>;
  onAnswer(input: { tripId: string; runId: string; answer: string }): Promise<RefinementReply>;
  onUndo(input: { tripId: string }): Promise<RefinementReply>;
}

/** Phrased as a traveller would say them, not as commands. */
const SUGGESTIONS = [
  'Make this less rushed',
  'Give me a harder day 5',
  'Keep the big walk but reduce the driving',
  'Find a more interesting place to stay',
  'Make this trip more food-focused',
  'Why did you put this here?',
] as const;

type Exchange =
  | { kind: 'request'; text: string }
  | { kind: 'answer'; text: string }
  | { kind: 'question'; text: string; because?: string; options: string[]; runId: string }
  | { kind: 'result'; summary: RefinementSummary }
  | { kind: 'error'; text: string };

export function AskSidequest(props: AskSidequestProps) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  /*
   * §59 — the idempotency key, minted purely.
   *
   * A stable id for this panel plus a counter, rather than a clock and a random
   * number. Two reasons, and the second is the better one: `Date.now()` in a
   * component body is a render-purity violation React's own lint rule catches,
   * and a counter dedupes a *retried identical request* reliably where a
   * timestamp does not — two attempts a millisecond apart would otherwise be two
   * runs and two model calls.
   */
  /*
   * A SESSION ID THAT IS ACTUALLY NEW EACH TIME THE PANEL OPENS.
   *
   * This was `useId()`, which is stable *by design*: React derives it from the
   * component's position in the tree, so the same page reloaded produces the
   * same value. The key is therefore the same on every first submission a
   * browser ever makes, and `beginRun`'s idempotency check — working exactly as
   * intended — would answer a traveller's second-ever request with the stored
   * result of their first. On this trip that would have meant replaying a
   * failure without calling anything.
   *
   * Minted in an effect rather than during render: `crypto.randomUUID()` is
   * impure and a component body must not be, which is the same rule that sent
   * the first version of this line to `useId` in the first place. An effect runs
   * after render, where impurity is the point.
   */
  const sessionRef = useRef('');
  useEffect(() => {
    if (!sessionRef.current) sessionRef.current = crypto.randomUUID().slice(0, 12);
  }, []);
  const submissionCount = useRef(0);

  /* Escape closes the sheet, which is what every sheet on the web does. */
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [exchanges]);

  const record = (reply: RefinementReply) => {
    if (!reply.ok && reply.error) return setExchanges((previous) => [...previous, { kind: 'error', text: reply.error! }]);
    if (reply.question && reply.runId) return setExchanges((previous) => [...previous, { kind: 'question', text: reply.question!.question, ...(reply.question!.because ? { because: reply.question!.because } : {}), options: reply.question!.options, runId: reply.runId! }]);
    if (reply.answer) return setExchanges((previous) => [...previous, { kind: 'answer', text: reply.answer! }]);
    if (reply.summary) return setExchanges((previous) => [...previous, { kind: 'result', summary: reply.summary! }]);
    setExchanges((previous) => [...previous, { kind: 'error', text: 'Nothing changed.' }]);
  };

  const send = (text: string) => {
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
        record(await props.onAsk({ tripId: props.tripId, request: trimmed, idempotencyKey }));
      } finally {
        setBusy(false);
      }
    });
  };

  const answer = (runId: string, choice: string) => {
    if (busy) return;
    setExchanges((previous) => [...previous, { kind: 'request', text: choice }]);
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
  const lastQuestion = [...exchanges].reverse().find((entry) => entry.kind === 'question');
  const awaiting = lastQuestion !== undefined && exchanges.indexOf(lastQuestion) === exchanges.length - 1;

  return (
    <>
      <button
        type="button"
        data-testid="ask-sidequest-open"
        onClick={() => setOpen(true)}
        className={cx(
          buttonClass('secondary'),
          'fixed bottom-20 right-4 z-30 shadow-lg sm:bottom-6 sm:right-6 print:hidden',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        Ask Sidequest
      </button>

      {open ? (
        <div className="fixed inset-0 z-40 print:hidden" role="presentation">
          <button type="button" aria-label="Close" className="absolute inset-0 bg-black/25" onClick={() => setOpen(false)} />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Ask Sidequest"
            data-testid="ask-sidequest-sheet"
            className={cx(
              'absolute bg-paper-raised shadow-2xl flex flex-col',
              /* Bottom sheet on a phone, side sheet from the medium breakpoint up. */
              'inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl',
              'sm:inset-y-0 sm:right-0 sm:left-auto sm:w-[26rem] sm:max-h-none sm:rounded-none',
            )}
          >
            <header className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-ink">Ask Sidequest</h2>
                <p className="mt-0.5 text-[13px] leading-snug text-ink-faint">Tell it what to change. It keeps everything you did not mention.</p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className={cx('rounded p-1 text-ink-faint hover:text-ink', FOCUS_RING)} aria-label="Close Ask Sidequest">
                ✕
              </button>
            </header>

            <div ref={logRef} className="flex-1 overflow-y-auto px-5 py-4">
              {!props.ready ? (
                <p className="text-[13px] leading-relaxed text-ink-faint">Build the trip first. Once there is a plan, Sidequest can change it for you.</p>
              ) : exchanges.length === 0 ? (
                <div>
                  <p className="text-[13px] leading-relaxed text-ink-faint">For example:</p>
                  <ul className="mt-3 flex flex-col gap-2">
                    {SUGGESTIONS.map((suggestion) => (
                      <li key={suggestion}>
                        <button type="button" onClick={() => send(suggestion)} disabled={working} className={cx('w-full rounded-lg border border-rule px-3 py-2 text-left text-[13px] text-ink hover:bg-paper-sunk disabled:opacity-50', FOCUS_RING)}>
                          {suggestion}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <ol className="flex flex-col gap-4">
                  {exchanges.map((entry, index) => (
                    <li key={index} className="text-[13px] leading-relaxed">
                      {entry.kind === 'request' ? (
                        <p className="ml-8 rounded-lg bg-paper-sunk px-3 py-2 text-ink">{entry.text}</p>
                      ) : entry.kind === 'answer' ? (
                        <p className="text-ink">{entry.text}</p>
                      ) : entry.kind === 'error' ? (
                        <p data-testid="ask-sidequest-error" className="rounded-lg border border-rule px-3 py-2 text-ink-faint">{entry.text}</p>
                      ) : entry.kind === 'question' ? (
                        <div data-testid="ask-sidequest-question">
                          <p className="text-ink">{entry.text}</p>
                          {entry.because ? <p className="mt-1 text-ink-faint">{entry.because}</p> : null}
                          <div className="mt-2 flex flex-col gap-2">
                            {entry.options.map((option) => (
                              <button key={option} type="button" onClick={() => answer(entry.runId, option)} disabled={working} className={cx('rounded-lg border border-rule px-3 py-2 text-left text-ink hover:bg-paper-sunk disabled:opacity-50', FOCUS_RING)}>
                                {option}
                              </button>
                            ))}
                          </div>
                        </div>
                      ) : (
                        /*
                         * §44 — changed, kept, rechecking. Three headings a
                         * traveller can act on, and no vocabulary from the graph
                         * that produced them.
                         */
                        <div data-testid="ask-sidequest-result" className="flex flex-col gap-3">
                          <ChangeList title="Changed" items={entry.summary.changed} />
                          <ChangeList title="Kept" items={entry.summary.kept} />
                          <ChangeList title="Rechecking" items={entry.summary.rechecking} muted />
                          {entry.summary.refused.length > 0 ? <ChangeList title="Not changed" items={entry.summary.refused} muted /> : null}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}
              {working ? <p className="mt-4 text-[13px] text-ink-faint" data-testid="ask-sidequest-working">Working on it…</p> : null}
            </div>

            <form
              className="rule-top px-5 py-4"
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
                placeholder={awaiting ? 'Answer the question above first' : 'Make day 4 easier…'}
                /*
                 * A real field, not `OVERLAY_INPUT`.
                 *
                 * The first version used `OVERLAY_INPUT`, which is the
                 * transparent full-bleed control a label paints over
                 * (`ui.tsx`). Applied to a textarea in an ordinary form it
                 * produced an invisible element stretched across the sheet that
                 * swallowed every click — the browser test caught it on the
                 * first suggestion button. Styled like every other multi-line
                 * field in the product instead (`interview/patterns.tsx`).
                 */
                className="w-full resize-none rounded-[var(--radius-card)] border border-rule bg-paper-raised px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint disabled:opacity-50" 
              />
              <div className="mt-2 flex items-center justify-between gap-3">
                {props.canUndo ? (
                  <button type="button" onClick={undo} disabled={working} className={cx('text-[13px] text-ink-faint underline underline-offset-2 hover:text-ink disabled:opacity-50', FOCUS_RING)} data-testid="ask-sidequest-undo">
                    Undo last change
                  </button>
                ) : (
                  <span />
                )}
                <button type="submit" disabled={!props.ready || working || awaiting || request.trim().length === 0} className={cx(buttonClass('primary'), 'disabled:opacity-50')}>
                  Send
                </button>
              </div>
            </form>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function ChangeList({ title, items, muted = false }: { title: string; items: readonly string[]; muted?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className={cx('text-[11px] font-semibold uppercase tracking-wide', muted ? 'text-ink-faint' : 'text-ink')}>{title}</h3>
      <ul className={cx('mt-1 flex flex-col gap-0.5', muted ? 'text-ink-faint' : 'text-ink')}>
        {items.slice(0, 6).map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
