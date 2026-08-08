'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  MEASURE_BAND_LABELS,
  RANK_BAND_LABELS,
  croppable,
  imageryFallbackFor,
  measureBand,
  type DestinationImage as ImageRecord,
  type DestinationShortlist,
  type RankedDestination,
} from '@sidequest/core';
import { Badge, ErrorNote, Panel, buttonClass, cx } from './ui';
import { DestinationImage } from './DestinationImage';
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
  const [selected, setSelected] = useState<string | null>(shortlist?.picks[0]?.entryId ?? null);
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
    return (
      <Panel className="p-8 text-center">
        <p className="breathing font-display text-xl text-ink">Ranking the world against your trip</p>
        <p className="measure mx-auto mt-3 text-sm leading-relaxed text-ink-muted">
          Climate records, how much ground each place covers, and what is actually there. A few
          seconds, and nothing is bought.
        </p>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </Panel>
    );
  }

  const current = shortlist.picks.find((pick) => pick.entryId === selected) ?? shortlist.picks[0];

  if (shortlist.picks.length === 0) {
    return (
      <Panel className="p-8">
        <h2 className="font-display text-2xl text-ink">Nothing came back</h2>
        <p className="measure mt-3 leading-relaxed text-ink-muted">
          {shortlist.considered === 0
            ? 'We had nothing to rank — see below for why. That is about us, not about anywhere.'
            : `We scored ${shortlist.considered} places and none of them cleared the bar for this trip. Widening your dates or your nights is the change that usually helps most.`}
        </p>
        <BlindSpots shortlist={shortlist} />
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

      <div className="grid gap-8 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-10">
        <ol className="space-y-3" aria-label="Suggested destinations">
          {shortlist.picks.map((pick, index) => (
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
          <Detail
            sessionId={sessionId}
            pick={current}
            image={images[current.entryId] ?? null}
            pending={pending}
            onError={setError}
          />
        ) : null}
      </div>

      {shortlist.diversityNote ? (
        <Panel className="bg-paper-sunk p-4">
          <p className="text-sm leading-relaxed text-ink-muted">{shortlist.diversityNote}</p>
        </Panel>
      ) : null}

      {shortlist.excluded.length > 0 ? (
        <details className="rounded-[var(--radius-card)] border border-rule bg-paper-raised p-5">
          <summary className={cx(MIN_TARGET_SUMMARY, 'cursor-pointer text-sm font-medium text-ink')}>
            {shortlist.excluded.length} we took off the list
          </summary>
          <ul className="mt-3 space-y-2 text-sm text-ink-muted">
            {shortlist.excluded.map((entry) => (
              <li key={entry.entryId}>
                <span className="text-ink">{entry.displayName}</span> — {entry.exclusion.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <BlindSpots shortlist={shortlist} />
    </div>
  );
}

function Detail({
  sessionId,
  pick,
  image,
  pending,
  onError,
}: {
  sessionId: string;
  pick: RankedDestination;
  image: ImageRecord | null;
  pending: boolean;
  onError: (message: string | null) => void;
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

      <p className="eyebrow">Why this one</p>
      <h2 id="shortlist-detail-heading" className="mt-2 font-display text-3xl text-ink">
        {pick.displayName}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{pick.qualifiedName}</p>

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

      {pick.unknowns.length > 0 ? (
        <div className="mt-5">
          <p className="eyebrow">What we could not see</p>
          <ul className="mt-2.5 space-y-1.5 text-sm leading-relaxed text-ink-muted">
            {pick.unknowns.map((unknown) => (
              <li key={unknown}>{unknown}</li>
            ))}
          </ul>
        </div>
      ) : null}

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
      <details className="mt-6 border-t border-rule pt-4">
        <summary className={cx(MIN_TARGET_SUMMARY, 'cursor-pointer text-sm text-ink-muted')}>
          What went into this, dimension by dimension
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-ink-faint">
          Each dimension as a band rather than a score. The weights differ and several
          dimensions are unmeasured, so two of these are not comparable as numbers.
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
                  <span className="text-ink-faint">not measured</span>
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

function BlindSpots({ shortlist }: { shortlist: DestinationShortlist }) {
  if (shortlist.blindSpots.length === 0) return null;
  return (
    <section aria-labelledby="blind-spots" className="border-t border-rule pt-6">
      <h2 id="blind-spots" className="eyebrow">
        What this ranking cannot see
      </h2>
      <ul className="measure mt-3 space-y-1.5 text-sm leading-relaxed text-ink-muted">
        {shortlist.blindSpots.map((spot) => (
          <li key={spot}>{spot}</li>
        ))}
      </ul>
    </section>
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
