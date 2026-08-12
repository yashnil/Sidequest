import Link from 'next/link';
import {
  RESEARCH_READINESS_COPY,
  RESEARCH_REPAIR_COPY,
  reportableDeficits,
  type DestinationResearchReadiness,
  type ResearchDimensionReport,
  type ResearchFunnel,
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
/**
 * THE SENTENCE THE COMPILER ALREADY WROTE.
 *
 * This panel used to re-derive its copy from `visitableAfter - visitableBefore`,
 * and that arithmetic cannot express what every repair does. The one that goes
 * back over the map for a place somebody named produces a *truer status* rather
 * than a wider board, so its two counts are equal by construction — and a
 * successful one rendered as **"found 0 more."**
 *
 * `detail` is written where the facts are, per repair, and already reads
 * correctly for every outcome the pipeline produces. Rendering it is both less
 * code and the only version that can be right.
 *
 * The cost note stays, because it is the one thing `detail` deliberately does
 * not say — and it says *what it cost* rather than restating the label above it,
 * which was the previous version's problem.
 */
function attemptSentence(entry: DestinationResearchReadiness['repairsAttempted'][number]) {
  const paid = entry.kind === 'acquire' && (entry.cost?.providerCalls ?? 0) > 0;
  return (
    <>
      {entry.detail}
      {paid ? <span className="text-ink-faint"> This one cost a fresh search.</span> : null}
    </>
  );
}

/**
 * WHAT THE SHORTFALL MEANS FOR THE TRIP, RATHER THAN WHAT IT COUNTED.
 *
 * `detail` is written next to the arithmetic that produced it and reads like it.
 * A live Tokyo board printed three of them in a row:
 *
 *   We know the opening times for 0 of 23.
 *   23 to build days around and 0 smaller finds.
 *   0 quieter finds.
 *
 * Every one is a true measurement, and not one is a sentence a traveller can do
 * anything with — it is §26's "Why we trust this: 0 of 6 checked" three times
 * over, and the middle one does not even name what the numbers count.
 *
 * Three dimensions are rewritten because those three are what a compiled region
 * reports on almost every trip. The rest keep the compiler's sentence, which for
 * them is already a statement about the destination rather than about our
 * instrument.
 *
 * Rewritten at the screen and not at the source deliberately: the same reading
 * feeds the build record and the operator view, where the raw count is the
 * useful form. This is the surface that owes a traveller meaning.
 */
export function deficitSentence(entry: ResearchDimensionReport, funnel: ResearchFunnel): string {
  switch (entry.dimension) {
    case 'hours_evidence': {
      const known = entry.observed ?? 0;
      return known === 0
        ? 'Nobody publishes opening times for any of these, so we have not built a day around anything that might be shut. Check before you set out.'
        : `Opening times are published for only ${known} of them, so we have planned the rest cautiously.`;
    }
    case 'role_diversity': {
      if (funnel.visitable === 0) return entry.detail;
      if (funnel.discoveries === 0) {
        return 'Everything here is a headline sight — nothing smaller turned up to fill the gaps between them.';
      }
      if (funnel.anchors === 0) {
        return 'Plenty of small finds, but nothing big enough to build a day around.';
      }
      return entry.detail;
    }
    case 'hidden_gem_coverage':
      return funnel.discoveries === 0
        ? 'None of this reads as a quiet local find. What we have is the well-known ones.'
        : entry.detail;
    default:
      return entry.detail;
  }
}

export function ResearchReadinessPanel({
  tripId,
  readiness,
}: {
  tripId: string;
  readiness: DestinationResearchReadiness;
}) {
  /**
   * `ready` is the ordinary case and says nothing — unless something was done.
   *
   * A banner on every healthy trip is a banner nobody reads by the third one,
   * and that reasoning is right. What it got wrong is the case where the board
   * is healthy *because* a second look made it so: the panel's own comment below
   * says "a traveller who waited through it is owed the sentence", and the early
   * return meant the sentence was withheld in precisely the case where the work
   * succeeded. Recovery was visible when it failed and invisible when it worked.
   *
   * So a ready board with attempts behind it gets the record and nothing else —
   * no verdict, no deficits, no remedies, because there is nothing wrong.
   */
  if (readiness.level === 'ready') {
    if (readiness.repairsAttempted.length === 0) return null;
    return (
      <section data-testid="research-readiness" data-readiness-level={readiness.level}>
        <Panel className="mt-8 p-5 sm:p-6">
          <div data-testid="readiness-recovery">
            <h3 className="text-xs uppercase tracking-[0.12em] text-ink-faint">
              {readiness.repairsAttempted.length === 1
                ? 'We went back for more'
                : 'What we tried again'}
            </h3>
            <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
              {readiness.repairsAttempted.map((entry, index) => (
                <li key={`${entry.repair}-${index}`}>
                  {RESEARCH_REPAIR_COPY[entry.repair]} —{' '}
                  {attemptSentence(entry)}
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </section>
    );
  }

  const copy = RESEARCH_READINESS_COPY[readiness.level];
  /*
   * The summary is one of the deficit sentences, chosen by the assessor as the
   * headline. Printing it again three lines down under "Worth knowing before you
   * plan" said the same thing twice on one panel — which reads as two problems
   * and is one.
   */
  const deficits = reportableDeficits(readiness)
    .map((entry) => ({ entry, sentence: deficitSentence(entry, readiness.funnel) }))
    .filter(({ sentence }) => sentence !== readiness.summary)
    .slice(0, 4);
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
            {attempted.length === 1 ? 'We went back for more' : 'What we tried again'}
          </h3>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-ink-muted">
            {attempted.map((entry, index) => (
              <li key={`${entry.repair}-${index}`}>
                {attemptSentence(entry)}
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
            {deficits.map(({ entry, sentence }) => (
              <li key={entry.dimension}>{sentence}</li>
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
          /*
           * Editing, not restarting. A blocked reading means the *destination*
           * is thin — it is not a reason to make the traveller re-enter their
           * dates, their party and their must-dos, all of which are still true.
           */
          <Link href={`/trips/${tripId}/edit`} className={buttonClass('secondary', 'sm')}>
            Try somewhere else
          </Link>
        ) : null}
      </div>
    </Panel>
    </section>
  );
}
