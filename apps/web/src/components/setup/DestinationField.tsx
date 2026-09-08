'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FOCUS_RING, cx } from '../ui';

/**
 * FREE TEXT FIRST. THE TYPED WORDS ARE THE DESTINATION.
 *
 * MVP V3, Stages 2, 3 and 44. What this replaces is an ARIA combobox whose
 * dropdown opened over the page on every keystroke, whose selection was the only
 * unambiguous way to proceed, and which left a traveller wondering whether their
 * click had registered. The founder's sentence for it: nobody must ever think
 * "Sidequest only supports things in its autocomplete".
 *
 * So the model is inverted.
 *
 * - **The input is the answer.** Typing "the steppes" and pressing Continue
 *   always works. There is no state in which the field holds text and the form
 *   refuses to move.
 * - **Suggestions are an aside, not a gate.** They appear *below* the field
 *   after a debounce, in the flow of the page rather than over it, as a quiet
 *   row of "did you mean" chips. Nothing about them is modal; nothing about them
 *   steals a keystroke; Escape is not needed because there is nothing to escape.
 * - **A pick is visible instantly and then gone.** Choosing a suggestion fills
 *   the field, shows a small confirmed mark with the place's own context, and
 *   collapses the row. There is no lingering popover and no second click.
 * - **Editing after a pick discards the identity, silently and correctly.** A
 *   trip must never point at a place whose name is no longer on screen.
 *
 * Accessibility: this is a plain labelled text input with a listbox of buttons
 * beneath it, not a combobox — because it is not one. Arrow keys move between
 * the suggestions as a radio group would; a live region says how many arrived.
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
  center?: { lat: number; lng: number };
  bounds?: { southWest: { lat: number; lng: number }; northEast: { lat: number; lng: number } } | null;
}

/** Long enough that a fast typist makes one request per word, not per letter. */
const DEBOUNCE_MS = 220;
const MIN_CHARS = 2;
const MAX_SHOWN = 4;

export function DestinationField({
  value,
  selectedId,
  onTextChange,
  onSelect,
  onSubmit,
  autoFocus = true,
}: {
  value: string;
  selectedId: string | null;
  onTextChange: (text: string) => void;
  onSelect: (suggestion: DestinationSuggestionView) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
}) {
  /*
   * Suggestions are stored *with the query that produced them*, and shown only
   * while that query is still what the field holds. Deriving rather than
   * clearing means a slow answer for a prefix the traveller has moved past can
   * never appear, and there is no reset-state-on-change effect to get wrong.
   */
  const [answered, setAnswered] = useState<{ query: string; items: DestinationSuggestionView[] }>({ query: '', items: [] });
  const [chosen, setChosen] = useState<DestinationSuggestionView | null>(null);
  const [searching, setSearching] = useState(false);
  const inputId = useId();
  const abort = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const adopted = useRef(false);

  const search = useCallback(async (query: string) => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      const response = await fetch(`/api/destinations/suggest?q=${encodeURIComponent(query)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as { kind: string; suggestions?: DestinationSuggestionView[] };
      if (controller.signal.aborted) return;
      setAnswered({ query, items: body.kind === 'suggestions' ? (body.suggestions ?? []).slice(0, MAX_SHOWN) : [] });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // A suggestion service that is down costs the traveller nothing: they typed the answer.
      setAnswered({ query, items: [] });
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  }, []);

  /*
   * Adopt anything typed before hydration. The field is server-rendered and
   * controlled, so between paint and hydration React is not listening — and it
   * does not read a pre-existing DOM value when it hydrates. Without this, a
   * fast typist on a slow connection sees their destination in the box and a
   * Continue button that will not move.
   */
  useEffect(() => {
    if (adopted.current) return;
    adopted.current = true;
    const typed = input.current?.value ?? '';
    if (typed.length > 0 && typed !== value) onTextChange(typed);
    // Runs once, on mount, deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const query = value.trim();
    if (query.length < MIN_CHARS || chosen?.displayName === query) return;
    timer.current = setTimeout(() => {
      setSearching(true);
      void search(query);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [value, search, chosen]);

  function choose(suggestion: DestinationSuggestionView) {
    setChosen(suggestion);
    onSelect(suggestion);
  }

  const query = value.trim();
  const suggestions = answered.query === query ? answered.items : [];
  const showSuggestions = suggestions.length > 0 && !chosen;

  return (
    <div>
      <label htmlFor={inputId} className="label block text-ink-faint">
        Destination
      </label>
      <input
        ref={input}
        id={inputId}
        name="destination"
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoFocus={autoFocus}
        value={value}
        placeholder="Anywhere you can name"
        onChange={(event) => {
          setChosen(null);
          onTextChange(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            if (value.trim().length >= MIN_CHARS) onSubmit?.();
          }
          if (event.key === 'ArrowDown' && showSuggestions) {
            event.preventDefault();
            document.getElementById(`${inputId}-suggestion-0`)?.focus();
          }
        }}
        className={cx(
          'mt-1 w-full rounded-none border-0 border-b-2 border-ink bg-transparent px-0 py-3 font-display text-3xl leading-tight text-ink outline-none placeholder:text-ink-faint/60 focus-visible:border-accent sm:text-5xl',
        )}
        data-testid="destination-input"
      />

      <p aria-live="polite" className="sr-only">
        {chosen ? `${chosen.displayName} selected.` : suggestions.length > 0 ? `${suggestions.length} suggestions below the field. They are optional.` : ''}
      </p>

      {/*
        The confirmation of a pick: small, immediate, and gone as soon as the
        traveller edits. It is the answer to "did that click register?".
      */}
      {chosen ? (
        <p className="rise mt-3 inline-flex items-center gap-2 rounded-full border border-pine/40 bg-pine-soft px-3 py-1 text-sm text-pine-strong" data-testid="destination-chosen">
          <span aria-hidden="true">✓</span>
          {chosen.qualifiedName}
          <button
            type="button"
            onClick={() => {
              setChosen(null);
              input.current?.focus();
            }}
            className={cx('ml-1 underline underline-offset-4', FOCUS_RING)}
          >
            change
          </button>
        </p>
      ) : null}

      {showSuggestions ? (
        <div className="rise mt-4" data-testid="destination-suggestions">
          <p className="type-small text-ink-faint">Did you mean — optional, and you can ignore it entirely:</p>
          <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Suggested destinations">
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.id}
                id={`${inputId}-suggestion-${index}`}
                type="button"
                onClick={() => choose(suggestion)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    document.getElementById(`${inputId}-suggestion-${Math.min(suggestions.length - 1, index + 1)}`)?.focus();
                  }
                  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    if (index === 0) input.current?.focus();
                    else document.getElementById(`${inputId}-suggestion-${index - 1}`)?.focus();
                  }
                }}
                className={cx('pressable inline-flex min-h-11 items-center gap-2 rounded-full border border-rule bg-paper-raised px-3.5 text-left text-sm text-ink transition-colors hover:border-ink-faint', FOCUS_RING)}
                data-testid={`destination-suggestion-${index}`}
              >
                <span className="font-medium">{suggestion.displayName}</span>
                <span className="text-ink-faint">{suggestion.typeLabel}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {searching && !showSuggestions && value.trim().length >= MIN_CHARS && !chosen ? (
        <p className="mt-4 type-small text-ink-faint" aria-hidden="true">
          Looking for matches — you do not have to wait.
        </p>
      ) : null}

      <input type="hidden" name="destinationEntryId" value={selectedId ?? ''} />
    </div>
  );
}
