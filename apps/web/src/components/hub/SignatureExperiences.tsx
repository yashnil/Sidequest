import type { ReactNode } from 'react';
import { cx } from '../ui';

/**
 * V6 — THE THREE THINGS THIS TRIP IS BUILT AROUND.
 *
 * The overview used to list five core anchors as a divided list of headline
 * and one grey sentence — the same shape as every other list on the page, and
 * indistinguishable from the day rail three centimetres above it. The trip's
 * defining experiences are the reason somebody chose this plan over another
 * one, and they are the only place on the overview where a photograph earns
 * its space.
 *
 * Three, not five: a signature is not an inventory. Each card is a link into
 * the day that holds it, so the section is navigation as well as argument.
 * A trip with no photograph anywhere renders the same cards without frames —
 * never a stand-in picture of somewhere else.
 */
export interface SignatureExperience {
  id: string;
  name: string;
  dayNumber: number;
  why: string;
  /** A `DestinationImage` for this place, or null when nothing licensable exists. */
  image?: ReactNode;
}

export function SignatureExperiences({ experiences }: { experiences: readonly SignatureExperience[] }) {
  if (experiences.length === 0) return null;
  const framed = experiences.some((experience) => experience.image);
  return (
    <section aria-labelledby="signature-experiences" data-testid="defining-moments">
      <p className="eyebrow">Signature experiences</p>
      <h2 id="signature-experiences" className="mt-1 type-section text-ink">
        The trip is built around
      </h2>
      {/*
        V8 — cards, with a picture where one of this trip's own places has a
        licensed one and a fixed-ratio plate where none does, so three cards
        line up whether or not each has a photograph. Never a stand-in picture
        of somewhere else.
      */}
      {/*
        Two columns from `sm`, three only from `xl`: the overview is itself two
        columns from `lg`, and three cards inside a 560-pixel column wrapped
        every title onto five lines on a tablet.
      */}
      <ol className={cx('mt-4 grid gap-4', experiences.length > 1 && 'sm:grid-cols-2', experiences.length > 2 && 'xl:grid-cols-3')}>
        {experiences.map((experience) => (
          <li key={experience.id} className="min-w-0">
            <a href={`#day-${experience.dayNumber}`} className="card lift pressable group flex h-full flex-col overflow-hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine" data-testid="signature-experience">
              {framed ? (
                experience.image ? (
                  <div className="[&_figure]:m-0 [&_img]:rounded-none">{experience.image}</div>
                ) : (
                  <div aria-hidden="true" className="atlas aspect-[4/3] w-full" />
                )
              ) : null}
              <span className="flex min-w-0 flex-1 flex-col px-4 pb-4 pt-3.5">
                <span className="type-figure text-xs text-ink-faint">Day {experience.dayNumber}</span>
                <span className="mt-1 block font-display text-xl leading-snug text-ink group-hover:underline group-hover:underline-offset-4">{experience.name}</span>
                {experience.why ? <span className="mt-1.5 block type-small text-ink-muted">{experience.why}</span> : null}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
