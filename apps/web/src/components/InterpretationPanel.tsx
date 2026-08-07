'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  INTERPRETATION_CLARIFICATION_COPY,
  MODEL_FALLBACK_OUTCOME_COPY,
  PREFERENCE_STRENGTH_LABELS,
  PREFERENCE_VALENCE,
  SUGGESTED_QUESTION_COPY,
  canOfferModelPass,
  chipLabel,
  type InterpretationSet,
} from '@sidequest/core';
import { Badge, ErrorNote, Panel, buttonClass, cx } from './ui';
import {
  confirmInterpretationAction,
  readUnresolvedTextAction,
} from '@/app/trips/[id]/questionnaire/actions';

/**
 * WHAT WE MADE OF WHAT YOU WROTE — SHOWN BEFORE IT CHANGES ANYTHING.
 *
 * The composer's two free-text boxes have been captured since Phase 11 and read
 * by nothing. This is the screen that lets them do something, and its whole
 * design is the rule that made shipping them inert the honest choice: **nothing
 * applies until somebody accepts it.**
 *
 * So every chip quotes the traveller's own characters, every chip can be dropped
 * on its own, the verbatim text stays exactly as written underneath, and until
 * the button is pressed the interpretation has no effect on any screen.
 *
 * Three states are rendered that a lesser version would hide:
 *
 * - **What we could not read**, quoted. "Nothing matched" is a real answer, and
 *   a box that silently discards half a sentence teaches people it does
 *   something it does not.
 * - **What looked like a name**, flagged as noted-but-not-looked-up. There is no
 *   geocoder on this path, so a place resolved here would have nothing to check
 *   it against.
 * - **What we refused to read**, as a question. A sentence about a knee or an
 *   allergy never becomes a constraint here; it becomes a prompt to set one
 *   properly, because a wrong safety constraint is not recoverable from a chip.
 *
 * The one thing that has changed since: there is now a button under the
 * unresolved list that offers **one** bounded reading of the leftovers. It is a
 * button rather than something the page does on arrival, because a render that
 * bought a model call would spend on every refresh — and because the whole
 * point of the deterministic pass is that the free, reproducible reading
 * happens first and the paid one is the traveller's choice. What comes back is
 * marked as a reading rather than a match, carries the confidence *we* derived
 * rather than any the model asserted, and is still just a proposal: the same
 * button, the same rejections, the same "nothing applies until you accept it".
 */
export function InterpretationPanel({
  tripId,
  interpretation,
  mustDo,
  avoid,
}: {
  tripId: string;
  interpretation: InterpretationSet;
  mustDo: string;
  avoid: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reading, startReading] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dropped, setDropped] = useState<Set<string>>(new Set());

  const alreadyConfirmed = Boolean(interpretation.confirmedAt);
  const hasAnything =
    interpretation.chips.length > 0 ||
    interpretation.unresolved.length > 0 ||
    interpretation.suggestedQuestions.length > 0;
  if (!hasAnything) return null;

  /*
   * A chip we cannot name is not shown.
   *
   * `chipLabel` returns an empty string for a value with no entry in the label
   * map, and the required behaviour is that nothing renders rather than a raw
   * enum identifier de-underscored into pseudo-English. Filtering here rather
   * than at the render site means such a chip is also not counted by the button,
   * which would otherwise offer to apply something the traveller never saw.
   */
  const named = interpretation.chips.filter((chip) => chipLabel(chip.target).length > 0);
  const kept = named.filter((chip) => !dropped.has(chip.id));

  const outsideLocale = interpretation.unresolved.some(
    (entry) => entry.clarificationReason === 'outside_the_locale_we_read',
  );

  return (
    <div className="mx-auto max-w-3xl px-5 pt-10 sm:px-8">
      <Panel className="p-6" as="section" labelledBy="interpretation-heading">
        <p className="eyebrow">Before we start</p>
        <h2 id="interpretation-heading" className="mt-2 font-display text-2xl text-ink">
          {alreadyConfirmed ? 'What we took from what you wrote' : 'This is what we made of it'}
        </h2>
        <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
          {alreadyConfirmed
            ? 'Applied to the answers below. You can still change any of them by hand.'
            : 'None of this changes anything until you accept it. Drop anything we read wrong.'}
        </p>

        {named.length > 0 ? (
          <ul className="mt-5 space-y-2.5">
            {named.map((chip) => {
              const off = dropped.has(chip.id);
              return (
                <li
                  key={chip.id}
                  className={cx(
                    'flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border p-3',
                    off ? 'border-dashed border-rule opacity-55' : 'border-rule bg-paper-sunk',
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-2">
                      {/*
                        * The badge follows the taxonomy's own polarity rather
                        * than a name comparison, so a strength added later is
                        * coloured correctly without anybody remembering to come
                        * back here.
                        */}
                      <Badge
                        tone={PREFERENCE_VALENCE[chip.strength]?.polarity === 'refuses' ? 'clay' : 'pine'}
                      >
                        {PREFERENCE_STRENGTH_LABELS[chip.strength]}
                      </Badge>
                      <span className="text-sm font-medium text-ink">{chipLabel(chip.target)}</span>
                      {/*
                        * Where it came from, and how sure we are, on the chip.
                        *
                        * A phrase-table match and a model reading are different
                        * kinds of claim and a screen that showed them
                        * identically would be quietly overstating the second
                        * one. The confidence is derived by `deriveConfidence`
                        * from span alignment, ambiguity, contradiction and
                        * parser overlap — the model has no field to assert it.
                        */}
                      {chip.source === 'model' ? (
                        <Badge tone="blue">
                          read
                          {chip.confidence ? ` · ${chip.confidence} confidence` : ''}
                        </Badge>
                      ) : null}
                    </span>
                    {/* The traveller's own characters, sliced from what they wrote. */}
                    <span className="mt-1 block text-xs italic text-ink-muted">“{chip.quote}”</span>
                  </span>
                  {!alreadyConfirmed ? (
                    <button
                      type="button"
                      className={buttonClass('ghost', 'sm')}
                      onClick={() =>
                        setDropped((current) => {
                          const next = new Set(current);
                          if (next.has(chip.id)) next.delete(chip.id);
                          else next.add(chip.id);
                          return next;
                        })
                      }
                    >
                      {off ? 'Put it back' : 'Not that'}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        {interpretation.unresolved.length > 0 ? (
          <div className="mt-5 rounded-lg border border-dashed border-rule p-3.5">
            <p className="eyebrow">We could not make anything of</p>
            <ul className="mt-2 space-y-1.5 text-sm text-ink-muted">
              {interpretation.unresolved.map((entry) => (
                <li key={`${entry.field ?? 'mustDo'}-${entry.span[0]}-${entry.quote}`}>
                  “{entry.quote}”
                  {entry.looksLikeAName ? (
                    <span className="text-ink-faint"> — noted, and not looked up.</span>
                  ) : null}
                  {/*
                    * Our sentence, keyed on a closed enum the reader chose
                    * from. It never renders text a model wrote, because there
                    * is no field in the response schema a model could write
                    * text into.
                    */}
                  {entry.clarificationReason ? (
                    <span className="mt-0.5 block text-xs text-ink-faint">
                      {INTERPRETATION_CLARIFICATION_COPY[entry.clarificationReason]}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-faint">
              It is saved with your trip exactly as you wrote it, and it has changed nothing.
            </p>

            {/*
              * WHICH LANGUAGE WE READ, SAID OUT LOUD, WHEN IT IS THE REASON.
              *
              * A sentence in another language used to come back as "we have no
              * setting that means this" — which tells somebody their preference
              * does not exist, when the truth is that our reader is English-only.
              * The reason is now its own member of the closed enum, and this is
              * where the limit is stated rather than implied. It appears only
              * when it is actually the cause; the language name is never
              * guessed, because naming a language we cannot read would be a
              * claim we cannot support.
              */}
            {outsideLocale ? (
              <p className="mt-2 rounded-md bg-amber-soft px-2.5 py-2 text-xs leading-relaxed text-ink">
                Some of this is not in a language we read. Our reader works in{' '}
                <span className="font-medium">{languageName(interpretation.lexiconLocale)}</span>{' '}
                only, so anything written in another language stays exactly as you typed it and
                changes nothing. You can set the same things by hand below.
              </p>
            ) : null}

            {/*
              * One reading, offered rather than taken.
              *
              * `canOfferModelPass` is false once a reading has been spent, once
              * the interpretation is confirmed, and whenever there is nothing
              * eligible to send — so the button disappears rather than failing.
              */}
            {!alreadyConfirmed && canOfferModelPass(interpretation) ? (
              <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-rule pt-3">
                <button
                  type="button"
                  className={buttonClass('secondary', 'sm')}
                  disabled={reading}
                  onClick={() => {
                    setError(null);
                    startReading(async () => {
                      const result = await readUnresolvedTextAction(tripId);
                      if (!result.ok) setError(result.error ?? 'We could not read that just then.');
                      else router.refresh();
                    });
                  }}
                >
                  {reading ? 'Reading…' : 'Have a go at the rest'}
                </button>
                <span className="text-xs text-ink-faint">
                  One attempt, on these words only. Anything it finds is a suggestion you still
                  have to accept.
                </span>
              </div>
            ) : null}

            {interpretation.modelPass ? (
              <p className="mt-3 border-t border-rule pt-3 text-xs text-ink-faint">
                {MODEL_FALLBACK_OUTCOME_COPY[interpretation.modelPass.outcome]}
              </p>
            ) : null}
          </div>
        ) : null}

        {interpretation.suggestedQuestions.length > 0 ? (
          <div className="mt-5 rounded-lg bg-amber-soft p-3.5">
            <p className="eyebrow">Worth telling us properly</p>
            <ul className="mt-2 space-y-2 text-sm leading-relaxed text-ink">
              {interpretation.suggestedQuestions.map((question) => (
                <li key={question.topic}>{SUGGESTED_QUESTION_COPY[question.topic]}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {/*
          * THE CONTROL SAYS WHAT IT WILL DO, AND CANNOT SAY "USE THESE 0".
          *
          * Three states rather than one label with a number interpolated into
          * it. With nothing to apply there is nothing to press, so the whole
          * block is absent; with everything dropped the button is disabled and
          * says so, rather than offering to apply a count of zero; and with one
          * chip it reads "Use this one" rather than "Use these 1".
          */}
        {!alreadyConfirmed && named.length > 0 ? (
          <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-rule pt-5">
            <button
              type="button"
              className={buttonClass('primary')}
              disabled={pending || kept.length === 0}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await confirmInterpretationAction(
                    tripId,
                    /*
                     * Only what was on the screen. A chip we could not name was
                     * never rendered, so nobody agreed to it, and a confirmation
                     * is an agreement — it is left out, which marks it rejected.
                     * Consent to something invisible is not consent.
                     */
                    kept.map((chip) => chip.id),
                  );
                  if (!result.ok) setError(result.error ?? 'We could not save that.');
                  else router.refresh();
                });
              }}
            >
              {pending ? 'Applying…' : applyLabel(kept.length)}
            </button>
            <span className="text-sm text-ink-faint">
              {kept.length === 0
                ? 'Put one back if we got any of it right. Your own words stay exactly as you wrote them either way.'
                : 'Your own words stay exactly as you wrote them, either way.'}
            </span>
          </div>
        ) : null}

        <details className="mt-5 border-t border-rule pt-4">
          <summary className="cursor-pointer text-xs text-ink-faint">What you actually wrote</summary>
          <dl className="mt-3 space-y-2 text-sm">
            {mustDo ? (
              <div>
                <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">Would regret missing</dt>
                <dd className="mt-0.5 text-ink">{mustDo}</dd>
              </div>
            ) : null}
            {avoid ? (
              <div>
                <dt className="text-xs uppercase tracking-[0.12em] text-ink-faint">Rather not</dt>
                <dd className="mt-0.5 text-ink">{avoid}</dd>
              </div>
            ) : null}
          </dl>
        </details>
      </Panel>
    </div>
  );
}

/**
 * The label comes from `chipLabel` in `@sidequest/core`, which is the same
 * function `applyInterpretation` uses to name what it changed. Two copies of a
 * label map is how a screen comes to call something one thing and the report of
 * the change call it another — and the version that used to live here fell back
 * to `target.value.replace(/_/g, ' ')`, the exact mechanism `stageLabel` was
 * written to refuse. An unmapped value now renders nothing at all, and a chip
 * with no name is not rendered.
 */

/**
 * The primary action's words, which never include a bare zero.
 *
 * "Use these 0" is not a thing anybody would say, and it is what the control
 * read whenever the traveller dropped everything — an offer to apply nothing,
 * rendered as an enabled button.
 */
/**
 * The lexicon's language, in a word, from a map rather than from the tag.
 *
 * A BCP-47 tag is an identifier, and printing it — "our reader works in en" —
 * would be the same defect as printing a raw enum member. An unmapped tag falls
 * back to the tag itself only because a locale code is at least *true*, and a
 * sentence that omitted the language entirely would not say the thing this
 * paragraph exists to say.
 */
const LOCALE_NAMES: Record<string, string> = {
  en: 'English',
};

function languageName(locale: string): string {
  return LOCALE_NAMES[locale.toLowerCase().split('-')[0] ?? locale] ?? locale;
}

function applyLabel(count: number): string {
  if (count === 0) return 'Nothing to apply';
  if (count === 1) return 'Use this one';
  return `Use these ${count}`;
}
