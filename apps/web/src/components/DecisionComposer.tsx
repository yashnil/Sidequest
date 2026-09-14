'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  BUDGET_BANDS,
  BUDGET_BAND_LABELS,
  TRANSPORT_INTENTS,
  TRANSPORT_INTENT_LABELS,
  TRIP_SHAPES,
  TRIP_SHAPE_LABELS,
  TRIP_THEMES,
  TRIP_THEME_LABELS,
  INTAKE_QUESTIONS,
  intakeAnswered,
  intakeQueue,
  intakeReady,
  intakeSignal,
  intakeUnderstanding,
  type IntakeQuestion,
  type IntakeQuestionId,
} from '@sidequest/core';
import { ChoiceGroup, ErrorNote, FOCUS_RING, FieldLabel, OVERLAY_INPUT, buttonClass, cx, selectableCardClass } from './ui';
import {
  saveDecisionAnswersAction,
  startDecisionAction,
} from '@/app/(product)/decide/actions';
import {
  decisionAnswersToComposer,
  emptyDecisionAnswers,
  type DecisionAnswersInput,
} from '@/lib/destinations/decision-answers';

/**
 * V11 §A1 — ONE QUESTION AT A TIME, IN THE ORDER THAT CHANGES THE ANSWER.
 *
 * What was here was a form: three numbered sections, twenty controls, all of
 * them on screen at once, and a disclosure holding five more. The traveller it
 * serves is the one who has *not* decided where to go — the person least able to
 * answer twenty questions about a trip that does not exist yet, and the person
 * most likely to close the tab at the sight of them.
 *
 * So this screen asks **one question**, starting with when they are free, and
 * asks the next only because answering it would change the ranking more than
 * anything else left. That order is not decided here: `intakeQueue` sorts the
 * ladder by the nominal weight of the rank dimensions each question feeds, so a
 * question cannot be promoted by being easy to draw. When enough weight is
 * unlocked (`intakeReady`), the primary action turns into "Show me where to go"
 * and everything after it is an offer rather than a gate — that switch is the
 * whole difference between an intake and a form.
 *
 * Three rules the screen holds:
 *
 * - **Skipping is an answer.** A passed-over question is written to `skipped`
 *   and not asked again, here or on a later visit. "Nobody said" and "nobody was
 *   asked" stay different facts, which is what lets a dimension abstain
 *   honestly.
 * - **The running summary is the receipt.** `intakeUnderstanding` turns the
 *   stored answers into the sentences beside the question, each one pressable to
 *   reopen the question that produced it, and an assumption is labelled as one.
 *   Nothing appears there that nobody said.
 * - **Revising is the same component.** With every question settled the queue is
 *   empty and the screen becomes the summary with its edit affordances, which is
 *   exactly what "change what you told us" should be. One component rather than
 *   two forms that drift apart.
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
  const [answers, setAnswers] = useState<DecisionAnswersInput>({
    ...emptyDecisionAnswers(),
    ...props.initial,
  });
  /**
   * The question on screen.
   *
   * Pinned rather than derived, and the reason is a defect the derived version
   * had: `queue[0]` changes the instant an answer lands, so choosing a month
   * swapped the question out from under the traveller's hand before they could
   * see what they had chosen. The cursor is set the moment they touch a control
   * and cleared by "Next", so the screen advances when a person says so.
   *
   * It doubles as the reopen mechanism — pressing a line in the summary sets it
   * to that question, whether or not the queue still holds one.
   */
  const [cursor, setCursor] = useState<IntakeQuestionId | null>(null);

  /*
   * The ladder reads a composer record, not this form's shape, so that the
   * question order on screen and the evidence the ranker will actually receive
   * are decided by one function. `decisionAnswersToComposer` is the same
   * conversion the server action performs before it writes the row.
   */
  const composer = useMemo(() => decisionAnswersToComposer(answers, new Date()), [answers]);
  const queue = useMemo(() => intakeQueue(composer), [composer]);
  const understanding = useMemo(() => intakeUnderstanding(composer), [composer]);
  const ready = intakeReady(composer);
  const signal = intakeSignal(composer);
  const essentialsLeft = queue.filter((question) => question.essential).length;

  const asked: IntakeQuestion | undefined = cursor ? QUESTION_BY_ID.get(cursor) : queue[0];

  /* Touching a control pins the question, so answering it does not also leave it. */
  const patch = (next: Partial<DecisionAnswersInput>) => {
    if (asked) setCursor(asked.id);
    setAnswers((current) => ({ ...current, ...next }));
  };

  function settle(id: IntakeQuestionId) {
    /* Skipping records the pass so a reload — or a later visit — does not re-ask it. */
    setAnswers((current) =>
      current.skipped?.includes(`intake:${id}`)
        ? current
        : { ...current, skipped: [...(current.skipped ?? []), `intake:${id}`] },
    );
    setCursor(null);
  }

  /**
   * Moving on.
   *
   * An optional question left blank is a skip, recorded as one — which is why
   * there is one control here rather than "Next" beside "Skip" doing different
   * things to the same unanswered question.
   */
  function advance(question: IntakeQuestion) {
    if (intakeAnswered(question.id, composer)) setCursor(null);
    else settle(question.id);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      if (props.sessionId) {
        const result = await saveDecisionAnswersAction(props.sessionId, answers);
        if (!result.ok) setError(result.error ?? 'We could not save that.');
        else props.onSaved?.();
        return;
      }
      /*
       * On success the action redirects (which throws, and Next follows it);
       * a returned value is always a refusal — the rate fence saying wait.
       */
      const started = await startDecisionAction(answers);
      if (started && !started.ok) setError(started.error ?? 'We could not start that just now.');
    });
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-14">
      <div>
        {asked ? (
          <section aria-labelledby="intake-question" data-intake-question={asked.id}>
            <div className="flex items-baseline justify-between gap-4">
              <h2 id="intake-question" className="display-md text-ink">
                {asked.title}
              </h2>
              {!asked.essential ? (
                <button
                  type="button"
                  onClick={() => settle(asked.id)}
                  className="inline-flex min-h-11 shrink-0 items-center text-sm text-ink-muted underline underline-offset-4 hover:text-pine"
                >
                  Skip
                </button>
              ) : null}
            </div>
            <p className="measure mt-2 type-small text-ink-muted">{asked.consequence}</p>

            <div className="mt-6">
              <QuestionBody question={asked} answers={answers} patch={patch} />
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-rule pt-6">
              {ready ? (
                <button
                  type="button"
                  className={buttonClass('accent', 'lg')}
                  disabled={pending || !props.indexReady}
                  onClick={submit}
                >
                  {pending ? 'Working through it…' : props.sessionId ? 'Save and rank again' : 'Show me where to go'}
                </button>
              ) : null}
              <button
                type="button"
                className={buttonClass(ready ? 'secondary' : 'accent', 'lg')}
                onClick={() => advance(asked)}
                disabled={!canAdvance(asked, answers)}
              >
                {ready ? 'One more question' : 'Next'}
              </button>
              {!ready ? (
                /*
                 * HOW MANY MORE, AND THE ANSWER IS NEVER SEVENTEEN.
                 *
                 * This read `queue.length - 1`, which on the first question is
                 * "16 more before we can rank anything" — a sentence that is both
                 * wrong and a reason to close the tab. The queue is every question
                 * the ladder *could* ask; what stands between the traveller and an
                 * answer is the essentials, and answering those two always clears
                 * the signal floor. Everything after them is an offer.
                 */
                <span className="type-small text-ink-muted">
                  {essentialsLeft === 1 ? 'One more and we can rank.' : `${essentialsLeft} questions and we can rank.`}
                </span>
              ) : null}
            </div>
          </section>
        ) : (
          <section aria-labelledby="intake-done">
            <h2 id="intake-done" className="display-md text-ink">
              That is everything we would ask.
            </h2>
            <p className="measure mt-2 type-small text-ink-muted">
              Anything above can be changed. Nothing here is a guess we made for you except where it says so.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-rule pt-6">
              <button
                type="button"
                className={buttonClass('accent', 'lg')}
                disabled={pending || !ready || !props.indexReady}
                onClick={submit}
              >
                {pending ? 'Working through it…' : props.sessionId ? 'Save and rank again' : 'Show me where to go'}
              </button>
            </div>
          </section>
        )}

        {error ? <div className="mt-6"><ErrorNote>{error}</ErrorNote></div> : null}
      </div>

      <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="What Sidequest understands">
        <p className="eyebrow">Sidequest understands</p>
        {/*
          A PROGRESS FIGURE THAT MEANS SOMETHING.

          Not "question 3 of 17" — the ladder has no fixed length and stopping
          early is the intended outcome. This is the share of the ranking's own
          weight table the answers so far have unlocked, which is the same
          currency `coverage` is reported in on the results.
        */}
        <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-paper-sunk" role="presentation">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-[var(--motion-slow)]"
            style={{ width: `${Math.round(Math.min(1, signal / 0.9) * 100)}%` }}
          />
        </div>
        <p className="type-meta mt-2 text-ink-faint">
          {ready ? 'Enough to rank. Everything after this sharpens it.' : 'Not yet enough to rank anywhere honestly.'}
        </p>

        <dl className="mt-5 space-y-3">
          {understanding.map((line) => (
            <div key={`${line.id}-${line.label}`} className="flex items-baseline justify-between gap-3">
              <dt className="label shrink-0 text-ink-faint">{line.label}</dt>
              <dd className="min-w-0 text-right">
                <button
                  type="button"
                  onClick={() => setCursor(line.id)}
                  className="text-left text-sm text-ink underline decoration-rule underline-offset-4 hover:text-pine"
                >
                  {line.value}
                </button>
                {line.assumed ? <span className="type-meta ml-2 text-ink-faint">assumed</span> : null}
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-5 border-t border-rule pt-4 type-meta text-ink-faint">
          No model chooses, orders or removes a destination. The ranking is arithmetic over sourced data, and you can open
          every number behind it.
          {props.climateEnabled ? '' : ' This build has no climate record, so nothing below is scored on the weather.'}
        </p>
      </aside>
    </div>
  );
}

/**
 * Can the traveller move on from this question?
 *
 * Only the two essentials can block, and they block on emptiness rather than on
 * a judgement about the answer. Every other question has Skip.
 */
function canAdvance(question: IntakeQuestion, answers: DecisionAnswersInput): boolean {
  if (question.id === 'priorities') return answers.themes.length > 0;
  if (question.id === 'when') {
    if (answers.dateMode === 'month') return typeof answers.month === 'number';
    if (answers.dateMode === 'season') return Boolean(answers.season);
    if (answers.dateMode === 'exact' || answers.dateMode === 'flexible') return Boolean(answers.startDate);
    return true;
  }
  return true;
}

/* Reopening a settled question needs its record even though the queue no longer holds it. */
const QUESTION_BY_ID = new Map<IntakeQuestionId, IntakeQuestion>(
  INTAKE_QUESTIONS.map((question) => [question.id, question] as const),
);

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

function QuestionBody({
  question,
  answers,
  patch,
}: {
  question: IntakeQuestion;
  answers: DecisionAnswersInput;
  patch: (next: Partial<DecisionAnswersInput>) => void;
}) {
  switch (question.id) {
    case 'when':
      return (
        <>
          <ChoiceGroup legend="How settled are your dates?" columns={2}>
            {(
              [
                ['month', 'Some time in a month'],
                ['season', 'Some time in a season'],
                ['exact', 'A window I know'],
                ['undecided', 'Not decided at all'],
              ] as const
            ).map(([value, label]) => (
              <Option
                key={value}
                name="decideDateMode"
                value={value}
                checked={answers.dateMode === value}
                onChange={() => patch({ dateMode: value })}
                label={label}
              />
            ))}
          </ChoiceGroup>

          {answers.dateMode === 'month' ? (
            <div className="mt-5">
              <FieldLabel htmlFor="decideMonth">Which month?</FieldLabel>
              <select
                id="decideMonth"
                /*
                 * A placeholder rather than a pre-selected month. A select that
                 * arrives on "January" has answered the question for them, and
                 * the ladder would then never show the question at all.
                 */
                value={answers.month ?? ''}
                onChange={(event) => patch({ month: Number(event.target.value) })}
                className={inputClass}
              >
                <option value="" disabled>
                  Choose a month
                </option>
                {MONTHS.map((name, index) => (
                  <option key={name} value={index + 1}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {answers.dateMode === 'season' ? (
            <ChoiceGroup legend="Which season?" columns={4} className="mt-5">
              {(['spring', 'summer', 'autumn', 'winter'] as const).map((value) => (
                <Option
                  key={value}
                  name="decideSeason"
                  value={value}
                  checked={answers.season === value}
                  onChange={() => patch({ season: value })}
                  label={value[0]!.toUpperCase() + value.slice(1)}
                />
              ))}
            </ChoiceGroup>
          ) : null}

          {answers.dateMode === 'exact' || answers.dateMode === 'flexible' ? (
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="decideStart">Free from</FieldLabel>
                <input
                  id="decideStart"
                  type="date"
                  value={answers.startDate ?? ''}
                  onChange={(event) => patch({ startDate: event.target.value })}
                  className={inputClass}
                />
              </div>
              <div>
                <FieldLabel htmlFor="decideEnd">Free until</FieldLabel>
                <input
                  id="decideEnd"
                  type="date"
                  value={answers.endDate ?? ''}
                  onChange={(event) => patch({ endDate: event.target.value })}
                  className={inputClass}
                />
              </div>
              {/*
                THE WINDOW AND THE TRIP ARE DIFFERENT LENGTHS.

                §A2 asks every recommendation to name a sub-window inside the
                free dates, which is only possible if the two are collected
                separately. A traveller free for a fortnight who wants ten days
                is the ordinary case and the old form had no way to say it.
              */}
              <label className="sm:col-span-2 flex min-h-11 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={answers.dateMode === 'flexible'}
                  onChange={(event) => patch({ dateMode: event.target.checked ? 'flexible' : 'exact' })}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                <span className="text-sm text-ink">These dates can shift by a few days</span>
              </label>
            </div>
          ) : null}
        </>
      );

    case 'priorities':
      return (
        <ChoiceGroup legend="Pick as many as apply" columns={2}>
          {TRIP_THEMES.map((theme) => (
            <Option
              key={theme}
              name={`decideTheme-${theme}`}
              type="checkbox"
              value={theme}
              checked={answers.themes.includes(theme)}
              onChange={() =>
                patch({
                  themes: answers.themes.includes(theme)
                    ? answers.themes.filter((entry) => entry !== theme)
                    : [...answers.themes, theme],
                })
              }
              label={TRIP_THEME_LABELS[theme]}
            />
          ))}
        </ChoiceGroup>
      );

    case 'length':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="decideNights">Nights away</FieldLabel>
            <input
              id="decideNights"
              type="number"
              /* `inputMode` is what actually decides the soft keyboard; `type` alone gets the text keypad on several Android browsers. */
              inputMode="numeric"
              min={1}
              max={30}
              value={answers.nights ?? ''}
              placeholder="Leave blank for a range"
              onChange={(event) =>
                patch({ nights: event.target.value === '' ? null : Number(event.target.value) })
              }
              className={inputClass}
            />
          </div>
          <div>
            <FieldLabel htmlFor="decideMinNights">Or a range</FieldLabel>
            <div className="mt-2 flex items-center gap-2">
              <input
                id="decideMinNights"
                type="number"
                inputMode="numeric"
                min={1}
                max={30}
                value={answers.minNights ?? ''}
                onChange={(event) =>
                  patch({ nights: null, minNights: event.target.value === '' ? null : Number(event.target.value) })
                }
                className={cx(inputClass, 'mt-0')}
                aria-label="Fewest nights"
              />
              <span aria-hidden="true" className="text-ink-faint">to</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={30}
                value={answers.maxNights ?? ''}
                onChange={(event) =>
                  patch({ nights: null, maxNights: event.target.value === '' ? null : Number(event.target.value) })
                }
                className={cx(inputClass, 'mt-0')}
                aria-label="Most nights"
              />
            </div>
          </div>
        </div>
      );

    case 'origin':
      return (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <div>
            <FieldLabel htmlFor="decideOrigin">City or airport</FieldLabel>
            <input
              id="decideOrigin"
              type="text"
              autoComplete="off"
              maxLength={120}
              value={answers.origin ?? ''}
              placeholder="San Francisco"
              onChange={(event) => patch({ origin: event.target.value })}
              className={inputClass}
            />
            <p className="mt-2 type-meta text-ink-faint">
              We measure distance from here. We never price a flight — Sidequest has no airfare source and will not invent one.
            </p>
          </div>
          <div>
            <FieldLabel htmlFor="decideOriginCountry">Country</FieldLabel>
            <input
              id="decideOriginCountry"
              type="text"
              maxLength={2}
              value={answers.originCountry ?? ''}
              placeholder="US"
              onChange={(event) => patch({ originCountry: event.target.value.toUpperCase().slice(0, 2) })}
              className={cx(inputClass, 'uppercase')}
            />
            <p className="mt-2 type-meta text-ink-faint">Decides what “domestic” means.</p>
          </div>
        </div>
      );

    case 'party':
      return (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="decideAdults">Adults</FieldLabel>
            <input
              id="decideAdults"
              type="number"
              inputMode="numeric"
              min={1}
              max={12}
              value={answers.adults}
              onChange={(event) => patch({ adults: Number(event.target.value) })}
              className={inputClass}
            />
          </div>
          <div>
            <FieldLabel htmlFor="decideChildren">Children</FieldLabel>
            <input
              id="decideChildren"
              type="number"
              inputMode="numeric"
              min={0}
              max={12}
              value={answers.children}
              onChange={(event) => patch({ children: Number(event.target.value) })}
              className={inputClass}
            />
          </div>
          {/*
            AGES ONLY WHERE THEY CHANGE THE PLAN.

            Not a birthday field. Four planning consequences, each of which
            changes what a day may contain — which is the V6 rule that these are
            consequences, never diagnoses.
          */}
          <fieldset className="sm:col-span-2">
            <legend className="label text-ink-faint">Anything that changes what a day can hold?</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['kids_under_12', 'Children under 12'],
                  ['seniors_in_group', 'Someone older in the group'],
                  ['mobility_limited', 'Limited walking'],
                  ['altitude_sensitive', 'Altitude is a problem'],
                ] as const
              ).map(([value, label]) => (
                <Option
                  key={value}
                  name={`decideNeed-${value}`}
                  type="checkbox"
                  value={value}
                  checked={(answers.travelerNeeds ?? []).includes(value)}
                  onChange={() =>
                    patch({
                      travelerNeeds: (answers.travelerNeeds ?? []).includes(value)
                        ? (answers.travelerNeeds ?? []).filter((entry) => entry !== value)
                        : [...(answers.travelerNeeds ?? []), value],
                    })
                  }
                  label={label}
                />
              ))}
            </div>
          </fieldset>
        </div>
      );

    case 'budget':
      return (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="decideBudgetFigure">Per person</FieldLabel>
              <input
                id="decideBudgetFigure"
                type="number"
                inputMode="numeric"
                min={0}
                max={1_000_000}
                value={answers.budgetPerPerson ?? ''}
                placeholder="2500"
                onChange={(event) =>
                  patch({
                    budgetPerPerson: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
                className={inputClass}
              />
            </div>
            <fieldset>
              <legend className="label text-ink-faint">Does that include getting there?</legend>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <Option
                  name="decideBudgetFlights"
                  value="yes"
                  checked={answers.budgetIncludesFlights === true}
                  onChange={() => patch({ budgetIncludesFlights: true })}
                  label="Flights included"
                />
                <Option
                  name="decideBudgetFlights"
                  value="no"
                  checked={answers.budgetIncludesFlights === false}
                  onChange={() => patch({ budgetIncludesFlights: false })}
                  label="Before flights"
                />
              </div>
            </fieldset>
          </div>
          <ChoiceGroup legend="Or just the shape of it" columns={3} className="mt-6">
            {BUDGET_BANDS.map((band) => (
              <Option
                key={band}
                name="decideBudget"
                value={band}
                checked={answers.budget === band}
                onChange={() => patch({ budget: band })}
                label={BUDGET_BAND_LABELS[band]}
              />
            ))}
          </ChoiceGroup>
        </>
      );

    case 'intensity':
      return (
        <ChoiceGroup legend="How hard should the outdoor days be?" columns={3}>
          {(
            [
              ['gentle', 'Gentle'],
              ['moderate', 'Moderate'],
              ['strenuous', 'Strenuous'],
            ] as const
          ).map(([value, label]) => (
            <Option
              key={value}
              name="decideIntensity"
              value={value}
              checked={answers.outdoorIntensity === value}
              onChange={() => patch({ outdoorIntensity: value })}
              label={label}
            />
          ))}
        </ChoiceGroup>
      );

    case 'climate':
      return (
        <ChoiceGroup legend="What kind of weather are you after?" columns={4}>
          {(
            [
              ['warm', 'Warm'],
              ['mild', 'Mild'],
              ['cold', 'Cold'],
              ['any', 'Does not matter'],
            ] as const
          ).map(([value, label]) => (
            <Option
              key={value}
              name="decideClimate"
              value={value}
              checked={answers.climatePreference === value}
              onChange={() => patch({ climatePreference: value })}
              label={label}
            />
          ))}
        </ChoiceGroup>
      );

    case 'flight':
      return (
        <ChoiceGroup legend="How much of the trip can be spent travelling?" columns={2}>
          {(
            [
              ['short', 'A short flight at most'],
              ['moderate', 'Half a day is fine'],
              ['long', 'A long haul is fine'],
              ['any', 'Distance is not an obstacle'],
            ] as const
          ).map(([value, label]) => (
            <Option
              key={value}
              name="decideFlight"
              value={value}
              checked={answers.flightTolerance === value}
              onChange={() => patch({ flightTolerance: value })}
              label={label}
            />
          ))}
        </ChoiceGroup>
      );

    case 'scope':
      return (
        <ChoiceGroup legend="Would you leave the country?" columns={3}>
          {(
            [
              ['domestic', 'Stay in the country'],
              ['international', 'Go abroad'],
              ['either', 'Either is fine'],
            ] as const
          ).map(([value, label]) => (
            <Option
              key={value}
              name="decideScope"
              value={value}
              checked={answers.tripScope === value}
              onChange={() => patch({ tripScope: value })}
              label={label}
            />
          ))}
        </ChoiceGroup>
      );

    case 'crowds':
      return (
        <ChoiceGroup legend="How busy will you accept?" columns={3}>
          {(
            [
              ['avoid', 'Away from the crowds'],
              ['tolerate', 'Busy is survivable'],
              ['unbothered', 'Crowds do not bother me'],
            ] as const
          ).map(([value, label]) => (
            <Option
              key={value}
              name="decideCrowds"
              value={value}
              checked={answers.crowdTolerance === value}
              onChange={() => patch({ crowdTolerance: value })}
              label={label}
            />
          ))}
        </ChoiceGroup>
      );

    case 'transport':
      return (
        <>
          <ChoiceGroup legend="How would you get around once you are there?" columns={2}>
            {TRANSPORT_INTENTS.map((value) => (
              <Option
                key={value}
                name="decideTransport"
                value={value}
                checked={answers.transport === value}
                onChange={() => patch({ transport: value })}
                label={TRANSPORT_INTENT_LABELS[value]}
              />
            ))}
          </ChoiceGroup>
          <p className="mt-3 type-meta text-ink-faint">
            Saying nothing means we assume no car, which is the recoverable error — a place we ruled out for being spread
            thin comes back the moment you say you will drive.
          </p>
        </>
      );

    case 'shape':
      return (
        <ChoiceGroup legend="How often would you change where you sleep?" columns={2}>
          {TRIP_SHAPES.map((value) => (
            <Option
              key={value}
              name="decideShape"
              value={value}
              checked={answers.shape === value}
              onChange={() => patch({ shape: value })}
              label={TRIP_SHAPE_LABELS[value]}
            />
          ))}
        </ChoiceGroup>
      );

    case 'lodging':
      return (
        <ChoiceGroup legend="Where would you be happy sleeping?" columns={3}>
          {(
            [
              ['simple', 'Simple is fine'],
              ['comfortable', 'Comfortable'],
              ['refined', 'Somewhere properly nice'],
            ] as const
          ).map(([value, label]) => (
            <Option
              key={value}
              name="decideLodging"
              value={value}
              checked={answers.lodgingComfort === value}
              onChange={() => patch({ lodgingComfort: value })}
              label={label}
            />
          ))}
        </ChoiceGroup>
      );

    case 'visited':
      return (
        <div>
          <FieldLabel htmlFor="decideVisited">Places you have already been</FieldLabel>
          <input
            id="decideVisited"
            type="text"
            maxLength={400}
            value={(answers.visited ?? []).join(', ')}
            placeholder="Iceland, Portugal, Japan"
            onChange={(event) =>
              patch({
                visited: event.target.value
                  .split(',')
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0)
                  .slice(0, 40),
              })
            }
            className={inputClass}
          />
          <p className="mt-2 type-meta text-ink-faint">
            Separated by commas. This lowers how new somewhere similar looks. It never removes anywhere.
          </p>
        </div>
      );

    case 'surprise':
      return (
        <ChoiceGroup legend="How far from the familiar?" columns={3}>
          {(
            [
              ['familiar', 'Somewhere I can picture'],
              ['open', 'Talk me into something'],
              ['surprise_me', 'Surprise me'],
            ] as const
          ).map(([value, label]) => (
            <Option
              key={value}
              name="decideSurprise"
              value={value}
              checked={answers.surpriseAppetite === value}
              onChange={() => patch({ surpriseAppetite: value })}
              label={label}
            />
          ))}
        </ChoiceGroup>
      );

    case 'constraints':
      return (
        <div>
          <FieldLabel htmlFor="decideAvoid">Anywhere or anything you would rather not?</FieldLabel>
          <textarea
            id="decideAvoid"
            rows={3}
            maxLength={600}
            value={answers.avoid}
            onChange={(event) => patch({ avoid: event.target.value })}
            className={cx(inputClass, 'resize-y')}
            placeholder="Naming a place exactly will take it off the list. We never guess at a near-miss."
          />
        </div>
      );
  }
}

const inputClass =
  'mt-2 min-h-11 w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3.5 py-2.5 text-ink placeholder:text-ink-faint focus-visible:outline-2 focus-visible:outline-pine focus-visible:outline-offset-2';

/**
 * V8 — ONE OPTION OF A QUESTION, AS A SELECTABLE CARD.
 *
 * The same contract as the kit's `Choice` — a native radio or checkbox
 * overlaid on its label, so keyboard traversal and announcement are the
 * browser's — drawn with `selectableCardClass`: a chosen option is a filled
 * card with the accent edge, a filled mark and a heavier title, never a border
 * colour alone. The mark is `aria-hidden`; the input's own state is what
 * assistive technology reads, and a tick inside the label would otherwise be
 * spoken as part of the option's name.
 */
function Option({
  name,
  value,
  checked,
  onChange,
  label,
  type = 'radio',
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  type?: 'radio' | 'checkbox';
}) {
  return (
    <label className={selectableCardClass(checked, cx('flex min-h-12 cursor-pointer items-center gap-3 px-4 py-3 text-left', FOCUS_RING))}>
      <input type={type} name={name} value={value} checked={checked} onChange={onChange} className={OVERLAY_INPUT} />
      <span
        aria-hidden="true"
        className={cx(
          'grid h-5 w-5 shrink-0 place-items-center border transition-colors duration-[var(--motion-fast)]',
          type === 'checkbox' ? 'rounded-[5px]' : 'rounded-full',
          checked ? 'border-accent bg-accent text-paper' : 'border-rule bg-paper',
        )}
      >
        {checked ? (
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3.5 8.5 3 3 6-7" />
          </svg>
        ) : null}
      </span>
      <span className={cx('min-w-0 text-sm', checked ? 'font-semibold text-accent-strong' : 'text-ink')}>{label}</span>
    </label>
  );
}
