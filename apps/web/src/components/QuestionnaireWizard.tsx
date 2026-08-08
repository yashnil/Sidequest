'use client';

import { useMemo, useState, useTransition } from 'react';
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
}: {
  tripId: string;
  context: QuestionnaireContext;
  initialAnswers: QuestionnaireAnswers;
}) {
  const [answers, setAnswers] = useState(initialAnswers);
  const [stepIndex, setStepIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const steps = stepDefinitions(context);
  const step = steps[stepIndex]!;
  const isLast = stepIndex === steps.length - 1;
  const visible = (id: Parameters<typeof isQuestionVisible>[0]) =>
    isQuestionVisible(id, { answers, context });

  function update(patch: Partial<QuestionnaireAnswers>) {
    setError(null);
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

  function goNext() {
    const problem = stepError(step.id);
    if (problem) {
      setError(problem);
      return;
    }
    startTransition(async () => {
      const result = await saveDraftAction(tripId, answers);
      if (!result.ok) {
        setError(result.error ?? 'We could not save your progress.');
        return;
      }
      setError(null);
      setStepIndex((index) => Math.min(index + 1, steps.length - 1));
    });
  }

  function goBack() {
    setError(null);
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  function finish() {
    startTransition(async () => {
      const result = await completeQuestionnaireAction(tripId, answers);
      // On success this redirects and never returns.
      if (!result.ok) setError(result.error ?? 'We could not save your profile.');
    });
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <Progress current={stepIndex} total={steps.length} />

      <h1 className="mt-6 font-display text-3xl leading-tight text-ink sm:text-4xl">
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
                        'relative cursor-pointer rounded-md border px-1 py-2 text-center text-[11px] leading-tight sm:text-xs',
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
                      'relative cursor-pointer rounded-full border border-rule px-3.5 py-1.5 text-sm text-ink-muted has-[:checked]:border-pine has-[:checked]:bg-pine-soft has-[:checked]:text-pine',
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
                      'relative cursor-pointer rounded-full border border-rule px-3.5 py-1.5 text-sm text-ink-muted has-[:checked]:border-clay has-[:checked]:bg-clay-soft has-[:checked]:text-clay',
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

        {step.id === 'review' ? <ReviewStep answers={answers} context={context} /> : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="mt-10 flex items-center justify-between gap-3 border-t border-rule pt-6">
        <button
          type="button"
          onClick={goBack}
          disabled={stepIndex === 0 || pending}
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

function ChoiceGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly { value: T; label: string; detail: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <Fieldset legend={legend}>
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
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
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
        <span className="block text-sm font-medium text-ink">{label}</span>
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

function ReviewStep({
  answers,
  context,
}: {
  answers: QuestionnaireAnswers;
  context: QuestionnaireContext;
}) {
  const personality = useMemo(() => {
    try {
      return tripPersonality(buildTravelerProfile(answers, context), context.tripDays);
    } catch {
      return null;
    }
  }, [answers, context]);

  if (!personality) {
    return (
      <Note>
        Something in your answers is incomplete. Step back through and check anything you skipped.
      </Note>
    );
  }

  return <TripPersonalityCard personality={personality} />;
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
