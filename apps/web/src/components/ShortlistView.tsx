'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  MEASURE_BAND_LABELS,
  RANK_BAND_LABELS,
  UNKNOWN_REASON_COPY,
  croppable,
  imageryFallbackFor,
  measureBand,
  shortlistLead,
  shortlistSeparation,
  type DestinationImage as ImageRecord,
  type DestinationShortlist,
  type RankDimension,
  type RankedDestination,
  type ShortlistLead,
  type UnknownReason,
} from '@sidequest/core';
import { Badge, ErrorNote, Panel, buttonClass, cx } from './ui';
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
  answersSummary,
  images = {},
}: {
  sessionId: string;
  shortlist: DestinationShortlist | null;
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
      <Panel className="p-8 text-center">
        <p className="breathing font-display text-xl text-ink">Putting a shortlist together</p>
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

  const current = ordered.find((pick) => pick.entryId === selected) ?? ordered[0];

  if (shortlist.picks.length === 0) {
    return (
      <Panel className="p-8">
        <h2 className="font-display text-2xl text-ink">Nothing came back</h2>
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

  return (
    <div className="space-y-8">
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

      {/*
        THE COMPARISON LAYOUT, OR THE ONE-RECOMMENDATION LAYOUT.

        Not a variant of the same grid. When the scores separate, the product is
        the comparison and the list deserves half the screen; when they do not,
        eight equal cards in a column is the screen a reviewer described as
        "eight identical abstract cards" and it is the wrong object entirely.
        The second layout puts the argument first at every width, which also
        settles the mobile order — the detail used to stack below all eight rows,
        so a phone reached the reasoning two viewports down.
      */}
      {orderIsMeaningless ? (
        <div className="space-y-8">
          {current ? (
            <Detail
              sessionId={sessionId}
              pick={current}
              image={images[current.entryId] ?? null}
              pending={pending}
              onError={setError}
              /*
                A leader with a tie behind it still leads.

                The live shape on a fully answered composer is one at 100 and
                seven at 95: the list below the first row is not ranked, so this
                layout is right, and the first row genuinely outscored the rest,
                so "why this one" is true of it. Withholding the claim here
                would be as inaccurate as the numbering was.
              */
              leads={lead?.basis === 'outscored' && current.entryId === lead.entryId}
              alreadySaid={alreadySaid}
              lead={lead && current.entryId === lead.entryId ? lead : null}
            />
          ) : null}

          <section aria-labelledby="shortlist-others">
            <h2 id="shortlist-others" className="eyebrow">
              {ordered.length === 1
                ? 'The one place we found'
                : `The other ${ordered.length - 1}, and how they compare`}
            </h2>
            <p className="measure mt-2 text-sm leading-relaxed text-ink-muted">
              {separation.undifferentiated
                ? 'All of these came out level with each other. Open one to see what we know about it.'
                : 'These scored the same as each other, so they are in no particular order. Open one to see what we know about it.'}
            </p>
            <ol
              className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
              aria-label="Suggested destinations"
            >
              {ordered.map((pick) => {
                const image = images[pick.entryId] ?? null;
                return (
                  <li key={pick.entryId}>
                    {/*
                      THESE CARDS CARRY THE PICTURES, AND THAT IS A LICENCE
                      DECISION AS MUCH AS A DESIGN ONE.

                      This list was eight text buttons for one release, and the
                      screen it produced showed *no photograph at all* — while six
                      licensed, credited, stored files sat in `destination_images`
                      for the destinations on it. The browser suite caught it as a
                      missing attribution link, which is the right alarm: an
                      obligation to credit is only ever discharged where a picture
                      is actually shown, so a screen that silently stops showing
                      them is a screen that has quietly stopped being the one the
                      licence terms were checked against.

                      It is also where these particular files *belong*. A
                      `verified_commons_category` match is `moderate`, and the
                      schema says of that band, in these words, "good enough to sit
                      beside a name, not good enough to headline a page" — so the
                      hero above stays strong-only and the moderate matches sit
                      here, beside a name, which is the one placement the
                      confidence ladder actually licenses.

                      The card is a div with a button inside it, for the reason the
                      comparison layout gives below: the credit is an anchor, and
                      an anchor inside a button is markup browsers resolve
                      inconsistently.
                    */}
                    <div
                      className={cx(
                        'flex h-full flex-col overflow-hidden rounded-[var(--radius-card)] border pb-4 transition-colors',
                        current?.entryId === pick.entryId
                          ? 'border-pine bg-pine-soft'
                          : 'border-rule bg-paper-raised hover:border-ink-faint',
                      )}
                    >
                      {/*
                        The same treatment the comparison layout gives its rows,
                        deliberately: one uniform frame, never cropped, the whole
                        file over the tinted graphic. Two layouts of one screen
                        that present a destination differently is how a traveller
                        comes to think they are looking at two different products —
                        and a grid of eight frames each taking its own file's shape
                        reads as a rendering fault rather than as a set of pictures.
                      */}
                      <DestinationImage
                        image={image}
                        fallback={fallbackFor(pick)}
                        credit="none"
                        className="px-4 pt-4"
                      />
                      <button
                        type="button"
                        onClick={() => setSelected(pick.entryId)}
                        aria-current={current?.entryId === pick.entryId}
                        className={cx(MIN_TARGET, 'w-full px-4 pt-3 text-left')}
                      >
                        <span className="block font-display text-base leading-tight text-ink">
                          {pick.displayName}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          {pick.qualifiedName}
                        </span>
                      </button>
                      {/*
                        At the foot, not under the picture. Two to four lines of
                        dotted-underlined attribution directly above a place's name
                        makes the photographer the loudest text on a card about a
                        valley — the defect the board card already fixed this way.
                        `mt-auto` holds the credits on one line across a row of
                        cards whose names wrap to different depths.
                      */}
                      {image ? <ImageCredit image={image} className="mt-auto px-4" /> : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-10">
          <ol className="order-2 space-y-3 lg:order-1" aria-label="Suggested destinations">
            {ordered.map((pick, index) => (
              <li key={pick.entryId}>
                {/*
                  THE CARD IS A DIV AND THE SELECTOR IS A BUTTON INSIDE IT.

                  It used to be one button wrapping everything, and it cannot be
                  any more: the image carries an attribution link, and an anchor
                  inside a button is invalid markup that browsers resolve
                  inconsistently — the credit becomes unclickable, the row
                  sometimes stops responding to Enter, and screen readers announce
                  a control containing a control. Splitting them keeps the whole
                  text area as one large click target and leaves the credit
                  separately reachable, which is what the licence requires anyway.
                */}
                <div
                  className={cx(
                    'overflow-hidden rounded-[var(--radius-card)] border transition-colors',
                    current?.entryId === pick.entryId
                      ? 'border-pine bg-pine-soft'
                      : 'border-rule bg-paper-raised hover:border-ink-faint',
                  )}
                >
                  {/*
                    The row image never crops, whatever its licence permits.

                    A 16:9 strip is not so much narrower than a photograph that
                    cropping buys anything worth a licence question, and letting
                    the whole file sit over the tinted graphic makes a card with a
                    photograph and one without read as the same kind of object.
                  */}
                  <DestinationImage
                    image={images[pick.entryId] ?? null}
                    fallback={fallbackFor(pick)}
                    className="px-4 pt-4"
                  />
                  <button
                    type="button"
                    onClick={() => setSelected(pick.entryId)}
                    aria-current={current?.entryId === pick.entryId}
                    className="w-full px-4 pt-3 pb-4 text-left"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-display text-lg leading-tight text-ink">
                        {pick.displayName}
                      </span>
                      <span aria-hidden="true" className="text-xs text-ink-faint">
                        {index + 1}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-muted">{pick.qualifiedName}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={BAND_TONE[pick.band]}>{RANK_BAND_LABELS[pick.band]}</Badge>
                      <Badge>{coverageWord(pick.coverage)}</Badge>
                    </div>
                  </button>
                </div>
              </li>
            ))}
          </ol>

          {current ? (
            /*
              `order-1` below `lg`: the argument for the selected destination
              comes before the eight rows on a phone, not after them.
            */
            <div className="order-1 lg:order-2">
              <Detail
                sessionId={sessionId}
                pick={current}
                image={images[current.entryId] ?? null}
                pending={pending}
                onError={setError}
                /*
                  "Why this one" is a promise that this one was chosen. It may be
                  said only about a pick that actually outscored the rest — with
                  eight equal scores it is the page asserting a recommendation the
                  ranking never made.
                */
                leads={separation.tiedAtTop === 1 && current.entryId === ordered[0]?.entryId}
                alreadySaid={alreadySaid}
                lead={null}
              />
            </div>
          ) : null}
        </div>
      )}

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

function Detail({
  sessionId,
  pick,
  image,
  pending,
  onError,
  leads,
  alreadySaid,
  lead,
}: {
  sessionId: string;
  pick: RankedDestination;
  image: ImageRecord | null;
  pending: boolean;
  onError: (message: string | null) => void;
  /** Whether this pick outscored every other. Decides what the panel may claim. */
  leads: boolean;
  /**
   * Dimensions already named once at list scope, so this panel does not repeat
   * them. See the note above the per-destination unknowns below.
   */
  alreadySaid: ReadonlySet<RankDimension>;
  /**
   * The lead verdict, when this panel is showing the destination it named.
   *
   * Separate from `leads` because they answer different questions. `leads` is
   * "did this outscore everything", which is the only licence for the words
   * "why this one". `lead` covers the case where nothing outscored anything and
   * the panel still has to head a recommendation — where the honest eyebrow is
   * a description of *how* it came to be first.
   */
  lead: ShortlistLead | null;
}) {
  const [adopting, startAdopt] = useTransition();

  /*
   * THE ONE PLACE THE SHARE-ALIKE RULE IS VISIBLE AS CODE.
   *
   * The hero is wide, so it crops — and cropping is an adaptation, which under a
   * ShareAlike licence would oblige us to publish the result under the same
   * terms. `croppable()` is the only way to obtain the type the cropping branch
   * accepts, and it returns null for every share-alike file. So the branch below
   * is not a policy somebody remembered; it is the shape the types force.
   */
  /*
   * THE HERO TAKES A STRONG MATCH OR IT TAKES THE GRAPHIC.
   *
   * `subjectConfidence` was computed, stored and then ignored by the widest
   * surface in the product. `verified_commons_category` is `moderate` and the
   * schema says of it, in those words, "good enough to sit beside a name, not
   * good enough to headline a page"; `bounded_identity_search` is `weak`. Both
   * were headlining the screen where somebody chooses where to go — so a
   * category containing a 1904 street plan and a portrait of the town's founder
   * could supply a 21:9 cropped hero.
   *
   * The board already gated on this (`anchorImage`). Two of three call sites
   * getting it right is how a convention behaves; this is the third.
   */
  const strongEnoughForHero = image?.subjectConfidence === 'strong' ? image : null;
  const cropSafe = strongEnoughForHero ? croppable(strongEnoughForHero) : null;
  const fallback = fallbackFor(pick);

  /**
   * What this panel is allowed to call itself.
   *
   * Three sentences for three different truths, and the difference between them
   * is the whole point of `shortlistLead`. "Why this one" is a claim that a
   * choice was made; it survives only where one destination actually outscored
   * the rest. The other two say what did happen — we knew most about this one,
   * or nothing separated them and somebody had to be first — which is more use
   * to a traveller than either a false claim or a blank refusal to lead.
   */
  const eyebrow = leads
    ? 'Why this one'
    : lead?.basis === 'best_evidenced'
      ? 'Where we would start'
      : lead?.basis === 'arbitrary'
        ? 'Somewhere to start'
        : 'What we know about it';

  return (
    <Panel className="self-start p-6" as="section" labelledBy="shortlist-detail-heading">
      {cropSafe ? (
        <DestinationImage crop image={cropSafe} fallback={fallback} ratio="21 / 9" showLabel className="mb-5" />
      ) : (
        <DestinationImage
          image={strongEnoughForHero}
          fallback={fallback}
          ratio="21 / 9"
          showLabel
          className="mb-5"
        />
      )}

      <p className="eyebrow">{eyebrow}</p>
      <h2 id="shortlist-detail-heading" className="mt-2 font-display text-3xl text-ink">
        {pick.displayName}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{pick.qualifiedName}</p>

      {/*
        WHY IT IS FIRST, IN ONE SENTENCE, WHERE IT IS FIRST.

        Only on the lead, only when nothing outscored anything, and never
        implying a verdict the ranking did not reach. `best_evidenced` is a claim
        about how much we could check — which is checkable — and `arbitrary` says
        outright that this one was not chosen, because the alternative is a page
        that quietly lets somebody act on a tiebreak over catalogue ids.
      */}
      {lead && lead.basis !== 'outscored' ? (
        <p className="measure mt-4 text-sm leading-relaxed text-ink-muted">
          {lead.basis === 'best_evidenced'
            ? `${lead.tiedWith} of these fit your answers equally well. This is the one we could check the most of, so it is the one to look at first.`
            : `${lead.tiedWith} of these fit your answers equally well and nothing we can measure tells them apart. We have put this one first so you have somewhere to start — not because it won.`}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Badge tone={BAND_TONE[pick.band]}>{RANK_BAND_LABELS[pick.band]}</Badge>
        {pick.suggestedNights ? (
          <Badge>
            About {pick.suggestedNights} nights
            {pick.suggestedBases ? `, ${pick.suggestedBases} base${pick.suggestedBases === 1 ? '' : 's'}` : ''}
          </Badge>
        ) : null}
        <Badge tone={pick.coverage >= 0.7 ? 'neutral' : 'amber'}>{coverageWord(pick.coverage)}</Badge>
      </div>

      {/*
        Where in the world, from the candidate's own coordinates.
        
        Deliberately the raw figures rather than a diagram: with one point there
        is no shape to draw, and a single dot on an empty frame communicates
        less than two numbers a traveller can put into any map they like.
      */}
      <p className="mt-5 text-xs tabular-nums text-ink-faint">
        {Math.abs(pick.center.lat).toFixed(2)}°{pick.center.lat >= 0 ? 'N' : 'S'},{' '}
        {Math.abs(pick.center.lng).toFixed(2)}°{pick.center.lng >= 0 ? 'E' : 'W'}
        {pick.countryCode ? ` · ${pick.countryCode}` : ''}
      </p>

      {pick.reasons.length > 0 ? (
        <ul className="mt-6 space-y-2 text-sm leading-relaxed text-ink">
          {pick.reasons.map((reason) => (
            <li key={reason} className="flex gap-2.5">
              <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-pine" />
              {reason}
            </li>
          ))}
        </ul>
      ) : null}

      {pick.tradeoffs.length > 0 ? (
        <div className="mt-5 rounded-lg bg-paper-sunk p-4">
          <p className="eyebrow">What it costs you</p>
          <ul className="mt-2.5 space-y-1.5 text-sm leading-relaxed text-ink-muted">
            {pick.tradeoffs.map((tradeoff) => (
              <li key={tradeoff}>{tradeoff}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {pick.conflicts.length > 0 ? (
        <ul className="mt-5 space-y-2 text-sm leading-relaxed text-amber">
          {pick.conflicts.map((conflict) => (
            <li key={conflict.code}>{conflict.message}</li>
          ))}
        </ul>
      ) : null}

      {/*
        ONLY WHAT IS TRUE OF *THIS* ONE.

        This listed every dimension the pick was missing, and on the live index
        that is six identical lines under the recommendation — because a
        dimension nobody could measure for any candidate is missing from all of
        them. The reviewer's phrase for the same pattern on the board was "a wall
        of what the product could not do".

        A caveat that is true of the whole list belongs to the whole list, and it
        is stated once in `Caveats`. What stays here is the difference: a
        dimension we could read for the others and not for this one, which is
        genuinely a fact about this destination. Filtered on the factor ids
        rather than on the rendered sentences — matching prose would break the
        moment somebody rewords a reason.
      */}
      {(() => {
        const own = pick.factors.filter(
          (factor) => factor.measure.kind === 'unknown' && !alreadySaid.has(factor.id),
        );
        if (own.length === 0) return null;
        return (
          <div className="mt-5">
            <p className="eyebrow">What we could not see about this one</p>
            <ul className="mt-2.5 space-y-1.5 text-sm leading-relaxed text-ink-muted">
              {own.map((factor) => (
                <li key={factor.id}>
                  {factor.label} —{' '}
                  {UNKNOWN_REASON_COPY[(factor.measure as { reason: UnknownReason }).reason]}
                </li>
              ))}
            </ul>
          </div>
        );
      })()}

      {/*
        THE COMPONENT'S OWN RULE, APPLIED HERE TOO.

        The header of this file says, in these words, that rendering "83" would
        be a precision the inputs do not have — and then this disclosure rendered
        `Math.round(value * 100)` for every dimension, an unlabelled 0–100
        integer beside a clause describing what it was computed from. Two of
        them invite a subtraction that means nothing: the dimensions have
        different weights, different coverage, and several of them are absent.

        So each one is a band, and the basis clause still travels with it. The
        summary says what the disclosure contains rather than promising numbers
        it should not be giving.
      */}
      {/*
        And said in the traveller's language, which is a separate fix from the
        one above it. This paragraph read "the weights differ and several
        dimensions are unmeasured, so two of these are not comparable as
        numbers" — a sentence about our scoring model, on the screen where
        somebody is choosing where to spend a holiday. §26: translate system
        state into traveller meaning.
      */}
      <details className="mt-6 border-t border-rule pt-4">
        <summary className={cx(MIN_TARGET_SUMMARY, 'cursor-pointer text-sm text-ink-muted')}>
          What we checked, one thing at a time
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          A rough read on each, not a score out of ten — some of these matter more than others,
          and a few we could not check at all. Worth skimming; not worth adding up.
        </p>
        <dl className="mt-3 space-y-2 text-sm">
          {pick.factors.map((factor) => (
            <div key={factor.id} className="flex items-baseline justify-between gap-4">
              <dt className="text-ink-muted">{factor.label}</dt>
              <dd className="text-right text-ink">
                {factor.measure.kind === 'measured' ? (
                  <>
                    <span>{MEASURE_BAND_LABELS[measureBand(factor.measure.value)]}</span>
                    <span className="ml-2 text-xs text-ink-faint">{factor.measure.basis}</span>
                  </>
                ) : (
                  <span className="text-ink-faint">we could not check this</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </details>

      <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-rule pt-6">
        <button
          type="button"
          className={cx(buttonClass('primary'), MIN_TARGET)}
          disabled={pending || adopting}
          onClick={() => {
            onError(null);
            startAdopt(async () => {
              const result = await adoptDestinationAction(sessionId, pick.entryId);
              if (!result.ok) onError(result.error ?? 'We could not save that.');
            });
          }}
        >
          {adopting ? 'Setting it up…' : `Plan ${pick.displayName}`}
        </button>
        <span className="text-sm text-ink-faint">
          Your dates, nights and preferences come with you.
        </span>
      </div>
    </Panel>
  );
}

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
function coverageWord(coverage: number): string {
  if (coverage >= 0.85) return 'Well evidenced';
  if (coverage >= 0.7) return 'Reasonably evidenced';
  if (coverage >= 0.5) return 'Partly evidenced';
  return 'Thin evidence';
}
