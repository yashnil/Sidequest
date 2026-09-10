'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ARRIVAL_PRECISIONS,
  ARRIVAL_PRECISION_LABELS,
  TRAVELER_NEEDS,
  TRAVELER_NEED_LABELS,
  type TripComposerAnswers,
} from '@sidequest/core';
import { DestinationCanvas } from '../DestinationCanvas';
import type { DestinationGeometry } from '../interview/DestinationMap';
import type { MapBasemap } from '../map-adapter';
import { DestinationField, type DestinationSuggestionView } from './DestinationField';
import { TimingStep } from './TimingStep';
import { StagePath } from '../interview/StagePath';
import { Glyph } from '../interview/glyphs';
import { ErrorNote, FOCUS_RING, buttonClass, cx } from '../ui';
import { createTripFromComposer, updateTripFromComposer, type ComposerResult } from '@/app/(product)/trips/new/actions';
import { placeDestinationAction } from '@/app/(product)/trips/new/place-actions';
import type { SetupDraft, SetupStepId } from './setup-draft';
import { SETUP_STEPS, describeParty, initialDraft, isStepAnswered, nextStep, previousStep, payloadFor, stepIsRelevant, summaryOf } from './setup-draft';

/**
 * ONE QUESTION AT A TIME, FROM THE FIRST SCREEN.
 *
 * MVP V3, Stages 4 and 45. What this replaces: a single page carrying a
 * destination field, two date inputs, a flexibility radio group, a month select,
 * a season group, two checkboxes, a nights field, two head counts, a needs
 * checklist, two time selects and two textareas — and then, on the *next*
 * screen, an interview that started by asking what the trip was for. Two
 * questionnaires with a form in between.
 *
 * There is one interview now. These five screens are its first stage, they share
 * its progress path (`StagePath`), and each of them asks exactly one thing:
 *
 *   where · when · how many nights · who · anything already fixed
 *
 * ## The rules the screens are built to
 *
 * **The destination is free text and always was.** Nothing here requires a row
 * from the index; suggestions are an optional convenience under the field. See
 * `DestinationField`.
 *
 * **Timing is an intent, not two dates.** "Tell me when it is best" and "I am
 * free between these dates" are first-class answers that need no date from the
 * traveller at all — Sidequest answers them from climate records and says what
 * it does not know. See `TimingStep`.
 *
 * **Nights, not "how long".** A trip is measured in beds; days are derived and
 * shown beside them.
 *
 * **Nothing is asked before it changes something.** Check-in and check-out
 * times are not settings; they are asked only if the traveller says a flight is
 * already booked, and are otherwise an estimate that says it is one.
 *
 * **Back always works, including the browser's.** Each step is a history entry
 * (`?step=`), the draft is kept in session storage as it is typed, and no answer
 * is lost by refreshing, reloading or navigating away and returning.
 */

export function SetupFlow({
  defaults,
  editing,
  intent = 'new',
  tiles = null,
  initialStep,
}: {
  defaults: { startDate: string; endDate: string };
  editing?: { tripId: string; answers: TripComposerAnswers };
  intent?: 'new' | 'has_plan';
  tiles?: MapBasemap | null;
  initialStep?: SetupStepId;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<SetupDraft>(() => initialDraft(defaults, editing?.answers));
  const [step, setStep] = useState<SetupStepId>(initialStep ?? 'where');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const heading = useRef<HTMLHeadingElement | null>(null);
  const storageKey = editing ? `sidequest:setup:${editing.tripId}` : 'sidequest:setup:new';

  /*
   * Restore anything typed before a refresh — once, on mount.
   *
   * `set-state-in-effect` is suppressed here rather than worked around, because
   * this is the case the rule cannot express: the source of truth is the
   * browser's own session storage, which the server render cannot see and which
   * therefore *must* arrive after the first commit. Deferring it to a microtask
   * or a transition to satisfy the linter would change nothing except how
   * honest the code looks. It runs at most once and reads no React state.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || editing) return;
    restored.current = true;
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (saved) setDraft((current) => ({ ...current, ...(JSON.parse(saved) as Partial<SetupDraft>) }));
    } catch {
      /* a private window with storage refused is not an error worth showing */
    }
  }, [editing, storageKey]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      /* see above */
    }
  }, [draft, storageKey]);

  /*
   * The step lives in the address bar, so the browser's own Back is the Back
   * button. The *initial* step comes from the server (`?step=` is read in the
   * page), so nothing has to be synced on mount — only later history moves.
   */
  useEffect(() => {
    const apply = () => {
      const raw = new URLSearchParams(window.location.search).get('step');
      setStep(raw && (SETUP_STEPS as readonly string[]).includes(raw) ? (raw as SetupStepId) : 'where');
    };
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, []);

  const goTo = useCallback(
    (next: SetupStepId, mode: 'push' | 'replace' = 'push') => {
      setError(null);
      setStep(next);
      const url = `${window.location.pathname}?step=${next}`;
      if (mode === 'push') window.history.pushState(null, '', url);
      else window.history.replaceState(null, '', url);
      window.scrollTo({ top: 0 });
    },
    [],
  );

  /*
   * Focus moves to the new question's heading — but only when the step
   * actually changed, never on the first paint.
   *
   * Somebody arriving at /trips/new did not navigate here from inside the
   * flow, so there is nothing to announce and nothing to take them to; the
   * browser treats a programmatic focus with no preceding interaction as
   * keyboard focus, which drew a dashed outline around "Where are you
   * thinking?" for every visitor. Between steps the move is the whole point:
   * it is what tells a screen-reader user the question changed.
   */
  const focusedStep = useRef<SetupStepId | null>(null);
  useEffect(() => {
    if (focusedStep.current !== null && focusedStep.current !== step) {
      heading.current?.focus({ preventScroll: true });
    }
    focusedStep.current = step;
  }, [step]);

  const patch = useCallback((next: Partial<SetupDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
  }, []);

  const geometry: DestinationGeometry | null = draft.destinationCenter
    ? { name: draft.destinationText.trim() || 'Your destination', center: draft.destinationCenter, bounds: draft.destinationBounds ?? null, ...(draft.destinationFeatureType ? { featureType: draft.destinationFeatureType } : {}) }
    : null;

  /*
   * PLACING WHAT THEY TYPED — ONCE, WHEN THEY MOVE ON (§1, §4).
   *
   * Only a picked suggestion used to carry a coordinate, so on a deployment with
   * no destination index nothing typed was ever placed: the canvas showed the
   * empty world and the seasons screen said the destination could not be placed.
   * Both were statements about a missing local table, made as if they were facts
   * about the world.
   *
   * The lookup runs when the traveller leaves the "where" step and not before —
   * never per keystroke, because the geocoder's policy forbids autocomplete and
   * because a person changing their mind mid-word has not asked anything yet. It
   * is fire-and-forget: the next screen is not waiting for it, and if the answer
   * arrives late the map and the timing recommendation pick it up when it does
   * (`TimingStep` keys its recommendation on the centre).
   */
  const [placing, setPlacing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const placedFor = useRef<string | null>(null);

  const place = useCallback((text: string) => {
    const query = text.trim();
    if (query.length < 2 || placedFor.current === query) return;
    placedFor.current = query;
    setPlacing(true);
    void placeDestinationAction({ text: query })
      .then((result) => {
        if (placedFor.current !== query) return;
        if (result.placed) {
          const placed = result.placed;
          setDraft((current) =>
            current.destinationText.trim() !== query
              ? current
              : {
                  ...current,
                  destinationCenter: placed.center,
                  destinationBounds: placed.bounds ?? null,
                  destinationFeatureType: placed.featureType ?? null,
                },
          );
        }
      })
      .catch(() => {
        /* Not placed is not an error the traveller has to act on; the canvas says so quietly. */
      })
      .finally(() => {
        if (placedFor.current !== query) return;
        setPlacing(false);
        setAttempted(true);
      });
  }, []);

  const summary = useMemo(() => summaryOf(draft), [draft]);

  function submit(source: SetupDraft = draft) {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const payload = payloadFor(source);
      const result: ComposerResult = editing ? await updateTripFromComposer(editing.tripId, payload) : await createTripFromComposer(payload);
      if (!result.ok) {
        setError(result.error ?? null);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        /* nothing to clean up */
      }
      router.push(result.href);
    });
  }

  function advance() {
    /* Leaving "where" with typed text nobody has placed yet: ask, and keep going. */
    if (step === 'where' && draft.destinationCenter === null) place(draft.destinationText);
    // Answering is what makes a step count, so the summary can never show a default.
    const answeredDraft = draft.answered.includes(step) ? draft : { ...draft, answered: [...draft.answered, step] };
    setDraft(answeredDraft);
    const next = nextStep(step, answeredDraft);
    if (next === null) {
      submit(answeredDraft);
      return;
    }
    goTo(next);
  }

  const canContinue = isStepAnswered(step, draft);
  const back = previousStep(step, draft);

  return (
    <div className="mx-auto w-full max-w-6xl px-5 pb-32 sm:px-8 lg:pb-16" data-testid="setup-flow" data-step={step}>
      <div className="pt-6">
        <StagePath current="trip" note={summary.short} />
      </div>

      <div className={cx('mt-8 grid gap-10', step === 'where' ? 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-center' : 'lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start')}>
        <div className="min-w-0">
          {step === 'where' ? (
            <WhereStep
              intent={intent}
              draft={draft}
              headingRef={heading}
              error={fieldErrors.destination}
              onChange={patch}
              onSubmit={advance}
            />
          ) : null}

          {step === 'when' ? (
            <TimingStep
              draft={draft}
              headingRef={heading}
              onChange={patch}
              onContinue={advance}
            />
          ) : null}

          {step === 'nights' ? <NightsStep draft={draft} headingRef={heading} onChange={patch} onSubmit={advance} /> : null}
          {step === 'who' ? <WhoStep draft={draft} headingRef={heading} onChange={patch} /> : null}
          {step === 'fixed' ? <FixedStep draft={draft} headingRef={heading} onChange={patch} /> : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="mt-10 hidden items-center justify-between gap-4 border-t border-rule pt-6 lg:flex">
            <div className="flex items-center gap-2">
              {back ? (
                <button type="button" onClick={() => goTo(back, 'push')} className={buttonClass('ghost')} data-testid="setup-back">
                  ← Back
                </button>
              ) : null}
              {step === 'fixed' ? <span className="type-small text-ink-faint">Optional — most trips have nothing here.</span> : null}
            </div>
            <button type="button" onClick={advance} disabled={!canContinue || pending} className={buttonClass('primary', 'lg')} data-testid="setup-continue">
              {pending ? 'Saving…' : nextStep(step, draft) === null ? 'Start the interview →' : 'Continue →'}
            </button>
          </div>
        </div>

        <aside className="min-w-0">
          <DestinationCanvas geometry={geometry} tiles={tiles} destinationText={draft.destinationText} placing={placing} attempted={attempted} />
          {summary.lines.length > 0 ? (
            <dl className="mt-4 divide-y divide-rule border-y border-rule" data-testid="setup-summary">
              {summary.lines.map((line) => (
                <div key={line.label} className="flex items-baseline justify-between gap-3 py-2">
                  <dt className="label text-ink-faint">{line.label}</dt>
                  <dd className={cx('text-right text-sm', line.assumed ? 'text-ink-muted italic' : 'text-ink')}>{line.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </aside>
      </div>

      {/* Phones: the one action, always under the thumb. */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-paper/95 px-5 py-3 backdrop-blur-sm lg:hidden">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          {back ? (
            <button type="button" onClick={() => goTo(back, 'push')} className={cx(buttonClass('ghost'), 'shrink-0')} aria-label="Back">
              ←
            </button>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-sm text-ink-muted">{summary.short}</span>
          <button type="button" onClick={advance} disabled={!canContinue || pending} className={cx(buttonClass('primary'), 'shrink-0')} data-testid="setup-continue">
            {pending ? 'Saving…' : nextStep(step, draft) === null ? 'Start' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Where
// ---------------------------------------------------------------------------

function WhereStep({
  intent,
  draft,
  headingRef,
  error,
  onChange,
  onSubmit,
}: {
  intent: 'new' | 'has_plan';
  draft: SetupDraft;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  error?: string;
  onChange: (patch: Partial<SetupDraft>) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="enter">
      <p className="label text-accent">{intent === 'has_plan' ? 'A plan you already have' : 'New trip'}</p>
      <h1 ref={headingRef} tabIndex={-1} className="display-hero mt-3 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
        {intent === 'has_plan' ? 'Where is the plan taking you?' : 'Where are you thinking?'}
      </h1>
      <div className="mt-8 max-w-2xl">
        <DestinationField
          value={draft.destinationText}
          selectedId={draft.destinationEntryId}
          onTextChange={(text) => onChange({ destinationText: text, destinationEntryId: null, destinationCenter: null, destinationBounds: null, destinationFeatureType: null })}
          onSelect={(suggestion: DestinationSuggestionView) =>
            onChange({
              destinationText: suggestion.displayName,
              destinationEntryId: suggestion.id,
              destinationCenter: suggestion.center ?? null,
              destinationBounds: suggestion.bounds ?? null,
              destinationFeatureType: suggestion.featureType,
            })
          }
          onSubmit={onSubmit}
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
      <ul className="mt-8 flex flex-wrap gap-2" aria-label="Examples of what you can type">
        {['A city', 'A whole country', 'A region with no borders', "Somewhere I can't spell"].map((example) => (
          <li key={example} className="rounded-full border border-dashed border-rule px-3 py-1 type-small text-ink-faint">
            {example}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nights
// ---------------------------------------------------------------------------

const NIGHT_CHIPS = [2, 3, 4, 5, 6, 7, 10, 14];

function NightsStep({
  draft,
  headingRef,
  onChange,
  onSubmit,
}: {
  draft: SetupDraft;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onChange: (patch: Partial<SetupDraft>) => void;
  onSubmit: () => void;
}) {
  const nights = draft.nights;
  return (
    <div className="enter">
      <p className="label text-ink-faint">The trip</p>
      <h1 ref={headingRef} tabIndex={-1} className="type-title mt-1.5 max-w-[24ch] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
        How many nights do you have?
      </h1>
      <p className="mt-2 max-w-[60ch] type-body text-ink-muted">Nights are what a trip is really made of — how many beds, how many days on the ground.</p>

      <div className="mt-7 flex flex-wrap gap-2" role="group" aria-label="Nights">
        {NIGHT_CHIPS.map((value) => {
          const on = nights === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ nights: value, wantsLengthHelp: false })}
              className={cx(
                'pressable numeral inline-flex h-14 min-w-14 items-center justify-center rounded-[var(--radius-card)] border px-4 font-display text-xl transition-colors',
                FOCUS_RING,
                on ? 'border-accent bg-accent text-paper' : 'border-rule bg-paper-raised text-ink hover:border-ink-faint',
              )}
              data-testid={`nights-${value}`}
            >
              {value}
            </button>
          );
        })}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-3">
          <span className="type-small text-ink-muted">Another number</span>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label="Nights"
            value={nights === null ? '' : String(nights)}
            onChange={(event) => {
              const digits = event.target.value.replace(/[^0-9]/g, '').slice(0, 2);
              onChange({ nights: digits === '' ? null : Math.max(1, Math.min(30, Number(digits))), wantsLengthHelp: false });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && nights !== null) onSubmit();
            }}
            className={cx('numeral h-12 w-20 rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-center text-lg text-ink', FOCUS_RING)}
          />
        </label>
        {nights !== null ? (
          <p className="numeral text-sm text-ink-muted" data-testid="nights-derived">
            {nights} {nights === 1 ? 'night' : 'nights'} · {nights + 1} days on the ground
          </p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => onChange({ wantsLengthHelp: !draft.wantsLengthHelp })}
        aria-pressed={draft.wantsLengthHelp}
        className={cx('mt-7 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm transition-colors', FOCUS_RING, draft.wantsLengthHelp ? 'border-accent bg-accent-soft text-accent-strong' : 'border-dashed border-rule text-ink-muted hover:text-ink')}
        data-testid="nights-recommend"
      >
        <Glyph id="compass" className="h-4 w-4" />
        I am not sure — tell me how long this deserves
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

const PARTY_SHAPES = [
  { value: 'solo', label: 'Just me', adults: 1, children: 0 },
  { value: 'couple', label: 'Two of us', adults: 2, children: 0 },
  { value: 'friends', label: 'A group of friends', adults: 4, children: 0 },
  { value: 'family', label: 'Family with children', adults: 2, children: 2 },
  { value: 'other', label: 'Something else', adults: 2, children: 0 },
] as const;

function WhoStep({ draft, headingRef, onChange }: { draft: SetupDraft; headingRef: React.RefObject<HTMLHeadingElement | null>; onChange: (patch: Partial<SetupDraft>) => void }) {
  const shape = draft.partyShape;
  return (
    <div className="enter">
      <p className="label text-ink-faint">The trip</p>
      <h1 ref={headingRef} tabIndex={-1} className="type-title mt-1.5 max-w-[24ch] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
        Who is going?
      </h1>
      <p className="mt-2 max-w-[60ch] type-body text-ink-muted">Group size changes how a day is paced and what a table needs booking for.</p>

      <div className="mt-7 grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Who is going">
        {PARTY_SHAPES.map((option) => {
          const on = shape === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange({ partyShape: option.value, adults: option.adults, children: option.children })}
              className={cx(
                'pressable flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-card)] border px-4 py-3 text-left transition-colors',
                FOCUS_RING,
                on ? 'border-accent bg-accent-soft' : 'border-rule bg-paper-raised hover:border-ink-faint',
              )}
              data-testid={`party-${option.value}`}
            >
              <span className={cx('font-display text-lg', on ? 'text-accent-strong' : 'text-ink')}>{option.label}</span>
            </button>
          );
        })}
      </div>

      {shape ? (
        <div className="rise mt-7 flex flex-wrap items-end gap-6">
          <Counter label="Adults" min={1} value={draft.adults} onChange={(adults) => onChange({ adults })} />
          <Counter label="Children" min={0} value={draft.children} onChange={(children) => onChange({ children })} />
          <p className="numeral pb-3 text-sm text-ink-muted">{describeParty(draft)}</p>
        </div>
      ) : null}

      {shape ? (
        <fieldset className="rise mt-8">
          <legend className="label text-ink-faint">Anything that changes what a day can hold?</legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {TRAVELER_NEEDS.map((need) => {
              const on = draft.travelerNeeds.includes(need);
              return (
                <label key={need} className={cx('pressable inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm transition-colors', FOCUS_RING, on ? 'border-accent bg-accent-soft text-accent-strong' : 'border-rule bg-paper-raised text-ink-muted hover:text-ink')}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => onChange({ travelerNeeds: on ? draft.travelerNeeds.filter((entry) => entry !== need) : [...draft.travelerNeeds, need] })}
                    className="sr-only"
                  />
                  {TRAVELER_NEED_LABELS[need]}
                </label>
              );
            })}
          </div>
        </fieldset>
      ) : null}
    </div>
  );
}

function Counter({ label, min, value, onChange }: { label: string; min: number; value: number; onChange: (value: number) => void }) {
  const clamp = (next: number) => Math.max(min, Math.min(12, next));
  return (
    <div>
      <p className="label text-ink-faint">{label}</p>
      <div className="mt-1.5 flex items-center gap-1">
        <button type="button" aria-label={`One fewer ${label.toLowerCase().replace(/s$/, '')}`} disabled={value <= min} onClick={() => onChange(clamp(value - 1))} className={cx('flex h-11 w-11 items-center justify-center rounded-lg border border-rule bg-paper-raised text-lg text-ink disabled:opacity-40', FOCUS_RING)}>
          −
        </button>
        <span className="numeral w-10 text-center font-display text-xl text-ink" aria-live="polite" data-testid={`count-${label.toLowerCase()}`}>
          {value}
        </span>
        <button type="button" aria-label={`One more ${label.toLowerCase().replace(/s$/, '')}`} disabled={value >= 12} onClick={() => onChange(clamp(value + 1))} className={cx('flex h-11 w-11 items-center justify-center rounded-lg border border-rule bg-paper-raised text-lg text-ink disabled:opacity-40', FOCUS_RING)}>
          +
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Anything already fixed
// ---------------------------------------------------------------------------

function FixedStep({ draft, headingRef, onChange }: { draft: SetupDraft; headingRef: React.RefObject<HTMLHeadingElement | null>; onChange: (patch: Partial<SetupDraft>) => void }) {
  return (
    <div className="enter">
      <p className="label text-ink-faint">The trip</p>
      <h1 ref={headingRef} tabIndex={-1} className="type-title mt-1.5 max-w-[26ch] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-4 focus-visible:outline-dashed">
        Anything already booked or fixed?
      </h1>
      <p className="mt-2 max-w-[60ch] type-body text-ink-muted">Only things the plan has to work around. Everything about how you like to travel comes next.</p>

      <div className="mt-7 space-y-6 max-w-2xl">
        <div>
          <label htmlFor="setup-fixed" className="block text-sm font-medium text-ink">
            Booked, fixed, or would regret missing
          </label>
          <textarea
            id="setup-fixed"
            rows={3}
            maxLength={600}
            value={draft.mustDo}
            onChange={(event) => onChange({ mustDo: event.target.value })}
            placeholder="A hotel you have booked, a tour on a set day, one place you must see."
            className={cx('mt-2 w-full resize-y rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3.5 py-2.5 text-ink placeholder:text-ink-faint', FOCUS_RING)}
          />
        </div>
        <div>
          <label htmlFor="setup-avoid" className="block text-sm font-medium text-ink">
            Anything you would rather not do
          </label>
          <textarea
            id="setup-avoid"
            rows={2}
            maxLength={600}
            value={draft.avoid}
            onChange={(event) => onChange({ avoid: event.target.value })}
            className={cx('mt-2 w-full resize-y rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3.5 py-2.5 text-ink placeholder:text-ink-faint', FOCUS_RING)}
          />
        </div>

        {/*
          MVP V3, Stage 9 — arrival and departure are not settings.
          Asking every traveller to pick a check-in band is asking them to invent
          a fact. It is asked only by somebody who says a flight is booked; for
          everyone else the plan uses an estimate and the trip says so.
        */}
        <div className="rounded-[var(--radius-card)] border border-dashed border-rule p-4">
          <button
            type="button"
            onClick={() => onChange({ knowsFlightTimes: !draft.knowsFlightTimes })}
            aria-expanded={draft.knowsFlightTimes}
            className={cx('flex w-full items-center justify-between gap-3 text-left', FOCUS_RING)}
            data-testid="setup-flight-times"
          >
            <span className="text-sm font-medium text-ink">I know when I land and when I leave</span>
            <span aria-hidden="true" className="text-ink-faint">
              {draft.knowsFlightTimes ? '−' : '+'}
            </span>
          </button>
          {draft.knowsFlightTimes ? (
            <div className="slide-down mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="label text-ink-faint">Landing</span>
                <select value={draft.arrival} onChange={(event) => onChange({ arrival: event.target.value as SetupDraft['arrival'] })} className={cx('mt-1.5 h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)}>
                  {ARRIVAL_PRECISIONS.map((precision) => (
                    <option key={precision} value={precision}>
                      {ARRIVAL_PRECISION_LABELS[precision]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="label text-ink-faint">Leaving</span>
                <select value={draft.departure} onChange={(event) => onChange({ departure: event.target.value as SetupDraft['departure'] })} className={cx('mt-1.5 h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 text-ink', FOCUS_RING)}>
                  {ARRIVAL_PRECISIONS.map((precision) => (
                    <option key={precision} value={precision}>
                      {ARRIVAL_PRECISION_LABELS[precision]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <p className="mt-2 type-small text-ink-faint">Otherwise we plan an afternoon arrival and a morning departure, and label both as estimates.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export { stepIsRelevant };
