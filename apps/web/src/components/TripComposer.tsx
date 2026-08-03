'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  ARRIVAL_PRECISIONS,
  ARRIVAL_PRECISION_LABELS,
  BUDGET_BANDS,
  BUDGET_BAND_LABELS,
  DATE_MODES,
  DATE_MODE_LABELS,
  TRANSPORT_INTENTS,
  TRANSPORT_INTENT_LABELS,
  TRAVELER_NEEDS,
  TRAVELER_NEED_LABELS,
  TRIP_SHAPES,
  TRIP_SHAPE_LABELS,
  TRIP_THEMES,
  TRIP_THEME_LABELS,
  type TripComposerAnswers,
} from '@sidequest/core';
import { DestinationCombobox, type DestinationSuggestionView } from './DestinationCombobox';
import { Choice, ChoiceGroup, ErrorNote, FieldLabel, Panel, buttonClass, cx } from './ui';
import { createTripFromComposer, type ComposerResult } from '@/app/trips/new/actions';

/**
 * THE TRIP COMPOSER.
 *
 * What it replaces: seven fields on one screen — destination, two dates, two
 * times, two head counts — followed by a compilation that knew none of the four
 * things which actually decide what is worth researching, and a questionnaire
 * that ran afterwards.
 *
 * Three rules shape everything below.
 *
 * **Ask what changes the plan, in the order it changes it.** The destination
 * decides the region; the dates decide seasonal access; the shape decides how
 * many bases; the themes decide what a candidate is worth. Everything else is a
 * follow-up and is disclosed rather than displayed.
 *
 * **Never demand precision the traveller does not have.** Arrival time is a
 * band, not a clock. Dates can be a month, a season, or nothing yet. Duration
 * can be a question rather than an answer.
 *
 * **Progressive, not paginated.** Sections open as the ones above them are
 * answered, so the first screen is one question rather than thirty fields — but
 * everything answered stays visible and editable, because a wizard that hides
 * what you already said is a wizard you cannot check.
 */

type Draft = Partial<TripComposerAnswers> & {
  destinationText?: string;
  destinationEntryId?: string | null;
};

export function TripComposer({ defaults }: { defaults: { startDate: string; endDate: string } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [draft, setDraft] = useState<Draft>({
    destinationText: '',
    destinationEntryId: null,
    adults: 2,
    children: 0,
    travelerNeeds: [],
    themes: [],
  });
  const [dateMode, setDateMode] = useState<TripComposerAnswers['dates']['mode']>('exact');
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [flexDays, setFlexDays] = useState(3);
  const [month, setMonth] = useState(new Date().getUTCMonth() + 2);
  const [season, setSeason] = useState<'spring' | 'summer' | 'autumn' | 'winter'>('summer');
  const [wantsDateHelp, setWantsDateHelp] = useState(false);
  const [wantsLengthHelp, setWantsLengthHelp] = useState(false);
  const [nights, setNights] = useState<number | ''>('');
  const [arrival, setArrival] = useState<(typeof ARRIVAL_PRECISIONS)[number]>('afternoon');
  const [departure, setDeparture] = useState<(typeof ARRIVAL_PRECISIONS)[number]>('morning');
  const [showMore, setShowMore] = useState(false);

  function patch(next: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...next }));
  }

  const hasDestination = Boolean(draft.destinationText && draft.destinationText.trim().length >= 2);
  const datesSettled =
    dateMode === 'undecided' ||
    dateMode === 'season' ||
    dateMode === 'month' ||
    Boolean(startDate && endDate);

  function submit() {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result: ComposerResult = await createTripFromComposer({
        destinationText: draft.destinationText ?? '',
        destinationEntryId: draft.destinationEntryId ?? null,
        dateMode,
        startDate,
        endDate,
        flexDays,
        month,
        season,
        wantsDateRecommendation: wantsDateHelp,
        wantsLengthRecommendation: wantsLengthHelp,
        nights: nights === '' ? null : nights,
        arrivalPrecision: arrival,
        departurePrecision: departure,
        adults: draft.adults ?? 2,
        children: draft.children ?? 0,
        travelerNeeds: draft.travelerNeeds ?? [],
        shape: draft.shape ?? null,
        pace: draft.pace ?? null,
        transport: draft.transport ?? null,
        budget: draft.budget ?? null,
        themes: draft.themes ?? [],
        crowdTolerance: draft.crowdTolerance ?? null,
        outdoorIntensity: draft.outdoorIntensity ?? null,
        foodImportance: draft.foodImportance ?? null,
        freeTime: draft.freeTime ?? null,
        mustDo: draft.mustDo ?? '',
        avoid: draft.avoid ?? '',
        origin: draft.origin ?? '',
      });

      if (!result.ok) {
        setError(result.error ?? null);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      router.push(result.href);
    });
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-14">
      <div className="space-y-10">
        {/* ---- 1. Where ------------------------------------------------- */}
        <Section step={1} title="Where are you going?">
          <DestinationCombobox
            name="destination"
            label="Destination"
            hint="A city, a region, a national park or a whole country — we will work out how much of it a trip can hold."
            autoFocus
            onSelect={(suggestion: DestinationSuggestionView | null) =>
              patch({
                destinationEntryId: suggestion?.id ?? null,
                ...(suggestion ? { destinationText: suggestion.displayName } : {}),
              })
            }
            onTextChange={(text) => patch({ destinationText: text })}
          />
          {fieldErrors.destination ? <ErrorNote>{fieldErrors.destination}</ErrorNote> : null}
        </Section>

        {/* ---- 2. When -------------------------------------------------- */}
        {hasDestination ? (
          <Section step={2} title="When?">
            <ChoiceGroup legend="How settled are your dates?" columns={2}>
              {DATE_MODES.map((mode) => (
                <Choice
                  key={mode}
                  name="dateMode"
                  value={mode}
                  checked={dateMode === mode}
                  onChange={() => setDateMode(mode)}
                  label={DATE_MODE_LABELS[mode]}
                />
              ))}
            </ChoiceGroup>

            {dateMode === 'exact' || dateMode === 'flexible' ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div>
                  <FieldLabel htmlFor="startDate">Arrive</FieldLabel>
                  <input
                    id="startDate"
                    type="date"
                    value={startDate}
                    onChange={(event) => setStartDate(event.target.value)}
                    className={inputClass}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="endDate">Leave</FieldLabel>
                  <input
                    id="endDate"
                    type="date"
                    value={endDate}
                    onChange={(event) => setEndDate(event.target.value)}
                    className={inputClass}
                  />
                </div>
                {dateMode === 'flexible' ? (
                  <div className="sm:col-span-2">
                    <ChoiceGroup legend="How far can they move?" columns={3}>
                      {[1, 3, 7].map((days) => (
                        <Choice
                          key={days}
                          name="flex"
                          value={String(days)}
                          checked={flexDays === days}
                          onChange={() => setFlexDays(days)}
                          label={`± ${days} day${days === 1 ? '' : 's'}`}
                        />
                      ))}
                    </ChoiceGroup>
                  </div>
                ) : null}
              </div>
            ) : null}

            {dateMode === 'month' ? (
              <div className="mt-5">
                <FieldLabel htmlFor="month">Which month?</FieldLabel>
                <select
                  id="month"
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
                    name="season"
                    value={value}
                    checked={season === value}
                    onChange={() => setSeason(value)}
                    label={value[0]!.toUpperCase() + value.slice(1)}
                  />
                ))}
              </ChoiceGroup>
            ) : null}

            <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-dashed border-rule p-3.5">
              <input
                type="checkbox"
                checked={wantsDateHelp}
                onChange={(event) => setWantsDateHelp(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-pine"
              />
              <span>
                <span className="block text-sm font-medium text-ink">
                  Tell me when this place is at its best
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  We will compare the months on climate records and daylight, and say what each one
                  costs you. Not a forecast — records from past years.
                </span>
              </span>
            </label>

            <ChoiceGroup legend="How long?" columns={2} className="mt-6">
              <label className="sm:col-span-1">
                <span className="sr-only">Nights</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={nights}
                  placeholder="Nights"
                  onChange={(event) =>
                    setNights(event.target.value === '' ? '' : Number(event.target.value))
                  }
                  className={inputClass}
                  disabled={dateMode === 'exact' || dateMode === 'flexible'}
                />
              </label>
              <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-rule px-3.5">
                <input
                  type="checkbox"
                  checked={wantsLengthHelp}
                  onChange={(event) => setWantsLengthHelp(event.target.checked)}
                  className="h-4 w-4 accent-pine"
                />
                <span className="text-sm text-ink">Recommend a trip length</span>
              </label>
            </ChoiceGroup>
            {dateMode === 'exact' || dateMode === 'flexible' ? (
              <p className="mt-2 text-xs text-ink-faint">
                Taken from your dates. Switch to a month or a season to set it directly.
              </p>
            ) : null}
          </Section>
        ) : null}

        {/* ---- 3. Shape ------------------------------------------------- */}
        {hasDestination && datesSettled ? (
          <Section step={3} title="What kind of trip?">
            <ChoiceGroup legend="How much do you want to move?" columns={2}>
              {TRIP_SHAPES.map((shape) => (
                <Choice
                  key={shape}
                  name="shape"
                  value={shape}
                  checked={draft.shape === shape}
                  onChange={() => patch({ shape })}
                  label={TRIP_SHAPE_LABELS[shape]}
                />
              ))}
            </ChoiceGroup>

            <ChoiceGroup legend="How are you getting around?" columns={2} className="mt-6">
              {TRANSPORT_INTENTS.map((transport) => (
                <Choice
                  key={transport}
                  name="transport"
                  value={transport}
                  checked={draft.transport === transport}
                  onChange={() => patch({ transport })}
                  label={TRANSPORT_INTENT_LABELS[transport]}
                />
              ))}
            </ChoiceGroup>

            <ChoiceGroup
              legend="What are you actually here for?"
              hint="Pick as many as apply. This decides what counts as worth researching, so it changes the whole board."
              columns={2}
              className="mt-6"
            >
              {TRIP_THEMES.map((theme) => (
                <Choice
                  key={theme}
                  name={`theme-${theme}`}
                  type="checkbox"
                  value={theme}
                  checked={(draft.themes ?? []).includes(theme)}
                  onChange={() =>
                    patch({
                      themes: (draft.themes ?? []).includes(theme)
                        ? (draft.themes ?? []).filter((entry) => entry !== theme)
                        : [...(draft.themes ?? []), theme],
                    })
                  }
                  label={TRIP_THEME_LABELS[theme]}
                />
              ))}
            </ChoiceGroup>
            {fieldErrors.themes ? <ErrorNote>{fieldErrors.themes}</ErrorNote> : null}

            <ChoiceGroup legend="Pace" columns={3} className="mt-6">
              {(
                [
                  ['slow', 'Slow — room to sit still'],
                  ['balanced', 'Balanced'],
                  ['packed', 'Packed — fit it all in'],
                ] as const
              ).map(([value, label]) => (
                <Choice
                  key={value}
                  name="pace"
                  value={value}
                  checked={draft.pace === value}
                  onChange={() => patch({ pace: value })}
                  label={label}
                />
              ))}
            </ChoiceGroup>
          </Section>
        ) : null}

        {/* ---- 4. Who and the rest -------------------------------------- */}
        {hasDestination && datesSettled ? (
          <Section step={4} title="Who is going?">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="adults">Adults</FieldLabel>
                <input
                  id="adults"
                  type="number"
                  min={1}
                  max={12}
                  value={draft.adults ?? 2}
                  onChange={(event) => patch({ adults: Number(event.target.value) })}
                  className={inputClass}
                />
              </div>
              <div>
                <FieldLabel htmlFor="children">Children</FieldLabel>
                <input
                  id="children"
                  type="number"
                  min={0}
                  max={12}
                  value={draft.children ?? 0}
                  onChange={(event) => patch({ children: Number(event.target.value) })}
                  className={inputClass}
                />
              </div>
            </div>

            <ChoiceGroup
              legend="Anything in the group that changes the plan?"
              hint="These do real work: a mobility need caps how hard a stop can be, and children thin out the day."
              columns={2}
              className="mt-6"
            >
              {TRAVELER_NEEDS.map((need) => (
                <Choice
                  key={need}
                  name={`need-${need}`}
                  type="checkbox"
                  value={need}
                  checked={(draft.travelerNeeds ?? []).includes(need)}
                  onChange={() =>
                    patch({
                      travelerNeeds: (draft.travelerNeeds ?? []).includes(need)
                        ? (draft.travelerNeeds ?? []).filter((entry) => entry !== need)
                        : [...(draft.travelerNeeds ?? []), need],
                    })
                  }
                  label={TRAVELER_NEED_LABELS[need]}
                />
              ))}
            </ChoiceGroup>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="arrival">When do you get in?</FieldLabel>
                <select
                  id="arrival"
                  value={arrival}
                  onChange={(event) =>
                    setArrival(event.target.value as (typeof ARRIVAL_PRECISIONS)[number])
                  }
                  className={inputClass}
                >
                  {ARRIVAL_PRECISIONS.map((precision) => (
                    <option key={precision} value={precision}>
                      {ARRIVAL_PRECISION_LABELS[precision]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="departure">And when do you head out?</FieldLabel>
                <select
                  id="departure"
                  value={departure}
                  onChange={(event) =>
                    setDeparture(event.target.value as (typeof ARRIVAL_PRECISIONS)[number])
                  }
                  className={inputClass}
                >
                  {ARRIVAL_PRECISIONS.map((precision) => (
                    <option key={precision} value={precision}>
                      {ARRIVAL_PRECISION_LABELS[precision]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-ink-faint">
              A band is enough. We plan a late arrival as a quiet first evening rather than
              inventing a flight time and then building a day around it.
            </p>

            <button
              type="button"
              onClick={() => setShowMore((current) => !current)}
              className="mt-6 text-sm text-ink-muted underline underline-offset-4 hover:text-pine"
              aria-expanded={showMore}
            >
              {showMore ? 'Fewer questions' : 'A few more that change the plan'}
            </button>

            {showMore ? (
              <div className="mt-6 space-y-6 border-t border-rule pt-6">
                <ChoiceGroup legend="Budget" columns={3}>
                  {BUDGET_BANDS.map((band) => (
                    <Choice
                      key={band}
                      name="budget"
                      value={band}
                      checked={draft.budget === band}
                      onChange={() => patch({ budget: band })}
                      label={BUDGET_BAND_LABELS[band]}
                    />
                  ))}
                </ChoiceGroup>

                <ChoiceGroup legend="Crowds" columns={3}>
                  {(
                    [
                      ['avoid', 'Ruin a place for me'],
                      ['tolerate', 'Worth it sometimes'],
                      ['unbothered', 'Do not mind them'],
                    ] as const
                  ).map(([value, label]) => (
                    <Choice
                      key={value}
                      name="crowd"
                      value={value}
                      checked={draft.crowdTolerance === value}
                      onChange={() => patch({ crowdTolerance: value })}
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
                      name="intensity"
                      value={value}
                      checked={draft.outdoorIntensity === value}
                      onChange={() => patch({ outdoorIntensity: value })}
                      label={label}
                    />
                  ))}
                </ChoiceGroup>

                <div>
                  <FieldLabel htmlFor="mustDo">Anything you would regret missing?</FieldLabel>
                  <textarea
                    id="mustDo"
                    rows={2}
                    maxLength={600}
                    value={draft.mustDo ?? ''}
                    onChange={(event) => patch({ mustDo: event.target.value })}
                    className={cx(inputClass, 'resize-y')}
                    placeholder="Free text. We will show you what we made of it before it changes anything."
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="avoid">Anything you would rather not do?</FieldLabel>
                  <textarea
                    id="avoid"
                    rows={2}
                    maxLength={600}
                    value={draft.avoid ?? ''}
                    onChange={(event) => patch({ avoid: event.target.value })}
                    className={cx(inputClass, 'resize-y')}
                  />
                </div>
              </div>
            ) : null}
          </Section>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="flex flex-wrap items-center gap-4 border-t border-rule pt-7">
          <button
            type="button"
            className={buttonClass('primary')}
            disabled={pending || !hasDestination || !datesSettled}
            onClick={submit}
          >
            {pending ? 'Reading the region…' : 'See what we make of it'}
          </button>
          <span className="text-sm text-ink-faint">
            Nothing is bought yet. The next screen is free and takes a few seconds.
          </span>
        </div>
      </div>

      {/* ---- The live intent rail -------------------------------------- */}
      <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="What we have so far">
        <Panel className="p-5">
          <p className="eyebrow">So far</p>
          <dl className="mt-4 space-y-3.5 text-sm">
            <Fact label="Destination" value={draft.destinationText || '—'} />
            <Fact
              label="Dates"
              value={
                dateMode === 'undecided'
                  ? 'Not decided'
                  : dateMode === 'month'
                    ? MONTHS[month - 1] ?? '—'
                    : dateMode === 'season'
                      ? season[0]!.toUpperCase() + season.slice(1)
                      : startDate && endDate
                        ? `${startDate} → ${endDate}${dateMode === 'flexible' ? ` (± ${flexDays}d)` : ''}`
                        : '—'
              }
            />
            <Fact
              label="Length"
              value={
                nights !== ''
                  ? `${nights} nights`
                  : startDate && endDate
                    ? `${nightsBetween(startDate, endDate)} nights`
                    : wantsLengthHelp
                      ? 'We will suggest one'
                      : '—'
              }
            />
            <Fact label="Shape" value={draft.shape ? TRIP_SHAPE_LABELS[draft.shape] : '—'} />
            <Fact
              label="Getting around"
              value={draft.transport ? TRANSPORT_INTENT_LABELS[draft.transport] : '—'}
            />
            <Fact
              label="Here for"
              value={
                (draft.themes ?? []).length > 0
                  ? (draft.themes ?? []).map((theme) => TRIP_THEME_LABELS[theme]).join(', ')
                  : '—'
              }
            />
            <Fact
              label="Travellers"
              value={`${draft.adults ?? 2} adult${(draft.adults ?? 2) === 1 ? '' : 's'}${(draft.children ?? 0) > 0 ? `, ${draft.children} child${draft.children === 1 ? '' : 'ren'}` : ''}`}
            />
          </dl>
          <p className="mt-5 border-t border-rule pt-4 text-xs leading-relaxed text-ink-faint">
            Every answer changes what we look for. None of them is stored anywhere until you press
            the button.
          </p>
        </Panel>
      </aside>
    </div>
  );
}

const inputClass =
  'mt-2 w-full rounded-lg border border-rule bg-paper-raised px-3.5 py-2.5 text-ink placeholder:text-ink-faint';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function nightsBetween(start: string, end: string): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

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
    <section aria-labelledby={`composer-step-${step}`}>
      <div className="flex items-baseline gap-3">
        <span
          aria-hidden="true"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink text-[11px] font-medium text-paper"
        >
          {step}
        </span>
        <h2 id={`composer-step-${step}`} className="font-display text-2xl text-ink">
          {title}
        </h2>
      </div>
      <div className="mt-5 pl-0 sm:pl-9">{children}</div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-ink">{value}</dd>
    </div>
  );
}
