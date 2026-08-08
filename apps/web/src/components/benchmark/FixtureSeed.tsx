'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Panel, buttonClass } from '@/components/ui';
import { FIXTURE_COPY } from './copy';

/**
 * The three shapes, in one list the select and its handler both read.
 *
 * Separate constants for the options and the change handler is how the handler
 * came to know about two of them.
 */
const FIXTURE_SHAPES = ['both_complete', 'partial_and_failed', 'awaiting_answers'] as const;
type FixtureShapeName = (typeof FIXTURE_SHAPES)[number];

/**
 * THE TEST SEAM, LABELLED AS ONE.
 *
 * This writes a whole session — assignment, two runs, two plans, two metric
 * sets, one validation report each — straight from the checked-in fixture kit,
 * so the review screen can be driven before either planner arm exists. It is not
 * a benchmark result and the rows it writes say so: the assignment is marked
 * `seeded` and every aggregate in this interface splits on that flag.
 *
 * It is deliberately plain and slightly ugly. A fixture control that looked like
 * part of the product is one somebody presses by accident.
 */
export function FixtureSeed({
  seed,
  cases,
}: {
  seed: (input: {
    caseId: string;
    seed: string;
    shape: FixtureShapeName;
  }) => Promise<{ ok: boolean; sessionId: string | null }>;
  cases: readonly { caseId: string; title: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState('');
  const first = cases[0]?.caseId ?? '';
  const [caseId, setCaseId] = useState(first);
  const [seedText, setSeedText] = useState('');
  const [shape, setShape] = useState<FixtureShapeName>('both_complete');

  return (
    <Panel className="border-dashed p-4">
      <h2 className="text-sm font-medium text-ink">{FIXTURE_COPY.heading}</h2>
      <p className="measure mt-1 text-sm leading-relaxed text-ink-muted">{FIXTURE_COPY.body}</p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="min-w-0 text-sm text-ink">
          {FIXTURE_COPY.caseLabel}
          <select
            data-testid="fixture-case"
            value={caseId}
            onChange={(event) => setCaseId(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm"
          >
            {cases.map((entry) => (
              <option key={entry.caseId} value={entry.caseId}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>

        <label className="min-w-0 text-sm text-ink">
          {FIXTURE_COPY.seedLabel}
          <input
            data-testid="fixture-seed"
            value={seedText}
            onChange={(event) => setSeedText(event.target.value)}
            className="mt-1 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm"
          />
        </label>

        <label className="min-w-0 text-sm text-ink">
          {FIXTURE_COPY.shapeLabel}
          <select
            data-testid="fixture-shape"
            value={shape}
            /*
             * Read against the list, not against one member of it.
             *
             * This was a two-way ternary collapsing anything unrecognised to
             * `both_complete`, so adding a third option gave the select a value
             * the handler silently threw away: the control showed the new shape
             * and the state kept the old one, and the seeded session was the
             * wrong shape with nothing saying so.
             */
            onChange={(event) => {
              const chosen = FIXTURE_SHAPES.find((shapeName) => shapeName === event.target.value);
              if (chosen) setShape(chosen);
            }}
            className="mt-1 min-h-11 w-full rounded-lg border border-rule bg-paper-raised px-3 text-sm"
          >
            {FIXTURE_SHAPES.map((shapeName) => (
              <option key={shapeName} value={shapeName}>
                {FIXTURE_COPY.shapeNames[shapeName]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <button
        type="button"
        data-testid="fixture-write"
        disabled={pending || seedText.trim().length === 0}
        className={`${buttonClass('secondary')} mt-4 motion-reduce:transition-none`}
        onClick={() =>
          startTransition(async () => {
            const result = await seed({ caseId, seed: seedText.trim(), shape });
            if (result.ok && result.sessionId !== null) {
              /*
               * A session parked at the question round has nothing to review
               * yet, so it lands on the screen it is actually stopped on.
               */
              router.push(
                shape === 'awaiting_answers'
                  ? `/labs/benchmark/${result.sessionId}/run`
                  : `/labs/benchmark/${result.sessionId}/review`,
              );
            } else {
              setNote(FIXTURE_COPY.refused);
            }
          })
        }
      >
        {pending ? FIXTURE_COPY.writing : FIXTURE_COPY.write}
      </button>

      <p role="status" aria-live="polite" className="mt-2 text-sm text-ink-muted">
        {note}
      </p>
    </Panel>
  );
}
