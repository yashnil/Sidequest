'use client';

import { useOptimistic, useState, useTransition } from 'react';
import type { FoodBoardEntry } from '@sidequest/core';
import { setFoodSelectionAction } from '@/app/(product)/trips/[id]/discover/actions';
import { Badge, ErrorNote, Panel, buttonClass, cx } from './ui';

type FoodChoice = 'included' | 'excluded';
export type FoodChoiceMap = Record<string, FoodChoice>;

/**
 * A short list of food stops the traveller may have an opinion about.
 *
 * Not a second board, and deliberately not built out of `PlaceCard`. These carry
 * no fit meter, no hidden-gem score and no photograph: they are not competing
 * with the attractions for the day's hours, and dressing them up as though they
 * were would make the page twice as long to collect a preference the planner can
 * mostly work out on its own.
 *
 * Saying yes is honoured where the route legally allows it and reported as a
 * conflict on the itinerary where it does not — never silently dropped. Saying
 * no removes the venue from every day of the trip.
 */
export function FoodStopsBoard({
  tripId,
  entries,
  initialChoices,
}: {
  tripId: string;
  entries: FoodBoardEntry[];
  initialChoices: FoodChoiceMap;
}) {
  const [choices, setChoices] = useState<FoodChoiceMap>(initialChoices);
  const [optimistic, applyOptimistic] = useOptimistic(
    choices,
    (current: FoodChoiceMap, next: { venueId: string; choice: FoodChoice | null }) => {
      const draft = { ...current };
      if (next.choice === null) delete draft[next.venueId];
      else draft[next.venueId] = next.choice;
      return draft;
    },
  );
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (entries.length === 0) return null;

  function choose(venueId: string, choice: FoodChoice) {
    const next = optimistic[venueId] === choice ? null : choice;
    setError(null);
    startTransition(async () => {
      applyOptimistic({ venueId, choice: next });
      const result = await setFoodSelectionAction(tripId, venueId, next);
      if (!result.ok) {
        setError(result.error ?? 'That did not save.');
        return;
      }
      setChoices((current) => {
        const draft = { ...current };
        if (next === null) delete draft[venueId];
        else draft[venueId] = next;
        return draft;
      });
    });
  }

  return (
    <section className="mt-12" aria-labelledby="food-stops">
      <h2 className="font-display text-xl text-ink" id="food-stops">
        Food &amp; local stops
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-ink-muted">
        Meals get put on the route you are already taking, so you do not have to pick any of these.
        These are the few where your opinion changes the trip.
      </p>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <ul className="mt-4 space-y-3">
        {entries.map((entry) => {
          const choice = optimistic[entry.venueId];
          return (
            <li key={entry.venueId}>
              <Panel as="article" className="p-4">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h3 className="text-sm font-medium text-ink">{entry.name}</h3>
                  <span className="text-[11px] uppercase tracking-[0.12em] text-ink-faint">
                    {entry.serviceTypeLabel} · {entry.locality}
                  </span>
                  <Badge>{entry.priceWord}</Badge>
                  {entry.closedThroughout ? (
                    <Badge tone="clay">Shut on your dates</Badge>
                  ) : entry.hoursUnknown ? (
                    <Badge tone="amber">Hours unconfirmed</Badge>
                  ) : null}
                </div>

                <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{entry.description}</p>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">{entry.why}</p>

                <div
                  className="mt-3 flex gap-2"
                  role="group"
                  aria-label={`Your decision on ${entry.name}`}
                >
                  <button
                    type="button"
                    aria-pressed={choice === 'included'}
                    onClick={() => choose(entry.venueId, 'included')}
                    className={cx(
                      buttonClass(choice === 'included' ? 'primary' : 'secondary', 'sm'),
                    )}
                  >
                    Sounds good
                  </button>
                  <button
                    type="button"
                    aria-pressed={choice === 'excluded'}
                    onClick={() => choose(entry.venueId, 'excluded')}
                    className={cx(
                      buttonClass(choice === 'excluded' ? 'primary' : 'secondary', 'sm'),
                    )}
                  >
                    Not for me
                  </button>
                </div>

                <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                  From{' '}
                  {entry.sourceUrl ? (
                    <a
                      className="underline underline-offset-2"
                      href={entry.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {entry.sourceName}
                    </a>
                  ) : (
                    entry.sourceName
                  )}
                  . We have not checked today.
                </p>
              </Panel>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
