import type { ReactNode } from 'react';

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
      <h2 id="signature-experiences" className="type-meta uppercase tracking-[0.14em]">
        The trip is built around
      </h2>
      <ol className={framed ? 'mt-4 grid gap-5 sm:grid-cols-3' : 'mt-3 divide-y divide-rule border-y border-rule'}>
        {experiences.map((experience) => (
          <li key={experience.id} className={framed ? 'min-w-0' : ''}>
            <a
              href={`#day-${experience.dayNumber}`}
              className={
                framed
                  ? 'pressable group block focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine'
                  : 'pressable group flex items-baseline gap-4 py-3 hover:bg-paper-sunk/60'
              }
              data-testid="signature-experience"
            >
              {framed && experience.image ? <div className="mb-2.5">{experience.image}</div> : null}
              {framed ? null : <span className="numeral w-10 shrink-0 text-xs text-ink-faint">Day {experience.dayNumber}</span>}
              <span className="min-w-0 flex-1">
                {framed ? <span className="numeral block text-xs text-ink-faint">Day {experience.dayNumber}</span> : null}
                <span className="block font-display text-xl leading-snug text-ink group-hover:underline group-hover:underline-offset-4">{experience.name}</span>
                {experience.why ? <span className="mt-1 block type-small text-ink-muted">{experience.why}</span> : null}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
