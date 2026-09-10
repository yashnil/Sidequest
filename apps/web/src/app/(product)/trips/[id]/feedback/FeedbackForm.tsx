'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { ErrorNote, buttonClass, cx } from '@/components/ui';
import { submitFeedbackAction, type FeedbackInput } from './actions';

function Chips({ label, options, value, onChange, testId }: { label: string; options: readonly string[]; value: string[]; onChange: (next: string[]) => void; testId: string }) {
  return (
    <fieldset className="mt-6">
      <legend className="font-display text-xl text-ink">{label}</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((option) => {
          const on = value.includes(option);
          return (
            <label key={option} className={cx('cursor-pointer rounded-full border px-3 py-1.5 text-sm', on ? 'border-accent bg-accent-soft text-accent-strong' : 'border-rule text-ink-muted hover:text-ink')}>
              <input type="checkbox" className="sr-only" checked={on} onChange={() => onChange(on ? value.filter((v) => v !== option) : [...value, option])} data-testid={`${testId}-${option.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`} />
              {option}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function Scale<T extends string>({ label, options, value, onChange }: { label: string; options: readonly { value: T; label: string }[]; value: T | undefined; onChange: (next: T) => void }) {
  return (
    <fieldset className="mt-6">
      <legend className="font-display text-xl text-ink">{label}</legend>
      <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)} className={cx('rounded-full border px-3 py-1.5 text-sm', value === option.value ? 'border-accent bg-accent-soft text-accent-strong' : 'border-rule text-ink-muted hover:text-ink')}>
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function FeedbackForm({ tripId, chips }: { tripId: string; chips: string[] }) {
  const [form, setForm] = useState<FeedbackInput>({ loved: [], skip: [] });
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (done) {
    return (
      <div className="mt-8" data-testid="feedback-done">
        <p className="font-display text-2xl text-ink">Thank you.</p>
        <p className="mt-2 type-body text-ink-muted">The next trip starts from what you loved.</p>
        <Link href="/trips" className={cx(buttonClass('primary'), 'mt-6')}>
          Back to your trips
        </Link>
      </div>
    );
  }
  return (
    <form
      className="mt-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await submitFeedbackAction(tripId, form);
          if (!result.ok) setError(result.error);
          else setDone(true);
        });
      }}
    >
      <Chips label="What did you love?" options={chips} value={form.loved} onChange={(loved) => setForm({ ...form, loved })} testId="feedback-loved" />
      <Chips label="What would you skip next time?" options={chips} value={form.skip} onChange={(skip) => setForm({ ...form, skip })} testId="feedback-skip" />
      <Scale label="Was the pace right?" options={[{ value: 'too_slow', label: 'Too slow' }, { value: 'right', label: 'About right' }, { value: 'too_fast', label: 'Too fast' }] as const} value={form.pace} onChange={(pace) => setForm({ ...form, pace })} />
      <Scale label="Was there too much driving?" options={[{ value: 'too_much', label: 'Too much' }, { value: 'right', label: 'About right' }, { value: 'could_take_more', label: 'Could take more' }] as const} value={form.driving} onChange={(driving) => setForm({ ...form, driving })} />
      <Scale label="Did the budget feel right?" options={[{ value: 'under', label: 'Cheaper than expected' }, { value: 'right', label: 'About right' }, { value: 'over', label: 'More than expected' }] as const} value={form.budget} onChange={(budget) => setForm({ ...form, budget })} />
      <div className="mt-6">
        <label htmlFor="feedback-surprised" className="font-display text-xl text-ink">
          Which places surprised you?
        </label>
        <textarea id="feedback-surprised" rows={2} maxLength={400} value={form.surprised ?? ''} onChange={(e) => setForm({ ...form, surprised: e.target.value || undefined })} className="mt-2 w-full rounded-[var(--radius-control)] border border-rule bg-paper px-3 py-2 text-ink" />
      </div>
      {error ? (
        <div className="mt-4">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
      <div className="mt-8 flex items-center gap-3">
        <button type="submit" disabled={pending} className={buttonClass('primary')} data-testid="feedback-submit">
          {pending ? 'Saving…' : 'Send'}
        </button>
        <Link href={`/trips/${tripId}/itinerary`} className={buttonClass('ghost')}>
          Not now
        </Link>
      </div>
    </form>
  );
}
