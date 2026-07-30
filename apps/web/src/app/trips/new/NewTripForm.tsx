'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { TRAVELER_NEEDS, TRAVELER_NEED_LABELS } from '@sidequest/core';
import {
  buttonClass,
  cx,
  ErrorNote,
  Fieldset,
  FOCUS_RING,
  OVERLAY_INPUT,
  Panel,
} from '@/components/ui';
import { createTripAction, type NewTripState } from './actions';

const MODES = [
  {
    id: 'known_destination',
    title: 'I know where I want to go',
    detail: 'You have a destination. We build the region around it.',
    available: true,
  },
  {
    id: 'help_me_decide',
    title: 'Help me decide where to go',
    detail: 'Dates and preferences, no destination yet.',
    available: false,
  },
  {
    id: 'optimize_existing',
    title: 'Check the plan I already have',
    detail: 'You have a rough itinerary and want it stress-tested.',
    available: false,
  },
] as const;

const inputClass =
  'w-full rounded-lg border border-rule bg-paper px-3 py-2.5 text-ink placeholder:text-ink-faint';

export function NewTripForm({ defaults }: { defaults: { startDate: string; endDate: string } }) {
  const [state, formAction] = useActionState<NewTripState, FormData>(createTripAction, {});
  const values = state.values ?? {};
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="mt-10 space-y-10" noValidate>
      <Fieldset legend="What kind of help do you need?">
        <div className="grid gap-3 sm:grid-cols-3">
          {MODES.map((mode) => (
            <label
              key={mode.id}
              className={cx(
                'group relative flex h-full flex-col rounded-[var(--radius-card)] border p-4',
                FOCUS_RING,
                mode.available
                  ? 'cursor-pointer border-rule bg-paper-raised has-[:checked]:border-pine has-[:checked]:ring-1 has-[:checked]:ring-pine'
                  : 'cursor-not-allowed border-dashed border-rule bg-transparent opacity-70',
              )}
            >
              <input
                type="radio"
                name="mode"
                value={mode.id}
                defaultChecked={mode.available}
                disabled={!mode.available}
                className={cx(OVERLAY_INPUT, !mode.available && 'cursor-not-allowed')}
              />
              <span className="text-sm font-medium text-ink">{mode.title}</span>
              <span className="mt-1 text-sm leading-relaxed text-ink-muted">{mode.detail}</span>
              {!mode.available ? (
                <span className="mt-3 text-[11px] uppercase tracking-[0.14em] text-ink-faint">
                  Not built yet
                </span>
              ) : null}
            </label>
          ))}
        </div>
      </Fieldset>

      <Panel className="p-5 sm:p-6">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="destinationInput" className="text-sm font-medium text-ink">
              Where are you going?
            </label>
            <input
              id="destinationInput"
              name="destinationInput"
              defaultValue={values.destinationInput ?? 'Mammoth Lakes'}
              className={cx(inputClass, 'mt-2')}
              aria-invalid={Boolean(errors.destinationInput)}
              aria-describedby={errors.destinationInput ? 'destinationInput-error' : undefined}
            />
            {errors.destinationInput ? (
              <ErrorNote id="destinationInput-error">{errors.destinationInput}</ErrorNote>
            ) : null}
          </div>

          <div>
            <label htmlFor="startDate" className="text-sm font-medium text-ink">
              Arrive
            </label>
            <input
              id="startDate"
              name="startDate"
              type="date"
              defaultValue={values.startDate ?? defaults.startDate}
              className={cx(inputClass, 'mt-2')}
              aria-invalid={Boolean(errors.startDate)}
              aria-describedby={errors.startDate ? 'startDate-error' : undefined}
            />
            {errors.startDate ? <ErrorNote id="startDate-error">{errors.startDate}</ErrorNote> : null}
          </div>

          <div>
            <label htmlFor="endDate" className="text-sm font-medium text-ink">
              Leave
            </label>
            <input
              id="endDate"
              name="endDate"
              type="date"
              defaultValue={values.endDate ?? defaults.endDate}
              className={cx(inputClass, 'mt-2')}
              aria-invalid={Boolean(errors.endDate)}
              aria-describedby={errors.endDate ? 'endDate-error' : undefined}
            />
            {errors.endDate ? <ErrorNote id="endDate-error">{errors.endDate}</ErrorNote> : null}
          </div>

          <div>
            <label htmlFor="arrivalTime" className="text-sm font-medium text-ink">
              Roughly what time do you get in?
            </label>
            <input
              id="arrivalTime"
              name="arrivalTime"
              type="time"
              defaultValue={values.arrivalTime ?? '15:00'}
              className={cx(inputClass, 'mt-2')}
            />
            <p className="mt-1 text-xs text-ink-faint">A late arrival makes day one lighter.</p>
          </div>

          <div>
            <label htmlFor="departureTime" className="text-sm font-medium text-ink">
              And what time do you head out?
            </label>
            <input
              id="departureTime"
              name="departureTime"
              type="time"
              defaultValue={values.departureTime ?? '11:00'}
              className={cx(inputClass, 'mt-2')}
            />
          </div>

          <div>
            <label htmlFor="adults" className="text-sm font-medium text-ink">
              Adults
            </label>
            <input
              id="adults"
              name="adults"
              type="number"
              min={1}
              max={12}
              defaultValue={values.adults ?? '2'}
              className={cx(inputClass, 'mt-2')}
              aria-invalid={Boolean(errors.adults)}
            />
            {errors.adults ? <ErrorNote>{errors.adults}</ErrorNote> : null}
          </div>

          <div>
            <label htmlFor="children" className="text-sm font-medium text-ink">
              Children
            </label>
            <input
              id="children"
              name="children"
              type="number"
              min={0}
              max={12}
              defaultValue={values.children ?? '0'}
              className={cx(inputClass, 'mt-2')}
            />
          </div>
        </div>

        <Fieldset
          legend="Anything in the group that changes the plan?"
          hint="These do real work: a mobility need caps how hard a stop can be, and children thin out the day."
          className="mt-7"
        >
          <div className="flex flex-wrap gap-2">
            {TRAVELER_NEEDS.map((need) => (
              <label
                key={need}
                className={cx(
                  'relative cursor-pointer rounded-full border border-rule px-3.5 py-1.5 text-sm text-ink-muted has-[:checked]:border-pine has-[:checked]:bg-pine-soft has-[:checked]:text-pine',
                  FOCUS_RING,
                )}
              >
                <input type="checkbox" name={`need-${need}`} className={OVERLAY_INPUT} />
                {TRAVELER_NEED_LABELS[need]}
              </label>
            ))}
          </div>
        </Fieldset>
      </Panel>

      {state.error ? <ErrorNote>{state.error}</ErrorNote> : null}

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={buttonClass('primary')} disabled={pending}>
      {pending ? 'Setting up…' : 'Start the questionnaire'}
    </button>
  );
}
