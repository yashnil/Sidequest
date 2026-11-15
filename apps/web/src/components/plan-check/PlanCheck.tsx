'use client';

import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { PLAN_MOVE_MODE_LABELS, PLAN_TEXT_MAX, STATED_TRANSPORT_LABELS, applyPlanChanges, defaultAcceptedChanges, formatPlanMinutes, measurePlanVersion, statedItineraryFromPlan, type PlanChange, type PlanFinding, type PlanMove, type PlanVersionMeasure, type ProposalStop } from '@sidequest/core';
import { PartyChoice, describeCounts, type PartyShapeChoice } from '@/components/setup/PartyChoice';
import { checkPlanAction, planFromCheckAction, type PlanCheckView } from '@/app/(product)/improve/actions';
import { Badge, ErrorNote, buttonClass, cx, type BadgeTone } from '@/components/ui';

/**
 * "I ALREADY HAVE A PLAN" — TYPE IT, SEE WHAT WORKS, PLAN IT.
 *
 * One field, one press, one answer. The answer is laid out the way the
 * critique is built: what we read (so a misreading is visible before anything
 * is said about it), the verdict and its numbers, each move with its estimate,
 * what strains, what to change, and the improved version. Both versions plan
 * through the ordinary trip door.
 *
 * Every travel figure on this screen is an estimate and says so; the footnote
 * says how it was made.
 */

const EXAMPLES = [
  'Tokyo, Kyoto, Osaka and Hokkaido in 10 days. Is that too much?',
  '3 nights Lisbon, 2 nights Porto, 2 nights in the Douro Valley, 1 night Lisbon',
  'Day 1-2: Rome\nDay 3: Rome to Florence\nDay 4-5: Florence\nDay 6-7: Venice',
];

const VERDICT: Record<PlanCheckView['result']['verdict'], { label: string; tone: BadgeTone }> = {
  comfortable: { label: 'Comfortable pace', tone: 'pine' },
  full: { label: 'Doable but full', tone: 'amber' },
  too_much: { label: 'Too much', tone: 'clay' },
  unknown: { label: 'Pace not judged', tone: 'neutral' },
};

const SEVERITY: Record<PlanFinding['severity'], { label: string; tone: BadgeTone }> = {
  major: { label: 'Strains', tone: 'clay' },
  minor: { label: 'Costs you', tone: 'amber' },
  note: { label: 'Worth knowing', tone: 'neutral' },
};

const TOTAL_BASIS: Record<NonNullable<PlanCheckView['parsed']['totalBasis']>, string> = {
  dates: 'from your dates',
  nights: 'as you said',
  days: 'from the days you gave',
  weeks: 'from the weeks you gave',
  day_list: 'from your day list',
  sum_of_stops: 'adding up your stops',
};

function nightsNote(basis: PlanCheckView['parsed']['stops'][number]['nightsBasis']): string {
  switch (basis) {
    case 'stated':
      return 'you said';
    case 'days_stated':
      return 'read from your days';
    case 'day_list':
      return 'from your day list';
    case 'spread':
      return 'an even split — you didn’t say';
    default:
      return 'not said';
  }
}

function moveLine(move: PlanMove): string {
  if (move.minutes === null) return move.mode === null ? 'not estimated — an end could not be placed' : 'no estimate';
  const by = move.mode === 'flight' ? 'door to door by air' : `by ${PLAN_MOVE_MODE_LABELS[move.mode!]}`;
  return `about ${formatPlanMinutes(move.minutes)} ${by}`;
}

export function PlanCheck() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [view, setView] = useState<PlanCheckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, startChecking] = useTransition();
  const [planning, startPlanning] = useTransition();
  const result = useRef<HTMLHeadingElement | null>(null);

  const check = (value: string) => {
    setError(null);
    startChecking(async () => {
      const response = await checkPlanAction({ text: value });
      if (!response.ok) {
        setView(null);
        setError(response.error);
        return;
      }
      setView(response.view);
      adopt(response.view);
      requestAnimationFrame(() => result.current?.focus());
    });
  };

  /*
   * THE CHANGES, EACH ONE THEIRS TO REFUSE.
   * Safe changes start ticked, major ones unticked; unticking is the exact undo.
   */
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  const [party, setParty] = useState<{ shape: PartyShapeChoice | null; adults: number; children: number; basis: 'stated' | 'profile' | 'assumed' } | null>(null);
  const adopt = (next: PlanCheckView) => {
    setAccepted(defaultAcceptedChanges(next.result.proposal.changes));
    const known = next.party;
    setParty(known.needsQuestion ? { shape: null, adults: known.adults, children: known.children, basis: 'assumed' } : { shape: known.children > 0 ? 'family' : known.adults === 1 ? 'solo' : known.adults === 2 ? 'couple' : 'friends', adults: known.adults, children: known.children, basis: known.basis });
  };
  const proposal = view?.result.proposal ?? null;
  const version = useMemo(() => (proposal ? applyPlanChanges(proposal.original, proposal.changes, accepted) : []), [proposal, accepted]);
  const measured = useMemo(() => (view && proposal ? measurePlanVersion(view.inputs, version, view.parsed.totalNights) : null), [view, proposal, version]);
  const toggle = (id: string) =>
    setAccepted((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const plan = (which: 'chosen' | 'as_written') => {
    if (!view || !proposal || !party?.shape) return;
    const chosen = which === 'chosen' ? accepted : new Set<string>();
    const stops = which === 'chosen' ? version : proposal.original;
    const statedItinerary = statedItineraryFromPlan({
      version: stops,
      original: proposal.original,
      changes: proposal.changes,
      accepted: chosen,
      placed: view.placed,
      arrival: view.parsed.arrival,
      departure: view.parsed.departure,
      parseConfidence: view.parsed.confidence,
      now: new Date(),
    });
    setError(null);
    startPlanning(async () => {
      const response = await planFromCheckAction({
        stops: stops.map((s) => ({ label: s.label, nights: s.nights, dayTrip: s.dayTrip })),
        totalNights: view.parsed.totalNights,
        startDate: view.parsed.startDate,
        endDate: view.parsed.endDate,
        month: view.parsed.month,
        contextCountries: view.parsed.contextCountries,
        statedItinerary,
        party: { adults: party.adults, children: party.children, basis: party.shape === 'later' ? 'assumed' : party.basis },
      });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      router.push(response.href);
    });
  };

  const verdict = view ? VERDICT[view.result.verdict] : null;
  const m = view?.result.metrics;

  return (
    <div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          check(text);
        }}
        className="max-w-3xl"
        aria-label="Your plan"
      >
        <label htmlFor="plan-check-input" className="sheet-label text-ink-muted">
          Your plan, as rough as it is
        </label>
        <textarea
          id="plan-check-input"
          data-testid="plan-check-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) check(text);
          }}
          rows={4}
          maxLength={PLAN_TEXT_MAX}
          placeholder="Places in order — nights per place, days or dates if you know them. One per line works, so does a sentence."
          className="mt-3 block w-full resize-y border-0 border-b-2 border-ink bg-transparent px-0 pb-3 font-display text-[clamp(1.2rem,1rem+0.8vw,1.7rem)] leading-snug font-[340] text-ink placeholder:text-ink-faint focus:border-flare focus:ring-0 focus:outline-none"
        />
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Examples">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setText(example)}
              className="min-h-11 max-w-full rounded-full border border-ink/20 px-3.5 py-2 text-left text-sm whitespace-pre-line text-ink-muted transition-colors hover:border-ink hover:text-ink"
            >
              {example.replace(/\n/g, ' · ')}
            </button>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button type="submit" disabled={checking || text.trim().length < 3} className={buttonClass('accent', 'lg')} data-testid="plan-check-submit">
            {checking ? 'Checking your plan…' : 'Check my plan'}
          </button>
          <p className="type-small text-ink-muted">No account needed. Nothing is booked or saved until you plan it.</p>
        </div>
        {error ? (
          <div className="mt-5" data-testid="plan-check-error">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}
      </form>

      {view && verdict && m ? (
        <section aria-labelledby="plan-check-headline" className="mt-14 rule-top pt-8" data-testid="plan-check-result">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={verdict.tone}>{verdict.label}</Badge>
            {view.parsed.question ? <p className="type-small text-ink-muted">You asked: “{view.parsed.question}”</p> : null}
          </div>
          <h2 ref={result} tabIndex={-1} id="plan-check-headline" data-testid="plan-check-headline" className="mt-4 focus:outline focus:outline-2 focus:outline-pine focus:outline-offset-2 max-w-[30ch] font-display text-[clamp(1.8rem,1.3rem+1.8vw,2.9rem)] leading-[1.05] font-[340] tracking-[-0.025em] text-balance text-ink">
            {view.result.headline}
          </h2>

          <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4" aria-label="The plan in numbers">
            <Figure term="Nights" value={m.totalNights === null ? '—' : String(m.totalNights)} note={view.parsed.totalBasis ? TOTAL_BASIS[view.parsed.totalBasis] : 'not said'} />
            <Figure term="Places to sleep" value={String(m.bases)} note={`${m.hotelMoves} hotel move${m.hotelMoves === 1 ? '' : 's'}`} />
            <Figure term="Days moving" value={m.moveDaysEstimated > 0 ? `≈${m.moveDaysEstimated}` : '—'} note="estimate" />
            <Figure term="Route" value={m.routeKm === null ? '—' : `${Math.round(m.routeKm)} km`} note="straight lines" />
          </dl>

          <div className="mt-12 grid gap-12 lg:grid-cols-2">
            <div className="min-w-0">
              <h3 className="sheet-label text-ink-muted">What we read</h3>
              <ol className="mt-4 divide-y divide-ink/10 border-y border-ink/10">
                {view.parsed.stops.map((stop, index) => {
                  const placed = view.placed[index];
                  const move = view.result.moves.find((mv) => mv.toIndex === index);
                  return (
                    <li key={`${stop.label}-${index}`} className="py-3" data-testid="plan-check-stop">
                      {move ? (
                        <p className="mb-2 font-mono text-xs text-ink-muted" data-testid="plan-check-move">
                          {move.dayTrip ? 'Day trip · ' : '↓ '}
                          {moveLine(move)}
                          {move.straightKm !== null ? ` · ${Math.round(move.straightKm)} km straight line` : ''}
                          {move.minutes !== null ? ' · estimate' : ''}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <p className="font-display text-xl text-ink">
                          <span className="mr-2 font-mono text-xs text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
                          {stop.label}
                        </p>
                        <p className="text-sm text-ink-muted">
                          {stop.dayTrip ? 'day trip' : stop.nights === null ? 'nights not said' : `${stop.nights} night${stop.nights === 1 ? '' : 's'} · ${nightsNote(stop.nightsBasis)}`}
                        </p>
                      </div>
                      {placed && !placed.point ? <p className="mt-1 text-sm text-amber">Not placed on the map — not checked, not wrong.</p> : placed?.placedName && placed.placedName !== stop.label ? <p className="mt-1 text-xs text-ink-faint">Placed as {placed.placedName}</p> : null}
                    </li>
                  );
                })}
              </ol>
              {view.parsed.notes.map((note) => (
                <p key={note} className="mt-3 text-sm text-ink-muted">
                  {note}
                </p>
              ))}
            </div>

            <div className="min-w-0">
              <h3 className="sheet-label text-ink-muted">What we found</h3>
              <ul className="mt-4 space-y-4">
                {view.result.findings.map((finding) => (
                  <li key={finding.id} className="flex flex-col gap-1.5" data-testid="plan-check-finding" data-severity={finding.severity} data-topic={finding.topic}>
                    <span>
                      <Badge tone={SEVERITY[finding.severity].tone}>{SEVERITY[finding.severity].label}</Badge>
                    </span>
                    <p className="type-body text-ink">{finding.sentence}</p>
                  </li>
                ))}
              </ul>
              {view.result.suggestions.some((s) => s.kind === 'add_nights' || s.kind === 'side_trip') ? (
                <>
                  <h3 className="mt-10 sheet-label text-ink-muted">Other ways to shape it</h3>
                  <ul className="mt-4 space-y-3">
                    {view.result.suggestions.filter((s) => s.kind === 'add_nights' || s.kind === 'side_trip').map((suggestion) => (
                      <li key={suggestion.id} className="border-l-2 border-flare pl-4 type-body text-ink" data-testid="plan-check-suggestion" data-kind={suggestion.kind}>
                        {suggestion.sentence}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          </div>

          {proposal && measured ? (
            <section className="mt-12" aria-labelledby="plan-check-versions" data-testid="plan-check-proposal">
              <h3 id="plan-check-versions" className="sheet-label text-ink-muted">
                Your plan and the version you’ll plan
              </h3>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <VersionColumn title="As you wrote it" testId="plan-check-original" stops={proposal.original} />
                <VersionColumn title={proposal.changes.length === 0 ? 'Nothing to change' : 'With the changes ticked below'} testId="plan-check-suggested" stops={version} highlight />
              </div>
              <p className="mt-4 type-small text-ink" data-testid="plan-check-savings">
                {savingsLine(proposal.measure.original, measured)}
              </p>

              {proposal.changes.length > 0 ? (
                <>
                  <h3 className="mt-10 sheet-label text-ink-muted">What we’d change — tick what you agree with</h3>
                  <p className="mt-1 type-small text-ink-muted">Safe changes touch nothing you said and start ticked. A change to something you said is yours to accept, one at a time. Untick anything to undo it.</p>
                  <ul className="mt-4 space-y-3">
                    {proposal.changes.map((change) => {
                      const on = accepted.has(change.id);
                      return (
                        <li key={change.id} className={cx('rounded-[var(--radius-control)] border p-4', change.class === 'major' ? 'border-clay/40' : 'border-ink/15')} data-testid="plan-check-change" data-class={change.class} data-kind={change.kind} data-accepted={on ? 'true' : 'false'}>
                          <label className="flex cursor-pointer items-start gap-3">
                            <input type="checkbox" checked={on} onChange={() => toggle(change.id)} className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-pine)]" data-testid={`plan-check-accept-${change.id}`} aria-describedby={`why-${change.id}`} />
                            <span className="min-w-0">
                              <span className="flex flex-wrap items-center gap-2">
                                <Badge tone={change.class === 'major' ? 'clay' : 'pine'}>{change.class === 'major' ? 'Changes what you said' : 'Safe'}</Badge>
                                <span className="type-body text-ink">{change.sentence}</span>
                              </span>
                              <span id={`why-${change.id}`} className="mt-1 block text-sm text-ink-muted">
                                {change.why}
                                {changeSaving(change)}
                              </span>
                              {change.touches.length > 0 ? <span className="mt-1 block text-sm text-clay">This {change.touches.join('; ')}.</span> : null}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {proposal.unresolved.length > 0 ? (
                <div className="mt-8" data-testid="plan-check-unresolved">
                  <h3 className="sheet-label text-ink-muted">Still to settle, whatever you choose</h3>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
                    {proposal.unresolved.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}

          {party ? (
            <section className="mt-12 rule-top pt-6" aria-labelledby="plan-check-party-heading" data-testid="plan-check-party" data-basis={party.shape === 'later' ? 'assumed' : party.basis}>
              <h3 id="plan-check-party-heading" className="sheet-label text-ink-muted">
                Who is going
              </h3>
              {view.party.needsQuestion ? (
                <>
                  <p className="mt-1 type-small text-ink-muted">Nobody said, and it changes rooms, prices and how long a day can be. One question — or skip it and we’ll plan for two adults and say so.</p>
                  <div className="mt-4 max-w-2xl">
                    <PartyChoice shape={party.shape} adults={party.adults} children={party.children} onChange={(next) => setParty({ shape: next.shape, adults: next.adults, children: next.children, basis: next.shape === 'later' ? 'assumed' : 'stated' })} />
                  </div>
                </>
              ) : (
                <p className="mt-2 type-body text-ink" data-testid="plan-check-party-known">
                  {describeCounts(party.adults, party.children)} <span className="text-ink-muted">· {view.party.label}</span>
                </p>
              )}
            </section>
          ) : null}

          <div className="mt-10 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => plan('chosen')} disabled={planning || !party?.shape} className={buttonClass('accent', 'lg')} data-testid="plan-check-plan">
              {planning ? 'Starting your trip…' : accepted.size > 0 ? 'Plan this version' : 'Plan this'}
            </button>
            {accepted.size > 0 ? (
              <button type="button" onClick={() => plan('as_written')} disabled={planning || !party?.shape} className={buttonClass('secondary', 'lg')} data-testid="plan-check-plan-as-written">
                Plan it exactly as written
              </button>
            ) : null}
            {!party?.shape ? <p className="type-small text-ink-muted">Say who is going, or skip it, to plan.</p> : null}
          </div>
          <p className="mt-6 max-w-3xl type-small text-ink-muted">
            Every travel time here is Sidequest’s estimate from the straight-line distance between the places and the way the country usually moves people (trains, roads or flights) — not a timetable and not a measured route. Planning the trip measures what it can and says what it couldn’t.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function Figure({ term, value, note }: { term: string; value: string; note: string }) {
  return (
    <div className="border-t border-ink/15 pt-2">
      <dt className="sheet-label text-ink-muted">{term}</dt>
      <dd className="mt-1 font-mono text-2xl text-ink">{value}</dd>
      <dd className="text-xs text-ink-faint">{note}</dd>
    </div>
  );
}

function savingsLine(before: PlanVersionMeasure, after: PlanVersionMeasure): string {
  const parts: string[] = [];
  parts.push(`${after.hotelMoves} hotel move${after.hotelMoves === 1 ? '' : 's'}${after.hotelMoves !== before.hotelMoves ? ` (was ${before.hotelMoves})` : ''}`);
  const travel = before.moveMinutes - after.moveMinutes;
  if (travel > 0) parts.push(`about ${formatPlanMinutes(travel)} less moving between beds`);
  else if (travel < 0) parts.push(`about ${formatPlanMinutes(-travel)} more moving between beds`);
  if (before.routeKm !== null && after.routeKm !== null && before.routeKm !== after.routeKm) parts.push(`${Math.abs(before.routeKm - after.routeKm)} km ${after.routeKm < before.routeKm ? 'less' : 'more'} in straight lines`);
  return `The version you’ll plan: ${parts.join(', ')} — estimates, not timetables.`;
}

function changeSaving(change: PlanChange): string {
  const bits: string[] = [];
  if (change.saving.hotelMoves > 0) bits.push(`${change.saving.hotelMoves} hotel move${change.saving.hotelMoves === 1 ? '' : 's'} fewer`);
  if (change.saving.moveMinutes > 0) bits.push(`about ${formatPlanMinutes(change.saving.moveMinutes)} less travel`);
  if (change.saving.routeKm > 0) bits.push(`${change.saving.routeKm} km less (straight lines)`);
  return bits.length > 0 ? ` Saves ${bits.join(', ')} (estimate).` : '';
}

function VersionColumn({ title, testId, stops, highlight = false }: { title: string; testId: string; stops: readonly ProposalStop[]; highlight?: boolean }) {
  return (
    <div className={cx('rounded-[var(--radius-card)] border p-4 sm:p-5', highlight ? 'border-ink/40' : 'border-ink/15')} data-testid={testId}>
      <p className="sheet-label text-ink-muted">{title}</p>
      <ol className="mt-3 space-y-2">
        {stops.map((stop, index) => (
          <li key={`${stop.label}-${index}`} className="flex flex-wrap items-baseline justify-between gap-x-3" data-testid="plan-check-version-stop" data-changed={highlight && stop.changedBy.length > 0 ? 'true' : 'false'}>
            <span className="font-display text-lg text-ink">
              <span className="mr-2 font-mono text-xs text-ink-faint">{String(index + 1).padStart(2, '0')}</span>
              {stop.label}
              {stop.fixed ? <span className="ml-2 font-mono text-xs text-pine">booked</span> : null}
            </span>
            <span className={cx('font-mono text-xs', highlight && stop.changedBy.length > 0 ? 'text-flare' : 'text-ink-muted')}>
              {stop.dayTrip ? 'day trip' : `${stop.nights} night${stop.nights === 1 ? '' : 's'}`}
              {stop.transportIn ? ` · by ${STATED_TRANSPORT_LABELS[stop.transportIn]}` : ''}
            </span>
            {stop.mustSee.length > 0 ? <span className="w-full text-xs text-ink-faint">See: {stop.mustSee.join(', ')}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
