'use client';

import { useOptimistic, useState, useTransition } from 'react';
import {
  ACCESS_BADGE_LABELS,
  BOARD_GROUP_COPY,
  FIT_BAND_LABELS,
  FIT_BAND_METER,
  OPERATING_BADGE_LABELS,
  PLACE_CATEGORY_LABELS,
  SELECTION_STATUS_LABELS,
  WORTH_DETOUR_COPY,
  type AccessBadge,
  type BoardGroup,
  type DiscoveryCandidate,
  type OperatingBadge,
  type SelectionStatus,
} from '@sidequest/core';
import { Badge, ErrorNote, FitMeter, Panel, PlacePlate, buttonClass, cx, type BadgeTone } from './ui';
import { BuildTripButton } from './BuildTripButton';
import { formatCost, formatDistance, formatIntensity, formatMinutes } from '@/lib/format';
import { autoPickAction, setSelectionAction } from '@/app/trips/[id]/discover/actions';

export interface SerializedGroup {
  group: BoardGroup;
  candidates: DiscoveryCandidate[];
}

type SelectionMap = Record<string, SelectionStatus | undefined>;

export function DiscoveryBoardView({
  tripId,
  groups,
  initialSelections,
  autoPickNotes,
  targetCount,
  hasItinerary,
}: {
  tripId: string;
  groups: SerializedGroup[];
  initialSelections: SelectionMap;
  autoPickNotes: string[];
  targetCount: number;
  hasItinerary: boolean;
}) {
  const [selections, setSelections] = useState<SelectionMap>(initialSelections);
  const [optimistic, applyOptimistic] = useOptimistic(
    selections,
    (current: SelectionMap, patch: SelectionMap) => ({ ...current, ...patch }),
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [onlyIncluded, setOnlyIncluded] = useState(false);
  const [notes, setNotes] = useState(autoPickNotes);

  const includedCount = Object.values(optimistic).filter((status) => status === 'included').length;
  const maybeCount = Object.values(optimistic).filter((status) => status === 'maybe').length;

  function choose(placeId: string, status: SelectionStatus) {
    const next = optimistic[placeId] === status ? undefined : status;
    const previous = selections;
    setError(null);
    startTransition(async () => {
      applyOptimistic({ [placeId]: next });
      const result = await setSelectionAction(tripId, placeId, next ?? null);
      if (result.ok) {
        setSelections((current) => ({ ...current, [placeId]: next }));
      } else {
        // Roll the card back rather than showing a state the server does not have.
        setSelections(previous);
        setError(result.error ?? 'That choice did not save.');
      }
    });
  }

  function autoPick() {
    setError(null);
    startTransition(async () => {
      const result = await autoPickAction(tripId);
      if (!result.ok || !result.selections) {
        setError(result.error ?? 'We could not build a selection just then.');
        return;
      }
      // Adopt what the server actually stored, which preserves any card the
      // traveller had already decided on by hand.
      setSelections(result.selections);
      setNotes(result.notes ?? []);
    });
  }

  const visibleGroups = groups
    .map((entry) => ({
      ...entry,
      candidates: onlyIncluded
        ? entry.candidates.filter((candidate) => optimistic[candidate.place.id] === 'included')
        : entry.candidates,
    }))
    .filter((entry) => entry.candidates.length > 0);

  return (
    <div>
      <Panel className="sticky top-0 z-10 mb-8 flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
        <p className="text-sm text-ink">
          <strong className="font-display text-lg">{includedCount}</strong> in
          {maybeCount > 0 ? <span className="text-ink-muted"> · {maybeCount} maybe</span> : null}
          <span className="text-ink-faint"> · we suggested {targetCount}</span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-muted">
            <input
              type="checkbox"
              checked={onlyIncluded}
              onChange={(event) => setOnlyIncluded(event.target.checked)}
              className="h-4 w-4 accent-[var(--color-pine)]"
            />
            Only what I picked
          </label>
          <button
            type="button"
            onClick={autoPick}
            disabled={pending}
            className={buttonClass('secondary', 'sm')}
          >
            {pending ? 'Working…' : 'Auto-pick the best mix for me'}
          </button>
          <BuildTripButton
            tripId={tripId}
            hasItinerary={hasItinerary}
            includedCount={includedCount}
          />
        </div>
      </Panel>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {notes.length > 0 ? (
        <ul className="mb-8 space-y-1.5 border-l-2 border-pine pl-4 text-sm leading-relaxed text-ink-muted">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}

      {visibleGroups.length === 0 ? (
        <Panel className="p-8 text-center">
          <p className="font-display text-lg text-ink">
            {onlyIncluded ? 'Nothing picked yet' : 'Nothing here fits this trip'}
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            {onlyIncluded
              ? 'Untick the filter to see everything we found, or use auto-pick for a starting set.'
              : 'Try widening how far you will travel, or moving your dates — most of this region is behind a snow gate for part of the year.'}
          </p>
        </Panel>
      ) : (
        <div className="space-y-14">
          {visibleGroups.map((entry) => (
            <section key={entry.group} aria-labelledby={`group-${entry.group}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h2 id={`group-${entry.group}`} className="font-display text-2xl text-ink">
                  {BOARD_GROUP_COPY[entry.group].title}
                </h2>
                <span className="text-sm text-ink-faint">{entry.candidates.length}</span>
              </div>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                {BOARD_GROUP_COPY[entry.group].blurb}
              </p>
              <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {entry.candidates.map((candidate) => (
                  <PlaceCard
                    key={candidate.place.id}
                    candidate={candidate}
                    status={optimistic[candidate.place.id]}
                    onChoose={choose}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Which access facts earn a badge, in the order they matter to a decision.
 *
 * `shuttle_available` and `no_transit` are deliberately absent: "there is also a
 * bus" and "there is no bus" are true of almost every card here, and a badge
 * that is always on is a badge nobody reads. They appear in the card's cautions
 * instead, where they belong.
 */
const ACCESS_BADGE_ORDER: readonly AccessBadge[] = [
  'shuttle_required',
  'car_required',
  'seasonal_service',
  'permit_required',
  'verify_conditions',
];

const ACCESS_BADGE_TONE: Record<AccessBadge, BadgeTone> = {
  car_required: 'neutral',
  shuttle_required: 'blue',
  shuttle_available: 'blue',
  seasonal_service: 'amber',
  no_transit: 'neutral',
  permit_required: 'amber',
  verify_conditions: 'amber',
};

/**
 * Which opening-hours facts earn a badge.
 *
 * `always_open` earns nothing at all, which is the point. Nineteen of the
 * twenty-two places in this region have no closing time, and stamping "Open 24
 * hours" across the board would drown the three cards where the hours genuinely
 * decide whether the day works.
 */
const OPERATING_BADGE_ORDER: readonly OperatingBadge[] = [
  'closed_on_your_dates',
  'closed_some_days',
  'limited_hours',
  'last_admission',
  'timed_entry',
  'reservation_required',
  'admission_permit',
  'hours_unknown',
  'verify_hours',
  'daylight_only',
];

const OPERATING_BADGE_TONE: Record<OperatingBadge, BadgeTone> = {
  limited_hours: 'neutral',
  closed_some_days: 'amber',
  closed_on_your_dates: 'clay',
  last_admission: 'amber',
  reservation_required: 'amber',
  timed_entry: 'amber',
  admission_permit: 'amber',
  hours_unknown: 'amber',
  verify_hours: 'amber',
  daylight_only: 'neutral',
};

/**
 * Whether stating the hours would tell the traveller anything. A day-use site
 * posted 06:00 to 22:00 cannot constrain a trip day, and printing its hours on
 * the card is a line of text that only competes with the ones that matter.
 */
function bindsTheDay(operating: DiscoveryCandidate['operating']): boolean {
  return (
    operating.badges.includes('limited_hours') ||
    operating.badges.includes('last_admission') ||
    operating.badges.includes('closed_some_days')
  );
}

const STATUS_STYLE: Record<SelectionStatus, string> = {
  included: 'border-pine bg-pine-soft text-pine',
  maybe: 'border-slate-blue bg-slate-blue-soft text-slate-blue',
  excluded: 'border-clay bg-clay-soft text-clay',
};

function PlaceCard({
  candidate,
  status,
  onChoose,
}: {
  candidate: DiscoveryCandidate;
  status: SelectionStatus | undefined;
  onChoose: (placeId: string, status: SelectionStatus) => void;
}) {
  const { place, fit, season, access, operating } = candidate;
  const blocked = fit.band === 'not_workable';

  return (
    <Panel
      as="article"
      className={cx(
        'flex flex-col overflow-hidden transition-colors',
        status === 'included' && 'border-pine',
        status === 'excluded' && 'opacity-60',
      )}
    >
      <div className="relative">
        <PlacePlate placeId={place.id} category={place.category} className="h-24" />
        <span className="absolute top-2 left-2 rounded-full bg-paper-raised/90 px-2 py-0.5 text-[11px] font-medium text-ink">
          {PLACE_CATEGORY_LABELS[place.category]}
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="font-display text-lg leading-snug text-ink">{place.name}</h3>
        <p className="mt-0.5 text-xs text-ink-faint">
          {place.locality}
          {/*
            Two records that share one car park would otherwise read as two
            unrelated stops that happen to have similar names. Saying which site
            they belong to is what makes "the grounds" and "the visitor centre"
            legible as halves of one visit rather than a duplicate.
          */}
          {place.accessGroup ? (
            <>
              {' · '}
              <span title={place.accessGroup.note}>Part of {place.accessGroup.label}</span>
            </>
          ) : null}
        </p>

        <div className="mt-3">
          <FitMeter band={fit.band} label={FIT_BAND_LABELS[fit.band]} meter={FIT_BAND_METER[fit.band]} />
        </div>

        <p className="mt-3 text-sm leading-relaxed text-ink-muted">{place.shortDescription}</p>

        <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
          <Stat label="From base">
            {candidate.detourClass === 'base'
              ? 'At your base'
              : `${formatMinutes(candidate.driveMinutes)} · ${formatDistance(candidate.distanceKm)}`}
          </Stat>
          <Stat label="Time there">{formatMinutes(place.typicalDurationMinutes)}</Stat>
          <Stat label="Cost">{formatCost(place.costLevel)}</Stat>
          <Stat label="Effort">{formatIntensity(place.physicalIntensity)}</Stat>
        </dl>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone={blocked ? 'clay' : 'neutral'}>{WORTH_DETOUR_COPY[candidate.worthDetour]}</Badge>
          {place.hiddenGemScore >= 0.6 ? <Badge tone="amber">Hidden gem</Badge> : null}
          {season.status === 'partially_open' ? <Badge tone="amber">Part of your dates</Badge> : null}
          {season.status === 'closed' ? <Badge tone="clay">Closed on your dates</Badge> : null}
          {/*
            Only the badges that change what the traveller has to do. A card that
            wears every flag it qualifies for teaches people to stop reading them.
          */}
          {ACCESS_BADGE_ORDER.filter((badge) => access.badges.includes(badge)).map((badge) => (
            <Badge key={badge} tone={ACCESS_BADGE_TONE[badge]}>
              {ACCESS_BADGE_LABELS[badge]}
            </Badge>
          ))}
          {OPERATING_BADGE_ORDER.filter((badge) => operating.badges.includes(badge)).map((badge) => (
            <Badge key={badge} tone={OPERATING_BADGE_TONE[badge]}>
              {OPERATING_BADGE_LABELS[badge]}
            </Badge>
          ))}
          {place.worksInBadWeather ? <Badge tone="blue">Bad-weather option</Badge> : null}
        </div>

        {access.status === 'partial' ? (
          <p className="mt-3 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Reachable on {access.usableDates.length} of your{' '}
            {access.byDate.length} days — we will only put it on one of those.
          </p>
        ) : null}

        {/*
          Reaching it and being let in are separate questions, so they get
          separate lines. Only the hours that bear on these dates appear; the
          rest of the annual timetable is not the traveller's problem.
        */}
        {operating.status === 'closed_throughout' ? (
          <p className="mt-3 rounded-md bg-clay-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Shut on every day of your trip.
          </p>
        ) : operating.status === 'open_some_days' ? (
          <p className="mt-3 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            Open on {operating.openDates.length} of your {operating.byDate.length} days
            {operating.hoursSummary ? `, ${operating.hoursSummary}` : ''} — we will only put it on
            one of those.
          </p>
        ) : operating.hoursSummary && bindsTheDay(operating) ? (
          <p className="mt-3 text-xs leading-relaxed text-ink-faint">
            Open {operating.hoursSummary}
            {operating.lastAdmissionSummary ? ` · ${operating.lastAdmissionSummary.toLowerCase()}` : ''}
          </p>
        ) : null}

        {operating.requiresVerification && operating.verifyNote ? (
          <p className="mt-2 rounded-md bg-amber-soft p-2.5 text-xs leading-relaxed text-ink-muted">
            {/*
              Deliberately not "check before you go" — that is the access
              badge's phrase, and a card wearing both said the same four words
              twice about two different things.
            */}
            <span className="font-medium text-ink">Check its hours.</span>{' '}
            {operating.verifyNote}
          </p>
        ) : null}

        {fit.blockers.length > 0 ? (
          <div className="mt-4 rounded-lg bg-clay-soft p-3">
            <p className="text-xs font-medium text-clay">Why this will not work</p>
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
              {fit.blockers.map((blocker) => (
                <li key={blocker.code}>{blocker.message}</li>
              ))}
            </ul>
          </div>
        ) : fit.reasons.length > 0 ? (
          <div className="mt-4 rounded-lg bg-paper-sunk p-3">
            <p className="text-xs font-medium text-ink">Why this fits you</p>
            <ul className="mt-1 space-y-1 text-xs leading-relaxed text-ink-muted">
              {fit.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {fit.cautions.length > 0 ? (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-ink-faint hover:text-ink">
              Worth knowing ({fit.cautions.length})
            </summary>
            <ul className="mt-2 space-y-1 leading-relaxed text-ink-muted">
              {fit.cautions.map((caution) => (
                <li key={caution}>{caution}</li>
              ))}
            </ul>
          </details>
        ) : null}

        <div className="mt-auto pt-4">
          {/*
            A choice that has become impossible stays visible as a conflict.
            Silently flipping it to "Skip" would rewrite what someone asked for
            and hide the one fact they need in order to change their mind.
          */}
          {blocked && status === 'included' ? (
            <p className="mb-2 rounded-md bg-clay-soft p-2.5 text-xs leading-relaxed text-clay">
              You picked this, and it no longer works on these dates. We have kept
              your choice — change your dates, your transport answers, or skip it.
            </p>
          ) : null}
          <div
            className="flex gap-1.5"
            role="group"
            aria-label={`Your decision on ${place.name}`}
          >
            {(['included', 'maybe', 'excluded'] as const).map((option) => {
              // Offering "Include" on a stop we just explained is impossible would
              // let the traveller build a plan that cannot run.
              const unavailable = blocked && option === 'included' && status !== 'included';
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onChoose(place.id, option)}
                  disabled={unavailable}
                  aria-pressed={status === option}
                  // The reason names the actual constraint. "Low logistics fit"
                  // tells nobody which of their answers to change.
                  title={unavailable ? (fit.blockers[0]?.message ?? undefined) : undefined}
                  className={cx(
                    'flex-1 rounded-md border px-2 py-1.5 text-xs font-medium whitespace-nowrap transition-colors',
                    unavailable && 'cursor-not-allowed border-rule text-ink-faint opacity-50',
                    !unavailable && status === option
                      ? STATUS_STYLE[option]
                      : !unavailable && 'border-rule text-ink-muted hover:border-ink-faint hover:text-ink',
                  )}
                >
                  {SELECTION_STATUS_LABELS[option]}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[11px] text-ink-faint">
            Source: {place.source.name}
            {place.source.url ? (
              <>
                {' · '}
                <a
                  href={place.source.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-ink"
                >
                  check current conditions
                </a>
              </>
            ) : null}
          </p>
        </div>
      </div>
    </Panel>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
