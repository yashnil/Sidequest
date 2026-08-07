'use client';

import { useState, useTransition } from 'react';
import {
  BUDGET_BANDS,
  BUDGET_BAND_LABELS,
  TRANSPORT_INTENTS,
  TRANSPORT_INTENT_LABELS,
  TRIP_SHAPES,
  TRIP_SHAPE_LABELS,
  TRIP_THEMES,
  TRIP_THEME_LABELS,
} from '@sidequest/core';
import { Choice, ChoiceGroup, ErrorNote, FieldLabel, Panel, buttonClass, cx } from './ui';
import {
  saveDecisionAnswersAction,
  startDecisionAction,
  type DecisionAnswersInput,
} from '@/app/decide/actions';

/**
 * THE FOUR QUESTIONS THAT CAN RANK ANYWHERE.
 *
 * Deliberately shorter than the known-destination composer, and the difference
 * is not a shortcut — it is what the data can answer. Before a destination
 * exists there is no region to expand, no candidate to score for effort, no
 * route to time. What *can* be ranked is: when they can go, how long for, what
 * they came for, and how much they will move. Everything else is asked after a
 * destination is chosen, on the screens that already ask it.
 *
 * Asking more here would look thorough and change nothing, which is the most
 * expensive kind of question there is.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export interface DecisionComposerProps {
  climateEnabled: boolean;
  indexReady: boolean;
  /** Present when editing an existing session rather than starting one. */
  sessionId?: string;
  initial?: Partial<DecisionAnswersInput>;
  onSaved?: () => void;
}

export function DecisionComposer(props: DecisionComposerProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [dateMode, setDateMode] = useState<DecisionAnswersInput['dateMode']>(
    props.initial?.dateMode ?? 'month',
  );
  const [month, setMonth] = useState(props.initial?.month ?? new Date().getUTCMonth() + 2);
  const [season, setSeason] = useState<'spring' | 'summer' | 'autumn' | 'winter'>(
    props.initial?.season ?? 'summer',
  );
  const [startDate, setStartDate] = useState(props.initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(props.initial?.endDate ?? '');
  const [nights, setNights] = useState<number | ''>(props.initial?.nights ?? 7);
  const [themes, setThemes] = useState<string[]>(props.initial?.themes ?? []);
  const [shape, setShape] = useState<DecisionAnswersInput['shape']>(props.initial?.shape ?? null);
  const [transport, setTransport] = useState<DecisionAnswersInput['transport']>(
    props.initial?.transport ?? null,
  );
  const [pace, setPace] = useState<DecisionAnswersInput['pace']>(props.initial?.pace ?? null);
  const [intensity, setIntensity] = useState<DecisionAnswersInput['outdoorIntensity']>(
    props.initial?.outdoorIntensity ?? null,
  );
  const [budget, setBudget] = useState<DecisionAnswersInput['budget']>(props.initial?.budget ?? null);
  const [adults, setAdults] = useState(props.initial?.adults ?? 2);
  const [children, setChildren] = useState(props.initial?.children ?? 0);
  const [avoid, setAvoid] = useState(props.initial?.avoid ?? '');
  const [showMore, setShowMore] = useState(false);

  const answers: DecisionAnswersInput = {
    dateMode,
    ...(dateMode === 'exact' || dateMode === 'flexible'
      ? { startDate: startDate || undefined, endDate: endDate || undefined }
      : {}),
    ...(dateMode === 'month' ? { month } : {}),
    ...(dateMode === 'season' ? { season } : {}),
    nights: nights === '' ? null : nights,
    shape,
    transport,
    pace,
    themes,
    outdoorIntensity: intensity,
    budget,
    adults,
    children,
    avoid,
  };

  const ready = themes.length > 0;

  function submit() {
    setError(null);
    startTransition(async () => {
      if (props.sessionId) {
        const result = await saveDecisionAnswersAction(props.sessionId, answers);
        if (!result.ok) setError(result.error ?? 'We could not save that.');
        else props.onSaved?.();
        return;
      }
      await startDecisionAction(answers);
    });
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-14">
      <div className="space-y-10">
        <Section step={1} title="When could you go?">
          <ChoiceGroup legend="How settled are your dates?" columns={2}>
            {(
              [
                ['month', 'Some time in a month'],
                ['season', 'Some time in a season'],
                ['exact', 'These exact dates'],
                ['undecided', 'Not decided at all'],
              ] as const
            ).map(([value, label]) => (
              <Choice
                key={value}
                name="decideDateMode"
                value={value}
                checked={dateMode === value}
                onChange={() => setDateMode(value)}
                label={label}
              />
            ))}
          </ChoiceGroup>

          {dateMode === 'month' ? (
            <div className="mt-5">
              <FieldLabel htmlFor="decideMonth">Which month?</FieldLabel>
              <select
                id="decideMonth"
                value={month}
                onChange={(event) => setMonth(Number(event.target.value))}
                className={inputClass}
              >
                {MONTHS.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {dateMode === 'season' ? (
            <ChoiceGroup legend="Which season?" columns={4} className="mt-5">
              {(['spring', 'summer', 'autumn', 'winter'] as const).map((value) => (
                <Choice
                  key={value}
                  name="decideSeason"
                  value={value}
                  checked={season === value}
                  onChange={() => setSeason(value)}
                  label={value[0]!.toUpperCase() + value.slice(1)}
                />
              ))}
            </ChoiceGroup>
          ) : null}

          {dateMode === 'exact' ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="decideStart">Arrive</FieldLabel>
                <input
                  id="decideStart"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <FieldLabel htmlFor="decideEnd">Leave</FieldLabel>
                <input
                  id="decideEnd"
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  className={inputClass}
                />
              </div>
            </div>
          ) : null}

          <div className="mt-6">
            <FieldLabel htmlFor="decideNights">How many nights?</FieldLabel>
            <input
              id="decideNights"
              type="number"
              min={1}
              max={30}
              value={nights}
              placeholder="Leave blank and we will suggest one"
              onChange={(event) =>
                setNights(event.target.value === '' ? '' : Number(event.target.value))
              }
              className={inputClass}
            />
            <p className="mt-2 text-xs leading-relaxed text-ink-faint">
              This does more work than anything else here: it decides how much ground a place has to
              cover to be worth the trip.
            </p>
          </div>
        </Section>

        <Section step={2} title="What are you going for?">
          <ChoiceGroup
            legend="Pick as many as apply"
            hint="This is the only question we insist on. Without it we would be ranking places against nobody."
            columns={2}
          >
            {TRIP_THEMES.map((theme) => (
              <Choice
                key={theme}
                name={`decideTheme-${theme}`}
                type="checkbox"
                value={theme}
                checked={themes.includes(theme)}
                onChange={() =>
                  setThemes(
                    themes.includes(theme)
                      ? themes.filter((entry) => entry !== theme)
                      : [...themes, theme],
                  )
                }
                label={TRIP_THEME_LABELS[theme]}
              />
            ))}
          </ChoiceGroup>
        </Section>

        <Section step={3} title="How much moving around?">
          <ChoiceGroup legend="How often would you change where you sleep?" columns={2}>
            {TRIP_SHAPES.map((value) => (
              <Choice
                key={value}
                name="decideShape"
                value={value}
                checked={shape === value}
                onChange={() => setShape(value)}
                label={TRIP_SHAPE_LABELS[value]}
              />
            ))}
          </ChoiceGroup>

          <ChoiceGroup legend="How would you get around?" columns={2} className="mt-6">
            {TRANSPORT_INTENTS.map((value) => (
              <Choice
                key={value}
                name="decideTransport"
                value={value}
                checked={transport === value}
                onChange={() => setTransport(value)}
                label={TRANSPORT_INTENT_LABELS[value]}
              />
            ))}
          </ChoiceGroup>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Saying nothing means we assume no car, which is the recoverable error — a place we
            ruled out for being spread thin comes back the moment you say you will drive.
          </p>

          <button
            type="button"
            onClick={() => setShowMore((current) => !current)}
            className="mt-6 text-sm text-ink-muted underline underline-offset-4 hover:text-pine"
            aria-expanded={showMore}
          >
            {showMore ? 'Fewer questions' : 'A few more that change the answer'}
          </button>

          {showMore ? (
            <div className="mt-6 space-y-6 border-t border-rule pt-6">
              <ChoiceGroup legend="Pace" columns={3}>
                {(
                  [
                    ['slow', 'Slow'],
                    ['balanced', 'Balanced'],
                    ['packed', 'Packed'],
                  ] as const
                ).map(([value, label]) => (
                  <Choice
                    key={value}
                    name="decidePace"
                    value={value}
                    checked={pace === value}
                    onChange={() => setPace(value)}
                    label={label}
                  />
                ))}
              </ChoiceGroup>

              <ChoiceGroup legend="How hard should the outdoor days be?" columns={3}>
                {(
                  [
                    ['gentle', 'Gentle'],
                    ['moderate', 'Moderate'],
                    ['strenuous', 'Strenuous'],
                  ] as const
                ).map(([value, label]) => (
                  <Choice
                    key={value}
                    name="decideIntensity"
                    value={value}
                    checked={intensity === value}
                    onChange={() => setIntensity(value)}
                    label={label}
                  />
                ))}
              </ChoiceGroup>

              <ChoiceGroup legend="Budget" columns={3}>
                {BUDGET_BANDS.map((band) => (
                  <Choice
                    key={band}
                    name="decideBudget"
                    value={band}
                    checked={budget === band}
                    onChange={() => setBudget(band)}
                    label={BUDGET_BAND_LABELS[band]}
                  />
                ))}
              </ChoiceGroup>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <FieldLabel htmlFor="decideAdults">Adults</FieldLabel>
                  <input
                    id="decideAdults"
                    type="number"
                    min={1}
                    max={12}
                    value={adults}
                    onChange={(event) => setAdults(Number(event.target.value))}
                    className={inputClass}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="decideChildren">Children</FieldLabel>
                  <input
                    id="decideChildren"
                    type="number"
                    min={0}
                    max={12}
                    value={children}
                    onChange={(event) => setChildren(Number(event.target.value))}
                    className={inputClass}
                  />
                </div>
              </div>

              <div>
                <FieldLabel htmlFor="decideAvoid">Anywhere or anything you would rather not?</FieldLabel>
                <textarea
                  id="decideAvoid"
                  rows={2}
                  maxLength={600}
                  value={avoid}
                  onChange={(event) => setAvoid(event.target.value)}
                  className={cx(inputClass, 'resize-y')}
                  placeholder="Naming a place exactly will take it off the list. We never guess at a near-miss."
                />
              </div>
            </div>
          ) : null}
        </Section>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-7">
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={pending || !ready || !props.indexReady}
            onClick={submit}
          >
            {pending
              ? 'Working through it…'
              : props.sessionId
                ? 'Save and rank again'
                : 'Show me where to go'}
          </button>
          <span className="text-sm text-ink-faint">
            {ready ? 'Free, and a few seconds.' : 'Pick at least one thing you are going for.'}
          </span>
        </div>
      </div>

      <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="How this is decided">
        <Panel className="p-5">
          <p className="eyebrow">How we decide</p>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-ink-muted">
            <li>
              <span className="text-ink">Climate records, not a forecast.</span> Twenty years of what
              each month has actually done.
            </li>
            <li>
              <span className="text-ink">How much ground it covers.</span> Whether your nights fit
              the place, rather than the other way round.
            </li>
            <li>
              <span className="text-ink">What is actually there.</span> Counted from map data, per
              area, so a country is not judged by its capital.
            </li>
            <li>
              <span className="text-ink">What we could not see.</span> Named on every result, rather
              than quietly scored as zero.
            </li>
          </ul>
          <p className="mt-5 border-t border-rule pt-4 text-xs leading-relaxed text-ink-faint">
            No model chooses, orders or removes a destination. The ranking is arithmetic over
            sourced data, and you can open every number behind it.
            {props.climateEnabled ? '' : ' Climate records are switched off in this build.'}
          </p>
        </Panel>
      </aside>
    </div>
  );
}

const inputClass =
  'mt-2 w-full rounded-lg border border-rule bg-paper-raised px-3.5 py-2.5 text-ink placeholder:text-ink-faint';

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`decide-step-${step}`}>
      <div className="flex items-baseline gap-3">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-paper"
        >
          {step}
        </span>
        <h2 id={`decide-step-${step}`} className="font-display text-2xl text-ink">
          {title}
        </h2>
      </div>
      <div className="mt-5 pl-0 sm:pl-9">{children}</div>
    </section>
  );
}
