'use client';

import { useActionState, useState } from 'react';
import {
  ACTIVITY_INTENSITIES,
  BUDGET_BANDS,
  CROWD_TOLERANCES,
  DISCOVERY_MIXES,
  EARLY_MORNING_TOLERANCES,
  FREE_TIME_APPETITES,
  INTEREST_LEVELS,
  INTERESTS,
  PACES,
  TRANSPORT_PREFERENCES,
} from '@sidequest/bench';
import { BusyFormSubmit } from '@/components/BusyFormSubmit';
import { ErrorNote, FieldLabel, Panel, cx } from '@/components/ui';
import { LABS_COPY } from './copy';

/**
 * THE ONE REQUEST BOTH PLANS ARE BUILT FROM.
 *
 * Either a traveller from the checked-in library or one written out here, and
 * the two are mutually exclusive on purpose: a form that let somebody start from
 * a saved case and then edit two fields would produce sessions that claim to be
 * comparable with the library and are not.
 *
 * The labels for every enumerated answer are derived from the value rather than
 * written out. That is not shorthand — a hand-written label table for
 * twenty-eight interests and six enumerations is a table that drifts out of step
 * with the schema, and the day it does the form silently offers an answer the
 * request cannot carry. Deriving them means adding an interest to the shared
 * vocabulary makes it appear here, spelled the way the schema spells it.
 */
export function RequestComposer({
  submit,
  cases,
  submissionNonce,
}: {
  submit: (state: { error: string | null }, form: FormData) => Promise<{ error: string | null }>;
  cases: readonly { caseId: string; title: string }[];
  /**
   * Identifies this rendering of the form, so a retried post is recognised as
   * one and two reviewers starting the same case are not folded together.
   */
  submissionNonce: string;
}) {
  const [state, action] = useActionState(submit, { error: null });
  const [written, setWritten] = useState(false);

  return (
    <div className="grid gap-5">
      <div role="group" aria-label={LABS_COPY.newTitle} className="flex flex-wrap gap-2">
        <Toggle active={!written} onSelect={() => setWritten(false)} label={LABS_COPY.chooseSaved} />
        <Toggle active={written} onSelect={() => setWritten(true)} label={LABS_COPY.writeYourOwn} />
      </div>

      {state.error ? <ErrorNote>{LABS_COPY.couldNotStart}</ErrorNote> : null}

      {written ? (
        <form action={action} className="grid gap-5">
          <input type="hidden" name="submissionNonce" value={submissionNonce} />
          <Panel className="p-4 sm:p-5">
            <p className="text-sm text-ink-muted">{LABS_COPY.writeYourOwnHint}</p>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Text name="destination" label={LABS_COPY.fieldDestination} hint={LABS_COPY.fieldDestinationHint} required />
              <div className="grid grid-cols-2 gap-3">
                <Text name="startDate" label={LABS_COPY.fieldStart} type="date" required />
                <Text name="endDate" label={LABS_COPY.fieldEnd} type="date" required />
              </div>
              <Text name="adults" label={LABS_COPY.fieldAdults} type="number" defaultValue="2" />
              <Text name="children" label={LABS_COPY.fieldChildren} type="number" defaultValue="0" />
              <Select name="carAvailable" label={LABS_COPY.fieldCar} options={[
                { value: 'yes', label: LABS_COPY.fieldCarYes },
                { value: 'no', label: LABS_COPY.fieldCarNo },
              ]} />
              <Select name="transport" label={LABS_COPY.fieldTransport} options={derive(TRANSPORT_PREFERENCES)} />
              <Text name="maxDrive" label={LABS_COPY.fieldMaxDrive} type="number" defaultValue="180" />
              <Text name="maxTravel" label={LABS_COPY.fieldMaxTravel} type="number" defaultValue="300" />
              <Text name="bases" label={LABS_COPY.fieldBases} type="number" defaultValue="1" />
              <Text name="baseChanges" label={LABS_COPY.fieldBaseChanges} type="number" defaultValue="0" />
              <Select name="pace" label={LABS_COPY.fieldPace} options={derive(PACES)} />
              <Select name="intensity" label={LABS_COPY.fieldIntensity} options={derive(ACTIVITY_INTENSITIES)} />
              <Select name="freeTime" label={LABS_COPY.fieldFreeTime} options={derive(FREE_TIME_APPETITES)} />
              <Select name="earlyMornings" label={LABS_COPY.fieldEarly} options={derive(EARLY_MORNING_TOLERANCES)} />
              <Select name="crowds" label={LABS_COPY.fieldCrowds} options={derive(CROWD_TOLERANCES)} />
              <Select name="mix" label={LABS_COPY.fieldMix} options={derive(DISCOVERY_MIXES)} />
              <Select name="budget" label={LABS_COPY.fieldBudget} options={derive(BUDGET_BANDS)} />
            </div>
          </Panel>

          <Panel className="p-4 sm:p-5">
            <p className="text-sm font-medium text-ink">{LABS_COPY.fieldInterests}</p>
            <p className="measure mt-1 text-sm text-ink-muted">{LABS_COPY.fieldInterestsHint}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {INTERESTS.map((interest) => (
                <Select
                  key={interest}
                  name={`interest.${interest}`}
                  label={humanise(interest)}
                  options={derive(INTEREST_LEVELS)}
                  defaultValue="low"
                />
              ))}
            </div>
          </Panel>

          <Panel className="p-4 sm:p-5">
            <FieldLabel htmlFor="freeText">{LABS_COPY.fieldFreeText}</FieldLabel>
            <p className="measure mt-1 text-sm text-ink-muted">{LABS_COPY.fieldFreeTextHint}</p>
            <textarea
              id="freeText"
              name="freeText"
              rows={3}
              className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 py-2 text-sm text-ink"
            />
          </Panel>

          <div>
            <BusyFormSubmit
              idleLabel={LABS_COPY.submitWritten}
              busyLabel={LABS_COPY.submitWritten}
              variant="primary"
              testId="composer-submit"
            />
          </div>
        </form>
      ) : (
        <form action={action} className="grid gap-4">
          <input type="hidden" name="submissionNonce" value={submissionNonce} />
          <Panel className="p-4 sm:p-5">
            <p className="measure text-sm text-ink-muted">{LABS_COPY.chooseSavedHint}</p>
            <div className="mt-4">
              <FieldLabel htmlFor="caseId">{LABS_COPY.savedTravellerLabel}</FieldLabel>
              <select
                id="caseId"
                name="caseId"
                data-testid="case-select"
                className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm text-ink"
              >
                {cases.map((entry) => (
                  <option key={entry.caseId} value={entry.caseId}>
                    {entry.title}
                  </option>
                ))}
              </select>
            </div>
          </Panel>
          <div>
            <BusyFormSubmit
              idleLabel={LABS_COPY.submitSaved}
              busyLabel={LABS_COPY.submitSaved}
              variant="primary"
              testId="composer-submit-saved"
            />
          </div>
        </form>
      )}
    </div>
  );
}

function Toggle({
  active,
  onSelect,
  label,
}: {
  active: boolean;
  onSelect: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cx(
        'min-h-11 rounded-lg border px-4 text-sm font-medium transition-colors motion-reduce:transition-none',
        active ? 'border-pine bg-pine-soft text-pine' : 'border-rule bg-paper-raised text-ink',
      )}
    >
      {label}
    </button>
  );
}

function Text({
  name,
  label,
  hint,
  type = 'text',
  defaultValue,
  required,
}: {
  name: string;
  label: string;
  hint?: string;
  type?: string;
  defaultValue?: string;
  required?: boolean;
}) {
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <div className="min-w-0">
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-ink-muted">
          {hint}
        </p>
      ) : null}
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        {...(hintId ? { 'aria-describedby': hintId } : {})}
        className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm text-ink"
      />
    </div>
  );
}

function Select({
  name,
  label,
  options,
  defaultValue,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  defaultValue?: string;
}) {
  return (
    <div className="min-w-0">
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        className="mt-2 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm text-ink"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function derive(values: readonly string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: humanise(value) }));
}

/** `mostly_hidden` becomes `Mostly hidden`. The schema's own word, made readable. */
function humanise(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
