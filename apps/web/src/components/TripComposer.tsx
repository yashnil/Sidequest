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
import {
  Choice,
  ChoiceGroup,
  ErrorNote,
  FieldLabel,
  FOCUS_RING,
  buttonClass,
  cx,
} from './ui';
import { formatDayRange } from '@/lib/format/dates';
import { Glyph, type GlyphId } from './interview/glyphs';
import {
  createTripFromComposer,
  updateTripFromComposer,
  type ComposerResult,
} from '@/app/(product)/trips/new/actions';

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

export function TripComposer({
  defaults,
  editing,
  intent = 'new',
}: {
  defaults: { startDate: string; endDate: string };
  /**
   * The trip being edited, and everything it already said.
   *
   * Absent means this is a new trip and the composer behaves exactly as before.
   * Present is the whole of the fix for the product's worst dead end: every
   * "Change the trip" control used to link here *without* it, so correcting one
   * answer meant a blank form and the loss of the destination, the dates, the
   * party, the must-dos, the questionnaire and any research already paid for.
   */
  editing?: { tripId: string; answers: TripComposerAnswers };
  /**
   * Which door the traveller came through.
   *
   * `has_plan` is the homepage's third intent — somebody who is not starting
   * from nothing. It changes exactly one thing: the list of places they already
   * have is asked for as the second question rather than buried at the bottom
   * of an optional disclosure. It is the same field, going to the same place,
   * because the must-do pipeline is what genuinely acts on it — the alternative
   * would be a second text box that reads better and does less.
   */
  intent?: 'new' | 'has_plan';
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const prior = editing?.answers;
  const [draft, setDraft] = useState<Draft>({
    destinationText: prior?.destinationQuery ?? prior?.destination?.displayName ?? '',
    destinationEntryId: prior?.destination?.entryId ?? null,
    adults: prior?.adults ?? 2,
    children: prior?.children ?? 0,
    travelerNeeds: prior ? [...prior.travelerNeeds] : [],
    themes: prior ? [...prior.themes] : [],
    ...(prior?.shape ? { shape: prior.shape } : {}),
    ...(prior?.pace ? { pace: prior.pace } : {}),
    ...(prior?.transport ? { transport: prior.transport } : {}),
    ...(prior?.budget ? { budget: prior.budget } : {}),
    ...(prior?.crowdTolerance ? { crowdTolerance: prior.crowdTolerance } : {}),
    ...(prior?.outdoorIntensity ? { outdoorIntensity: prior.outdoorIntensity } : {}),
    ...(prior?.mustDo ? { mustDo: prior.mustDo } : {}),
    ...(prior?.avoid ? { avoid: prior.avoid } : {}),
    ...(prior?.origin ? { origin: prior.origin } : {}),
  });
  const [dateMode, setDateMode] = useState<TripComposerAnswers['dates']['mode']>(
    prior?.dates.mode ?? 'exact',
  );
  const [startDate, setStartDate] = useState(prior?.dates.startDate ?? defaults.startDate);
  const [endDate, setEndDate] = useState(prior?.dates.endDate ?? defaults.endDate);
  const [flexDays, setFlexDays] = useState(prior?.dates.flexDays ?? 3);
  /**
   * The default month, which used to be able to be thirteen.
   *
   * `getUTCMonth()` is zero-based, so `+ 2` means "the month after next" — and
   * in November and December that is 13 or 14, outside the 1–12 the schema
   * accepts and outside the array the label is read from. A traveller opening
   * the composer in December got a blank month and a validation failure nobody
   * rendered.
   */
  const [month, setMonth] = useState(prior?.dates.month ?? (new Date().getUTCMonth() % 12) + 1);
  const [season, setSeason] = useState<'spring' | 'summer' | 'autumn' | 'winter'>(
    prior?.dates.season ?? 'summer',
  );
  const [wantsDateHelp, setWantsDateHelp] = useState(prior?.dates.wantsRecommendation ?? false);
  const [wantsLengthHelp, setWantsLengthHelp] = useState(
    prior?.duration.wantsRecommendation ?? false,
  );
  const [nights, setNights] = useState<number | ''>(prior?.duration.nights ?? '');
  const [arrival, setArrival] = useState<(typeof ARRIVAL_PRECISIONS)[number]>(
    prior?.arrival?.precision ?? 'afternoon',
  );
  const [departure, setDeparture] = useState<(typeof ARRIVAL_PRECISIONS)[number]>(
    prior?.departure?.precision ?? 'morning',
  );
  const [showMore, setShowMore] = useState(Boolean(prior));

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
      const payload = {
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
      };
      /*
       * One payload, two destinations for it. Editing must not become a second
       * reading of the same form — see `readComposer`, which is shared by both
       * server actions for exactly this reason.
       */
      const result: ComposerResult = editing
        ? await updateTripFromComposer(editing.tripId, payload)
        : await createTripFromComposer(payload);

      if (!result.ok) {
        setError(result.error ?? null);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      router.push(result.href);
    });
  }

  const nightsSoFar =
    nights !== ''
      ? `${nights} nights`
      : startDate && endDate && (dateMode === 'exact' || dateMode === 'flexible')
        ? `${nightsBetween(startDate, endDate)} nights`
        : wantsLengthHelp
          ? 'We will suggest a length'
          : null;
  const datesSoFar =
    dateMode === 'undecided'
      ? 'Dates not decided'
      : dateMode === 'month'
        ? (MONTHS[month - 1] ?? '—')
        : dateMode === 'season'
          ? season[0]!.toUpperCase() + season.slice(1)
          : startDate && endDate
            ? /*
               * `2026-10-12 → 2026-10-18` was the database's format on the panel
               * a traveller checks their own answers against. One formatter,
               * shared with the homepage and the context bar.
               */
              `${formatDayRange(startDate, endDate)}${dateMode === 'flexible' ? ` (± ${flexDays} days)` : ''}`
            : '—';
  const travellersSoFar = `${draft.adults ?? 2} adult${(draft.adults ?? 2) === 1 ? '' : 's'}${(draft.children ?? 0) > 0 ? `, ${draft.children} child${draft.children === 1 ? '' : 'ren'}` : ''}`;
  const canSubmit = !pending && hasDestination && datesSettled;

  return (
    <div className="pb-24 lg:pb-0">
      {/* ---- 1. Where: the one big question ------------------------------ */}
      <section className="enter" aria-labelledby="composer-where">
        <p className="label text-accent">{intent === 'has_plan' ? 'A plan you already have' : 'New trip'}</p>
        <h1 id="composer-where" className="display-hero mt-3 text-ink">
          {intent === 'has_plan' ? 'Where is the plan taking you?' : 'Where do you want to go?'}
        </h1>
        <div className="mt-8 max-w-3xl">
          <DestinationCombobox
            name="destination"
            label="Destination"
            size="hero"
            hint="A city, a region, a national park or a whole country — we will work out how much of it a trip can hold."
            autoFocus
            /*
             * Seeded when editing, so the screen opens on what the traveller
             * actually said rather than on an empty box. Without this the edit
             * route reproduces the defect it exists to fix — a blank form.
             */
            {...(prior?.destinationQuery ? { defaultValue: prior.destinationQuery } : {})}
            onSelect={(suggestion: DestinationSuggestionView | null) =>
              patch({
                destinationEntryId: suggestion?.id ?? null,
                ...(suggestion ? { destinationText: suggestion.displayName } : {}),
              })
            }
            onTextChange={(text) => patch({ destinationText: text })}
          />
          {fieldErrors.destination ? <ErrorNote>{fieldErrors.destination}</ErrorNote> : null}
        </div>

        {/*
          THE PLACES A PLAN ALREADY HAS, ASKED FOR WHERE THEY MATTER.

          Same field, same pipeline, promoted. For somebody arriving from "I
          already have a plan" this is the whole reason they came.
        */}
        {intent === 'has_plan' && hasDestination ? (
          <div className="enter mt-8 max-w-3xl">
            <FieldLabel htmlFor="mustDo">Which places does your plan already have?</FieldLabel>
            <textarea
              id="mustDo"
              rows={4}
              maxLength={600}
              value={draft.mustDo ?? ''}
              onChange={(event) => patch({ mustDo: event.target.value })}
              className={cx(inputClass, 'resize-y')}
              placeholder="One per line, or however you have them written down."
            />
            <p className="mt-2 text-xs leading-relaxed text-ink-muted">
              We look each one up on the map and show you what we made of it before it changes
              anything. Anything we cannot find, cannot reach, or cannot fit into your dates is
              named with the reason rather than dropped quietly.
            </p>
          </div>
        ) : null}
        {!hasDestination ? (
          <p className="mt-6 max-w-xl text-sm leading-relaxed text-ink-muted">
            Start typing. The rest of the questions open as you go, and each one changes what we
            go and look for.
          </p>
        ) : null}
      </section>

      <div className={cx('grid gap-10 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-14', hasDestination ? 'mt-12' : 'mt-8')}>
        <div className="space-y-12">
          {/* ---- 2. When ------------------------------------------------ */}
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
                    <input id="startDate" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <FieldLabel htmlFor="endDate">Leave</FieldLabel>
                    <input id="endDate" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className={inputClass} />
                  </div>
                  {dateMode === 'flexible' ? (
                    <div className="sm:col-span-2">
                      <ChoiceGroup legend="How far can they move?" columns={3}>
                        {[1, 3, 7].map((days) => (
                          <Choice key={days} name="flex" value={String(days)} checked={flexDays === days} onChange={() => setFlexDays(days)} label={`± ${days} day${days === 1 ? '' : 's'}`} />
                        ))}
                      </ChoiceGroup>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {dateMode === 'month' ? (
                <div className="mt-5">
                  <FieldLabel htmlFor="month">Which month?</FieldLabel>
                  <select id="month" value={month} onChange={(event) => setMonth(Number(event.target.value))} className={inputClass}>
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
                    <Choice key={value} name="season" value={value} checked={season === value} onChange={() => setSeason(value)} label={value[0]!.toUpperCase() + value.slice(1)} />
                  ))}
                </ChoiceGroup>
              ) : null}

              <label className={cx('mt-5 flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border border-dashed border-rule p-3.5', FOCUS_RING)}>
                <input type="checkbox" checked={wantsDateHelp} onChange={(event) => setWantsDateHelp(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
                <span>
                  <span className="block text-sm font-medium text-ink">Tell me when this place is at its best</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                    We will compare the months on climate records and daylight, and say what each one costs you. Not a forecast — records from past years.
                  </span>
                </span>
              </label>

              <ChoiceGroup legend="How long?" columns={2} className="mt-6">
                <label className="sm:col-span-1">
                  <span className="sr-only">Nights</span>
                  <input
                    type="number"
                    // `type="number"` alone still opens the text keypad on
                    // several Android browsers; `inputMode` is what decides it.
                    inputMode="numeric"
                    min={1}
                    max={30}
                    value={nights}
                    placeholder="Nights"
                    onChange={(event) => setNights(event.target.value === '' ? '' : Number(event.target.value))}
                    className={cx(inputClass, 'mt-0')}
                    disabled={dateMode === 'exact' || dateMode === 'flexible'}
                  />
                </label>
                <label className={cx('flex cursor-pointer items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-rule px-3.5 py-2.5', FOCUS_RING)}>
                  <input type="checkbox" checked={wantsLengthHelp} onChange={(event) => setWantsLengthHelp(event.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
                  <span className="text-sm text-ink">Recommend a trip length</span>
                </label>
              </ChoiceGroup>
              {dateMode === 'exact' || dateMode === 'flexible' ? (
                <p className="mt-2 text-xs text-ink-faint">Taken from your dates. Switch to a month or a season to set it directly.</p>
              ) : null}
            </Section>
          ) : null}

          {/* ---- 3. Shape ----------------------------------------------- */}
          {hasDestination && datesSettled ? (
            <Section step={3} title="What kind of trip?">
              <ChoiceGroup legend="How much do you want to move?" columns={2}>
                {TRIP_SHAPES.map((shape) => (
                  <Choice key={shape} name="shape" value={shape} checked={draft.shape === shape} onChange={() => patch({ shape })} label={TRIP_SHAPE_LABELS[shape]} />
                ))}
              </ChoiceGroup>

              <ChoiceGroup legend="How are you getting around?" columns={2} className="mt-6">
                {TRANSPORT_INTENTS.map((transport) => (
                  <Choice key={transport} name="transport" value={transport} checked={draft.transport === transport} onChange={() => patch({ transport })} label={TRANSPORT_INTENT_LABELS[transport]} />
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
                        themes: (draft.themes ?? []).includes(theme) ? (draft.themes ?? []).filter((entry) => entry !== theme) : [...(draft.themes ?? []), theme],
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
                  <Choice key={value} name="pace" value={value} checked={draft.pace === value} onChange={() => patch({ pace: value })} label={label} />
                ))}
              </ChoiceGroup>
            </Section>
          ) : null}

          {/* ---- 4. Who and the rest ------------------------------------ */}
          {hasDestination && datesSettled ? (
            <Section step={4} title="Who is going?">
              <div className="grid gap-4 sm:grid-cols-2">
                <CountField id="adults" label="Adults" singular="adult" min={1} max={12} value={draft.adults ?? 2} onChange={(adults) => patch({ adults })} />
                <CountField id="children" label="Children" singular="child" min={0} max={12} value={draft.children ?? 0} onChange={(children) => patch({ children })} />
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
                        travelerNeeds: (draft.travelerNeeds ?? []).includes(need) ? (draft.travelerNeeds ?? []).filter((entry) => entry !== need) : [...(draft.travelerNeeds ?? []), need],
                      })
                    }
                    label={TRAVELER_NEED_LABELS[need]}
                  />
                ))}
              </ChoiceGroup>

              <div className="mt-6 grid gap-4 sm:grid-cols-2">
                <div>
                  <FieldLabel htmlFor="arrival">When do you get in?</FieldLabel>
                  <select id="arrival" value={arrival} onChange={(event) => setArrival(event.target.value as (typeof ARRIVAL_PRECISIONS)[number])} className={inputClass}>
                    {ARRIVAL_PRECISIONS.map((precision) => (
                      <option key={precision} value={precision}>
                        {ARRIVAL_PRECISION_LABELS[precision]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <FieldLabel htmlFor="departure">And when do you head out?</FieldLabel>
                  <select id="departure" value={departure} onChange={(event) => setDeparture(event.target.value as (typeof ARRIVAL_PRECISIONS)[number])} className={inputClass}>
                    {ARRIVAL_PRECISIONS.map((precision) => (
                      <option key={precision} value={precision}>
                        {ARRIVAL_PRECISION_LABELS[precision]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                A band is enough. We plan a late arrival as a quiet first evening rather than inventing a flight time and then building a day around it.
              </p>

              <button
                type="button"
                onClick={() => setShowMore((current) => !current)}
                className={cx('mt-6 min-h-11 text-sm text-accent underline underline-offset-4 hover:text-accent-strong', FOCUS_RING)}
                aria-expanded={showMore}
              >
                {showMore ? 'Fewer questions' : 'A few more that change the plan'}
              </button>

              {showMore ? (
                <div className="slide-down mt-6 space-y-6 border-t border-rule pt-6">
                  <ChoiceGroup legend="Budget" columns={3}>
                    {BUDGET_BANDS.map((band) => (
                      <Choice key={band} name="budget" value={band} checked={draft.budget === band} onChange={() => patch({ budget: band })} label={BUDGET_BAND_LABELS[band]} />
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
                      <Choice key={value} name="crowd" value={value} checked={draft.crowdTolerance === value} onChange={() => patch({ crowdTolerance: value })} label={label} />
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
                      <Choice key={value} name="intensity" value={value} checked={draft.outdoorIntensity === value} onChange={() => patch({ outdoorIntensity: value })} label={label} />
                    ))}
                  </ChoiceGroup>

                  {/*
                    Asked once. Somebody who came through "I already have a plan"
                    answered this in the first section, and two boxes with the same
                    `id` writing to the same field is an invalid document.
                  */}
                  {intent === 'has_plan' ? null : (
                    <div>
                      <FieldLabel htmlFor="mustDo">Anything you would regret missing?</FieldLabel>
                      <textarea id="mustDo" rows={2} maxLength={600} value={draft.mustDo ?? ''} onChange={(event) => patch({ mustDo: event.target.value })} className={cx(inputClass, 'resize-y')} placeholder="Free text. We will show you what we made of it before it changes anything." />
                    </div>
                  )}
                  <div>
                    <FieldLabel htmlFor="avoid">Anything you would rather not do?</FieldLabel>
                    <textarea id="avoid" rows={2} maxLength={600} value={draft.avoid ?? ''} onChange={(event) => patch({ avoid: event.target.value })} className={cx(inputClass, 'resize-y')} />
                  </div>
                </div>
              ) : null}
            </Section>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          {hasDestination ? (
            <div className="hidden flex-wrap items-center gap-4 border-t border-rule pt-7 lg:flex">
              <button type="button" className={buttonClass('primary', 'lg')} disabled={!canSubmit} onClick={submit}>
                {pending ? 'Reading the region…' : 'See what we make of it'}
              </button>
              <span className="text-sm text-ink-faint">Nothing is bought yet. The next screen is free and takes a few seconds.</span>
            </div>
          ) : null}
        </div>

        {/* ---- The trip stub ------------------------------------------- */}
        <aside className="min-w-0 lg:sticky lg:top-[calc(var(--chrome-height)+1.5rem)] lg:self-start" aria-label="What we have so far">
          <TripStub
            destination={draft.destinationText?.trim() || null}
            dates={datesSoFar}
            nights={nightsSoFar}
            shape={draft.shape ? TRIP_SHAPE_LABELS[draft.shape] : null}
            shapeCode={draft.shape ?? null}
            transport={draft.transport ? TRANSPORT_INTENT_LABELS[draft.transport] : null}
            transportCode={draft.transport ?? null}
            themes={(draft.themes ?? []).map((theme) => TRIP_THEME_LABELS[theme])}
            travellers={travellersSoFar}
          />
        </aside>
      </div>

      {/* ---- Mobile: the one action, always reachable ------------------- */}
      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-rule bg-paper/95 px-5 py-3 backdrop-blur-sm lg:hidden">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3">
          <span className="min-w-0 truncate text-sm text-ink-muted">
            {hasDestination ? `${draft.destinationText?.trim()} · ${nightsSoFar ?? datesSoFar}` : 'Start with a destination'}
          </span>
          <button type="button" className={cx(buttonClass('primary'), 'shrink-0')} disabled={!canSubmit} onClick={submit}>
            {pending ? 'Reading…' : 'See what we make of it'}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputClass =
  'mt-2 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3.5 py-2.5 text-ink placeholder:text-ink-faint';

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

/**
 * A section of the composer: a numeral in the margin, a display heading, and
 * the controls. Sections enter as the ones above them are answered.
 */
function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={`composer-step-${step}`} className="enter">
      <div className="flex items-baseline gap-4">
        <span aria-hidden="true" className="numeral text-sm text-accent">
          {String(step).padStart(2, '0')}
        </span>
        <h2 id={`composer-step-${step}`} className="display-md text-ink">
          {title}
        </h2>
      </div>
      <div className="mt-5 sm:pl-10">{children}</div>
    </section>
  );
}

const STUB_TRANSPORT: Record<string, GlyphId> = {
  drive: 'car',
  public_transport: 'transit',
  mixed: 'compass',
  undecided: 'compass',
};

/**
 * THE TRIP STUB.
 *
 * What the composer knows so far, drawn as a ticket rather than listed as a
 * table: the destination lettered on a plate, the length as a numeral, and the
 * few facts that decide what we research. It fills in as the traveller answers,
 * which is the first time the product visibly learns something from them.
 */
function TripStub({
  destination,
  dates,
  nights,
  shape,
  shapeCode,
  transport,
  transportCode,
  themes,
  travellers,
}: {
  destination: string | null;
  dates: string;
  nights: string | null;
  shape: string | null;
  shapeCode: string | null;
  transport: string | null;
  transportCode: string | null;
  themes: string[];
  travellers: string;
}) {
  const bases = shapeCode === 'two_bases' ? 2 : shapeCode === 'circuit' ? 3 : 1;
  return (
    <div className="overflow-hidden rounded-[var(--radius-plate)] border border-rule bg-paper-raised">
      <div className="plate relative h-40 px-5 pt-4" style={{ '--plate-hue': 38 } as React.CSSProperties}>
        <p className="label text-ink-faint">So far</p>
        <svg viewBox="0 0 320 120" className="absolute inset-x-0 bottom-0 h-24 w-full" aria-hidden="true">
          <circle cx="160" cy="80" r="46" fill="none" stroke="var(--color-ink)" strokeOpacity="0.25" strokeDasharray="3 4" />
          <rect x="155" y="75" width="10" height="10" fill="var(--color-ink)" />
          {bases >= 2 ? <rect x="228" y="52" width="8" height="8" fill="var(--color-accent)" /> : null}
          {bases >= 2 ? <path d="M165 80 L 232 56" stroke="var(--color-accent)" strokeDasharray="3 3" fill="none" /> : null}
          {bases >= 3 ? <rect x="84" y="44" width="8" height="8" fill="var(--color-accent)" /> : null}
          {bases >= 3 ? <path d="M155 80 L 88 48" stroke="var(--color-accent)" strokeDasharray="3 3" fill="none" /> : null}
        </svg>
        {transportCode ? (
          <span className="absolute top-4 right-4 flex h-9 w-9 items-center justify-center rounded-full bg-paper-raised text-ink shadow-sm">
            <Glyph id={STUB_TRANSPORT[transportCode] ?? 'compass'} className="h-4 w-4" />
          </span>
        ) : null}
      </div>
      <div className="px-5 py-4">
        <p className={cx('font-display text-2xl leading-tight', destination ? 'text-ink' : 'text-ink-faint')}>{destination ?? 'Somewhere'}</p>
        <p className="mt-1 text-sm text-ink-muted">{dates}</p>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <Fact label="Length" value={nights ?? '—'} />
          <Fact label="Travellers" value={travellers} />
          <Fact label="Shape" value={shape ?? '—'} />
          <Fact label="Getting around" value={transport ?? '—'} />
          <div className="col-span-2">
            <Fact label="Here for" value={themes.length > 0 ? themes.join(', ') : '—'} />
          </div>
        </dl>
        <p className="mt-4 border-t border-rule pt-3 text-xs leading-relaxed text-ink-faint">
          Every answer changes what we look for. None of them is stored anywhere until you press the button.
        </p>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="label text-ink-faint">{label}</dt>
      <dd className="mt-0.5 truncate text-ink">{value}</dd>
    </div>
  );
}

/**
 * A HEAD COUNT, WITH THE THREE SEMANTICS A BARE NUMBER INPUT DOES NOT HAVE.
 *
 * The founder test reported a traveller count that read `01`, and the mechanism
 * is worth stating because it is not obvious. A controlled `type="number"` was
 * bound to a number and updated with `Number(event.target.value)`. Clearing the
 * children field yields `''`, `Number('')` is `0`, and `0` is the value already
 * in state — so React bails out of the re-render, the DOM keeps the empty
 * string it has, and the next keystroke makes it `"01"`. For adults the same
 * path silently wrote `0`, below the `min` the markup advertised, and the only
 * complaint arrived from the server at submit time.
 *
 * Three fixes, all of which have to be here rather than in the caller:
 *
 * 1. **The text is the state.** An empty field stays empty while it is being
 *    typed in, instead of snapping to a number nobody chose.
 * 2. **Empty means unset, not zero.** It is reported as the minimum on blur,
 *    which is the only defensible reading of "how many adults" left blank.
 * 3. **The bounds are enforced where they are declared.** `min` and `max` on a
 *    number input are advisory outside a submitting form, and this form does
 *    not submit — the button is a `type="button"`. So they are clamped on blur.
 *
 * Stepper buttons because this is a phone-first control: forty-four-pixel
 * targets beat a spinner two pixels tall, and they make the bounds visible by
 * disabling at the ends.
 */
function CountField({
  id,
  label,
  singular,
  min,
  max,
  value,
  onChange,
}: {
  id: string;
  label: string;
  /**
   * The singular noun, for the steppers' accessible names.
   *
   * "One fewer adult" rather than "One fewer adults" — better English, and
   * load-bearing besides: an accessible name containing the field's own label
   * makes three controls answer to the same lookup, which is ambiguous for a
   * screen-reader user reading a control list and fatal for any test that
   * addresses a control by its name.
   */
  singular: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);

  /*
   * The parent is the source of truth; the local text is a typing buffer.
   *
   * Adjusted during render rather than in an effect. React's own guidance, and
   * for a reason that matters here: an effect that calls `setState` renders the
   * stale text once, commits it, and then renders again — so a stepper press
   * would paint the old number for a frame. Comparing against the last value
   * seen instead means the corrected text is in the *same* render as the change.
   */
  if (value !== lastValue) {
    setLastValue(value);
    setText(String(value));
  }

  const clamp = (next: number): number => Math.max(min, Math.min(max, next));

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      onChange(min);
      setText(String(min));
      return;
    }
    const parsed = Number.parseInt(trimmed, 10);
    const next = Number.isFinite(parsed) ? clamp(parsed) : min;
    onChange(next);
    setText(String(next));
  }

  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="mt-1 flex items-stretch gap-1">
        <button
          type="button"
          aria-label={`One fewer ${singular}`}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - 1))}
          className={cx(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-rule bg-paper-raised text-lg text-ink disabled:opacity-40',
            FOCUS_RING,
          )}
        >
          −
        </button>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          aria-describedby={`${id}-range`}
          value={text}
          onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ''))}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit((event.target as HTMLInputElement).value);
          }}
          className={cx(inputClass, 'mt-0 h-11 text-center')}
        />
        <button
          type="button"
          aria-label={`One more ${singular}`}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + 1))}
          className={cx(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-rule bg-paper-raised text-lg text-ink disabled:opacity-40',
            FOCUS_RING,
          )}
        >
          +
        </button>
      </div>
      <span id={`${id}-range`} className="sr-only">
        Between {min} and {max}
      </span>
    </div>
  );
}
