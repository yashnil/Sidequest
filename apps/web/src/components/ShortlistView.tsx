'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  MEASURE_BAND_LABELS,
  RANK_BAND_LABELS,
  RERANK_CONTROLS,
  RERANK_LABELS,
  UNKNOWN_REASON_COPY,
  compareDestinations,
  featureRecommendation,
  proposeDestinations,
  rerankBy,
  imageryFallbackFor,
  measureBand,
  shortlistLead,
  shortlistSeparation,
  type DestinationImage as ImageRecord,
  type DestinationShortlist,
  type RankDimension,
  type RankedDestination,
  type RerankControl,
  type TripComposerAnswers,
  type UnknownReason,
} from '@sidequest/core';
import { Badge, ErrorNote, FOCUS_RING, Panel, buttonClass, cx } from './ui';
import { DestinationImage, ImageCredit } from './DestinationImage';
import { adoptDestinationAction, buildShortlistAction } from '@/app/(product)/decide/actions';

/**
 * THE SHORTLIST, AND WHY EACH ONE IS ON IT.
 *
 * A list and a detail beside it, rather than eight tall cards. The comparison is
 * the product here — somebody asking "where should I go" is not choosing between
 * a destination and nothing, they are choosing between eight — and eight cards
 * that each have to carry a full argument are eight cards nobody finishes.
 *
 * Two rules the screen holds:
 *
 * **A band, never a number.** The score is a weighted heuristic; rendering "83"
 * would be a precision the inputs do not have. What is shown is the band, the
 * reasons that produced it, and — through a disclosure — every factor with its
 * own measurement or its own stated absence.
 *
 * **What we could not see is on screen, not in a footnote.** Coverage is
 * rendered as prose beside the band, and the dimensions that came back unknown
 * are listed by name. A destination scored on two-fifths of the evidence and one
 * scored on nine-tenths must not look the same, and this is where that
 * difference becomes visible to somebody who is not reading the code.
 *
 * **Every destination has an image, and most of them are not photographs.** The
 * `images` map holds only what was resolved, licensed, credited and stored by
 * the server action; a destination missing from it gets a coordinate-derived
 * graphic drawn from its own centre point. Both arrive through one component, so
 * there is no branch here that can produce an empty frame — and no card that
 * looks broken because nobody has photographed a valley under a licence a
 * commercial product may use.
 *
 * **Two layouts, because a tie is a different screen from a ranking.** The
 * comparison layout above assumes the ranking separates. When it does not — the
 * ordinary case on this index, where eight regions score within five points of
 * each other — the same layout put eight equal cards in a column under a
 * headline admitting we could not tell them apart, and the reviewer who opened
 * it got a page whose entire content was our own uncertainty. So a shortlist
 * that does not rank collapses to *one* recommendation with its picture and its
 * argument, the rest as a short secondary list underneath, and every caveat
 * behind a single disclosure. Which one leads, and what may be claimed for it,
 * is `shortlistLead`'s decision, not this file's.
 */

/**
 * The smallest a control on this screen may be.
 *
 * WCAG 2.5.5's 44 px. The disclosures here are a line of 14 px text — about
 * twenty pixels of target — and on the screen where somebody chooses where to go
 * they are the only way to the evidence.
 *
 * Two forms, because a `<summary>` cannot take the first one. A summary is a
 * `display: list-item`, and turning it into a flex box removes the disclosure
 * triangle in every WebKit-derived browser — a 44 px target that no longer looks
 * like a control is not an improvement. So a summary grows by padding, which
 * keeps the marker, and everything else grows by `min-height`.
 */
const MIN_TARGET = 'min-h-11';
const MIN_TARGET_SUMMARY = 'min-h-11 py-3';

const BAND_TONE = {
  strong_match: 'pine',
  worth_a_look: 'blue',
  possible: 'neutral',
  thin_evidence: 'amber',
} as const;

export function ShortlistView({
  sessionId,
  shortlist,
  answers,
  answersSummary,
  images = {},
}: {
  sessionId: string;
  shortlist: DestinationShortlist | null;
  /**
   * What the traveller told us.
   *
   * The featured cards state a sub-window inside the free dates, a trip concept
   * and a budget fit, and every one of those is a function of the answers as
   * well as of the ranking — so the answers come in rather than being inferred
   * from the picks, which could only ever produce a guess about what was asked.
   */
  answers: TripComposerAnswers;
  /** One line of what was asked, so the list is readable without scrolling up. */
  answersSummary: string;
  /**
   * Persisted, licensed photographs by index entry id. Read from a table by the
   * page; never fetched here, and empty is the ordinary case rather than a fault.
   */
  images?: Record<string, ImageRecord>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /*
   * Nothing chosen yet, rather than the first row chosen.
   *
   * The default is resolved below, after the lead is known — because when the
   * ranking does not separate the lead is not necessarily `picks[0]`, and a
   * state initialiser that reached for the first row would select one
   * destination while the page argued for another.
   */
  const [selected, setSelected] = useState<string | null>(null);
  /*
   * V11 §3 — RERANKING AND COMPARISON ARE CLIENT WORK, BECAUSE THEY HAVE TO BE.
   *
   * "Warmer", "closer", "less touristy" re-weight dimensions the ranker has
   * already measured and stored on every pick, so pressing one needs no server
   * round trip, no model and no new evidence — it re-asks the same question with
   * the traveller's new emphasis. A control that had to go and fetch something
   * would be a control that pretends to know more afterwards than it did before.
   */
  const [leaning, setLeaning] = useState<RerankControl[]>([]);
  const [comparingTo, setComparingTo] = useState<string | null>(null);
  const inFlight = useRef(false);

  /*
   * Rank whenever there is nothing stored, and only one request at a time.
   *
   * A button whose only possible answer is "yes, do the thing I already asked
   * for" is a click that exists because the code needed one — the same rule the
   * destination lookup already follows.
   *
   * The guard is a *request in flight*, not a once-ever latch, and the
   * difference is a defect a second consecutive browser run caught. A latch
   * survives the component: revising the answers clears the stored shortlist on
   * the server, the page re-renders with nothing, and the latch — still set from
   * the first mount — refuses to rank again. The screen then sits on the loading
   * state forever. It passed the first run only because the refresh occasionally
   * landed before the clear, leaving the *previous* list on screen, which is the
   * stale answer the test exists to forbid.
   */
  useEffect(() => {
    if (shortlist || inFlight.current) return;
    inFlight.current = true;
    startTransition(async () => {
      const result = await buildShortlistAction(sessionId);
      inFlight.current = false;
      if (!result.ok) setError(result.error ?? 'We could not put a list together.');
      else router.refresh();
    });
  }, [shortlist, sessionId, router]);

  if (!shortlist) {
    /*
     * THE ONLY THING BETWEEN THE ANSWERS AND THE LIST, SO IT HAS TO BE TRUE.
     *
     * "Ranking the world against your trip" described a global search this does
     * not run — it scores a bounded set of indexed places — and set an
     * expectation the results then had to survive. Short and literal instead:
     * three named checks and roughly how long they take.
     */
    return (
      <Panel className="p-8 text-center shadow-[var(--shadow-card)]">
        <p className="breathing type-section text-ink">Putting a shortlist together</p>
        <p className="measure mx-auto mt-3 text-sm leading-relaxed text-ink-muted">
          Checking the weather each place gets at that time of year, how much there is to do, and
          how far apart it all is. A few seconds.
        </p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </Panel>
    );
  }

  /**
   * WHEN THE ORDER MEANS NOTHING, THE PAGE MUST NOT NUMBER IT.
   *
   * A live run produced eight administrative polygons and the page headed them
   * "We could not tell these apart" — above a list numbered 1 to 8. The numbers
   * are a stronger claim than the headline is a disclaimer: somebody acts on the
   * first row.
   *
   * So they are dropped rather than dimmed. A greyer 1 is still a 1, and the
   * only honest rendering of a rank we do not stand behind is no rank at all.
   *
   * The test used to be `band === 'thin_evidence'` on every pick, and it let the
   * numbers straight back in the moment the traveller answered enough questions
   * to lift the band: measured over the live index, a fully answered composer
   * produces eight picks scored 87, 87, 87, 87, 87, 87, 87 and 91 — all
   * `worth_a_look`, seven of them indistinguishable, numbered 1 to 8. An ordinal
   * is a claim about *this row against the next one*, so the condition has to be
   * too: numbers appear only where every adjacent pair actually differs.
   * `shortlistSeparation` is the one definition, shared with the page.
   */
  const separation = shortlistSeparation(shortlist.picks);
  const orderIsMeaningless = !separation.separates;
  const lead = shortlistLead(shortlist.picks, separation);
  /** Said once, at list scope, in `Caveats`. The panels do not repeat these. */
  const alreadySaid = new Set(separation.unmeasured.map((entry) => entry.id));

  /*
   * The lead first, then everything else in the order the ranker produced.
   *
   * Only reorders when the ranking does not separate — where the sequence is a
   * tiebreak over catalogue ids and moving one row costs nothing true. It buys
   * the property the whole screen rests on: the destination the page argues for,
   * the destination selected in the panel and the first row of the list are the
   * same destination. They were not, briefly, and the version where they
   * disagreed is the one that plans a trip to somewhere the page never
   * recommended.
   */
  const ordered =
    orderIsMeaningless && lead
      ? [
          shortlist.picks.find((pick) => pick.entryId === lead.entryId)!,
          ...shortlist.picks.filter((pick) => pick.entryId !== lead.entryId),
        ]
      : shortlist.picks;

  /*
   * V11 §3 — the answer is three and a wildcard, not a list of eight.
   *
   * Five to eight is the right size for a shortlist and the wrong size for an
   * answer. `proposeDestinations` takes the best three and then chooses the
   * *most different* remaining candidate that still scores respectably — a
   * fourth-place near-twin of the third teaches nobody anything.
   */
  const leaned = leaning.length > 0 ? rerankBy(ordered, leaning) : ordered;
  const proposals = proposeDestinations({ picks: leaned });
  /*
   * The featured set is three and a wildcard; the rest are **demoted, never
   * hidden**. That distinction is the screen's own long-standing principle and
   * it is right: a traveller who disagrees with our three has to be able to see
   * the fourth, and a list that silently drops half of what was scored is a
   * verdict wearing the clothes of a choice. So the emphasis changes and the
   * reachability does not — the featured four are labelled and come first, and
   * everything else follows in the order the ranking produced.
   */
  const roleOf = new Map(proposals.map((proposal) => [proposal.destination.entryId, proposal] as const));
  const shown = [...proposals.map((proposal) => proposal.destination), ...leaned.filter((pick) => !roleOf.has(pick.entryId))];

  const current = shown.find((pick) => pick.entryId === selected) ?? shown[0] ?? ordered[0];
  /*
   * A COMPARISON NEEDS TWO DESTINATIONS.
   *
   * `comparingTo === current` produced `compareDestinations(x, x)` — every
   * dimension tied, and the screen said so in a full sentence: "on everything we
   * could measure, these two came out the same". It was comparing a destination
   * with itself, and it was reachable by pressing Compare on the card the page
   * had already selected, which is the first thing anybody presses.
   *
   * The right side is dropped when it is the left side. `compareWith` below then
   * moves the *selection* rather than the target, so pressing Compare on the
   * selected card gives a real pair instead of nothing.
   */
  const against = comparingTo && comparingTo !== current?.entryId ? shown.find((pick) => pick.entryId === comparingTo) : undefined;
  const comparison = against && current ? compareDestinations(current, against) : null;

  /** Press Compare on a card: it becomes the right-hand side, and the left side is never itself. */
  const compareWith = (entryId: string) => {
    if (comparingTo === entryId) {
      setComparingTo(null);
      return;
    }
    if (current?.entryId === entryId) {
      const other = shown.find((pick) => pick.entryId !== entryId);
      if (other) setSelected(other.entryId);
    }
    setComparingTo(entryId);
  };

  if (shortlist.picks.length === 0) {
    return (
      <Panel className="p-8 shadow-[var(--shadow-card)]">
        <h2 className="display-md text-ink">Nothing came back</h2>
        <p className="measure mt-3 leading-relaxed text-ink-muted">
          {shortlist.considered === 0
            ? 'We had nothing to rank — see below for why. That is about us, not about anywhere.'
            : `We scored ${shortlist.considered} places and none of them cleared the bar for this trip. Widening your dates or your nights is the change that usually helps most.`}
        </p>
        <div className="mt-6">
          <Caveats shortlist={shortlist} separation={separation} />
        </div>
      </Panel>
    );
  }

  /*
   * V11 §A2 — ONE LAYOUT, AND THE ANSWER IS AT THE TOP OF IT.
   *
   * There were two layouts here — a comparison grid when the scores separated
   * and a single-recommendation column when they did not — and the reason the
   * second one existed was sound: a page whose entire content is eight
   * indistinguishable cards under a headline admitting we cannot tell them apart
   * is a report on our own confidence, not an answer.
   *
   * But two layouts for one screen is also how a traveller comes to believe they
   * are looking at two products, and the honest-verdict problem the second
   * layout solved is not a *layout* problem: it is a question of what the
   * featured cards are allowed to claim. `shortlistLead` already answers that,
   * per destination, in words. So there is one layout now — three and a
   * wildcard, prominent, with everything else demoted below them — and the claim
   * each card makes is `lead.basis`'s decision, exactly as it was.
   */
  const best = proposals.filter((proposal) => proposal.role === 'best_fit');
  const wildcard = proposals.find((proposal) => proposal.role === 'wildcard') ?? null;
  const demoted = leaned.filter((pick) => !roleOf.has(pick.entryId));

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-sm text-ink-muted">{answersSummary}</p>
        <p className="text-xs text-ink-faint">
          {shortlist.considered} places scored
          {shortlist.climateRequests > 0
            ? ` · ${shortlist.climateRequests} climate lookup${shortlist.climateRequests === 1 ? '' : 's'}`
            : ''}
          {/* A tenth of a second rendered as "0.0s" is not a duration anybody
              wanted; below that threshold the honest report is the word. */}
          {shortlist.elapsedMs >= 100 ? ` · ${(shortlist.elapsedMs / 1000).toFixed(1)}s` : ' · instant'}
        </p>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <section aria-labelledby="shortlist-best" data-testid="shortlist-featured">
        <h2 id="shortlist-best" className="eyebrow">
          {best.length >= 3 ? 'Our top three' : best.length === 2 ? 'Our top two' : 'Where we would go'}
        </h2>
        {/*
          The honest verdict, once, at the top — not a headline per card.

          When nothing separated the picks this is the sentence that says so, and
          it replaces the whole second layout that used to exist for this case.
        */}
        {lead && lead.basis !== 'outscored' ? (
          <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
            {lead.basis === 'best_evidenced'
              ? `${lead.tiedWith} of these fit your answers equally well. We have put first the one we could check the most of.`
              : `${lead.tiedWith} of these fit your answers equally well and nothing we can measure tells them apart. The order below is not a verdict.`}
          </p>
        ) : null}

        {/*
          V11 §O — THE ANSWER ARRIVES, IT DOES NOT APPEAR.

          A rise from below, once, staggered a tenth of a second apart so the
          three read left to right rather than blinking on together. `.rise` is
          CSS-only (`@starting-style`), so no JavaScript runs for it, and the
          reduced-motion block at the end of `globals.css` removes it entirely.
          Nothing here loops and nothing here delays a control becoming usable.
        */}
        <ol className={cx('mt-5 grid gap-5', best.length > 1 && 'md:grid-cols-2 xl:grid-cols-3')}>
          {best.map((proposal, index) => (
            <li key={proposal.destination.entryId} className="rise" style={{ transitionDelay: `${index * 90}ms` }}>
              <Featured
                sessionId={sessionId}
                pick={proposal.destination}
                answers={answers}
                image={images[proposal.destination.entryId] ?? null}
                pending={pending}
                onError={setError}
                selected={current?.entryId === proposal.destination.entryId}
                leads={lead?.basis === 'outscored' && proposal.destination.entryId === lead.entryId}
                alreadySaid={alreadySaid}
                onWhy={() => setSelected(proposal.destination.entryId)}
                onCompare={() => compareWith(proposal.destination.entryId)}
                comparing={comparingTo === proposal.destination.entryId}
              />
            </li>
          ))}
        </ol>
      </section>

      {wildcard ? (
        <section aria-labelledby="shortlist-wildcard">
          <h2 id="shortlist-wildcard" className="eyebrow text-accent">
            Wildcard
          </h2>
          {wildcard.wildcardReason ? (
            <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">{wildcard.wildcardReason}</p>
          ) : null}
          <div className="rise mt-5" style={{ transitionDelay: '270ms' }}>
            <Featured
              sessionId={sessionId}
              pick={wildcard.destination}
              answers={answers}
              image={images[wildcard.destination.entryId] ?? null}
              pending={pending}
              onError={setError}
              selected={current?.entryId === wildcard.destination.entryId}
              leads={false}
              alreadySaid={alreadySaid}
              onWhy={() => setSelected(wildcard.destination.entryId)}
              onCompare={() => compareWith(wildcard.destination.entryId)}
              comparing={comparingTo === wildcard.destination.entryId}
              wide
            />
          </div>
        </section>
      ) : null}

      {/*
        * V11 §3 — the reranking controls.
        *
        * Each one re-weights dimensions already measured on every pick, so the
        * list reorders instantly and nothing is fetched. Pressed state is a
        * toggle, and several can be on at once — "cheaper" and "closer" is a
        * real thing to want.
        */}
      <section aria-labelledby="shortlist-lean" className="rule-top pt-6">
        <h2 id="shortlist-lean" className="eyebrow">
          Lean the list
        </h2>
        <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
          These re-sort what we already worked out. Nothing new is looked up, and nothing is added to the list.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {RERANK_CONTROLS.map((control) => {
            const on = leaning.includes(control);
            return (
              <button
                key={control}
                type="button"
                aria-pressed={on}
                onClick={() => setLeaning((previous) => (previous.includes(control) ? previous.filter((entry) => entry !== control) : [...previous, control]))}
                className={cx(buttonClass(on ? 'primary' : 'secondary', 'sm'), 'rounded-full')}
              >
                {RERANK_LABELS[control]}
              </button>
            );
          })}
          {leaning.length > 0 ? (
            <button type="button" onClick={() => setLeaning([])} className={cx(buttonClass('ghost', 'sm'), 'rounded-full')}>
              Clear
            </button>
          ) : null}
        </div>
      </section>

      {/*
        * V11 §3 — "Why this over that?".
        *
        * Only the dimensions where the two genuinely differ, widest first, with
        * the ties reported as a count. A table where most rows say "the same"
        * buries the two that do not.
        */}
      {current && shown.length > 1 ? (
        <section aria-labelledby="shortlist-compare" className="rule-top pt-6">
          <h2 id="shortlist-compare" className="eyebrow">
            Why {current.displayName} over…
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {shown
              .filter((pick) => pick.entryId !== current.entryId)
              .map((pick) => (
                <button
                  key={pick.entryId}
                  type="button"
                  aria-pressed={comparingTo === pick.entryId}
                  onClick={() => compareWith(pick.entryId)}
                  className={cx(buttonClass(comparingTo === pick.entryId ? 'primary' : 'secondary', 'sm'), 'rounded-full')}
                >
                  {pick.displayName}
                </button>
              ))}
          </div>
          {comparison ? (
            <div className="mt-4">
              {comparison.differences.length === 0 ? (
                <p className="measure text-sm leading-relaxed text-ink-muted">
                  On everything we could measure, these two came out the same. The choice is yours to make on something we did not weigh.
                </p>
              ) : (
                <ul className="grid gap-2">
                  {comparison.differences.slice(0, 5).map((difference) => (
                    <li key={difference.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                      <span className="label w-44 shrink-0 text-ink-faint">{difference.label}</span>
                      <span className={difference.delta > 0 ? 'text-pine' : 'text-ink-muted'}>
                        {difference.delta > 0 ? comparison.left.displayName : comparison.right.displayName}
                      </span>
                      <span className="text-ink-muted">
                        {(difference.delta > 0 ? difference.left : difference.right)?.basis ?? 'we could not measure this on the other one'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {comparison.tied.length > 0 ? (
                <p className="mt-3 text-xs text-ink-faint">
                  They came out level on {comparison.tied.length} other {comparison.tied.length === 1 ? 'thing' : 'things'}.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/*
        DEMOTED, NEVER HIDDEN.

        A traveller who disagrees with our three has to be able to see the
        fourth, and a list that silently drops half of what was scored is a
        verdict wearing the clothes of a choice. So the emphasis changes and the
        reachability does not.
      */}
      {demoted.length > 0 ? (
        <section aria-labelledby="shortlist-others" className="rule-top pt-6">
          <h2 id="shortlist-others" className="eyebrow">
            Also scored
          </h2>
          <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
            {separation.undifferentiated
              ? 'These came out level with the ones above. Open one to see what we know about it.'
              : 'These scored below the ones above. Open one to see what we know about it.'}
          </p>
          <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3" aria-label="Other destinations scored">
            {demoted.map((pick) => (
              <li key={pick.entryId}>
                <button
                  type="button"
                  onClick={() => setSelected(pick.entryId)}
                  aria-current={current?.entryId === pick.entryId}
                  className={cx(
                    MIN_TARGET,
                    FOCUS_RING,
                    'flex w-full items-baseline justify-between gap-3 rounded-[var(--radius-control)] px-3 py-2.5 text-left hover:bg-paper-sunk',
                    current?.entryId === pick.entryId && 'bg-paper-sunk',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink">{pick.displayName}</span>
                    <span className="block truncate text-xs text-ink-muted">{pick.qualifiedName}</span>
                  </span>
                  <span className="shrink-0 text-xs text-ink-faint">{RANK_BAND_LABELS[pick.band]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/*
        EVERY CAVEAT BEHIND ONE DISCLOSURE.

        Three surfaces used to state their own: a diversity note in its own
        panel, a removals disclosure, and an always-open list of six things the
        ranking cannot see — which on the tied case ran to eleven consecutive
        negative sentences under the results. One summary line, with the count in
        it, is the §26 shape: the material is still one click away and reachable,
        and it has stopped being the loudest thing on the page.
      */}
      <Caveats shortlist={shortlist} separation={separation} />
    </div>
  );
}

/**
 * V11 §A2 — A FEATURED RECOMMENDATION.
 *
 * Seven things the brief asks each one to communicate — the destination, a
 * recommended sub-window inside the free dates, why it fits *this* traveller,
 * the trip concept, its defining draws, budget fit, travel burden and the main
 * tradeoff — and every one of them is derived by `featureRecommendation` from
 * measurements the ranking already made. A line whose measurement came back
 * unknown says so in words; none of them is ever filled with something
 * plausible.
 *
 * Three actions, per the brief: **Why this?** selects the destination so the
 * evidence panel below shows it, **Compare** puts it against the current
 * selection, and **Plan this** is the one that ends the screen.
 */
function Featured({
  sessionId,
  pick,
  answers,
  image,
  pending,
  onError,
  selected,
  leads,
  alreadySaid,
  onWhy,
  onCompare,
  comparing,
  wide = false,
}: {
  sessionId: string;
  pick: RankedDestination;
  answers: TripComposerAnswers;
  image: ImageRecord | null;
  pending: boolean;
  onError: (message: string | null) => void;
  selected: boolean;
  /** Whether this one outscored every other. The only licence for the words "why this one". */
  leads: boolean;
  /** Dimensions already named once at list scope, so a card does not repeat them. */
  alreadySaid: ReadonlySet<RankDimension>;
  onWhy: () => void;
  onCompare: () => void;
  comparing: boolean;
  wide?: boolean;
}) {
  const [adopting, startAdopt] = useTransition();
  const card = featureRecommendation(pick, answers);

  return (
    <article
      data-testid="shortlist-featured-card"
      className={cx(
        'flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] border bg-paper-raised',
        selected ? 'border-accent' : 'border-rule',
      )}
    >
      {/*
        The credit sits at the card's foot, not under the picture.

        Two to four lines of dotted-underlined attribution directly above a
        place's name makes the photographer the loudest text on a card about a
        valley — the defect the board card already fixed this way. It is still
        rendered, and still reachable: an obligation to credit is discharged only
        where a picture is actually shown, so a card that shows one always
        carries it.
      */}
      {/*
        V11 §J — THE CONFIDENCE LADDER DECIDES WHICH FRAME A FILE MAY FILL.

        `verified_commons_category` is `moderate`, and the imagery schema says of
        that band, in these words, "good enough to sit beside a name, not good
        enough to headline a page". The three featured cards sit beside a name at
        card scale, so a moderate match belongs on them. The wildcard is drawn
        wide and reads as a hero — so it takes a `strong` match or it takes the
        designed graphic, which is the same gate the detail panel's hero applies.
      */}
      <DestinationImage
        image={wide && image?.subjectConfidence !== 'strong' ? null : image}
        fallback={fallbackFor(pick)}
        credit="none"
        ratio={wide ? '21 / 9' : '16 / 9'}
      />

      <div className="flex min-w-0 flex-1 flex-col p-5">
        {/*
          "Why this one" is a promise that a choice was made. It may be said only
          about a pick that actually outscored the rest — with eight equal scores
          it is the page asserting a recommendation the ranking never made, and
          the honest verdict for that case is stated once above these cards.
        */}
        {leads ? <p className="eyebrow text-accent-strong">Why this one</p> : null}
        <h3 className={cx('font-display text-2xl leading-tight text-ink', leads && 'mt-1')}>{pick.displayName}</h3>
        <p className="mt-0.5 text-xs text-ink-muted">{pick.qualifiedName}</p>

        {card.window ? (
          <p className="type-figure mt-3 text-sm text-ink">
            {formatWindow(card.window.startDate, card.window.endDate)}
            <span className="ml-2 font-sans text-xs text-ink-faint">
              {card.window.wholeWindow ? 'your whole free window' : `${card.window.nights} nights`}
            </span>
          </p>
        ) : null}

        {card.concept ? <p className="mt-3 text-sm leading-relaxed text-ink">{card.concept}</p> : null}

        {card.fit.length > 0 ? (
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">{card.fit[0]}</p>
        ) : null}

        {card.draws.length > 0 ? (
          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{card.draws[0]}</p>
        ) : null}

        {/*
          One row, never a two-column grid. At card width "Getting there" and
          "Not checked" landed on different lines with the value under the wrong
          label, which is worse than saying nothing.
        */}
        <dl className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <div className="flex items-baseline gap-1.5">
            <dt className="label text-ink-faint">Budget</dt>
            <dd className="text-ink">{card.budget.word}</dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="label text-ink-faint">Getting there</dt>
            <dd className="text-ink">{card.travel.word}</dd>
          </div>
        </dl>

        {card.tradeoff ? (
          <p className="mt-4 border-t border-rule pt-3 text-sm leading-relaxed text-ink-muted">
            <span className="label mr-2 text-ink-faint">Tradeoff</span>
            {card.tradeoff}
          </p>
        ) : null}

        {/*
          THE EVIDENCE LIVES ON THE CARD, ONE LINE HIGH.

          It used to be a second panel below the three cards — a hero picture,
          the name again, the same reasons, the same tradeoff and the factor
          table — so the page argued for its lead destination twice, two hundred
          pixels apart. That is the exact duplication V11 §3 removed from Book
          and from Prepare, reintroduced by a layout change.

          Folded onto the card it belongs to, every destination gets its own
          evidence instead of only the selected one, and a closed disclosure
          costs one line rather than four hundred words.
        */}
        <details className="mt-4 border-t border-rule pt-3">
          <summary className={cx(MIN_TARGET_SUMMARY, 'cursor-pointer text-xs text-ink-muted')}>What we checked, one thing at a time</summary>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            A rough read on each, not a score out of ten — some of these matter more than others, and a few we could not
            check at all. Worth skimming; not worth adding up.
          </p>

          {pick.reasons.length > 1 ? (
            <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-ink">
              {pick.reasons.slice(1).map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          ) : null}

          {pick.conflicts.length > 0 ? (
            <ul className="mt-3 space-y-1.5 text-xs leading-relaxed text-amber">
              {pick.conflicts.map((conflict) => (
                <li key={conflict.code}>{conflict.message}</li>
              ))}
            </ul>
          ) : null}

          {/*
            ONLY WHAT IS TRUE OF *THIS* ONE. A dimension nobody could measure for
            any candidate belongs to the whole list and is stated once, in
            `Caveats`. What stays here is the difference: a dimension we could
            read for the others and not for this one.
          */}
          {(() => {
            const own = pick.factors.filter((factor) => factor.measure.kind === 'unknown' && !alreadySaid.has(factor.id));
            if (own.length === 0) return null;
            return (
              <div className="mt-3">
                <p className="eyebrow">What we could not see about this one</p>
                <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-ink-muted">
                  {own.map((factor) => (
                    <li key={factor.id}>
                      {factor.label} — {UNKNOWN_REASON_COPY[(factor.measure as { reason: UnknownReason }).reason]}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}

          <dl className="mt-3 space-y-1.5 text-xs">
            {pick.factors.map((factor) => (
              <div key={factor.id} className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-muted">{factor.label}</dt>
                <dd className="text-right text-ink">
                  {factor.measure.kind === 'measured' ? (
                    <>
                      <span>{MEASURE_BAND_LABELS[measureBand(factor.measure.value)]}</span>
                      <span className="ml-2 text-ink-faint">{factor.measure.basis}</span>
                    </>
                  ) : (
                    <span className="text-ink-faint">we could not check this</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          <p className="mt-3 text-xs text-ink-faint">
            <Badge tone={BAND_TONE[pick.band]}>{RANK_BAND_LABELS[pick.band]}</Badge>
            <span className="ml-2">{coverageWord(pick.coverage)}</span>
          </p>
        </details>

        {/*
          V11 §N — THE PRIMARY ACTION SITS ON ONE BASELINE ACROSS THE THREE.

          The credit used to follow the action row, so a card whose picture
          carried an obligation had its "Plan this" lifted by the height of two
          dotted-underlined lines while the cards beside it did not: three
          primary buttons on three different baselines, which reads as three
          different kinds of card rather than three choices of one kind. Credit
          and actions are now one block pushed to the bottom together, with the
          credit directly above the actions rather than under them. The
          obligation is unchanged — it is still on screen wherever the picture is.
        */}
        <div className="mt-auto pt-5">
          {/* Credited only where a picture was actually drawn: an obligation to credit follows the file on screen. */}
          {image && !(wide && image.subjectConfidence !== 'strong') ? <ImageCredit image={image} className="mb-3" /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={cx(buttonClass('accent', 'md'), MIN_TARGET)}
              disabled={pending || adopting}
              onClick={() => {
                onError(null);
                startAdopt(async () => {
                  const result = await adoptDestinationAction(sessionId, pick.entryId);
                  if (!result.ok) onError(result.error ?? 'We could not save that.');
                });
              }}
            >
              {/*
                "Plan this", not "Plan <name>". The card's own heading is the name,
                two lines above the button, so repeating it inside the label says
                nothing new and wraps three actions onto three lines at card width.
              */}
              {adopting ? 'Setting it up…' : 'Plan this'}
            </button>
            <button type="button" onClick={onWhy} aria-pressed={selected} className={cx(buttonClass('secondary', 'md'), MIN_TARGET)}>
              Why this?
            </button>
            <button type="button" onClick={onCompare} aria-pressed={comparing} className={cx(buttonClass('ghost', 'md'), MIN_TARGET)}>
              Compare
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * A window as a person would write it.
 *
 * Deliberately not a locale-formatted date: these are the dates a traveller
 * typed, and re-rendering them in a format they did not choose is one more place
 * for a day to shift by one.
 */
function formatWindow(startDate: string, endDate: string): string {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const month = (date: Date) => MONTH_SHORT[date.getUTCMonth()];
  const same = start.getUTCMonth() === end.getUTCMonth() && start.getUTCFullYear() === end.getUTCFullYear();
  return same
    ? `${month(start)} ${start.getUTCDate()}–${end.getUTCDate()}`
    : `${month(start)} ${start.getUTCDate()} – ${month(end)} ${end.getUTCDate()}`;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * ONE PLACE FOR EVERYTHING WE COULD NOT DO.
 *
 * Four separate confessions used to sit under the results — a diversity note, a
 * removals list, the blind spots and, on the page above, the unmeasured
 * dimensions — each correct, each in its own container, adding up to a screen
 * whose loudest content was our own limitations. §26's rule is one statement per
 * unknown at the highest scope that is true, and §21's is that the caveat must
 * still be reachable. A single disclosure with the count in its summary line
 * satisfies both, and the count is what makes it worth opening.
 *
 * `separation` comes in rather than being recomputed: the flat and unmeasured
 * lists are facts about the ranking that the page and this component both read,
 * and two derivations of the same fact is how they come to disagree.
 */
function Caveats({
  shortlist,
  separation,
}: {
  shortlist: DestinationShortlist;
  separation: ReturnType<typeof shortlistSeparation>;
}) {
  const lines: string[] = [];
  if (separation.flat.length > 0) {
    lines.push(
      `What we could measure came back the same for all of them: ${separation.flat
        .map((entry) => entry.label.toLowerCase())
        .join(', ')}. So none of it separated one from another.`,
    );
  }
  for (const entry of separation.unmeasured) {
    lines.push(`${entry.label} — ${UNKNOWN_REASON_COPY[entry.reason]}`);
  }
  lines.push(...shortlist.blindSpots);
  if (shortlist.diversityNote) lines.push(shortlist.diversityNote);

  const removed = shortlist.excluded.length;
  if (lines.length === 0 && removed === 0) return null;

  return (
    <details className="rounded-[var(--radius-card)] border border-rule bg-paper-sunk p-5">
      <summary className={cx(MIN_TARGET_SUMMARY, 'cursor-pointer text-sm font-medium text-ink')}>
        {lines.length > 0
          ? `${lines.length} thing${lines.length === 1 ? '' : 's'} we could not check`
          : 'What we took off the list'}
        {removed > 0 ? `, and ${removed} we took off the list` : ''}
      </summary>
      {lines.length > 0 ? (
        <ul className="measure mt-3 space-y-1.5 text-sm leading-relaxed text-ink-muted">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {removed > 0 ? (
        <ul className="mt-3 space-y-2 border-t border-rule pt-3 text-sm text-ink-muted">
          {shortlist.excluded.map((entry) => (
            <li key={entry.entryId}>
              <span className="text-ink">{entry.displayName}</span> — {entry.exclusion.message}
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

/**
 * The graphic a destination gets when nobody has licensed a photograph of it.
 *
 * Derived here rather than passed down, because it is a pure function of the
 * pick's own centre point and identity — sending it over the wire would be
 * shipping bytes that the client can compute, and would open the possibility of
 * a stale fallback describing a different set of coordinates from the ones on
 * the card beside it.
 */
function fallbackFor(pick: RankedDestination) {
  return imageryFallbackFor({
    kind: 'destination',
    id: pick.entryId,
    name: pick.displayName,
    coordinates: pick.center,
  });
}

/**
 * Coverage as a word, because the number is not the point.
 *
 * What a traveller needs from it is whether the answer rests on much or little,
 * and "measured on 62% of the evidence" invites a comparison between two
 * percentages that were never meant to be subtracted.
 */
/* V11 §20 — "evidenced" is our word for our own process. What a traveller wants to know is how much of this we were actually able to check. */
function coverageWord(coverage: number): string {
  if (coverage >= 0.85) return 'We checked most of this';
  if (coverage >= 0.7) return 'We checked a good deal of this';
  if (coverage >= 0.5) return 'We checked some of this';
  return 'We could not check much of this';
}
