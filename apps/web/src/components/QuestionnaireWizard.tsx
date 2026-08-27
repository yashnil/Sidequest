'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  AVOIDANCE_OPTIONS,
  BREAKFAST_STYLE_OPTIONS,
  BUDGET_OPTIONS,
  DIETARY_NEED_OPTIONS,
  FOOD_STYLE_OPTIONS,
  OFFERED_AVOIDANCE_OPTIONS,
  SPECIAL_MEAL_OPTIONS,
  CROWD_TOLERANCE_OPTIONS,
  DAILY_INTENSITY_OPTIONS,
  DAY_START_OPTIONS,
  DISCOVERY_MIX_OPTIONS,
  INTEREST_LABELS,
  INTEREST_LEVELS,
  EXPANSION_CEILING_MINUTES,
  MAX_DECISION_QUESTIONS,
  PACE_OPTIONS,
  REGIONAL_EXPANSIONS,
  offeredInterestRows,
  regionalExpansionOptions,
  resumeStepIndex,
  TRANSPORT_PRIORITY_OPTIONS,
  stepDefinitions,
  availableRegionalExpansions,
  buildTravelerProfile,
  isQuestionVisible,
  normalizeAnswers,
  tripPersonality,
  type Avoidance,
  type DecisionAnswerField,
  type DietaryNeed,
  type Interest,
  type InterestLevel,
  type InterpretationSet,
  type ComposerAnsweredField,
  type QuestionnaireAnswers,
  type QuestionnaireContext,
  type QuestionnaireStepId,
  type RegionDecisionQuestionRecord,
  type RegionalExpansion,
} from '@sidequest/core';
import { Badge, ErrorNote, Fieldset, FOCUS_RING, OVERLAY_INPUT, Panel, buttonClass, cx } from './ui';
import { InterpretationPanel } from './InterpretationPanel';
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
 */
const ONLY_CARRIED: Partial<Record<QuestionnaireStepId, ComposerAnsweredField[]>> = {
  budget: ['budgetStyle'],
};

/**
 * The steps actually shown, given what the composer answered and what the
 * traveller has since touched. Recomputed on every render rather than frozen,
 * because the moment the traveller edits a carried-over field on another step
 * it stops being an assumption — and a step that reappeared mid-flow would be
 * worse than one that never left. `edited` only ever grows, so the list can
 * only grow, never shrink.
 */
function visibleSteps(
  allSteps: ReturnType<typeof stepDefinitions>,
  prefilled: readonly ComposerAnsweredField[],
  edited: ReadonlySet<string>,
) {
  return allSteps.filter((entry) => {
    const fields = ONLY_CARRIED[entry.id];
    if (fields === undefined) return true;
    return !fields.every((field) => prefilled.includes(field) && !edited.has(field));
  });
}

/** Steps where "decide for me" is not an answer: interests is the one step that
 * refuses to advance empty, and the review is a check, not a question. */
const NO_HANDOVER: readonly QuestionnaireStepId[] = ['interests', 'review'];

/**
 * CONTRADICTORY MOBILITY ANSWERS ARE A QUESTION, NEVER A SILENT CLAMP.
 *
 * A live Iceland trip carried "up to 5 hr at the wheel a day" beside "nothing
 * further than about an hour from base". The profile maths takes the stricter
 * of the two (`effectiveDetourMinutes` is a `min`), so the board quietly marked
 * the destination's headline waterfalls and glacier "Probably skip — past how
 * far you said you would go" — blaming a willingness to travel the traveller had
 * explicitly stated, five times over, in the very next answer. Neither answer
 * is wrong; together they cannot both bind, and the traveller is the only one
 * entitled to say which one they meant.
 *
 * Fires only when the gap is unmistakable: the stated daily wheel time has to
 * exceed a full out-and-back to the range limit by more than an hour, so the
 * defaults (150 min against a 60-min range) stay quiet and the factor-of-five
 * case is loud.
 */
const RECONCILE_SLACK_MINUTES = 60;

export interface MobilityReconciliation {
  /** Minutes at the wheel a single day may hold, as stated. */
  wheelMinutes: number;
  /** The one-way range actually binding: min of detour answer and radius ring. */
  rangeMinutes: number;
  /** The one-way range the stated driving day could honestly support. */
  widenedDetourMinutes: number;
  /** The smallest radius ring that admits that range. */
  widenedExpansion: RegionalExpansion;
}

export function mobilityReconciliation(
  answers: QuestionnaireAnswers,
): MobilityReconciliation | null {
  if (!answers.willDrive) return null;
  if (answers.detourToleranceMinutes <= 0) return null;
  const rangeMinutes = Math.min(
    answers.detourToleranceMinutes,
    EXPANSION_CEILING_MINUTES[answers.regionalExpansion],
  );
  if (answers.maxDailyTravelMinutes <= rangeMinutes * 2 + RECONCILE_SLACK_MINUTES) return null;

  const halfDay = Math.floor(answers.maxDailyTravelMinutes / 2 / 15) * 15;
  const widenedDetourMinutes = Math.min(
    180,
    Math.max(halfDay, answers.detourToleranceMinutes),
  );
  if (widenedDetourMinutes <= rangeMinutes) return null;
  const widenedExpansion =
    REGIONAL_EXPANSIONS.find(
      (value) => EXPANSION_CEILING_MINUTES[value] >= widenedDetourMinutes,
    ) ?? 'best_regional';

  return {
    wheelMinutes: answers.maxDailyTravelMinutes,
    rangeMinutes,
    widenedDetourMinutes,
    widenedExpansion,
  };
}

export function QuestionnaireWizard({
  tripId,
  context,
  initialAnswers,
  initialStep = 0,
  initialStepId,
  prefilled = [],
  interpretation,
  durationAdvice = null,
  decisionQuestions = [],
}: {
  tripId: string;
  context: QuestionnaireContext;
  initialAnswers: QuestionnaireAnswers;
  /**
   * Legacy resume position, as an index. Superseded by `initialStepId`: an
   * index into the visible list goes stale the moment the list changes length,
   * which it does whenever a composer-answered step is dropped. Kept so a
   * caller that has only a number still resumes somewhere sensible.
   */
  initialStep?: number;
  /**
   * Where the traveller had got to, as the step's identity rather than its
   * position — resolved against whatever list is actually shown this render.
   */
  initialStepId?: QuestionnaireStepId;
  /**
   * Fields the composer already answered *and the stored answers still agree
   * with*. Shown as confirmable assumptions instead of asked a second time.
   * The page recomputes this against saved answers on every load, so a refresh
   * no longer strips the provenance off every carried answer.
   */
  prefilled?: readonly ComposerAnsweredField[];
  /**
   * What the deterministic reader made of the composer's free text, rendered
   * above the wizard. Owned here rather than by the page so the wizard can
   * collapse it to a one-line bar after the first advance — it is 1.4 mobile
   * viewports tall, and a resume to step seven does not need it unrolled.
   */
  interpretation?: { set: InterpretationSet; mustDo: string; avoid: string };
  /**
   * The trip-length steer the traveller asked the composer for, already
   * written as a sentence. Shown on the review step; null when nobody asked
   * or nothing defensible exists.
   */
  durationAdvice?: string | null;
  /**
   * Stage B — the follow-ups this destination's own geography justified asking.
   *
   * Emitted by the compiler (`interests/decisions.ts`), never authored here, and
   * every one of them steers a control this wizard already renders. Empty is the
   * ordinary case: before a region is compiled there is nothing to justify a
   * follow-up, and a compiled region that measured no reason to ask emits none.
   */
  decisionQuestions?: readonly RegionDecisionQuestionRecord[];
}) {
  const [answers, setAnswers] = useState(initialAnswers);
  const allSteps = stepDefinitions(context);
  /** Prefilled fields the traveller has since touched. Their edit wins, and stays won. */
  const [edited, setEdited] = useState<Set<string>>(() => new Set());

  const steps = visibleSteps(allSteps, prefilled, edited);

  /*
   * The mount-time position, from the step id when the caller has one. Plain
   * consts rather than state initialisers so the two pieces of state that need
   * it (`stepIndex`, `panelOpen`) read one computation.
   */
  const mountIndex = initialStepId
    ? resumeStepIndex(visibleSteps(allSteps, prefilled, new Set()), initialStepId)
    : Math.max(0, initialStep);
  const [stepIndex, setStepIndex] = useState(mountIndex);
  /*
   * The interpretation is shown in full exactly once: on arrival at the start.
   * After the first advance — or on a resume that lands mid-flow — it collapses
   * to a bar with a Show control, so the wizard is the first thing on screen.
   */
  const [panelOpen, setPanelOpen] = useState(mountIndex === 0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const prefill = (field: ComposerAnsweredField): boolean =>
    prefilled.includes(field) && !edited.has(field);

  /*
   * The interest rows this destination has earned the right to ask about.
   *
   * Recomputed rather than memoised: it is a filter over seventeen strings, and
   * it has to follow the answers — an interest the traveller grades that the
   * offer does not include stays on screen, so nobody's saved answer becomes
   * uneditable.
   */
  const interestRows = offeredInterestRows(context, answers.interests);

  /*
   * Which follow-up, if any, belongs above a given control.
   *
   * Looked up by the field the question steers rather than pushed into a block
   * of its own, because a destination-triggered question and the control that
   * answers it must be the same control — a second copy of "will you drive"
   * beside the first is how a questionnaire ends up disagreeing with itself.
   * Capped again here: the emitter already truncates, and a screen that renders
   * whatever it is handed is one bad artifact away from a second questionnaire.
   */
  const stageB = decisionQuestions.slice(0, MAX_DECISION_QUESTIONS);
  const decisionFor = (field: DecisionAnswerField): RegionDecisionQuestionRecord | undefined =>
    stageB.find((question) => question.answerField === field);

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
    // the answer that hides them changes, rather than at submit time. Editing
    // anything on a step the traveller had handed to us takes it back: an
    // answered question is no longer "you decide".
    setAnswers((current) => {
      const withdrawn = current.decideForMe?.includes(step.id)
        ? { ...current, ...patch, decideForMe: current.decideForMe.filter((id) => id !== step.id) }
        : { ...current, ...patch };
      return normalizeAnswers(withdrawn, context);
    });
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
      // Over the rows actually on screen: an error pointing at a control the
      // traveller cannot see is an error they cannot clear.
      const hasSomething = interestRows.some((interest) =>
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
   *
   * The position is saved as the target step's *id*, not its index — the
   * visible list changes length when a composer-answered step is dropped, and
   * an index stored against one length resumes against another.
   */
  function goTo(target: number, toSave: QuestionnaireAnswers = answers) {
    const clamped = Math.min(Math.max(target, 0), steps.length - 1);
    if (clamped === safeIndex) return;
    startTransition(async () => {
      const result = await saveDraftAction(tripId, toSave, steps[clamped]!.id);
      if (!result.ok) {
        setError(result.error ?? 'We could not save your progress.');
        return;
      }
      setError(null);
      setAnswers(toSave);
      setStepIndex(clamped);
      if (clamped > 0) setPanelOpen(false);
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
   * Record that the traveller handed this step to us, and move on.
   *
   * Distinct from pressing Continue over the defaults, and the distinction is
   * the point: a default accepted in silence and a step explicitly delegated
   * look identical in the answer values, and downstream may treat only the
   * second as licence. The step id lands in `answers.decideForMe`; editing
   * anything on the step later takes it back (see `update`).
   */
  function decideThisForMe() {
    const handed = normalizeAnswers(
      { ...answers, decideForMe: [...(answers.decideForMe ?? []), step.id] },
      context,
    );
    goTo(safeIndex + 1, handed);
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

  const offersHandover = !NO_HANDOVER.includes(step.id);

  return (
    <>
      {/*
        * The page-level h1, above the interpretation panel, with the step's own
        * heading demoted to h2 below it. The panel opens with an h2 and used to
        * precede the wizard's h1, so a screen reader's heading list read the
        * page inside out on every visit where the traveller had typed anything.
        */}
      <header className="mx-auto max-w-3xl px-5 pt-10 sm:px-8">
        <p className="eyebrow">Before the research</p>
        <h1 className="mt-2 font-display text-2xl leading-tight text-ink sm:text-3xl">
          Tell us how you travel
        </h1>
      </header>

      {interpretation ? (
        <InterpretationPanel
          tripId={tripId}
          interpretation={interpretation.set}
          mustDo={interpretation.mustDo}
          avoid={interpretation.avoid}
          collapsed={!panelOpen}
          onExpand={() => setPanelOpen(true)}
        />
      ) : null}

      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
        <Progress current={safeIndex} total={steps.length} />

        <h2
          ref={headingRef}
          tabIndex={-1}
          className="mt-6 scroll-mt-24 font-display text-3xl leading-tight text-ink outline-none sm:text-4xl"
        >
          {step.title}
        </h2>
        <p className="mt-3 text-ink-muted">{step.intro}</p>

        <div className="mt-8 space-y-8">
          {step.id === 'interests' ? (
            <Panel className="divide-y divide-rule">
              {interestRows.map((interest) => (
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
              <DecisionPrompt question={decisionFor('dayStart')} />
              <ChoiceGroup
                legend="When do you want to be out the door?"
                options={DAY_START_OPTIONS}
                value={answers.dayStart}
                onChange={(dayStart) => update({ dayStart })}
              />
              {visible('dailyIntensity') ? (
                <>
                  <DecisionPrompt question={decisionFor('dailyIntensity')} />
                  <ChoiceGroup
                    legend="How hard do you want to work for it?"
                    options={DAILY_INTENSITY_OPTIONS}
                    value={answers.dailyIntensity}
                    onChange={(dailyIntensity) => update({ dailyIntensity })}
                    carriedOver={prefill('dailyIntensity')}
                  />
                </>
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
              {/*
                * The tourist-trap warning is derived from the crowd answer
                * rather than asked. It was the fourth surface collecting one
                * preference — composer, graded control, a toggle here, and an
                * avoidance chip — and the toggle and chip are gone. The note
                * says what the answer now does, so nothing happens silently.
                */}
              {answers.crowdTolerance !== 'dont_mind' ? (
                <Note>
                  Because crowds matter to you, we also push down places that are famous mostly for
                  being famous — no extra setting needed.
                </Note>
              ) : null}
            </>
          ) : null}

          {step.id === 'transport' ? (
            <>
              <DecisionPrompt question={decisionFor('willDrive')} />
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
                <>
                  <DecisionPrompt question={decisionFor('maxDailyTravelMinutes')} />
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
                </>
              ) : null}
              {visible('shuttleUse') ? (
                <>
                  <DecisionPrompt question={decisionFor('willUseShuttles')} />
                  <Toggle
                    label="Shuttles and buses are fine"
                    detail="Some places here bar private vehicles in season. Saying no closes those off entirely."
                    checked={answers.willUseShuttles}
                    onChange={(willUseShuttles) => update({ willUseShuttles })}
                  />
                </>
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
              <DecisionPrompt question={decisionFor('regionalExpansion')} />
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
                  Wider radii are hidden because you are not driving — what is on offer is what a
                  day of scheduled transport can realistically cover. Whether local service truly
                  reaches a place is checked during research; where it disappoints, we say so
                  rather than route you there.
                </Note>
              ) : null}
              {visible('detourToleranceMinutes') ? (
                <SliderField
                  /*
                   * The noun follows the transport answer. This slider used to
                   * say "furthest you would drive" directly under a screen that
                   * had just recorded "you are not driving" — the value is real
                   * either way (it sets how wide the research looks), so the
                   * wording changes rather than the control disappearing.
                   */
                  label={
                    answers.willDrive
                      ? 'Furthest you would drive for one stop'
                      : 'Furthest you would travel one way for one stop'
                  }
                  value={answers.detourToleranceMinutes}
                  min={15}
                  max={180}
                  step={15}
                  format={formatMinutes}
                  onChange={(detourToleranceMinutes) => update({ detourToleranceMinutes })}
                  hint={
                    answers.willDrive
                      ? 'One way, from where you are staying. Something genuinely special may still be offered just past this, labelled as a stretch.'
                      : 'By train, bus or shuttle, from where you are staying. This sets how wide we search — where the timetable cannot actually deliver a place, we say so instead of offering it.'
                  }
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
                  {OFFERED_AVOIDANCE_OPTIONS.map((option) => (
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
                  aria-describedby="accessibilityNotes-hint"
                />
                {/*
                  * Where the words actually go, said honestly. They travel on
                  * the profile and appear on the review step; they are never
                  * silently parsed into constraints — the chips above are the
                  * filters. A box that implied otherwise was a placebo.
                  */}
                <p id="accessibilityNotes-hint" className="mt-2 text-sm text-ink-muted">
                  Kept with your trip and shown on the review step. We never turn a sentence into a
                  hard limit — anything that must filter the plan belongs in the choices above.
                </p>
              </div>
            </>
          ) : null}

          {step.id === 'review' ? (
            <ReviewStep
              answers={answers}
              context={context}
              steps={steps}
              onJumpTo={goTo}
              onUpdate={update}
              prefilled={prefilled.filter((field) => !edited.has(field))}
              durationAdvice={durationAdvice}
              unresolved={interpretation?.set.unresolved ?? []}
            />
          ) : null}
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <div className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-6">
          <button
            type="button"
            onClick={goBack}
            disabled={safeIndex === 0 || pending}
            className={buttonClass('ghost')}
          >
            Back
          </button>
          <div className="flex flex-wrap items-center gap-3">
            {offersHandover && !isLast ? (
              <button
                type="button"
                onClick={decideThisForMe}
                disabled={pending}
                className={buttonClass('ghost')}
                title="We use sensible defaults and note that you left this to us"
              >
                Decide this for me
              </button>
            ) : null}
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
      </div>
    </>
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

/**
 * A STAGE B QUESTION, ABOVE THE CONTROL THAT ANSWERS IT.
 *
 * Three lines, and §6.6 asks for all three: the question, one line on what the
 * answer changes, and the measurement that justified interrupting somebody with
 * it. The evidence line is the one that keeps this from becoming destination
 * trivia — "3 of the 11 places we found have no way in but a drive" is a reason
 * to be asked; "this region has roads" is not.
 *
 * Deliberately not a control of its own. It sits above the existing toggle or
 * choice group, so there is exactly one place in the wizard where each of these
 * answers can be given. `null` when this destination measured no reason to ask,
 * which is the ordinary case.
 */
function DecisionPrompt({ question }: { question: RegionDecisionQuestionRecord | undefined }) {
  if (!question) return null;
  return (
    <div
      className="rounded-lg border-l-2 border-slate-blue bg-paper-sunk p-4"
      data-testid={`decision-question-${question.id}`}
    >
      <p className="eyebrow">Because of where you are going</p>
      <p className="mt-1.5 text-sm font-medium text-ink">{question.prompt}</p>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">{question.why}</p>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">{question.evidence}</p>
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
 * look the same on the screen where they confirm both. Plus — because this is
 * the last honest moment before the research spends — the free text we could
 * *not* model, quoted, so nobody leaves believing a sentence steered anything.
 */
function ReviewStep({
  answers,
  context,
  steps,
  onJumpTo,
  onUpdate,
  prefilled,
  durationAdvice,
  unresolved,
}: {
  answers: QuestionnaireAnswers;
  context: QuestionnaireContext;
  steps: readonly { id: QuestionnaireStepId; title: string }[];
  onJumpTo: (index: number) => void;
  /** The wizard's own `update`, so a reconciliation answer is a real edit. */
  onUpdate: (patch: Partial<QuestionnaireAnswers>) => void;
  prefilled: readonly ComposerAnsweredField[];
  durationAdvice: string | null;
  unresolved: InterpretationSet['unresolved'];
}) {
  /*
   * "Keep the range" is an answer too, and it is remembered for this sitting:
   * a question somebody has answered must not re-ask itself on the same
   * screen. It is deliberately *not* persisted — the contradiction is still
   * true of the stored answers, and a traveller returning tomorrow deserves
   * the question again rather than a silence they never chose.
   */
  const [rangeKept, setRangeKept] = useState(false);
  const reconcile = mobilityReconciliation(answers);
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

  /*
   * `change` is the hand-written remainder of the accessible name: the button
   * renders "Change" and appends this for screen readers. It exists because the
   * generated form pasted the row label after the verb, and the row label for
   * the constraints step is "Steering around" — so the control announced itself
   * as "Change Steering around", which is not a sentence anybody wrote.
   */
  const rows: {
    step: QuestionnaireStepId;
    label: string;
    value: string;
    change: string;
    field?: ComposerAnsweredField;
  }[] = [
    {
      step: 'interests',
      label: 'What you are here for',
      change: 'what you are here for',
      /*
       * The offered rows first, then anything graded that the offer no longer
       * includes — `offeredInterestRows` appends exactly those. Filtering the
       * offer alone would drop a stated preference from the one screen headed
       * "Everything you told us" while it carried on steering the research.
       */
      value:
        offeredInterestRows(context, answers.interests)
          .filter((interest) =>
            ['occasional', 'frequent', 'core'].includes(answers.interests[interest] ?? 'low'),
          )
          .map((interest) => `${INTEREST_LABELS[interest]} (${LEVEL_SHORT[answers.interests[interest]!]})`)
          .join(', ') || 'Nothing marked yet',
    },
    { step: 'rhythm', label: 'Pace', change: 'the pace', value: labelOf(PACE_OPTIONS, answers.pace), field: 'pace' },
    { step: 'rhythm', label: 'Day start', change: 'the day start', value: labelOf(DAY_START_OPTIONS, answers.dayStart) },
    {
      step: 'rhythm',
      label: 'How hard the days work',
      change: 'how hard the days work',
      value: labelOf(DAILY_INTENSITY_OPTIONS, answers.dailyIntensity),
      field: 'dailyIntensity',
    },
    {
      step: 'budget',
      label: 'Spending style',
      change: 'the spending style',
      value: labelOf(BUDGET_OPTIONS, answers.budgetStyle),
      field: 'budgetStyle',
    },
    { step: 'food', label: 'Breakfast', change: 'breakfast', value: labelOf(BREAKFAST_STYLE_OPTIONS, answers.breakfastStyle) },
    { step: 'food', label: 'Eating', change: 'how you eat', value: labelOf(FOOD_STYLE_OPTIONS, answers.foodStyle) },
    {
      step: 'food',
      label: 'Meals that are an event',
      change: 'how many meals are an event',
      value: labelOf(SPECIAL_MEAL_OPTIONS, answers.specialMealAppetite),
    },
    {
      step: 'food',
      label: 'Dietary',
      change: 'dietary needs',
      value:
        answers.dietaryNeeds.length === 0
          ? 'Nothing stated'
          : answers.dietaryNeeds
              .map((need) => labelOf(DIETARY_NEED_OPTIONS, need))
              .join(', ') + (answers.dietaryStrict ? ' · requirements, not preferences' : ''),
    },
    {
      step: 'discovery',
      label: 'Famous or hidden',
      change: 'the famous-or-hidden mix',
      value: labelOf(DISCOVERY_MIX_OPTIONS, answers.discoveryMix),
    },
    {
      step: 'discovery',
      label: 'Crowds',
      change: 'how you feel about crowds',
      value: labelOf(CROWD_TOLERANCE_OPTIONS, answers.crowdTolerance),
      field: 'crowdTolerance',
    },
    {
      step: 'transport',
      label: 'Getting around',
      change: 'how you get around',
      value: answers.willDrive ? 'Driving' : 'Without a car',
      field: 'willDrive',
    },
    {
      step: 'transport',
      label: 'Furthest walk to a stop',
      change: 'the walk to a stop',
      value: formatMinutes(answers.maxAccessWalkMinutes),
    },
    {
      step: 'region',
      label: 'How far from base',
      change: 'how far from base',
      value: labelOf(regionalExpansionOptions(context), answers.regionalExpansion),
    },
    {
      step: 'constraints',
      label: 'Steering around',
      change: 'what you are steering around',
      value:
        answers.avoidances.length === 0
          ? 'Nothing stated'
          : answers.avoidances.map((item) => labelOf(AVOIDANCE_OPTIONS, item)).join(', '),
    },
    {
      step: 'constraints',
      label: 'Anything else',
      change: 'your notes',
      value: answers.accessibilityNotes?.trim() || 'Nothing added',
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

      {durationAdvice ? (
        <Note>
          You asked for a steer on trip length: {durationAdvice}
        </Note>
      ) : null}

      {/*
        THE CONTRADICTION, ASKED RATHER THAN RESOLVED IN SILENCE.

        Two of the traveller's own answers cannot both bind, and the maths
        downstream takes the stricter one — so without this question a person
        who said "five hours at the wheel a day" watches the destination's
        headline sights land under "Probably skip", with copy blaming a
        willingness to travel they never stated. Both buttons are explicit
        edits; nothing changes until one is pressed.
      */}
      {reconcile && !rangeKept ? (
        <Panel className="border-amber p-5 sm:p-6" testId="mobility-reconciliation">
          <h3 className="font-display text-lg text-ink">Two of your answers pull against each other</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
            You said up to {formatMinutes(reconcile.wheelMinutes)} at the wheel in a day, but
            nothing further than about {formatMinutes(reconcile.rangeMinutes)} from base. As things
            stand the shorter answer wins: anything past{' '}
            {formatMinutes(reconcile.rangeMinutes)} away will be marked as beyond your range, even
            where the driving day you allowed reaches it comfortably. Which did you mean?
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={buttonClass('secondary')}
              onClick={() =>
                onUpdate({
                  detourToleranceMinutes: reconcile.widenedDetourMinutes,
                  regionalExpansion: reconcile.widenedExpansion,
                })
              }
            >
              Widen my range to {formatMinutes(reconcile.widenedDetourMinutes)}
            </button>
            <button
              type="button"
              className={buttonClass('ghost')}
              onClick={() => setRangeKept(true)}
            >
              Keep it within {formatMinutes(reconcile.rangeMinutes)}
            </button>
          </div>
        </Panel>
      ) : null}

      <Panel className="p-5 sm:p-6">
        <h3 className="font-display text-lg text-ink">Everything you told us</h3>
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
                {answers.decideForMe?.includes(row.step) ? (
                  <span className="ml-2 align-middle">
                    <Badge>left to us</Badge>
                  </span>
                ) : null}
              </dd>
              <button
                type="button"
                onClick={() => onJumpTo(stepIndexOf(row.step))}
                className={cx('text-sm text-pine underline underline-offset-2', FOCUS_RING)}
              >
                Change
                <span className="sr-only"> {row.change}</span>
              </button>
            </div>
          ))}
        </dl>
      </Panel>

      {/*
        * The gap, stated rather than hidden. Free text the reader could not
        * model steered nothing — and a review that stayed quiet about that
        * would let a traveller believe "no long museum days" is a setting when
        * it is only a sentence. Quoted, with where it lives and what it did.
        */}
      {unresolved.length > 0 ? (
        <Panel className="p-5 sm:p-6">
          <h3 className="font-display text-lg text-ink">In your own words</h3>
          <p className="mt-1 text-sm text-ink-muted">
            Saved with your trip exactly as you wrote it. We could not turn these into settings, so
            they have not steered anything above — anything that must count belongs in the steps.
          </p>
          <ul className="mt-3 space-y-1.5 text-sm italic text-ink-muted">
            {unresolved.map((entry) => (
              <li key={`${entry.field ?? 'mustDo'}-${entry.span[0]}-${entry.quote}`}>
                “{entry.quote}”
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
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
