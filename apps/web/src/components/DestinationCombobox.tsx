'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cx } from './ui';

/**
 * WORLDWIDE DESTINATION ENTRY.
 *
 * The screen this replaces was a text input pre-filled with "Mammoth Lakes",
 * followed by a screen explaining that we only look a destination up when you
 * press a button "because the map service asks that of everyone". That was true,
 * and the answer was to stop using the map service for typeahead — not to
 * apologise for it.
 *
 * This talks to one local endpoint over a bounded index. It never calls a
 * geocoder, never calls a model, and cannot return a place that is not a stored
 * row.
 *
 * ACCESSIBILITY. This is the ARIA 1.2 combobox pattern, not a div with a
 * keydown handler:
 *
 * - the input owns `role="combobox"`, `aria-expanded`, `aria-controls`
 * - the highlighted option is named by `aria-activedescendant`, so focus never
 *   leaves the input and a screen reader announces the option as it changes
 * - options are a real `role="listbox"` / `role="option"` pair
 * - a live region reports how many results there are, because a silently
 *   repopulating list is invisible to anybody not looking at it
 * - Escape closes without clearing, Enter selects the highlighted row, and
 *   Enter with nothing highlighted submits the typed text — which is the path
 *   for everything the index does not hold
 *
 * NETWORK DISCIPLINE. Debounced, and every in-flight request is aborted when a
 * newer keystroke arrives, so a slow response can never overwrite a newer one.
 * That last part is not a nicety: without it, typing quickly reliably ends with
 * the dropdown showing results for a prefix the user has already moved past.
 */

export interface DestinationSuggestionView {
  id: string;
  displayName: string;
  localName: string | null;
  qualifiedName: string;
  typeLabel: string;
  featureType: string;
  context: string;
  highlight: [number, number][];
  matchedText: string;
}

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'results'; suggestions: DestinationSuggestionView[] }
  | { kind: 'empty' }
  | { kind: 'unavailable'; reason: string };

/** Long enough that a fast typist makes one request per word, not per letter. */
const DEBOUNCE_MS = 160;
const MIN_CHARS = 2;

export function DestinationCombobox({
  name,
  defaultValue,
  defaultSelectedId,
  onSelect,
  onTextChange,
  autoFocus,
  label = 'Where are you going?',
  hint,
}: {
  name: string;
  defaultValue?: string;
  defaultSelectedId?: string;
  /** Called with the chosen row, or null when the traveller edits after choosing. */
  onSelect?: (suggestion: DestinationSuggestionView | null) => void;
  onTextChange?: (text: string) => void;
  autoFocus?: boolean;
  label?: string;
  hint?: string;
}) {
  const [text, setText] = useState(defaultValue ?? '');
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [selectedId, setSelectedId] = useState<string | null>(defaultSelectedId ?? null);

  const inputId = useId();
  const listId = `${inputId}-listbox`;
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const adopted = useRef(false);

  const search = useCallback(async (query: string) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;

    try {
      const response = await fetch(`/api/destinations/suggest?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as
        | { kind: 'suggestions'; suggestions: DestinationSuggestionView[] }
        | { kind: 'no_match' }
        | { kind: 'too_short' }
        | { kind: 'unavailable'; reason: string };

      // A response for a prefix the traveller has already moved past is stale by
      // definition. `abort` usually prevents this; this check covers the race
      // where the response was already in flight when the abort landed.
      if (controller.signal.aborted) return;

      if (body.kind === 'suggestions') {
        setState({ kind: 'results', suggestions: body.suggestions });
        setOpen(body.suggestions.length > 0);
        setActive(body.suggestions.length > 0 ? 0 : -1);
      } else if (body.kind === 'unavailable') {
        setState({ kind: 'unavailable', reason: body.reason });
        setOpen(true);
      } else if (body.kind === 'no_match') {
        setState({ kind: 'empty' });
        setOpen(true);
      } else {
        setState({ kind: 'idle' });
        setOpen(false);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState({ kind: 'idle' });
      setOpen(false);
    }
  }, []);

  /*
   * The effect *schedules*; it does not set state.
   *
   * Both state changes that used to live here — clearing on a too-short query,
   * and entering the loading state — are consequences of an edit, so they belong
   * in the change handler where the edit happens. Doing them in an effect meant
   * a render, then a synchronous second render, on every keystroke.
   */
  /**
   * ADOPT ANYTHING TYPED BEFORE THE PAGE WAS INTERACTIVE.
   *
   * This input is server-rendered and controlled, so between first paint and
   * hydration it is a plain text box accepting keystrokes that nothing is
   * listening to. React does **not** read a pre-existing DOM value when it
   * hydrates a controlled input — so without this, the component's state stays
   * empty while the box visibly holds what somebody typed, and the composer's
   * next section, which is gated on that state, never appears.
   *
   * The failure is silent and unrecoverable: no error, no retry, just a form
   * that will not open on a page whose first field plainly contains the
   * destination. It was found in the browser suite, where a slow start made it
   * reproducible; a traveller on a slow connection who types quickly hits
   * exactly the same thing.
   *
   * Latched, so an inline-arrow `onTextChange` changing identity on every render
   * cannot make this run twice.
   */
  useEffect(() => {
    if (adopted.current) return;
    adopted.current = true;
    const typed = input.current?.value ?? '';
    if (typed.length === 0) return;
    setText(typed);
    onTextChange?.(typed);
  }, [onTextChange]);

  useEffect(() => {
    const query = text.trim();
    if (query.length < MIN_CHARS) return;
    timer.current = setTimeout(() => void search(query), DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, search]);

  // Close when focus or a click goes elsewhere. Pointerdown rather than click so
  // the list is gone before a click on something behind it registers.
  useEffect(() => {
    function away(event: PointerEvent) {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, []);

  const suggestions = state.kind === 'results' ? state.suggestions : [];

  function choose(suggestion: DestinationSuggestionView) {
    setText(suggestion.displayName);
    setSelectedId(suggestion.id);
    setOpen(false);
    setState({ kind: 'idle' });
    onSelect?.(suggestion);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!open && suggestions.length > 0) {
        setOpen(true);
        return;
      }
      if (suggestions.length === 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => {
        const next = current + step;
        if (next < 0) return suggestions.length - 1;
        if (next >= suggestions.length) return 0;
        return next;
      });
      return;
    }
    if (event.key === 'Enter') {
      const chosen = open ? suggestions[active] : undefined;
      if (chosen) {
        event.preventDefault();
        choose(chosen);
      }
      // Otherwise fall through: Enter on typed text submits the form, which is
      // the explicit-resolution path for anything the index does not hold.
      return;
    }
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }
    if (event.key === 'Home' && open) {
      event.preventDefault();
      setActive(0);
    }
    if (event.key === 'End' && open) {
      event.preventDefault();
      setActive(suggestions.length - 1);
    }
  }

  return (
    <div ref={wrapper} className="relative">
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {hint ? <p className="mt-1 text-sm text-ink-muted">{hint}</p> : null}

      <div className="relative mt-2">
        <input
          ref={input}
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${inputId}-option-${active}` : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          spellCheck={false}
          value={text}
          placeholder="A city, region, park or country"
          onChange={(event) => {
            const next = event.target.value;
            setText(next);
            onTextChange?.(next);
            if (timer.current) clearTimeout(timer.current);
            if (next.trim().length < MIN_CHARS) {
              setState({ kind: 'idle' });
              setOpen(false);
            } else {
              setState({ kind: 'loading' });
            }
            if (selectedId) {
              // Editing after choosing discards the identity. Keeping it would
              // mean the trip pointed at a place whose name is no longer on
              // screen, which is the worst of both paths.
              setSelectedId(null);
              onSelect?.(null);
            }
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true);
          }}
          className="w-full rounded-lg border border-rule bg-paper-raised px-3.5 py-3 text-base text-ink placeholder:text-ink-faint focus-visible:border-pine"
        />
        {state.kind === 'loading' ? (
          <span
            aria-hidden="true"
            className="breathing absolute top-1/2 right-3.5 -translate-y-1/2 text-xs text-ink-faint"
          >
            searching
          </span>
        ) : null}
      </div>

      {/* Hidden inputs are what the form actually posts: the typed text always,
          and the chosen identity when there is one. */}
      <input type="hidden" name={name} value={text} />
      <input type="hidden" name={`${name}EntryId`} value={selectedId ?? ''} />

      <p aria-live="polite" className="sr-only">
        {state.kind === 'results'
          ? `${state.suggestions.length} destination${state.suggestions.length === 1 ? '' : 's'} found`
          : state.kind === 'empty'
            ? 'No matching destination. Press Enter to look up what you typed.'
            : ''}
      </p>

      {open ? (
        <div className="absolute top-full right-0 left-0 z-20 mt-1.5 overflow-hidden rounded-[var(--radius-card)] border border-rule bg-paper-raised shadow-[var(--shadow-panel)]">
          <ul id={listId} role="listbox" aria-label="Destination suggestions" className="max-h-80 overflow-y-auto">
            {suggestions.map((suggestion, index) => (
              <li
                key={suggestion.id}
                id={`${inputId}-option-${index}`}
                role="option"
                aria-selected={index === active}
                onPointerDown={(event) => {
                  // Prevent the input losing focus before the click resolves.
                  event.preventDefault();
                  choose(suggestion);
                }}
                onPointerEnter={() => setActive(index)}
                className={cx(
                  'cursor-pointer border-b border-rule px-3.5 py-2.5 last:border-b-0',
                  index === active ? 'bg-pine-soft' : '',
                )}
              >
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-ink">
                    <Highlighted text={suggestion.displayName} ranges={suggestion.highlight} />
                  </span>
                  {suggestion.localName ? (
                    <span className="text-sm text-ink-faint">{suggestion.localName}</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-ink-muted">
                  {suggestion.typeLabel}
                  {suggestion.context ? ` · ${suggestion.context}` : ''}
                </span>
              </li>
            ))}
          </ul>

          {state.kind === 'empty' ? (
            <p className="px-3.5 py-3 text-sm text-ink-muted">
              Nothing in our index by that name. Press{' '}
              <kbd className="rounded border border-rule px-1 text-xs">Enter</kbd> and we will look
              up what you typed.
            </p>
          ) : null}
          {state.kind === 'unavailable' ? (
            <p className="px-3.5 py-3 text-sm text-ink-muted">
              {state.reason} Type the full name and press{' '}
              <kbd className="rounded border border-rule px-1 text-xs">Enter</kbd> — we will look it
              up instead.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The matched characters, marked.
 *
 * Ranges are computed server-side against the *original* text, because folding
 * an accented name shortens it and offsets taken from the folded form land one
 * character early per stripped mark. An empty range list renders plain, which is
 * the honest result for a typo-tolerant match that has no exact span.
 */
function Highlighted({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>;
  const [start, end] = ranges[0]!;
  return (
    <>
      {text.slice(0, start)}
      <mark className="bg-transparent font-semibold text-pine">{text.slice(start, end)}</mark>
      {text.slice(end)}
    </>
  );
}
