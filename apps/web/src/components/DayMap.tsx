import { buildDayMap, type DayMapStop } from './BoardMapModel';
import { cx } from './ui';

/**
 * THE DAY, ON THE GROUND — ON THE PAGE THE TRAVELLER TAKES WITH THEM.
 *
 * The finished itinerary carried no picture and no map: two text links per day
 * ("Open day 3 in Google Maps") were the only geography on the product's entire
 * deliverable, and both of them require a phone, a signal and a tap. A plan
 * about where to go should show where it goes.
 *
 * Deliberately *not* interactive and deliberately not a client component. This
 * is the printed half of the product — it has to survive `Ctrl+P`, a PDF, a
 * screenshot in a group chat and an aeroplane — so it is an SVG the server
 * renders once, with no tile provider and therefore no terms nobody agreed to
 * (`map-adapter.ts` carries the standing reason). There is no coastline, no road
 * and no border, because we have not read one. What is drawn is exactly what is
 * known: where the day's stops are, relative to each other and to the bed, and
 * the order they come in.
 *
 * Accessibility: the drawing carries a one-sentence accessible name listing the
 * stops in order, so a screen-reader user gets the same content the drawing
 * carries rather than the word "image".
 */
export function DayMap({
  base,
  stops,
  omitted,
  className,
}: {
  base: { lat: number; lng: number } | null;
  stops: readonly DayMapStop[];
  /** Stops the compiled region has no position for. Named, never drawn. */
  omitted: number;
  className?: string;
}) {
  const model = buildDayMap({ base, stops, width: 320, height: 200 });
  if (!model) return null;

  return (
    <figure className={cx('m-0', className)} data-testid="day-map">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-rule bg-paper-sunk">
        <svg
          viewBox={`0 0 ${model.width} ${model.height}`}
          className="h-auto w-full"
          role="img"
          aria-label={model.summary}
        >
          {/*
            The order of the day, as one line. Dashed because it is not a route:
            nobody measured this path and the timeline beside it carries the
            journeys that were.
          */}
          <path
            d={model.route}
            fill="none"
            stroke="var(--color-slate-blue)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            opacity={0.7}
          />

          {model.pins.map((pin) => (
            <g key={pin.id}>
              <circle
                cx={pin.x}
                cy={pin.y}
                r={8}
                fill="var(--color-pine)"
                stroke="var(--color-paper-raised)"
                strokeWidth={1.5}
              />
              {/*
                The number, not a label. Names on a 320px frame overlap into
                illegibility at four stops; the number ties the mark to the row
                in the timeline that carries the name, the time and the reason.
              */}
              <text
                x={pin.x}
                y={pin.y + 3}
                textAnchor="middle"
                fontSize={9}
                fontWeight={600}
                fill="var(--color-paper-raised)"
              >
                {pin.order}
              </text>
            </g>
          ))}

          {/*
            The bed, last so nothing paints over it, and a different *shape* from
            a stop rather than merely a different colour — a colour is the first
            thing a printout loses.
          */}
          {model.base ? (
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
          ) : null}
        </svg>
      </div>

      <figcaption className="mt-1.5 text-[11px] leading-snug text-ink-faint">
        Numbered in the order above, from where you are staying. Straight lines, not routes.
        {omitted > 0
          ? ` ${omitted} ${omitted === 1 ? 'stop is' : 'stops are'} not drawn, because nobody publishes where ${omitted === 1 ? 'it is' : 'they are'}.`
          : ''}
      </figcaption>
    </figure>
  );
}
