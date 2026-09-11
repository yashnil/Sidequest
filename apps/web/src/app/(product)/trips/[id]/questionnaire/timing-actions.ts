'use server';

import { z } from 'zod';
import { chosenInterests, concreteWindow, crowdPeriodsTouching, monthsBetween, recommendDateWindows, seasonMonths, type DateWindow } from '@sidequest/core';
import { climateWithReason } from '@/lib/destinations/preflight';
import { getAnswers, getTrip, updateTripDates } from '@/lib/db/repository';
import { getIntent, saveComposerAnswers } from '@/lib/db/compiler-repository';
import { realityForTrip } from '@/lib/interview/screening';
import { isClimateEnabled } from '@/lib/providers/switches';
import { guardAction } from '@/lib/net/caller';
import { tripAccessRefusal } from '@/lib/net/trip-access';
import { timingIntentOf } from '@/lib/planning/canonical-input';
import { resolveDestinationAction } from '@/app/(product)/trips/[id]/plan/actions';
import type { TimingWindowView } from '@/app/(product)/trips/new/timing-actions';

/**
 * V7 §7 — BEST_TIME V4: THE WINDOW IS CHOSEN WHEN THE TRIP IS UNDERSTOOD.
 *
 * "Tell me when it is best" used to be answered on the second screen of the
 * composer, before Sidequest knew who was going, what for, or how they felt
 * about crowds. Now that screen records the *mode* and the window is scored
 * here, at the Ready boundary, from everything the interview learned: the
 * climate normals as before, plus the interests the traveller ranked, their
 * crowd tolerance, and the busy periods and closures compiled for the
 * destination's countries. Acceptance is durable — the same row lock and the
 * same accepted recommendation as every other door that closes the question —
 * so the composition can never overwrite it.
 */

const tripIdSchema = z.string().trim().min(1).max(64);

export type TripTimingResult =
  | { ok: true; pick: TimingWindowView; alternatives: TimingWindowView[]; unknowns: string[]; basis: string; attribution: string; sampleYears: string }
  | { ok: false; deferred: true; note: string }
  | { ok: false; deferred?: false; note: string };

function view(window: DateWindow, placed: { label: string; startDate: string; endDate: string; month: number; year: number }): TimingWindowView {
  return { label: placed.label, startDate: placed.startDate, endDate: placed.endDate, month: placed.month, year: placed.year, reasons: [...window.reasons].slice(0, 4), tradeoffs: [...window.tradeoffs].slice(0, 4) };
}

function nightsOf(startDate: string, endDate: string): number {
  const nights = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(nights) ? Math.max(1, Math.min(30, nights)) : 7;
}

export async function recommendTripTimingAction(tripId: string): Promise<TripTimingResult> {
  if (!tripIdSchema.safeParse(tripId).success) return { ok: false, note: 'We could not find that trip.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, note: refusal };
  const trip = getTrip(tripId);
  const intent = getIntent(tripId);
  if (!trip) return { ok: false, note: 'We could not find that trip.' };
  const timing = timingIntentOf({ composer: intent?.composer ?? null, trip, at: new Date().toISOString() });
  if (!timing.sidequestChooses) return { ok: false, note: 'The dates for this trip are already decided.' };

  const guard = await guardAction('timing_recommendation');
  if (guard) return { ok: false, note: guard };
  if (!isClimateEnabled()) return { ok: false, deferred: true, note: 'Sidequest has no climate record to compare months on here, so it will choose the window with the plan.' };

  /*
   * V8 — the live acceptance walk found the review deferring the window with
   * "once it has placed the destination" although the phrase resolves cleanly:
   * resolution is started by the plan screen's client on mount, and a traveller
   * who leaves that screen before the geocoder answers arrives here with no
   * centre. Resolve on demand, once, behind the same fence the plan screen
   * uses; a resolver that cannot answer leaves the honest deferral below.
   */
  let intentNow = intent;
  const centreOf = (of: typeof intent) => {
    const candidate = of?.resolution?.candidates.find((c) => c.id === (of.selectedCandidateId ?? of.resolution?.unambiguousCandidateId)) ?? of?.resolution?.candidates[0] ?? null;
    return of?.selectedDestination?.center ?? candidate?.center ?? of?.destinationIntent?.graph?.envelope?.center ?? null;
  };
  let centre = centreOf(intentNow);
  if (!centre && intentNow?.destinationQuery?.trim()) {
    const resolved = await resolveDestinationAction(tripId).catch(() => ({ ok: false as const }));
    if (resolved.ok) {
      intentNow = getIntent(tripId);
      centre = centreOf(intentNow);
    }
  }
  if (!centre) return { ok: false, deferred: true, note: 'Sidequest will choose the best window once it has placed the destination.' };

  const now = new Date();
  const climate = await climateWithReason(centre, now);
  if (!climate.profile) {
    return { ok: false, deferred: true, note: climate.reason === 'provider_rate_limited' ? 'The climate records are busy this minute. Sidequest will choose the window with the plan if you carry on.' : 'We could not read the climate records just now, so Sidequest will choose the window with the plan.' };
  }

  const composer = intentNow?.composer ?? null;
  const dates = composer?.dates;
  const onlyMonths =
    dates?.months && dates.months.length > 0
      ? dates.months
      : dates?.season
        ? [...seasonMonths(dates.season, centre.lat)]
        : dates?.earliest && dates?.latest
          ? monthsBetween(dates.earliest, dates.latest)
          : [];
  const answers = getAnswers(tripId);
  const interests = answers ? chosenInterests(answers) : [];
  const reality = realityForTrip({ trip, intent: intentNow, region: null });
  const nights = composer?.duration?.nights ?? nightsOf(trip.basics.startDate, trip.basics.endDate);
  const crowdPeriods = reality.crowdPeriods.map((p) => ({ name: p.name, ranges: p.ranges, effect: p.effect, note: p.note, movable: p.movable }));

  const guidance = recommendDateWindows({ profile: climate.profile, nights, onlyMonths, year: now.getUTCFullYear(), limit: 3, now, ...(composer ? { answers: composer } : {}), interests, ...(answers ? { crowdTolerance: answers.crowdTolerance } : {}), crowdPeriods });
  if (guidance.kind !== 'recommended' || guidance.windows.length === 0) return { ok: false, note: guidance.kind === 'unavailable' ? guidance.note : 'We could not compare this destination’s seasons.' };

  const bounds = { ...(dates?.earliest ? { earliest: dates.earliest } : {}), ...(dates?.latest ? { latest: dates.latest } : {}) };
  const placed = guidance.windows
    .map((window, index) => {
      const spot = concreteWindow({ windows: guidance.windows, choose: index, nights, ...bounds });
      return spot ? view(window, spot) : null;
    })
    .filter((entry): entry is TimingWindowView => entry !== null);
  const pick = placed[0];
  if (!pick) return { ok: false, note: 'We could not place a window on the calendar for this destination.' };

  const touching = crowdPeriodsTouching(reality, pick.startDate, pick.endDate);
  const basis = [interests.length > 0 ? `what you ranked (${interests.slice(0, 3).map((i) => i.replace(/_/g, ' ')).join(', ')})` : null, crowdPeriods.length > 0 ? `${crowdPeriods.length} known busy period${crowdPeriods.length === 1 ? '' : 's'}${touching.length > 0 ? `, ${touching.length} touching this window` : ''}` : null, 'twenty years of climate normals'].filter((s): s is string => s !== null).join('; ');
  return { ok: true, pick, alternatives: placed.slice(1), unknowns: [...guidance.windows[0]!.unknowns], basis, attribution: guidance.attribution, sampleYears: `${guidance.sampleYearFrom}–${guidance.sampleYearTo}` };
}

const acceptSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
  label: z.string().max(80),
  reasons: z.array(z.string().max(300)).max(6).default([]),
  tradeoffs: z.array(z.string().max(300)).max(6).default([]),
});

/**
 * "Use this timing" on the review. The same durable acceptance as the composer's
 * door and "Move my trip to June": the row's dates and lock in one statement,
 * the composer's recommendation marked accepted by the traveller.
 */
export async function acceptTripTimingAction(tripId: string, raw: z.input<typeof acceptSchema>): Promise<{ ok: true; startDate: string; endDate: string } | { ok: false; error: string }> {
  if (!tripIdSchema.safeParse(tripId).success) return { ok: false, error: 'We could not find that trip.' };
  const parsed = acceptSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'That window could not be read.' };
  const refusal = await tripAccessRefusal(tripId);
  if (refusal) return { ok: false, error: refusal };
  const trip = getTrip(tripId);
  const intent = getIntent(tripId);
  if (!trip) return { ok: false, error: 'We could not find that trip.' };
  const window = parsed.data;
  const start = Date.parse(`${window.startDate}T00:00:00Z`);
  const end = Date.parse(`${window.endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return { ok: false, error: 'That window ends before it starts.' };
  /* A locked row belongs to whoever locked it; this door only closes an open question. */
  if (trip.basics.timingLock === 'traveler') return { ok: false, error: 'The dates for this trip are already decided.' };

  const now = new Date();
  updateTripDates(tripId, window.startDate, window.endDate, 'traveler');
  if (intent?.composer) {
    saveComposerAnswers(tripId, {
      ...intent.composer,
      dates: {
        ...intent.composer.dates,
        startDate: window.startDate,
        endDate: window.endDate,
        year: window.year,
        recommendation: {
          startDate: window.startDate,
          endDate: window.endDate,
          label: window.label,
          month: window.month,
          year: window.year,
          reasons: window.reasons,
          tradeoffs: window.tradeoffs,
          unknowns: [],
          basis: 'climate_normals',
          generatedAt: now.toISOString(),
          accepted: true,
          decidedBy: 'traveller',
        },
      },
      updatedAt: now.toISOString(),
    });
  }
  return { ok: true, startDate: window.startDate, endDate: window.endDate };
}
