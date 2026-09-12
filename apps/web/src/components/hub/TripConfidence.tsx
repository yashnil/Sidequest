import type { TravelIntelligence, TripPackage, VerificationState } from '@sidequest/core';
import { Badge } from '../ui';
import { VERIFICATION_WORDS, type HumanTone } from './HumanWords';

/**
 * V6 — CONFIDENCE IN THREE WORDS A TRAVELLER ALREADY OWNS.
 *
 * The hub used to state confidence in the vocabulary of the thing that
 * produced it: "0 / 23 routing", "partially verified", claim authorities,
 * source taxonomies, the names of the services that answered. All of that is
 * true and none of it is a sentence anybody can act on.
 *
 * There are three traveller-facing states and no others (V9 human words,
 * `HumanWords.ts`):
 *
 *   Confirmed from source   a real place, found, at a known position
 *   Likely                  the place is real; its hours or access are not confirmed
 *   Check before relying    nothing could be matched to it yet — which is not
 *                           the same as saying it is wrong
 *
 * Transfers get one sentence with the same shape: either every one of them was
 * timed, or a number of them still need checking. Never a ratio against a
 * provider count. The forensic account — how many legs a router answered, how
 * many are Sidequest's own estimate, what was skipped — lives behind "How this
 * was checked", where somebody debugging a plan can find it and nobody else
 * has to read it.
 */

export const CONFIDENCE_WORD: Record<VerificationState, { label: string; tone: HumanTone; blurb: string }> = VERIFICATION_WORDS;

/** Kept under its old name for the timeline rows that import it. */
export const VERIFICATION_WORD = CONFIDENCE_WORD;

export function confidenceSummary(pkg: TripPackage | undefined, intel: TravelIntelligence | null) {
  const anchors = pkg?.anchors ?? [];
  const named = anchors.filter((a) => (a.anchorKind ?? 'named_place') === 'named_place' && !a.disposition.startsWith('rejected'));
  const verified = named.filter((a) => a.verification === 'verified').length;
  const likely = named.filter((a) => a.verification === 'partially_verified').length;
  const uncertain = named.filter((a) => a.verification === 'unverified').length;
  const recheck = intel?.freshness.recheckBeforeDeparture.length ?? 0;
  const changed = intel ? intel.sourceRegistry.filter((c) => c.state === 'contradicted').length : 0;
  const legs = pkg?.verification;
  return {
    verified,
    likely,
    uncertain,
    checked: verified + likely,
    recheck,
    changed,
    named: named.length,
    legsMeasured: legs?.legsMeasured ?? 0,
    legsEstimated: legs?.legsEstimated ?? 0,
    legsUnmeasured: legs?.legsUnmeasured ?? 0,
  };
}

/**
 * The one sentence about travel.
 *
 * "N transfers still need checking" counts the legs no router and no estimate
 * could speak for; when there are none and something was timed, the sentence
 * is that every transfer was timed. Silence when the plan holds no legs at all
 * — a claim about nothing is worse than no claim.
 */
export function transferLine(summary: ReturnType<typeof confidenceSummary>): string | null {
  const { legsMeasured, legsEstimated, legsUnmeasured } = summary;
  if (legsUnmeasured > 0) return `${legsUnmeasured} ${legsUnmeasured === 1 ? 'transfer still needs' : 'transfers still need'} checking`;
  if (legsMeasured > 0 || legsEstimated > 0) return 'Every transfer timed';
  return null;
}

export function TripConfidence({ pkg, intel, compact = false }: { pkg: TripPackage | undefined; intel: TravelIntelligence | null; compact?: boolean }) {
  const s = confidenceSummary(pkg, intel);
  if (s.named === 0 && s.recheck === 0) return null;
  const transfers = transferLine(s);
  const states: { label: string; count: number }[] = [
    { label: VERIFICATION_WORDS.verified.label, count: s.verified },
    { label: VERIFICATION_WORDS.partially_verified.label, count: s.likely },
    { label: VERIFICATION_WORDS.unverified.label, count: s.uncertain },
  ].filter((entry) => entry.count > 0);

  return (
    <div className={compact ? '' : 'rule-top pt-5'} data-testid="trip-confidence">
      {!compact ? <h2 className="type-section text-ink">Trip confidence</h2> : null}
      {states.length > 0 ? (
        <dl className="mt-1 flex flex-wrap gap-x-8 gap-y-3">
          {states.map((state) => (
            <div key={state.label}>
              <dd className="numeral font-display text-3xl leading-none text-ink">{state.count}</dd>
              <dt className="mt-1 type-meta">{state.label}</dt>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 type-small text-ink-muted">
        {transfers ? <span data-testid="transfer-line">{transfers}.</span> : null}
        {s.recheck > 0 ? <span>{s.recheck} {s.recheck === 1 ? 'thing is' : 'things are'} worth a second look nearer the date.</span> : null}
        {s.changed > 0 ? <Badge tone="clay">{s.changed} changed since the plan was written</Badge> : null}
      </p>
      {/*
        The forensic account, one disclosure deep. Never the primary reading:
        nobody plans a holiday around how many legs a router answered.
      */}
      <details className="mt-3" data-testid="how-this-was-checked" data-print="appendix">
        <summary className="min-h-9 cursor-pointer type-small text-ink-faint hover:text-ink">How this was checked</summary>
        <ul className="mt-2 space-y-1 type-small text-ink-muted">
          <li>
            {s.named} {s.named === 1 ? 'named place' : 'named places'} on this plan: {s.verified} confirmed from source, {s.likely} likely, {s.uncertain} still to check.
          </li>
          {s.legsMeasured > 0 || s.legsEstimated > 0 || s.legsUnmeasured > 0 ? (
            <li>
              {s.legsMeasured} of {s.legsMeasured + s.legsEstimated + s.legsUnmeasured} journeys were timed against a road or timetable
              {s.legsEstimated > 0 ? `, ${s.legsEstimated} carry Sidequest's own estimate from map distance` : ''}
              {s.legsUnmeasured > 0 ? `, ${s.legsUnmeasured} could not be timed and are held as an allowance` : ''}.
            </li>
          ) : null}
          <li>A finished plan is frozen to the day it was built. Nothing here has been re-read today.</li>
        </ul>
      </details>
    </div>
  );
}
