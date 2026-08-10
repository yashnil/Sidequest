'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  AVOIDANCE_OPTIONS,
  BREAKFAST_STYLE_OPTIONS,
  BUDGET_OPTIONS,
  DIETARY_NEED_OPTIONS,
  FOOD_STYLE_OPTIONS,
  SPECIAL_MEAL_OPTIONS,
  CROWD_TOLERANCE_OPTIONS,
  DAILY_INTENSITY_OPTIONS,
  DAY_START_OPTIONS,
  DISCOVERY_MIX_OPTIONS,
  INTERESTS,
  INTEREST_LABELS,
  INTEREST_LEVELS,
  PACE_OPTIONS,
  regionalExpansionOptions,
  TRANSPORT_PRIORITY_OPTIONS,
  stepDefinitions,
  availableRegionalExpansions,
  buildTravelerProfile,
  isQuestionVisible,
  normalizeAnswers,
  tripPersonality,
  type Avoidance,
  type DietaryNeed,
  type Interest,
  type InterestLevel,
  type ComposerAnsweredField,
  type QuestionnaireAnswers,
  type QuestionnaireContext,
  type QuestionnaireStepId,
} from '@sidequest/core';
import { Badge, ErrorNote, Fieldset, FOCUS_RING, OVERLAY_INPUT, Panel, buttonClass, cx } from './ui';
import {
  completeQuestionnaireAction,
  saveDraftAction,
} from '@/app/(product)/trips/[id]/questionnaire/actions';

/** Compact labels for the interest frequency control; the long forms are too wide for a segmented row. */
const LEVEL_SHORT: Record<InterestLevel, string> = {
  avoid: 'Skip',
  low: 'If nearby',
  occasional: 'Once or twice',
  frequent: 'A few times',
  core: 'Core',
};

export function QuestionnaireWizard({
  tripId,
  context,
  initialAnswers,
  initialStep = 0,
  prefilled = [],
}: {
  tripId: string;
  context: QuestionnaireContext;
  initialAnswers: QuestionnaireAnswers;
  /**
   * Where the traveller had got to, from the server.
   *
   * This used to be `useState(0)` with the answers saved separately, so a
   * refresh on step seven of nine returned to step one with everything intact
   * and nothing to say which answers had been reached deliberately — while the
   * header said "Saved as you go".
   */
  initialStep?: number;
  /**
   * Fields the composer already answered.
   *
   * Shown as a confirmable assumption instead of asked a second time. The
   * questionnaire used to re-ask five of these *and* discard what the composer
   * had been told, which is how a traveller who chose trains and buses arrived
   * here with "You will have a car" ticked.
   */
  prefilled?: readonly ComposerAnsweredField[];
}) {
  const [answers, setAnswers] = useState(initialAnswers);
  const allSteps = stepDefinitions(context);
  const [stepIndex, setStepIndex] = useState(() => Math.max(0, initialStep));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  /** Prefilled fields the traveller has since touched. Their edit wins, and stays won. */
  const [edited, setEdited] = useState<Set<string>>(() => new Set());
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const prefill = (field: ComposerAnsweredField): boolean =>
    prefilled.includes(field) && !edited.has(field);

  /**
   * A STEP WHOSE ONLY QUESTION IS ALREADY ANSWERED IS NOT SHOWN.
   *
   * Carrying the composer's answers across stopped the questionnaire
   * *contradicting* the traveller, which was the worst of it — but a review
   * pointed out it did not make the questionnaire any shorter. Every question
   * was still asked, in the same words, with a badge over it. "We already know
   * this, please confirm" nine times is not fewer questions; it is the same
   * form with an apology attached.
   *
   * So a step every one of whose questions is carried over is dropped from the
   * flow entirely. Today that is `budget`, whose sole control is the spending
   * style — one screen of nine, removed for anybody who answered it up front.
   * The answer is not lost and not hidden: it appears on the review screen,
   * marked `assumed`, with a control that jumps back to change it.
   *
   * Recomputed on every render rather than frozen, because the moment the
   * traveller edits a carried-over field on another step it stops being an
   * assumption — and a step that reappeared mid-flow would be worse than one
   * that never left. `edited` is only ever added to, so this list can only
   * grow, never shrink.
   */
  const ONLY_CARRIED: Partial<Record<QuestionnaireStepId, ComposerAnsweredField[]>> = {
    budget: ['budgetStyle'],
  };
  const steps = allSteps.filter((entry) => {
    const fields = ONLY_CARRIED[entry.id];
    return fields === undefined || !fields.every((field) => prefill(field));
  });

  /*
   * Clamped on read rather than on write, because the visible list can shrink
   * *after* a position was stored — a traveller who reaches step eight, goes
   * back and answers something that removes a step would otherwise resume past
   * the end and render nothing.
   */
  const safeIndex = Math.min(Math.max(0, stepIndex), steps.length - 1);
  const step = steps[safeIndex]!;
  const isLast = safeIndex === steps.length - 1;
  const visible = (id: Parameters<typeof isQuestionVisible>[0]) =>
    isQuestionVisible(id, { answers, context });

  function update(patch: Partial<QuestionnaireAnswers>) {
    setError(null);
    /*
     * A prefilled field the traveller has now touched stops being an
     * assumption. Recorded rather than inferred from value equality: choosing
     * the same answer we had assumed is still a decision they made, and a
     * screen that kept calling it an assumption would be ignoring them twice.
     */
    const touched = Object.keys(patch);
    if (touched.some((field) => prefilled.includes(field as ComposerAnsweredField))) {
      setEdited((current) => new Set([...current, ...touched]));
    }
    // Re-normalising on every change keeps hidden answers consistent as soon as
    // the answer that hides them changes, rather than at submit time.
    setAnswers((current) => normalizeAnswers({ ...current, ...patch }, context));
  }

  function setInterest(interest: Interest, level: InterestLevel) {
    update({ interests: { ...answers.interests, [interest]: level } });
  }

  function toggleDietary(need: DietaryNeed, checked: boolean) {
    const next = checked
      ? [...answers.dietaryNeeds, need]
      : answers.dietaryNeeds.filter((entry) => entry !== need);
    update({ dietaryNeeds: [...new Set(next)].sort() });
  }

  function toggleAvoidance(avoidance: Avoidance, checked: boolean) {
    update({
      avoidances: checked
        ? [...answers.avoidances, avoidance]
        : answers.avoidances.filter((item) => item !== avoidance),
    });
  }

  function stepError(id: QuestionnaireStepId): string | null {
    if (id === 'interests') {
      const hasSomething = INTERESTS.some((interest) =>
        ['occasional', 'frequent', 'core'].includes(answers.interests[interest] ?? 'low'),
      );
      if (!hasSomething) {
        return 'Pick at least one thing you actually want to do — “if nearby” on everything gives us nothing to plan around.';
      }
    }
    return null;
  }

  /**
   * Move, saving both the answers and the position.
   *
   * One function for both directions, and that is the fix rather than a tidy-up.
   * `goBack` used to change the index and save nothing, so an edit made on a
   * step and then stepped away from was lost until the traveller happened to
   * walk forward through it again — on a screen headed "Saved as you go".
   *
   * The move happens **after** the save resolves in both directions, so a
   * failed write leaves the traveller on the step whose answers did not persist
   * rather than one further on with a message about a screen they can no longer
   * see.
   */
  function goTo(target: number) {
    const clamped = Math.min(Math.max(target, 0), steps.length - 1);
    if (clamped === safeIndex) return;
    startTransition(async () => {
      const result = await saveDraftAction(tripId, answers, clamped);
      if (!result.ok) {
        setError(result.error ?? 'We could not save your progress.');
        return;
      }
      setError(null);
      setStepIndex(clamped);
    });
  }

  function goNext() {
    const problem = stepError(step.id);
    if (problem) {
      setError(problem);
      return;
    }
    goTo(safeIndex + 1);
  }

  function goBack() {
    setError(null);
    goTo(safeIndex - 1);
  }

  /**
   * Move focus to the new step's heading after the step changes.
   *
   * Two defects, one fix. A keyboard or screen-reader user pressing Continue
   * was left with focus on a button whose label no longer described what would
   * happen, with no announcement that the page had changed underneath them. And
   * a sighted user was scrolled to wherever the previous step had left them —
   * a visual audit caught the review step's heading sitting cut in half behind
   * the sticky header. `scroll-mt` on the heading is what keeps the browser's
   * own scroll-into-view clear of the chrome.
   */
  const hasMoved = useRef(false);
  useEffect(() => {
    /*
     * Not on first render, and that exception is load-bearing.
     *
     * Scrolling the wizard's heading to the top of the viewport is right when
     * the *step changes* — it is what stops the new heading appearing under the
     * sticky chrome. On arrival it is wrong: the interpretation panel sits
     * above the wizard, and scrolling past it on load hides the chips a
     * traveller has to act on before anything else. A browser suite caught it
     * as a lost click on a phone; the traveller's version is a screen that
     * silently starts halfway down.
     */
    if (!hasMoved.current) {
      hasMoved.current = true;
      return;
    }
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView({ block: 'start' });
  }, [safeIndex]);

  function finish() {
    startTransition(async () => {
      const result = await completeQuestionnaireAction(tripId, answers);
      // On success this redirects and never returns.
      if (!result.ok) setError(result.error ?? 'We could not save your profile.');
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <Progress current={safeIndex} total={steps.length} />

      <h1
        ref={headingRef}
        tabIndex={-1}
        className="mt-6 scroll-mt-24 font-display text-3xl leading-tight text-ink outline-none sm:text-4xl"
      >
        {step.title}
      </h1>
      <p className="mt-3 text-ink-muted">{step.intro}</p>

      <div className="mt-8 space-y-8">
        {step.id === 'interests' ? (
          <Panel className="divide-y divide-rule">
            {INTERESTS.map((interest) => (
              <fieldset key={interest} className="p-4 sm:flex sm:items-center sm:gap-4 sm:p-5">
                <legend className="sr-only">{INTEREST_LABELS[interest]}</legend>
                <span aria-hidden="true" className="text-sm font-medium text-ink sm:w-48 sm:shrink-0">
                  {INTEREST_LABELS[interest]}
                </span>
                <div className="mt-3 grid grid-cols-5 gap-1 sm:mt-0 sm:flex-1">
                  {INTEREST_LEVELS.map((level) => (
                    <label
                      key={level}
                      className={cx(
                        /*
                         * WCAG 2.5.5's forty-four pixels, on the control this
                         * screen has most of.
                         *
                         * Five of these sit across a 390px phone inside a row
                         * that repeats for every interest, and at `py-2` they
                         * were about thirty-two pixels tall. `min-h-11` is the
                         * floor the rest of the product already holds itself to
                         * — the board, the boards's disclosures, the plan flow,
                         * the progress panel all use it — and the questionnaire
                         * is the one screen the discipline was never applied to.
                         * Grown with flex centring rather than with padding, so
                         * the type size and the five-across grid are unchanged.
                         */
                        'relative flex min-h-11 cursor-pointer items-center justify-center rounded-md border px-1 py-2 text-center text-[11px] leading-tight sm:text-xs',
                        FOCUS_RING,
                        (answers.interests[interest] ?? 'low') === level
                          ? 'border-pine bg-pine-soft font-medium text-pine'
                          : 'border-rule text-ink-muted hover:border-ink-faint',
                      )}
                    >
                      <input
                        type="radio"
                        name={`interest-${interest}`}
                        value={level}
                        checked={(answers.interests[interest] ?? 'low') === level}
                        onChange={() => setInterest(interest, level)}
                        className={OVERLAY_INPUT}
                      />
                      <span className="sr-only">
                        {INTEREST_LABELS[interest]}:{' '}
                      </span>
                      {LEVEL_SHORT[level]}
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
          </Panel>
        ) : null}

        {step.id === 'rhythm' ? (
          <>
            <ChoiceGroup
              legend="How full should a day be?"
              options={PACE_OPTIONS}
              value={answers.pace}
              onChange={(pace) => update({ pace })}
              carriedOver={prefill('pace')}
            />
            <ChoiceGroup
              legend="When do you want to be out the door?"
              options={DAY_START_OPTIONS}
              value={answers.dayStart}
              onChange={(dayStart) => update({ dayStart })}
            />
            {visible('dailyIntensity') ? (
              <ChoiceGroup
                legend="How hard do you want to work for it?"
                options={DAILY_INTENSITY_OPTIONS}
                value={answers.dailyIntensity}
                onChange={(dailyIntensity) => update({ dailyIntensity })}
                carriedOver={prefill('dailyIntensity')}
              />
            ) : (
              <Note>
                You told us someone in the group has limited mobility, so we are keeping every stop
                low-effort and skipping the intensity question.
              </Note>
            )}
          </>
        ) : null}

        {step.id === 'budget' ? (
          <ChoiceGroup
            legend="What is the spending style for activities?"
            options={BUDGET_OPTIONS}
            value={answers.budgetStyle}
            onChange={(budgetStyle) => update({ budgetStyle })}
            carriedOver={prefill('budgetStyle')}
          />
        ) : null}

        {step.id === 'food' ? (
          <>
            <ChoiceGroup
              legend="What does breakfast look like?"
              options={BREAKFAST_STYLE_OPTIONS}
              value={answers.breakfastStyle}
              onChange={(breakfastStyle) => update({ breakfastStyle })}
            />
            <ChoiceGroup
              legend="And the rest of the day?"
              options={FOOD_STYLE_OPTIONS}
              value={answers.foodStyle}
              onChange={(foodStyle) => update({ foodStyle })}
            />
            {isQuestionVisible('specialMealAppetite', { answers, context }) ? (
              <ChoiceGroup
                legend="How many meals should be an event?"
                options={SPECIAL_MEAL_OPTIONS}
                value={answers.specialMealAppetite}
                onChange={(specialMealAppetite) => update({ specialMealAppetite })}
              />
            ) : null}
            <Toggle
              label="Happy to pick up a lunch and carry it"
              detail="Some of the best days out here have nowhere at all to buy food."
              checked={answers.willPackLunch}
              onChange={(willPackLunch) => update({ willPackLunch })}
            />
            <Fieldset
              legend="Anything you do not eat?"
              hint="We only ever say a place can handle one of these when the place itself has published that it can."
            >
              <div className="flex flex-wrap gap-2">
                {DIETARY_NEED_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={cx(
                      /* The same forty-four-pixel floor. See the interest grid. */
                      'relative inline-flex min-h-11 cursor-pointer items-center rounded-full border border-rule px-3.5 py-1.5 text-sm text-ink-muted has-[:checked]:border-pine has-[:checked]:bg-pine-soft has-[:checked]:text-pine',
                      FOCUS_RING,
                    )}
                  >
                    <input
                      type="checkbox"
                      className={OVERLAY_INPUT}
                      checked={answers.dietaryNeeds.includes(option.value)}
                      onChange={(event) => toggleDietary(option.value, event.target.checked)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </Fieldset>
            {isQuestionVisible('dietaryStrict', { answers, context }) ? (
              <Toggle
                label="These are requirements, not preferences"
                detail="Say yes and we stop treating “nobody has confirmed it” as good enough."
                checked={answers.dietaryStrict}
                onChange={(dietaryStrict) => update({ dietaryStrict })}
              />
            ) : null}
          </>
        ) : null}

        {step.id === 'discovery' ? (
          <>
            <ChoiceGroup
              legend="Famous or off the track?"
              options={DISCOVERY_MIX_OPTIONS}
              value={answers.discoveryMix}
              onChange={(discoveryMix) => update({ discoveryMix })}
            />
            <ChoiceGroup
              legend="How do you feel about crowds?"
              options={CROWD_TOLERANCE_OPTIONS}
              value={answers.crowdTolerance}
              onChange={(crowdTolerance) => update({ crowdTolerance })}
              carriedOver={prefill('crowdTolerance')}
            />
            {visible('avoidTouristTraps') ? (
              <Toggle
                label="Warn me about tourist traps"
                detail="We will push down places that are famous mostly for being famous."
                checked={answers.avoidTouristTraps}
                onChange={(avoidTouristTraps) => update({ avoidTouristTraps })}
              />
            ) : null}
          </>
        ) : null}

        {step.id === 'transport' ? (
          <>
            <Toggle
              label="You will have a car"
              detail="This is the difference between a region and a town. Some destinations run local transport in season; beyond that, a lot of what we find is only reachable with a vehicle."
              checked={answers.willDrive}
              onChange={(willDrive) => update({ willDrive })}
              carriedOver={prefill('willDrive')}
            />
            {visible('roadComfort') ? (
              <>
                <Toggle
                  label="Steep mountain roads are fine"
                  detail="Switchbacks, drop-offs and passes. In some regions this is most of what reaches the good stuff."
                  checked={answers.comfortableMountainRoads}
                  onChange={(comfortableMountainRoads) => update({ comfortableMountainRoads })}
                />
                <Toggle
                  label="Graded dirt roads are fine"
                  detail="Graded but unpaved. Often the last few miles to a trailhead, a spring or a ghost town."
                  checked={answers.comfortableGravelRoads}
                  onChange={(comfortableGravelRoads) => update({ comfortableGravelRoads })}
                />
              </>
            ) : (
              <Note>
                Without a car we will keep to what walks, and to whatever scheduled service the
                destination actually runs. That is a real constraint rather than a preference —
                plenty of the world has no timetable at all outside its towns.
              </Note>
            )}
            {visible('maxDailyTravelMinutes') ? (
              <SliderField
                label="Most you want to spend at the wheel in a day"
                value={answers.maxDailyTravelMinutes}
                min={60}
                max={360}
                step={15}
                format={formatMinutes}
                onChange={(maxDailyTravelMinutes) => update({ maxDailyTravelMinutes })}
                hint="Round trip, driving only. Time on a shuttle counts separately — being carried is not the same as driving."
              />
            ) : null}
            {visible('shuttleUse') ? (
              <Toggle
                label="Shuttles and buses are fine"
                detail="Some places here bar private vehicles in season. Saying no closes those off entirely."
                checked={answers.willUseShuttles}
                onChange={(willUseShuttles) => update({ willUseShuttles })}
              />
            ) : null}
            <SliderField
              label="Furthest you would walk to reach a stop"
              value={answers.maxAccessWalkMinutes}
              min={0}
              max={60}
              step={5}
              format={formatMinutes}
              onChange={(maxAccessWalkMinutes) => update({ maxAccessWalkMinutes })}
              hint="Getting from the car park or the bus stop to the thing itself, not the walking you came for."
            />
            {/*
              Every option here trades driving against being driven, so it only
              means anything to someone who could do either. Without a car there
              is never more than one way in.
            */}
            {visible('shuttleUse') ? (
              <ChoiceGroup
                legend="When there is more than one way in, what matters?"
                options={TRANSPORT_PRIORITY_OPTIONS}
                value={answers.transportPriority}
                onChange={(transportPriority) => update({ transportPriority })}
              />
            ) : null}
          </>
        ) : null}

        {step.id === 'region' ? (
          <>
            <ChoiceGroup
              legend="How far out should we look?"
              options={regionalExpansionOptions(context).filter((option) =>
                availableRegionalExpansions(answers.willDrive, context).includes(option.value),
              )}
              value={answers.regionalExpansion}
              onChange={(regionalExpansion) => update({ regionalExpansion })}
            />
            {!answers.willDrive ? (
              <Note>
                Wider radii are hidden because you are not driving — we will not offer you
                somewhere an hour out and then have no way to get you there.
              </Note>
            ) : null}
            {visible('detourToleranceMinutes') ? (
              <SliderField
                label="Furthest you would drive for one stop"
                value={answers.detourToleranceMinutes}
                min={15}
                max={180}
                step={15}
                format={formatMinutes}
                onChange={(detourToleranceMinutes) => update({ detourToleranceMinutes })}
                hint="One way, from where you are staying. Something genuinely special may still be offered just past this, labelled as a stretch."
              />
            ) : null}
          </>
        ) : null}

        {step.id === 'constraints' ? (
          <>
            <Fieldset
              legend="Anything you would rather not do?"
              hint="These become hard filters, not gentle nudges."
            >
              <div className="flex flex-wrap gap-2">
                {AVOIDANCE_OPTIONS.map((option) => (
                  <label
                    key={option.value}
                    className={cx(
                      /* The same forty-four-pixel floor. See the interest grid. */
                      'relative inline-flex min-h-11 cursor-pointer items-center rounded-full border border-rule px-3.5 py-1.5 text-sm text-ink-muted has-[:checked]:border-clay has-[:checked]:bg-clay-soft has-[:checked]:text-clay',
                      FOCUS_RING,
                    )}
                  >
                    <input
                      type="checkbox"
                      className={OVERLAY_INPUT}
                      checked={answers.avoidances.includes(option.value)}
                      onChange={(event) => toggleAvoidance(option.value, event.target.checked)}
                    />
                    {option.label}
                  </label>
                ))}
              </div>
            </Fieldset>
            <div>
              <label htmlFor="accessibilityNotes" className="text-sm font-medium text-ink">
                Anything else we should know? (optional)
              </label>
              <textarea
                id="accessibilityNotes"
                rows={3}
                maxLength={500}
                value={answers.accessibilityNotes ?? ''}
                onChange={(event) => update({ accessibilityNotes: event.target.value })}
                className="mt-2 w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-ink placeholder:text-ink-faint"
                placeholder="Altitude, knees, someone who hates heights…"
              />
            </div>
          </>
        ) : null}

        {step.id === 'review' ? (
          <ReviewStep
            answers={answers}
            context={context}
            steps={steps}
            onJumpTo={goTo}
            prefilled={prefilled.filter((field) => !edited.has(field))}
          />
        ) : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="mt-10 flex items-center justify-between gap-3 border-t border-rule pt-6">
        <button
          type="button"
          onClick={goBack}
          disabled={safeIndex === 0 || pending}
          className={buttonClass('ghost')}
        >
          Back
        </button>
        {isLast ? (
          <button type="button" onClick={finish} disabled={pending} className={buttonClass('primary')}>
            {pending ? 'Building your board…' : 'Build my discovery board'}
          </button>
        ) : (
          <button type="button" onClick={goNext} disabled={pending} className={buttonClass('primary')}>
            {pending ? 'Saving…' : 'Continue'}
          </button>
        )}
      </div>
    </div>
  );
}

function Progress({ current, total }: { current: number; total: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <span>
          Step {current + 1} of {total}
        </span>
        <span>Saved as you go</span>
      </div>
      <div
        className="mt-2 flex gap-1"
        role="progressbar"
        aria-valuenow={current + 1}
        aria-valuemin={1}
        aria-valuemax={total}
        aria-label="Questionnaire progress"
      >
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={cx('h-1 flex-1 rounded-full', index <= current ? 'bg-pine' : 'bg-rule')}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A note that this answer was carried over rather than asked twice.
 *
 * Shown rather than hidden, and shown *next to a live control*: the honest
 * middle ground between asking a question the traveller has already answered
 * and silently deciding on their behalf. Rendered by both controls below so the
 * wording cannot drift between them.
 */
function CarriedOver() {
  return (
    <span className="ml-2 align-middle">
      <Badge>from your answers · change if wrong</Badge>
    </span>
  );
}

function ChoiceGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
  carriedOver = false,
}: {
  legend: string;
  options: readonly { value: T; label: string; detail: string }[];
  value: T;
  onChange: (value: T) => void;
  carriedOver?: boolean;
}) {
  return (
    <Fieldset legend={legend}>
      {carriedOver ? (
        <p className="-mt-1 mb-2 text-sm text-ink-muted">
          <CarriedOver />
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cx(
              'relative cursor-pointer rounded-lg border p-3.5',
              FOCUS_RING,
              value === option.value
                ? 'border-pine bg-pine-soft'
                : 'border-rule bg-paper-raised hover:border-ink-faint',
            )}
          >
            <input
              type="radio"
              name={legend}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className={OVERLAY_INPUT}
            />
            <span
              className={cx(
                'block text-sm font-medium',
                value === option.value ? 'text-pine' : 'text-ink',
              )}
            >
              {option.label}
            </span>
            {option.detail ? (
              <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">
                {option.detail}
              </span>
            ) : null}
          </label>
        ))}
      </div>
    </Fieldset>
  );
}

function Toggle({
  label,
  detail,
  checked,
  onChange,
  carriedOver = false,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  carriedOver?: boolean;
}) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-lg border border-rule bg-paper-raised p-4">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-pine)]"
      />
      <span>
        <span className="block text-sm font-medium text-ink">
          {label}
          {carriedOver ? <CarriedOver /> : null}
        </span>
        <span className="mt-0.5 block text-sm leading-relaxed text-ink-muted">{detail}</span>
      </span>
    </label>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  hint,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  hint: string;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const id = label.replace(/\W+/g, '-').toLowerCase();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-ink">
          {label}
        </label>
        <output htmlFor={id} className="font-display text-lg text-pine">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-3 w-full accent-[var(--color-pine)]"
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="mt-2 text-sm text-ink-muted">
        {hint}
      </p>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-rule bg-paper-sunk p-4 text-sm leading-relaxed text-ink-muted">
      {children}
    </p>
  );
}

/**
 * WHAT THE REVIEW SCREEN HAS TO SHOW: THE ANSWERS.
 *
 * It used to render a derived personality card and **nothing else** — no answer
 * the traveller had given appeared anywhere on it. A review screen that shows a
 * summary of a summary is not a review; there is nothing on it to check, and
 * the one thing standing between an intake and the expensive research that
 * follows it was a paragraph of adjectives.
 *
 * So: every answer, grouped by the step that asked it, each row linking back to
 * that step. Plus the assumptions carried over from the composer, marked as
 * assumptions, because a value we inferred and a value somebody typed must not
 * look the same on the screen where they confirm both.
 */
function ReviewStep({
  answers,
  context,
  steps,
  onJumpTo,
  prefilled,
}: {
  answers: QuestionnaireAnswers;
  context: QuestionnaireContext;
  steps: readonly { id: QuestionnaireStepId; title: string }[];
  onJumpTo: (index: number) => void;
  prefilled: readonly ComposerAnsweredField[];
}) {
  const personality = useMemo(() => {
    try {
      return tripPersonality(buildTravelerProfile(answers, context), context.tripDays);
    } catch {
      return null;
    }
  }, [answers, context]);

  const stepIndexOf = (id: QuestionnaireStepId): number =>
    Math.max(0, steps.findIndex((entry) => entry.id === id));

  const labelOf = <T extends string>(
    options: readonly { value: T; label: string }[],
    value: T,
  ): string => options.find((option) => option.value === value)?.label ?? String(value);

  const rows: {
    step: QuestionnaireStepId;
    label: string;
    value: string;
    field?: ComposerAnsweredField;
  }[] = [
    {
      step: 'interests',
      label: 'What you are here for',
      value:
        INTERESTS.filter((interest) =>
          ['occasional', 'frequent', 'core'].includes(answers.interests[interest] ?? 'low'),
        )
          .map((interest) => `${INTEREST_LABELS[interest]} (${LEVEL_SHORT[answers.interests[interest]!]})`)
          .join(', ') || 'Nothing marked yet',
    },
    { step: 'rhythm', label: 'Pace', value: labelOf(PACE_OPTIONS, answers.pace), field: 'pace' },
    { step: 'rhythm', label: 'Day start', value: labelOf(DAY_START_OPTIONS, answers.dayStart) },
    {
      step: 'rhythm',
      label: 'How hard the days work',
      value: labelOf(DAILY_INTENSITY_OPTIONS, answers.dailyIntensity),
      field: 'dailyIntensity',
    },
    {
      step: 'budget',
      label: 'Spending style',
      value: labelOf(BUDGET_OPTIONS, answers.budgetStyle),
      field: 'budgetStyle',
    },
    { step: 'food', label: 'Breakfast', value: labelOf(BREAKFAST_STYLE_OPTIONS, answers.breakfastStyle) },
    { step: 'food', label: 'Eating', value: labelOf(FOOD_STYLE_OPTIONS, answers.foodStyle) },
    {
      step: 'food',
      label: 'Meals that are an event',
      value: labelOf(SPECIAL_MEAL_OPTIONS, answers.specialMealAppetite),
    },
    {
      step: 'food',
      label: 'Dietary',
      value:
        answers.dietaryNeeds.length === 0
          ? 'Nothing stated'
          : answers.dietaryNeeds
              .map((need) => labelOf(DIETARY_NEED_OPTIONS, need))
              .join(', ') + (answers.dietaryStrict ? ' · requirements, not preferences' : ''),
    },
    { step: 'discovery', label: 'Famous or hidden', value: labelOf(DISCOVERY_MIX_OPTIONS, answers.discoveryMix) },
    {
      step: 'discovery',
      label: 'Crowds',
      value: labelOf(CROWD_TOLERANCE_OPTIONS, answers.crowdTolerance),
      field: 'crowdTolerance',
    },
    {
      step: 'transport',
      label: 'Getting around',
      value: answers.willDrive ? 'Driving' : 'Without a car',
      field: 'willDrive',
    },
    {
      step: 'transport',
      label: 'Furthest walk to a stop',
      value: formatMinutes(answers.maxAccessWalkMinutes),
    },
    {
      step: 'region',
      label: 'How far from base',
      value: labelOf(regionalExpansionOptions(context), answers.regionalExpansion),
    },
    {
      step: 'constraints',
      label: 'Steering around',
      value:
        answers.avoidances.length === 0
          ? 'Nothing stated'
          : answers.avoidances.map((item) => labelOf(AVOIDANCE_OPTIONS, item)).join(', '),
    },
  ];

  return (
    <div className="space-y-6">
      {personality ? (
        <TripPersonalityCard personality={personality} />
      ) : (
        <Note>
          Something in your answers is incomplete. Step back through and check anything you skipped.
        </Note>
      )}

      <Panel className="p-5 sm:p-6">
        <h2 className="font-display text-lg text-ink">Everything you told us</h2>
        <p className="mt-1 text-sm text-ink-muted">
          This is what the research runs on. Anything that reads wrong, change it now — it is far
          cheaper to fix here than after the board is built.
        </p>
        {prefilled.length > 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-rule bg-paper-sunk p-3 text-sm text-ink-muted">
            Rows marked <em>assumed</em> came from what you told us when you started the trip. We
            have not asked again — change any of them if they are wrong.
          </p>
        ) : null}
        <dl className="mt-4 divide-y divide-rule" data-testid="review-answers">
          {rows.map((row) => (
            <div key={`${row.step}-${row.label}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
              <dt className="w-full text-xs uppercase tracking-[0.12em] text-ink-faint sm:w-52 sm:shrink-0">
                {row.label}
              </dt>
              <dd className="flex-1 text-sm text-ink">
                {row.value}
                {row.field && prefilled.includes(row.field) ? (
                  <span className="ml-2 align-middle">
                    <Badge>assumed</Badge>
                  </span>
                ) : null}
              </dd>
              <button
                type="button"
                onClick={() => onJumpTo(stepIndexOf(row.step))}
                className={cx('text-sm text-pine underline underline-offset-2', FOCUS_RING)}
              >
                Change
                <span className="sr-only"> {row.label}</span>
              </button>
            </div>
          ))}
        </dl>
      </Panel>
    </div>
  );
}

export function TripPersonalityCard({
  personality,
}: {
  personality: ReturnType<typeof tripPersonality>;
}) {
  return (
    <Panel className="p-5 sm:p-6">
      <p className="font-display text-xl leading-snug text-ink">{personality.headline}</p>

      <div className="mt-5 space-y-2.5">
        {personality.dimensions.map((dimension) => (
          <div key={dimension.id} className="flex items-center gap-3">
            <span className="w-28 shrink-0 text-xs text-ink-muted sm:w-36">{dimension.label}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-rule">
              <span
                className="block h-full rounded-full bg-pine"
                style={{ width: `${dimension.value}%` }}
              />
            </span>
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-ink-faint">
              {dimension.value}
            </span>
          </div>
        ))}
      </div>

      <dl className="mt-6 grid gap-x-6 gap-y-3 border-t border-rule pt-5 sm:grid-cols-2">
        {personality.traits.map((trait) => (
          <div key={trait.label} className="flex items-baseline justify-between gap-3">
            <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">{trait.label}</dt>
            <dd className="text-right text-sm text-ink">{trait.value}</dd>
          </div>
        ))}
      </dl>

      {personality.topInterests.length > 0 ? (
        <div className="mt-5 flex flex-wrap gap-1.5 border-t border-rule pt-5">
          {personality.topInterests.map((interest) => (
            <Badge key={interest} tone="pine">
              {INTEREST_LABELS[interest]}
            </Badge>
          ))}
        </div>
      ) : null}
    </Panel>
  );
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}
