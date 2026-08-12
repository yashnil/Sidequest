'use client';

import { useId } from 'react';
import { buildBoardMap, type BoardMapPlace } from './BoardMapModel';
import { cx } from './ui';

/**
 * THE BOARD, ON THE GROUND.
 *
 * The product shipped with no map on any screen. That is not a missing feature
 * on a travel planner, it is a missing sense: every question a discovery board
 * exists to answer — is this near the other thing, are the far ones all in one
 * direction, does this lot make a day — is spatial, and the board answered them
 * with a column of durations.
 *
 * WHAT IT IS AND IS NOT. Self-rendered from coordinates the artifact already
 * holds, with no tile provider and therefore no terms nobody has agreed to (see
 * `map-adapter.ts` for the standing reason). There is no coastline, no road and
 * no border, because we have not read one — what is drawn is exactly what is
 * known: where each place is relative to the others and to the bed, and one ring
 * of true ground radius so the spacing means something.
 *
 * SELECTION IS TWO-WAY, WHICH IS THE WHOLE POINT (§10.5). Pressing a pin focuses
 * the card; focusing a card lights its pin. A map that cannot be tied back to
 * the list is decoration, and a decorative map on a screen this dense is worse
 * than none.
 *
 * ACCESSIBILITY. The drawing carries a one-sentence accessible name and the pins
 * are real buttons in the tab order, each labelled with its place's name and how
 * far out it is. Anything with no published position is named underneath in
 * words rather than dropped, so the map and the board hold the same set.
 */

export function BoardMap({
  base,
  places,
  focusedId,
  onFocus,
  className,
}: {
  base: { name: string; coordinates: { lat: number; lng: number } } | null;
  places: readonly BoardMapPlace[];
  /** The card the traveller is looking at, or null. */
  focusedId: string | null;
  onFocus: (placeId: string) => void;
  className?: string;
}) {
  const rawId = useId();
  // `useId` emits colons, which are awkward inside a `url(#…)` reference.
  const id = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  /*
   * The frame is sized so the drawing is rendered at close to 1:1.
   *
   * A viewBox much wider than the element scales everything down, pins
   * included: at 420 units inside a 350px phone column a 28px hit target became
   * 18px, which is under WCAG 2.5.8's 24px floor. Keeping the units near the
   * rendered width means the target the code asks for is the target a thumb
   * gets, at both the phone width and the desktop column width.
   */
  const model = buildBoardMap({ base, places, width: 360, height: 300 });
  if (!model) return null;

  const focused = model.pins.find((pin) => pin.id === focusedId) ?? null;

  return (
    <figure className={cx('m-0', className)} data-testid="board-map">
      <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-rule bg-paper-sunk">
        <svg
          viewBox={`0 0 ${model.width} ${model.height}`}
          className="h-auto w-full"
          role="img"
          aria-label={model.summary}
        >
          {/*
            The scale ring, drawn from real coordinates walked out along
            bearings. It is the only claim about distance the drawing makes, and
            it is one it can stand behind.
          */}
          {model.ring ? (
            <>
              <path
                d={model.ring.path}
                fill="none"
                stroke="var(--color-ink-faint)"
                strokeWidth={1}
                strokeDasharray="3 4"
                opacity={0.7}
              />
              <text
                x={model.base ? model.base.x : model.width / 2}
                y={model.base ? model.base.y - 6 : 12}
                textAnchor="middle"
                fontSize={9}
                fill="var(--color-ink-faint)"
                stroke="var(--color-paper-sunk)"
                strokeWidth={2.5}
                paintOrder="stroke"
              >
                {model.ring.km} km
              </text>
            </>
          ) : null}

          {/*
            The leg to whatever the traveller is looking at.

            Drawn only for the focused pin: twenty-three lines from one point is
            a starburst that hides the geography it is meant to reveal. It is a
            straight line and is never labelled with a distance, because the
            journey is not straight and the card already carries the measured
            time.
          */}
          {model.base && focused ? (
            <line
              x1={model.base.x}
              y1={model.base.y}
              x2={focused.x}
              y2={focused.y}
              stroke="var(--color-pine)"
              strokeWidth={1.5}
              opacity={0.55}
            />
          ) : null}

          {model.pins.map((pin) => {
            const isFocused = pin.id === focusedId;
            return (
              <g key={pin.id}>
                {/*
                  A generous transparent target under a small visible dot. The
                  drawn mark is 4–6px because a board of forty needs small marks
                  to stay readable; the target is 28px because a thumb is not.
                */}
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={14}
                  fill="transparent"
                  className="cursor-pointer"
                  onClick={() => onFocus(pin.id)}
                  role="button"
                  tabIndex={0}
                  aria-label={pinLabel(pin)}
                  aria-pressed={isFocused}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onFocus(pin.id);
                    }
                  }}
                />
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={isFocused ? 6.5 : pin.chosen ? 5 : 3.5}
                  fill={pin.chosen ? 'var(--color-pine)' : 'var(--color-ink-faint)'}
                  stroke={isFocused ? 'var(--color-pine-strong)' : 'var(--color-paper-raised)'}
                  strokeWidth={isFocused ? 2.5 : 1}
                  pointerEvents="none"
                />
              </g>
            );
          })}

          {/*
            The bed, last so it is never painted over, and shaped differently
            from a place rather than merely coloured differently — a colour is
            the first thing a projector, a printout or a colour-blind reader
            loses.
          */}
          {model.base ? (
            <g pointerEvents="none">
              <rect
                x={model.base.x - 5}
                y={model.base.y - 5}
                width={10}
                height={10}
                rx={2}
                fill="var(--color-ink)"
                stroke="var(--color-paper-raised)"
                strokeWidth={1.5}
              />
            </g>
          ) : null}

          {/* The name of whatever is focused, over the drawing rather than beside it. */}
          {focused ? (
            <text
              x={Math.min(Math.max(focused.x, 40), model.width - 40)}
              y={focused.y > 24 ? focused.y - 12 : focused.y + 20}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="var(--color-ink)"
              stroke="var(--color-paper-sunk)"
              strokeWidth={3}
              paintOrder="stroke"
              id={`${id}-focused`}
            >
              {focused.name}
            </text>
          ) : null}
        </svg>
      </div>

      <figcaption className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-snug text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-[2px] bg-ink" />
          {base ? base.name : 'your base'}
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-pine" />
          chosen
        </span>
        <span>Positions come from the source records. Straight lines, not routes.</span>
      </figcaption>

      {model.unplaced.length > 0 ? (
        <p className="mt-1 text-[11px] leading-snug text-ink-faint" data-testid="board-map-unplaced">
          {/*
            Named rather than dropped. A map that quietly holds fewer places than
            the board beside it teaches the reader that the two disagree, and the
            reader is right.
          */}
          Not on the map, because nobody publishes where {model.unplaced.length === 1 ? 'it is' : 'they are'}:{' '}
          {model.unplaced
            .slice(0, 4)
            .map((place) => place.name)
            .join(', ')}
          {model.unplaced.length > 4 ? ` and ${model.unplaced.length - 4} more` : ''}.
        </p>
      ) : null}
    </figure>
  );
}

/** "Convict Lake, 20 min from base" — enough to choose from without seeing it. */
function pinLabel(pin: { name: string; travelMinutes: number | null; chosen: boolean }): string {
  const distance =
    pin.travelMinutes === null
      ? 'journey not verified'
      : pin.travelMinutes === 0
        ? 'at your base'
        : `${pin.travelMinutes} min from base`;
  return `${pin.name}, ${distance}${pin.chosen ? ', chosen' : ''}`;
}
