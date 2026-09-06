import type { TravelIntelligence, TripPackage } from '@sidequest/core';
import { Badge } from '../ui';

/**
 * PRODUCTION UI V1 — TRIP CONFIDENCE, IN THREE LINES.
 *
 * The founder's hub rendered 86 evidence rows by default. The traveller needs
 * three numbers and a door: how many places were checked, how many are worth
 * rechecking closer to departure, how many details are still uncertain — then
 * "See details" for the actionable list, and the full provenance behind a
 * second disclosure that never prints unless the appendix is asked for.
 *
 * Words are the states a traveller understands (Checked · Likely · Confirm
 * later · Changed), never a claim-authority vocabulary.
 */
export function confidenceSummary(pkg: TripPackage | undefined, intel: TravelIntelligence | null) {
  const anchors = pkg?.anchors ?? [];
  const named = anchors.filter((a) => (a.anchorKind ?? 'named_place') === 'named_place' && !a.disposition.startsWith('rejected'));
  const checked = named.filter((a) => a.verification === 'verified' || a.verification === 'partially_verified').length;
  const uncertain = named.filter((a) => a.verification === 'unverified').length;
  const recheck = intel?.freshness.recheckBeforeDeparture.length ?? 0;
  const changed = intel ? intel.sourceRegistry.filter((c) => c.state === 'contradicted').length : 0;
  const legs = pkg?.verification;
  return { checked, uncertain, recheck, changed, named: named.length, legsMeasured: legs?.legsMeasured ?? 0, legsEstimated: legs?.legsEstimated ?? 0, legsUnmeasured: legs?.legsUnmeasured ?? 0 };
}

export function TripConfidence({ pkg, intel, compact = false }: { pkg: TripPackage | undefined; intel: TravelIntelligence | null; compact?: boolean }) {
  const s = confidenceSummary(pkg, intel);
  if (s.named === 0 && s.recheck === 0) return null;
  const legsLine =
    s.legsMeasured > 0
      ? `${s.legsMeasured} of ${s.legsMeasured + s.legsUnmeasured} travel legs measured${s.legsEstimated > 0 ? `, ${s.legsEstimated} estimated from map distance` : ''}`
      : s.legsEstimated > 0
        ? `Travel times are Sidequest's estimates from map distance; no road router covered this trip`
        : s.legsUnmeasured > 0
          ? `Travel times could not be timed; the days show parts of the day`
          : null;
  return (
    <div className={compact ? '' : 'rule-top pt-5'} data-testid="trip-confidence">
      {!compact ? <h2 className="type-section text-ink">Trip confidence</h2> : <p className="label text-ink-faint">Trip confidence</p>}
      <dl className="mt-3 grid grid-cols-3 gap-3 sm:max-w-md">
        <div>
          <dt className="type-meta">Places checked</dt>
          <dd className="numeral font-display text-3xl text-ink">
            {s.checked}
            <span className="font-sans text-sm text-ink-faint"> / {s.named}</span>
          </dd>
        </div>
        <div>
          <dt className="type-meta">Recheck nearer the date</dt>
          <dd className="numeral font-display text-3xl text-ink">{s.recheck}</dd>
        </div>
        <div>
          <dt className="type-meta">Still uncertain</dt>
          <dd className="numeral font-display text-3xl text-ink">{s.uncertain}</dd>
        </div>
      </dl>
      <p className="mt-2 flex flex-wrap items-center gap-2 type-small text-ink-muted">
        {s.changed > 0 ? <Badge tone="clay">{s.changed} changed since the plan was written</Badge> : null}
        {legsLine ? <span>{legsLine}.</span> : null}
      </p>
      {!compact ? (
        <p className="mt-2 type-small text-ink-muted">
          <a href="#verify" className="text-accent underline underline-offset-4">
            See details
          </a>
          {' — '}the things worth acting on first; the full provenance sits behind a further disclosure.
        </p>
      ) : null}
    </div>
  );
}

export const VERIFICATION_WORD: Record<'verified' | 'partially_verified' | 'unverified', { label: string; tone: 'pine' | 'blue' | 'neutral' | 'amber' }> = {
  verified: { label: 'Checked', tone: 'pine' },
  partially_verified: { label: 'Likely', tone: 'blue' },
  unverified: { label: 'Confirm later', tone: 'neutral' },
};
