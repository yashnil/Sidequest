'use client';

import { useState, useTransition } from 'react';
import { startAdvisorAction } from '@/app/(product)/decide/advisor-actions';
import { buttonClass, cx, ErrorNote } from '@/components/ui';
import type { DecisionAnswersInput } from '@/lib/destinations/decision-answers';

/**
 * THE FIRST THING "HELP ME CHOOSE" ASKS: NOTHING IN PARTICULAR.
 *
 * Say it however you like; the parser reads what is plainly there and the
 * interview asks only what is missing. Typing is optional — "Just ask me"
 * starts the same interview from nothing.
 */
const EXAMPLES = [
  'Somewhere outdoors this summer — hiking, wildlife, mountains, lakes, coast and swimming.',
  'Two weeks of trekking in July, anywhere in the world, moderate budget.',
  'Warm beaches and snorkelling over Christmas, from London, with the kids.',
  'A gentle week of nature with my parents, no car.',
];

export function AdvisorStart({ prefill }: { prefill?: Partial<DecisionAnswersInput> }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (value: string) => {
    setError(null);
    startTransition(async () => {
      const result = await startAdvisorAction({ text: value, ...(prefill && Object.keys(prefill).length > 0 ? { prefill } : {}) });
      if (result && !result.ok) setError(result.error ?? 'Something went wrong.');
    });
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit(text);
      }}
      className="max-w-3xl"
      aria-label="Describe your trip"
    >
      <label htmlFor="advisor-request" className="sheet-label text-ink-muted">
        In your own words
      </label>
      <textarea
        id="advisor-request"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(text);
        }}
        rows={3}
        maxLength={600}
        placeholder="When, what for, who with — as much or as little as you know."
        className="mt-3 block w-full resize-none border-0 border-b-2 border-ink bg-transparent px-0 pb-3 font-display text-[clamp(1.35rem,1.1rem+1vw,2rem)] leading-snug font-[340] text-ink placeholder:text-ink-faint focus:border-flare focus:ring-0 focus:outline-none"
      />
      <div className="mt-4 flex flex-wrap gap-2" aria-label="Examples">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => setText(example)}
            className="min-h-11 rounded-full border border-ink/20 px-3.5 py-2 text-left text-sm text-ink-muted transition-colors hover:border-ink hover:text-ink"
          >
            {example}
          </button>
        ))}
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <button type="submit" disabled={pending} className={cx(buttonClass('accent', 'lg'))}>
          {pending ? 'Reading that…' : text.trim() ? 'Find my places' : 'Just ask me'}
        </button>
        <p className="type-small text-ink-muted">We’ll ask only what would change the answer — usually two to five taps.</p>
      </div>
      {error ? (
        <div className="mt-5">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : null}
    </form>
  );
}
