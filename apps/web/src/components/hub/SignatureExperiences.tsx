import type { ReactNode } from 'react';
import { cx } from '../ui';

/**
 * THE THREE THINGS THIS TRIP IS BUILT AROUND — as a spread, not three cards.
 *
 * The trip's defining experiences are the reason somebody chose this plan over
 * another, and the one place on the overview where a photograph earns its
 * space. Three equal boxes in a row is the template pattern this product is
 * leaving behind, so the first is a lead print (the photograph whole, at its
 * own shape — share-alike files are never cropped) and the other two follow it
 * as smaller entries, numbered I · II · III like plates in a book. Every entry
 * links into the day that holds it. The credit sits under its own picture,
 * never above the name.
 *
 * Where the plan gives every experience the same sentence (an open-data board
 * knows little about each place), the sentence is said once for the set rather
 * than three times.
 */
export interface SignatureExperience {
  id: string;
  name: string;
  dayNumber: number;
  why: string;
  /** A `DestinationImage` for this place, or null when nothing licensable exists. */
  image?: ReactNode;
  /** The licence credit for that image, rendered under it. */
  credit?: ReactNode;
}

const NUMERALS = ['I', 'II', 'III'];

export function SignatureExperiences({ experiences }: { experiences: readonly SignatureExperience[] }) {
  if (experiences.length === 0) return null;
  const whys = experiences.map((experience) => experience.why.trim()).filter(Boolean);
  const shared = whys.length > 1 && whys.every((why) => why === whys[0]) ? whys[0]! : null;
  const [lead, ...rest] = experiences;
  return (
    <section aria-labelledby="signature-experiences" data-testid="defining-moments">
      <p className="sheet-label text-ink-muted">Signature experiences</p>
      <h2 id="signature-experiences" className="mt-1.5 font-display text-[1.9rem] leading-tight font-light tracking-[-0.02em] text-ink">
        The trip is built around
      </h2>
      {shared ? <p className="mt-2 max-w-[60ch] type-small text-ink-muted">{shared}</p> : null}
      <ol className={cx('mt-6 grid gap-x-8 gap-y-8', rest.length > 0 && 'md:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]')}>
        {lead ? (
          <li className="min-w-0">
            <Entry experience={lead} index={0} lead showWhy={!shared} />
          </li>
        ) : null}
        {rest.length > 0 ? (
          <li className="min-w-0">
            <ol className="ruled border-t border-ink/15">
              {rest.map((experience, index) => (
                <li key={experience.id} className="py-4 first:pt-4">
                  <Entry experience={experience} index={index + 1} lead={false} showWhy={!shared} />
                </li>
              ))}
            </ol>
          </li>
        ) : null}
      </ol>
    </section>
  );
}

function Entry({ experience, index, lead, showWhy }: { experience: SignatureExperience; index: number; lead: boolean; showWhy: boolean }) {
  return (
    <div className={cx('min-w-0', !lead && 'grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,9rem)_minmax(0,1fr)]')}>
      {experience.image ? (
        <figure className={cx('print-frame m-0 self-start', lead && 'rotate-[-0.4deg]')}>
          <div className="[&_figure]:m-0 [&_img]:rounded-none [&>div>figure>div]:rounded-none">{experience.image}</div>
          {lead && experience.credit ? <figcaption className="!font-sans !text-[10.5px] !normal-case !tracking-normal leading-snug">{experience.credit}</figcaption> : null}
        </figure>
      ) : lead ? null : (
        <div aria-hidden="true" className="atlas aspect-[4/3] w-full" />
      )}
      <a
        href={`#day-${experience.dayNumber}`}
        className={cx('group block min-w-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine', lead && Boolean(experience.image) && 'mt-5')}
        data-testid="signature-experience"
      >
        <span className="sheet-label text-ink-muted">
          <span className="text-accent">{NUMERALS[index] ?? index + 1}</span> · Day {experience.dayNumber}
        </span>
        <span className={cx('mt-1 block font-display leading-[1.08] tracking-[-0.015em] text-ink group-hover:underline group-hover:underline-offset-4', lead ? 'text-[2rem] font-light' : 'text-xl')}>{experience.name}</span>
        {showWhy && experience.why ? <span className="mt-1.5 block type-small text-ink-muted">{experience.why}</span> : null}
      </a>
      {!lead && experience.image && experience.credit ? <p className="col-start-2 -mt-2 text-[10.5px] leading-snug text-ink-faint">{experience.credit}</p> : null}
    </div>
  );
}
