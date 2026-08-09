import Link from 'next/link';
import {
  RESEARCH_READINESS_COPY,
  RESEARCH_REPAIR_COPY,
  reportableDeficits,
  type DestinationResearchReadiness,
} from '@sidequest/core';
import { Panel, buttonClass } from './ui';

/**
 * WHAT WE FOUND, AND WHETHER IT IS ENOUGH.
 *
 * The one screen where the research reading becomes something a traveller can
 * act on rather than a value on an artifact. Four states, and they must not look
 * alike — the whole failure this contract exists to prevent is a thin or
 * misrepresentative board being mistaken for a full one.
 *
 * Three rules the copy holds to.
 *
 * **No jargon.** Nothing here says packet, portfolio, containment, candidate,
 * provider or compile. A traveller is owed the finding, not the machinery.
 *
 * **No fabricated confidence.** Every number rendered comes from a dimension
 * that measured something; a dimension that could not measure is simply absent
 * rather than shown as zero.
 *
 * **A next action that could actually work.** The actions offered come from the
 * deficits that are binding, so a blocked destination never gets a button that
 * cannot move the thing blocking it.
 */
export function ResearchReadinessPanel({
  tripId,
  readiness,
}: {
  tripId: string;
  readiness: DestinationResearchReadiness;
}) {
  // `ready` is the ordinary case and says nothing: a banner on every healthy
  // trip is a banner nobody reads by the third one.
  if (readiness.level === 'ready') return null;

  const copy = RESEARCH_READINESS_COPY[readiness.level];
  const deficits = reportableDeficits(readiness).slice(0, 4);
  const attempted = readiness.repairsAttempted;
  const blocked = readiness.level === 'blocked';

  return (
    /*
     * The landmark and the test attributes live on a real `section`, not on
     * `Panel`.
     *
     * `Panel` forwards `className`, `as`, `children` and a `testId` and drops
     * everything else — so an `aria-labelledby` and a `data-` attribute handed
     * to it silently vanish. They did, and the first version of this component
     * rendered correctly while every specification that looked for it found
     * nothing and passed vacuously.
     */
    <section
      aria-labelledby="research-readiness-heading"
      data-testid="research-readiness"
      data-readiness-level={readiness.level}
    >
    <Panel
      className={`mt-8 p-5 sm:p-6 ${blocked ? 'border-clay bg-clay-soft' : 'border-amber bg-amber-soft'}`}
    >
      <p className="eyebrow">What we found</p>
      <h2
        id="research-readiness-heading"
        className="mt-2 font-display text-xl text-ink"
        data-testid="readiness-label"
      >
        {copy.label}
      </h2>
      <p className="measure mt-2 text-sm leading-relaxed text-ink">{copy.blurb}</p>
      <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">{readiness.summary}</p>

      {/*
        THE SECOND LOOK, WHEN THERE WAS ONE.

        Recorded whether or not it helped. A repair that achieved nothing and
        then vanished from the record is how an automatic loop comes to look like
        it never ran — and a traveller who waited through it is owed the sentence.
      */}
      {attempted.length > 0 ? (
        <div className="mt-4" data-testid="readiness-recovery">
          <h3 className="text-xs uppercase tracking-[0.12em] text-ink-faint">
            {attempted.length === 1 ? 'We went back for more' : 'We went back for more, twice'}
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
            {attempted.map((entry, index) => (
              <li key={`${entry.repair}-${index}`}>
                {RESEARCH_REPAIR_COPY[entry.repair]} —{' '}
                {entry.outcome === 'improved'
                  ? `found ${entry.visitableAfter - entry.visitableBefore} more.`
                  : 'nothing further came back.'}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {deficits.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs uppercase tracking-[0.12em] text-ink-faint">
            {blocked ? 'What is missing' : 'Worth knowing before you plan'}
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
            {deficits.map((entry) => (
              <li key={entry.dimension}>{entry.detail}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        THE SMALLEST USEFUL NEXT ACTION.

        Only routes that could move something that is actually binding. A blocked
        destination with an identity problem gets the destination screen; one
        with a shape or transport problem gets the answers that set those. Where
        nothing here would help, the panel offers a way back rather than a
        plausible button — which is the same discipline the board's own integrity
        panel already follows.
      */}
      <div className="mt-5 flex flex-wrap gap-2">
        {readiness.binding.includes('identity_agreement') ||
        readiness.binding.includes('destination_coverage') ? (
          <Link href={`/trips/${tripId}/plan`} className={buttonClass('secondary', 'sm')}>
            Check the place we searched
          </Link>
        ) : null}
        {readiness.binding.includes('transport_routeability') ||
        readiness.binding.includes('must_do_coverage') ? (
          <Link href={`/trips/${tripId}/questionnaire`} className={buttonClass('secondary', 'sm')}>
            Change how you are getting around
          </Link>
        ) : null}
        {blocked ? (
          <Link href="/trips/new" className={buttonClass('secondary', 'sm')}>
            Try somewhere else
          </Link>
        ) : null}
      </div>
    </Panel>
    </section>
  );
}
