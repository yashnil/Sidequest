'use client';

import { useState, useTransition } from 'react';
import { submitAlphaFeedbackAction } from '@/app/(product)/trips/[id]/feedback/alpha-actions';
import { Panel, buttonClass } from './ui';

/**
 * PRIVATE ALPHA — THE ONE PLACE TO TELL US SOMETHING.
 *
 * A disclosure at the foot of the trip, so it never competes with the plan:
 * what it is about, optionally which day and which place, optionally a
 * sentence. Owner only (the share page passes no trip id, so it never renders
 * there).
 */
const CATEGORIES: { id: 'useful' | 'too_packed' | 'wrong_recommendation' | 'missing_place' | 'outdated' | 'bug'; label: string }[] = [
  { id: 'useful', label: 'This trip is useful' },
  { id: 'too_packed', label: 'A day is too packed' },
  { id: 'wrong_recommendation', label: 'A recommendation is wrong' },
  { id: 'missing_place', label: 'A place is missing' },
  { id: 'outdated', label: 'Something is outdated' },
  { id: 'bug', label: 'Something is broken' },
];

export function AlphaFeedback({ tripId, dayCount }: { tripId: string; dayCount: number }) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['id'] | null>(null);
  const [day, setDay] = useState<string>('');
  const [place, setPlace] = useState('');
  const [comment, setComment] = useState('');
  const [status, setStatus] = useState<{ kind: 'sent' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    if (!category) return;
    start(async () => {
      try {
        const result = await submitAlphaFeedbackAction(tripId, { category, dayNumber: day ? Number(day) : null, ...(place.trim() ? { place } : {}), ...(comment.trim() ? { comment } : {}) });
        if (result.ok) {
          setStatus({ kind: 'sent', text: 'Thank you — that reached us, with a link to this trip.' });
          setCategory(null);
          setDay('');
          setPlace('');
          setComment('');
        } else setStatus({ kind: 'error', text: result.error });
      } catch {
        setStatus({ kind: 'error', text: 'That did not send. Check your connection and try again.' });
      }
    });
  };

  return (
    <Panel className="mt-10 p-5" as="section" testId="alpha-feedback">
      <details>
        <summary className="cursor-pointer text-sm font-medium text-ink">Tell us about this plan</summary>
        <p className="mt-2 type-small text-ink-muted">Sidequest is in private alpha. What you tell us goes to the team with a link to this trip and nothing else.</p>
        <fieldset className="mt-4">
          <legend className="sr-only">What is this about?</legend>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((c) => (
              <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)} className={buttonClass(category === c.id ? 'primary' : 'secondary', 'sm')} data-testid={`alpha-feedback-${c.id}`}>
                {c.label}
              </button>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm text-ink">
            Which day (optional)
            <select value={day} onChange={(e) => setDay(e.target.value)} className="mt-1 block w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 py-2">
              <option value="">The whole trip</option>
              {Array.from({ length: dayCount }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  Day {i + 1}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-ink">
            Which place (optional)
            <input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={120} className="mt-1 block w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 py-2" />
          </label>
        </div>
        <label className="mt-3 block text-sm text-ink">
          Anything else (optional)
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} rows={3} className="mt-1 block w-full rounded-[var(--radius-control)] border border-rule bg-paper-raised px-3 py-2" data-testid="alpha-feedback-comment" />
        </label>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" onClick={submit} disabled={!category || pending} className={buttonClass('primary', 'md')} data-testid="alpha-feedback-send">
            {pending ? 'Sending…' : 'Send'}
          </button>
          {!category ? <span className="type-small text-ink-faint">Pick what this is about first.</span> : null}
        </div>
        {status ? (
          <p role="status" className={`mt-3 text-sm ${status.kind === 'sent' ? 'text-pine' : 'text-clay'}`} data-testid="alpha-feedback-status">
            {status.text}
          </p>
        ) : null}
      </details>
    </Panel>
  );
}
